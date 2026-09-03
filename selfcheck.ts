/**
 * Assert-based self-check for the pure helpers in index.ts.
 * Run: npm run check  (or: node selfcheck.ts — Node >= 22.6 strips types natively)
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBalance, hasCachedInput, isCacheFresh, isChatModel, isCodingModel, isDevpassModel, keyFromAuthEntry, mappingSupportsCoding, readCacheFrom, resolveBaseUrl, shouldFetchCatalog, toPerMillion, toPiModel, writeCacheTo } from "./index.ts";

// keyFromAuthEntry — auth.json shapes: oauth ({access}) and manual api_key ({key})
assert.equal(keyFromAuthEntry({ type: "oauth", access: "llmgtwy_a", refresh: "llmgtwy_a", expires: 1 }), "llmgtwy_a");
assert.equal(keyFromAuthEntry({ type: "api_key", key: "llmgtwy_b" }), "llmgtwy_b");
assert.equal(keyFromAuthEntry({ type: "oauth", access: "  llmgtwy_c  \n" }), "llmgtwy_c", "trimmed");
assert.equal(keyFromAuthEntry({ type: "oauth", access: "" }), undefined, "empty access");
assert.equal(keyFromAuthEntry({}), undefined);
assert.equal(keyFromAuthEntry(undefined), undefined);
assert.equal(keyFromAuthEntry("nope"), undefined);

// resolveBaseUrl precedence: env > models.json > default
assert.equal(resolveBaseUrl(undefined, undefined), "https://api.llmgateway.io/v1");
assert.equal(resolveBaseUrl("", ""), "https://api.llmgateway.io/v1");
assert.equal(resolveBaseUrl(undefined, '{"providers":{"devpass":{"baseUrl":"https://gw.self/v1"}}}'), "https://gw.self/v1");
assert.equal(resolveBaseUrl("http://env:9", '{"providers":{"devpass":{"baseUrl":"https://gw.self/v1"}}}'), "http://env:9", "env wins over file");
assert.equal(resolveBaseUrl(undefined, '{"providers":{"other":{"baseUrl":"https://x"}}}'), "https://api.llmgateway.io/v1");
assert.equal(resolveBaseUrl(undefined, '{"providers":{"devpass":{}}}'), "https://api.llmgateway.io/v1");
assert.equal(resolveBaseUrl(undefined, "not json"), "https://api.llmgateway.io/v1", "corrupt file ignored");

// toPerMillion — gateway sends USD-per-token scientific notation
assert.equal(toPerMillion("5e-6"), 5);
assert.equal(toPerMillion("0.000003"), 3);
assert.equal(toPerMillion("30e-6"), 30);
assert.equal(toPerMillion("0.3e-6"), 0.3);
assert.equal(toPerMillion("3.75e-6"), 3.75);
assert.equal(toPerMillion("0.05"), 0.05, "already $/M — not multiplied");
assert.equal(toPerMillion("0"), 0);
assert.equal(toPerMillion(undefined), 0);
assert.equal(toPerMillion("not-a-number"), 0);

// isCodingModel — DevPass gate: paid + stable + tools + stream + cache
const codingMap = { tools: true, streaming: true, pricing: { input_cache_read: "0.1e-6" } };
assert.equal(isCodingModel({ id: "ok", providers: [codingMap] }), true);
assert.equal(isCodingModel({ id: "custom", providers: [codingMap] }), false, "BYOK placeholder");
assert.equal(isCodingModel({ id: "auto", providers: [codingMap] }), false, "auto-router");
assert.equal(isCodingModel({ id: "free", free: true, providers: [codingMap] }), false);
assert.equal(isCodingModel({ id: "unstable", stability: "unstable", providers: [codingMap] }), false);
assert.equal(isCodingModel({ id: "experimental", stability: "experimental", providers: [codingMap] }), false);
assert.equal(isCodingModel({ id: "no-tools", providers: [{ ...codingMap, tools: false }] }), false);
assert.equal(isCodingModel({ id: "no-stream", providers: [{ ...codingMap, streaming: false }] }), false);
assert.equal(isCodingModel({ id: "stream-only", providers: [{ ...codingMap, streaming: "only" }] }), true);
assert.equal(isCodingModel({ id: "no-cache", providers: [{ tools: true, streaming: true, pricing: { input_cache_read: "0" } }] }), false, "public API 0 = missing cache");
assert.equal(isCodingModel({ id: "cache-write", providers: [{ tools: true, streaming: true, pricing: { input_cache_write: "3e-6" } }] }), true);
assert.equal(
	isCodingModel({
		id: "one-good",
		providers: [{ ...codingMap, tools: false }, codingMap],
	}),
	true,
	"one usable mapping is enough",
);
assert.equal(isCodingModel({ id: "empty", providers: [] }), false);
assert.equal(mappingSupportsCoding({ ...codingMap, stability: "unstable" }), false);
assert.equal(hasCachedInput("0"), false);
assert.equal(hasCachedInput("0.1e-6"), true);
assert.equal(hasCachedInput(undefined), false);

// isChatModel
const base = { id: "m", context_length: 1000, max_output: 100 };
assert.equal(isChatModel({ ...base }), true);
assert.equal(isChatModel({ ...base, deprecated_at: "2026-01-01" }), false);
assert.equal(isChatModel({ ...base, deactivated_at: "2026-01-01" }), false);
assert.equal(isChatModel({ ...base, architecture: { output_modalities: ["image"] } }), false);
assert.equal(isChatModel({ ...base, architecture: { input_modalities: ["audio"] } }), false);
// live-catalog shapes (/v1/models, verified 2026-08): embeddings/rerank/tts are excluded
assert.equal(isChatModel({ ...base, architecture: { output_modalities: ["embedding"] } }), false);
assert.equal(isChatModel({ ...base, architecture: { output_modalities: ["rerank"] } }), false);
assert.equal(isChatModel({ ...base, architecture: { output_modalities: ["audio"] } }), false);
assert.equal(isChatModel({ ...base, id: "custom" }), false, "BYOK placeholder excluded");
assert.equal(isChatModel({ ...base, id: "auto" }), true, "gateway auto-router kept");
assert.equal(isChatModel({ ...base, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } }), true);
// image-output hybrids excluded (text+image output)
assert.equal(
	isChatModel({ ...base, architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] } }),
	false,
);
assert.equal(
	isChatModel({ ...base, architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] } }),
	false,
);

// real catalog pricing strings (gpt-4o-mini)
assert.deepEqual(
	toPiModel({
		id: "gpt-4o-mini",
		pricing: { prompt: "0.15e-6", completion: "0.6e-6", input_cache_read: "0.075e-6", input_cache_write: "0" },
	}).cost,
	{ input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
);
assert.equal(toPerMillion("0"), 0, "free/custom models cost 0");
assert.equal(toPerMillion("3e-05"), 30, "catalog max $30/M in");

// toPiModel
const mapped = toPiModel({
	id: "claude-sonnet-4-5",
	display_name: "Claude Sonnet 4.5",
	context_length: 200_000,
	max_output: 64_000,
	providers: [{ reasoning: true, vision: true }],
	pricing: { prompt: "3e-6", completion: "15e-6", input_cache_read: "0.3e-6", input_cache_write: "3.75e-6" },
});
assert.deepEqual(mapped, {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5 [P]",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});
assert.equal(
	toPiModel({ id: "input-threshold", display_name: "Input Threshold", pricing: { prompt: "5e-6", completion: "1e-6" } }).name,
	"Input Threshold [P]",
);
assert.equal(
	toPiModel({ id: "standard", display_name: "Standard", pricing: { prompt: "4.999e-6", completion: "14.999e-6" } }).name,
	"Standard",
);

// defaults
assert.deepEqual(toPiModel({ id: "bare" }), {
	id: "bare",
	name: "bare",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
});

// formatBalance
assert.equal(
	formatBalance({ devPlanCreditsRemaining: "8.12", devPlanCreditsLimit: "25" }),
	"$8.12/$25 left",
);
assert.equal(formatBalance({ usage: "3.5", limit: "10" }), "$3.50/$10 used");
assert.equal(formatBalance({ devPlan: "none" }), "");
assert.equal(formatBalance(undefined), "");

// isDevpassModel — status line / balance only while this provider is active
assert.equal(isDevpassModel({ provider: "devpass" }), true);
assert.equal(isDevpassModel({ provider: "anthropic" }), false);
assert.equal(isDevpassModel({ provider: "openai" }), false);
assert.equal(isDevpassModel({}), false);
assert.equal(isDevpassModel(undefined), false);
assert.equal(isDevpassModel(null), false);

// cache: round-trip, freshness, corruption, schema version
const cachePath = join(mkdtempSync(join(tmpdir(), "devpass-cache-")), "cache.json");
assert.equal(await readCacheFrom(cachePath), undefined, "missing file → undefined");
const sample = [toPiModel({ id: "x", pricing: { prompt: "3e-6", completion: "15e-6" } })];
await writeCacheTo(cachePath, sample);
const entry = await readCacheFrom(cachePath);
assert.ok(entry, "round-trip readable");
assert.deepEqual(entry.models, sample, "round-trip preserves models");
assert.ok(isCacheFresh(entry), "fresh just after write");
assert.ok(!isCacheFresh({ ...entry, fetchedAt: Date.now() - 25 * 3600_000 }), "stale after 24h TTL");
assert.ok(!isCacheFresh(undefined), "missing entry not fresh");
assert.equal(shouldFetchCatalog(false, true, undefined), false, "registration refresh stays cache-only");
assert.equal(shouldFetchCatalog(true, false, entry), false, "fresh cache avoids network");
assert.equal(shouldFetchCatalog(true, true, entry), true, "forced refresh bypasses cache TTL");
assert.equal(shouldFetchCatalog(true, false, { ...entry, fetchedAt: Date.now() - 25 * 3600_000 }), true, "stale cache refreshes");
writeFileSync(cachePath, "{corrupt json");
assert.equal(await readCacheFrom(cachePath), undefined, "corrupt → undefined");
writeFileSync(cachePath, JSON.stringify({ v: 2, fetchedAt: Date.now(), models: [] }));
assert.equal(await readCacheFrom(cachePath), undefined, "pre-coding-filter cache invalidated");

console.log("selfcheck passed");
