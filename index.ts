/**
 * @kshlm/pi-devpass-provider — LLM Gateway / DevPass model provider for pi.
 *
 * Registers a "devpass" provider (OpenAI-compatible, https://api.llmgateway.io/v1)
 * whose coding models and $/M rates are fetched from GET /v1/models, filtered
 * to the DevPass coding-plan set (24h on-disk cache, stale-fallback on
 * network failure) and surfaces the DevPass credit balance
 * (GET /v1/key) in the status line — only while a `devpass/*` model is active.
 *
 * Setup:
 *   pi -e /path/to/pi-devpass-provider
 *   /login devpass        # paste your DevPass key (llmgtwy_...) — stored in ~/.pi/agent/auth.json
 *   (or) export LLM_GATEWAY_API_KEY=llmgtwy_...   # DevPass plan key from https://devpass.llmgateway.io
 * Then pick a model with /model (root ids like `claude-sonnet-4-5` — DevPass
 * keys cannot use provider-pinned ids) and check /devpass for the balance.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER_ID = "devpass";
const DEFAULT_BASE_URL = "https://api.llmgateway.io/v1";
const API_KEY_ENV = "LLM_GATEWAY_API_KEY";
const FETCH_TIMEOUT_MS = 15_000;
// Static gateway key: no expiry, so park `expires` far out and refresh is identity.
const TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** baseUrl precedence: LL_GATEWAY_BASE_URL env > models.json providers.devpass.baseUrl > default. */
export function resolveBaseUrl(env: string | undefined, modelsJson: string | undefined): string {
	const fromEnv = env?.trim();
	if (fromEnv) return fromEnv;
	try {
		const fromFile = (JSON.parse(modelsJson ?? "")?.providers?.[PROVIDER_ID]?.baseUrl ?? "").trim?.() ?? "";
		if (fromFile) return fromFile;
	} catch {
		// corrupt/missing models.json — pi itself will surface that; fall through
	}
	return DEFAULT_BASE_URL;
}

const BASE_URL = resolveBaseUrl(
	process.env.LLM_GATEWAY_BASE_URL,
	readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"),
);
// per-base-URL cache file: self-hosted gateways must not be served the cloud catalog
const CACHE_FILE = join(
	homedir(),
	".pi",
	"agent",
	"cache",
	`devpass-models-${createHash("sha1").update(BASE_URL).digest("hex").slice(0, 12)}.json`,
);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_V = 3;

// --- Gateway API shapes (subset of fields we consume) ---

interface GwPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

interface GwProviderMapping {
	reasoning?: boolean;
	vision?: boolean;
	tools?: boolean;
	streaming?: boolean | "only";
	stability?: string | null;
	pricing?: GwPricing;
}

interface GwModel {
	id: string;
	name?: string;
	display_name?: string;
	free?: boolean | null;
	stability?: string | null;
	deprecated_at?: string | null;
	deactivated_at?: string | null;
	context_length?: number;
	max_output?: number;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	providers?: GwProviderMapping[];
	pricing?: GwPricing;
}

interface GwKeyStatus {
	data?: {
		label?: string;
		usage?: string;
		limit?: string;
		devPlan?: string;
		devPlanCreditsUsed?: string;
		devPlanCreditsLimit?: string;
		devPlanCreditsRemaining?: string;
		devPlanPremiumWeeklyLimit?: string;
		devPlanPremiumCreditsUsed?: string;
		devPlanPremiumWeekResetsAt?: string;
	};
}

// --- Pure helpers (assert-checked in selfcheck.ts) ---

const fmtUSD = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Gateway pricing strings are USD per token in scientific notation
 * ("5e-6" = $5 per million tokens). Guard: a value >= 0.01 is already $/M
 * (real per-token prices are < 0.002).
 */
export function toPerMillion(raw?: string | number): number {
	const n = typeof raw === "number" ? raw : parseFloat(raw ?? "");
	if (!Number.isFinite(n) || n <= 0) return 0;
	const perMillion = n >= 0.01 ? n : n * 1e6;
	return +perMillion.toFixed(6);
}

function isUnstable(stability?: string | null): boolean {
	return stability === "unstable" || stability === "experimental";
}

/**
 * Public /v1/models writes missing cachedInputPrice as "0". Official DevPass
 * gate treats a set field (including "0") as cache support, so "0" here is
 * indistinguishable from absent. Non-zero cache read/write is the public-API
 * stand-in; a true "0" cache rate still looks like no cache.
 */
export function hasCachedInput(raw?: string): boolean {
	if (raw === undefined || raw === null || raw === "") return false;
	const n = Number(raw);
	return Number.isFinite(n) && n !== 0;
}

/** One provider mapping can serve coding-plan traffic. */
export function mappingSupportsCoding(p: GwProviderMapping): boolean {
	if (isUnstable(p.stability)) return false;
	return (
		p.tools === true &&
		p.streaming !== false &&
		(hasCachedInput(p.pricing?.input_cache_read) || hasCachedInput(p.pricing?.input_cache_write))
	);
}

/**
 * DevPass coding model: paid, stable, and served by a mapping with tools,
 * streaming, and cached input. Same gate as GET /v1/chat on a coding plan and
 * the All tab on https://devpass.llmgateway.io/coding-models.
 */
export function isCodingModel(m: GwModel): boolean {
	if (m.id === "custom" || m.id === "auto") return false;
	if (m.free || isUnstable(m.stability)) return false;
	return (m.providers ?? []).some(mappingSupportsCoding);
}

/** Chat-capable and not deprecated/deactivated. Placeholder entries ("custom") are excluded. */
export function isChatModel(m: GwModel): boolean {
	if (m.id === "custom") return false; // BYOK placeholder, not a real model
	if (m.deprecated_at || m.deactivated_at) return false;
	const outputs = m.architecture?.output_modalities ?? ["text"]; // missing metadata defaults to text
	const inputs = m.architecture?.input_modalities ?? ["text"];
	// text-only output: image/audio/video-output models aren't chat-completions usable
	return outputs.length === 1 && outputs[0] === "text" && inputs.includes("text");
}

export function toPiModel(m: GwModel) {
	const input = toPerMillion(m.pricing?.prompt);
	const output = toPerMillion(m.pricing?.completion);
	const name = m.display_name || m.name || m.id;
	// LLM Gateway defines Premium from live catalog prices; /models exposes no category field.
	const premium = input >= 5 || output >= 15;
	return {
		id: m.id,
		name: premium ? `[Premium] ${name}` : name,
		reasoning: m.providers?.some((p) => p.reasoning) ?? false,
		input: (m.providers?.some((p) => p.vision) ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: {
			input,
			output,
			cacheRead: toPerMillion(m.pricing?.input_cache_read),
			cacheWrite: toPerMillion(m.pricing?.input_cache_write),
		},
		contextWindow: m.context_length || 128_000,
		maxTokens: m.max_output || 8_192,
	};
}

/** One-line balance summary for the status line; "" when nothing reportable. */
export function formatBalance(d: GwKeyStatus["data"]): string {
	if (!d) return "";
	const num = (v?: string) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	const planLimit = num(d.devPlanCreditsLimit);
	const planRemaining = num(d.devPlanCreditsRemaining);
	if (planLimit && planLimit > 0 && planRemaining !== undefined) {
		return `$${fmtUSD(planRemaining)}/$${fmtUSD(planLimit)} left`;
	}
	const used = num(d.usage);
	const keyLimit = num(d.limit);
	if (keyLimit && keyLimit > 0 && used !== undefined) {
		return `$${fmtUSD(used)}/$${fmtUSD(keyLimit)} used`;
	}
	return "";
}

/** True when the active model belongs to this provider. */
export function isDevpassModel(model?: { provider?: string } | null): boolean {
	return model?.provider === PROVIDER_ID;
}

/** Extract the key string from an auth.json entry (oauth `access` or api_key `key`). */
export function keyFromAuthEntry(e: unknown): string | undefined {
	if (typeof e !== "object" || e === null) return;
	const { access, key } = e as { access?: unknown; key?: unknown };
	for (const v of [access, key]) {
		if (typeof v === "string" && v.trim()) return v.trim();
	}
}

// --- Gateway client ---

async function gwFetch<T>(path: string, apiKey?: string, signal?: AbortSignal): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, // /v1/models is public
		signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	return (res.json() as Promise<T>);
}

/** Live catalog: fetch, keep DevPass coding models, map to pi model configs. */
async function fetchCatalog(signal: AbortSignal, apiKey?: string) {
	const payload = await gwFetch<{ data: GwModel[] }>("/models?exclude_deprecated=true", apiKey, signal);
	return (payload.data ?? []).filter(isCodingModel).map(toPiModel);
}

// --- Catalog cache (~/.pi/agent/cache/devpass-models.json) ---

type PiModelConfig = ReturnType<typeof toPiModel>;

interface CacheEntry {
	v: number;
	fetchedAt: number;
	models: PiModelConfig[];
}

export function isCacheFresh(entry: CacheEntry | undefined | null, now = Date.now()): boolean {
	return !!entry && now - entry.fetchedAt < CACHE_TTL_MS;
}

export async function readCacheFrom(path: string): Promise<CacheEntry | undefined> {
	try {
		const entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
		return entry.v === CACHE_V && Array.isArray(entry.models) ? entry : undefined;
	} catch {
		return; // missing or corrupt — treat as no cache
	}
}

export async function writeCacheTo(path: string, models: PiModelConfig[]): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify({ v: CACHE_V, fetchedAt: Date.now(), models }));
	} catch {
		// ponytail: cache write failure is non-fatal — next run refetches
	}
}

// --- Extension ---

/** Saved `/login devpass` token from ~/.pi/agent/auth.json (re-read per call: works right after login). */
function readSavedKey(): string | undefined {
	try {
		return keyFromAuthEntry(JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))?.[PROVIDER_ID]);
	} catch {
		return; // missing/corrupt auth.json — env var still applies
	}
}

/** Key precedence mirrors pi: auth.json (/login) > env var. Used for balance + catalog fetches. */
const currentApiKey = () => readSavedKey() ?? process.env[API_KEY_ENV];

export default async function devpassProvider(pi: ExtensionAPI) {
	let models: PiModelConfig[] = [];
	// /v1/models is public — the key is only needed for streaming and balance.
	// Fresh cache short-circuits the network; stale cache beats an empty list.
	const cached = await readCacheFrom(CACHE_FILE);
	if (cached && isCacheFresh(cached)) {
		models = cached.models;
	} else {
		try {
			models = await fetchCatalog(AbortSignal.timeout(FETCH_TIMEOUT_MS), currentApiKey());
			await writeCacheTo(CACHE_FILE, models);
		} catch {
			if (cached) models = cached.models;
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "LLM Gateway (DevPass)",
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-completions",
		models,
		// Registration/session start triggers a cache-only refresh (the factory
		// above owns the 24h TTL). allowNetwork=true only arrives from explicit
		// user refreshes (/model selector, ctx.modelRegistry.refresh) — those
		// always refetch. `pi update --models` never reaches us: it builds an
		// extension-free runtime from builtins + models.json.
		async refreshModels({ signal, allowNetwork }) {
			if (!allowNetwork) return models;
			const next = await fetchCatalog(signal, currentApiKey());
			models = next;
			await writeCacheTo(CACHE_FILE, models);
			return models;
		},
		// `/login devpass`: prompt for the gateway key, verify it, persist as credentials.
		oauth: {
			name: "LLM Gateway (DevPass)",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const key = (await callbacks.onPrompt({ message: "LLM Gateway API key (llmgtwy_…):" })).trim();
				if (!key) throw new Error("Login cancelled");
				callbacks.onProgress?.(`devpass: verifying key against ${BASE_URL}/key…`);
				try {
					await gwFetch<GwKeyStatus>("/key", key);
				} catch (e) {
					throw new Error(`Key rejected: ${e instanceof Error ? e.message : String(e)}`);
				}
				return { refresh: key, access: key, expires: Date.now() + TOKEN_TTL_MS };
			},
			async refreshToken(credentials) {
				return credentials; // static key — never actually expires
			},
			getApiKey: (credentials) => credentials.access,
		},
	});

	async function fetchBalance(): Promise<GwKeyStatus["data"] | undefined> {
		const key = currentApiKey();
		if (!key) return;
		try {
			return (await gwFetch<GwKeyStatus>("/key", key)).data;
		} catch {
			return; // ponytail: silent — status line just keeps the last known balance
		}
	}

	let lastBalance = "";

	function statusLine(ui: ExtensionContext["ui"]): string | undefined {
		return lastBalance ? ui.theme.fg("dim", `devpass balance ${lastBalance}`) : undefined;
	}

	// Status (balance only) only while a devpass model is active.
	async function paintStatus(
		model: { provider?: string } | null | undefined,
		ui: ExtensionContext["ui"],
		refresh = false,
	) {
		if (!isDevpassModel(model)) {
			ui.setStatus(PROVIDER_ID, undefined);
			return;
		}
		if (refresh) {
			const next = formatBalance(await fetchBalance());
			if (next) lastBalance = next; // keep last known on fail
		}
		ui.setStatus(PROVIDER_ID, statusLine(ui));
	}

	pi.on("session_start", (_event, ctx) => paintStatus(ctx.model, ctx.ui, true));
	pi.on("model_select", (event, ctx) => paintStatus(event.model, ctx.ui, true));

	// event.message is the finalized assistant message — typed provider access
	// (verified live: /v1/models uses per-token sci-notation pricing)
	pi.on("turn_end", (event, ctx) => {
		if (event.message.role !== "assistant" || event.message.provider !== PROVIDER_ID) return;
		return paintStatus(ctx.model, ctx.ui, true);
	});

	pi.registerCommand("devpass", {
		description: "Show DevPass credit balance and refresh the status line",
		handler: async (_args, ctx) => {
			if (!currentApiKey()) {
				ctx.ui.notify(`devpass: /login devpass first (or set ${API_KEY_ENV}).`, "error");
				return;
			}
			try {
				const d = await fetchBalance();
				const balance = formatBalance(d);
				if (balance) lastBalance = balance;
				const lines = [
					d?.label ? `Key: ${d.label}` : null,
					d?.devPlan && d.devPlan !== "none" ? `Dev plan: ${d.devPlan}` : null,
					balance || null,
					d?.devPlanCreditsUsed ? `Credits used: $${d.devPlanCreditsUsed}` : null,
					d?.devPlanPremiumCreditsUsed
						? `Premium used: $${d.devPlanPremiumCreditsUsed}${d.devPlanPremiumWeeklyLimit ? `/$${d.devPlanPremiumWeeklyLimit}` : ""}${d.devPlanPremiumWeekResetsAt ? ` (resets ${d.devPlanPremiumWeekResetsAt})` : ""}`
						: null,
					d?.usage ? `Key usage: $${d.usage}` : null,
					`Models loaded: ${models.length}`,
				].filter((l): l is string => l !== null);
				await paintStatus(ctx.model, ctx.ui); // paints only if a devpass model is active
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(`devpass: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}
