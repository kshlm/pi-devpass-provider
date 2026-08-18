/**
 * Assert-based self-check for the pure helpers in index.ts.
 * Run: npm run check  (or: node selfcheck.ts — Node >= 22.6 strips types natively)
 */
import assert from "node:assert/strict";
import { formatBalance, isChatModel, toPerMillion, toPiModel } from "./index.ts";

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
	name: "Claude Sonnet 4.5",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

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

console.log("selfcheck passed");
