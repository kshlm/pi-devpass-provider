# AGENTS.md — pi-devpass-provider

pi extension package that registers a **`devpass` model provider** backed by LLM
Gateway, following https://llmgateway.io/guides/pi. Models and $/M rates are
auto-fetched at startup; the DevPass credit balance is shown in the status line
and via `/devpass`.

## Layout

- `index.ts` — the entire extension: provider registration, live model/rate fetch,
  balance status line, `/devpass` command. Pure helpers are exported for tests.
- `selfcheck.ts` — assert-based checks for the pure helpers.
- No build step: pi loads `index.ts` (TypeScript) directly via the `pi.extensions`
  manifest in `package.json`.

## Commands

- `npm install`
- `npm run check` — `tsc --noEmit` + selfcheck asserts
- Live test: `LLM_GATEWAY_API_KEY=llmgtwy_... pi -e .`
  then `/model` (pick a `devpass/*` model) and `/devpass`.
- Install permanently: `pi install /abs/path/to/pi-devpass-provider` (or publish
  with the `pi-package` keyword and `pi install npm:pi-devpass-provider`).

## Gateway API facts (verified against docs.llmgateway.io)

- Base URL `https://api.llmgateway.io/v1`; OpenAI-compatible →
  `api: "openai-completions"` with Bearer auth (pi's openai API sends it).
- `GET /v1/models` — full catalog, no pagination. Keep text-in→text-out chat
  models only: skip `deprecated_at`/`deactivated_at`, the `custom` BYOK placeholder,
  and any model with non-text output modalities (image/audio/video/embedding/
  rerank hybrids aren't chat-completions usable).
  `pricing.prompt`/`completion`/`input_cache_read`/`input_cache_write` are USD
  **per token** in scientific notation (`"5e-6"` = $5/M) — `toPerMillion()`
  converts (values ≥ 0.01 treated as already-$/M guard).
- `GET /v1/key` — key status with `data.devPlanCreditsRemaining/Limit/Used`,
  `usage`, `limit` (all strings). Drives the balance display.
- DevPass plan keys must request **root model ids** (`claude-sonnet-4-5`);
  provider-pinned ids (`anthropic/...`) are unavailable on coding plans.
- Auth env var: `LLM_GATEWAY_API_KEY` (name used in the gateway's own docs).

## Behavior notes / gotchas

- The extension factory is `async`: pi waits for it, so fetched models are
  available during interactive startup and to `pi --list-models`.
- `refreshModels` is registered on the provider config, so `pi update --models`
  (and any model refresh) re-fetches the live catalog without a restart. The
  refreshed list is not persisted — startup refetches anyway.
- No/invalid key never crashes pi: provider registers with zero models and the
  status line carries the error.
- Balance refresh: `session_start`, `turn_end` (only when the active model's
  provider is `devpass`), and `/devpass`. Failed refreshes keep the last known
  balance silently.
- Rates are display/cost-tracking only — the gateway bills, pi just meters.
