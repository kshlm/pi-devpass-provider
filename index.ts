/**
 * pi-devpass-provider — LLM Gateway / DevPass model provider for pi.
 *
 * Registers a "devpass" provider (OpenAI-compatible, https://api.llmgateway.io/v1)
 * whose models and $/M rates are fetched live from GET /v1/models at startup,
 * and surfaces the DevPass credit balance (GET /v1/key) in the status line.
 *
 * Setup:
 *   export LL_GATEWAY_API_KEY=llmgtwy_...   # DevPass plan key from https://devpass.llmgateway.io
 *   pi -e /path/to/pi-devpass-provider
 * Then pick a model with /model (root ids like `claude-sonnet-4-5` — DevPass
 * keys cannot use provider-pinned ids) and check /devpass for the balance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "devpass";
const BASE_URL = "https://api.llmgateway.io/v1";
const API_KEY_ENV = "LLM_GATEWAY_API_KEY";
const FETCH_TIMEOUT_MS = 15_000;

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
}

interface GwModel {
	id: string;
	name?: string;
	display_name?: string;
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

/** Chat-capable and not deprecated/deactivated. */
export function isChatModel(m: GwModel): boolean {
	if (m.deprecated_at || m.deactivated_at) return false;
	const outputs = m.architecture?.output_modalities ?? ["text"]; // missing metadata defaults to text
	const inputs = m.architecture?.input_modalities ?? ["text"];
	return outputs.includes("text") && inputs.includes("text");
}

export function toPiModel(m: GwModel) {
	return {
		id: m.id,
		name: m.display_name || m.name || m.id,
		reasoning: m.providers?.some((p) => p.reasoning) ?? false,
		input: (m.providers?.some((p) => p.vision) ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: {
			input: toPerMillion(m.pricing?.prompt),
			output: toPerMillion(m.pricing?.completion),
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

// --- Gateway client ---

async function gwFetch<T>(path: string, apiKey: string): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`GET ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	return (res.json() as Promise<T>);
}

// --- Extension ---

export default async function devpassProvider(pi: ExtensionAPI) {
	const apiKey = process.env[API_KEY_ENV];

	let models: GwModel[] = [];
	let loadError: string | undefined;

	if (!apiKey) {
		loadError = `${API_KEY_ENV} not set (key: https://devpass.llmgateway.io)`;
	} else {
		try {
			const payload = await gwFetch<{ data: GwModel[] }>("/models?exclude_deprecated=true", apiKey);
			models = (payload.data ?? []).filter(isChatModel);
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "LLM Gateway (DevPass)",
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-completions",
		models: models.map(toPiModel),
	});

	async function fetchBalance(): Promise<GwKeyStatus["data"] | undefined> {
		if (!apiKey) return;
		try {
			return (await gwFetch<GwKeyStatus>("/key", apiKey)).data;
		} catch {
			return; // ponytail: silent — status line just keeps the last known balance
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const parts = [`${models.length} devpass models`];
		if (loadError) parts.push(loadError);
		const balance = formatBalance(await fetchBalance());
		if (balance) parts.push(balance);
		ctx.ui.setStatus(PROVIDER_ID, ctx.ui.theme.fg("dim", parts.join(" · ")));
	});

	pi.on("turn_end", async (_event, ctx) => {
		if ((ctx as { model?: { provider?: string } }).model?.provider !== PROVIDER_ID) return;
		const balance = formatBalance(await fetchBalance());
		if (balance) ctx.ui.setStatus(PROVIDER_ID, ctx.ui.theme.fg("dim", balance));
	});

	pi.registerCommand("devpass", {
		description: "Show DevPass credit balance and refresh the status line",
		handler: async (_args, ctx) => {
			if (!apiKey) {
				ctx.ui.notify(`devpass: set ${API_KEY_ENV} to use this provider.`, "error");
				return;
			}
			try {
				const d = await fetchBalance();
				const balance = formatBalance(d);
				const lines = [
					d?.label ? `Key: ${d.label}` : null,
					d?.devPlan && d.devPlan !== "none" ? `Dev plan: ${d.devPlan}` : null,
					balance || null,
					d?.devPlanCreditsUsed ? `Credits used: $${d.devPlanCreditsUsed}` : null,
					d?.usage ? `Key usage: $${d.usage}` : null,
					`Models loaded: ${models.length}`,
				].filter((l): l is string => l !== null);
				if (balance) ctx.ui.setStatus(PROVIDER_ID, ctx.ui.theme.fg("dim", balance));
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(`devpass: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}
