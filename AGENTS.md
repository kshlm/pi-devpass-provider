# AGENTS.md — pi-devpass-provider

pi extension package that registers a **`devpass` model provider** backed by LLM
Gateway, following https://llmgateway.io/guides/pi. Models and $/M rates are
auto-fetched at startup; the DevPass credit balance (and loaded-model count) is
shown as `devpass balance $<balance>` in the status line only while a
`devpass/*` model is active, and via `/devpass`.

## Layout

- `index.ts` — the entire extension: provider registration, live model/rate fetch,
  balance status line, `/devpass` command. Pure helpers are exported for tests.
- `selfcheck.ts` — assert-based checks for the pure helpers.
- No build step: pi loads `index.ts` (TypeScript) directly via the `pi.extensions`
  manifest in `package.json`.

## Commands

- `npm install`
- `npm run check` — `tsc --noEmit` + selfcheck asserts
- Live test: `pi -e .` then `/login devpass` (paste `llmgtwy_...` key; stored in
  `~/.pi/agent/auth.json`) — or set `LLM_GATEWAY_API_KEY` and skip /login.
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
- Auth: `/login devpass` stores the key as OAuth-style credentials in
  `~/.pi/agent/auth.json` (static key — `refreshToken` is identity, `expires`
  parked 10y out). pi resolves auth.json before env var, so a saved token wins
  over `LLM_GATEWAY_API_KEY` (name used in the gateway's own docs).
- The extension's own fetches (balance, catalog) mirror that precedence:
  auth.json entry → env var, re-read per call so mid-session `/login` works.
- Base URL override: `LLM_GATEWAY_BASE_URL` (default `https://api.llmgateway.io/v1`),
  e.g. for a self-hosted gateway or proxy. Applies to requests, catalog fetch,
  and balance alike — unlike a `models.json` baseUrl override, which only
  redirects streaming requests. Cache files are keyed per base URL.

## Behavior notes / gotchas

- The extension factory is `async`: pi waits for it, so fetched models are
  available during interactive startup and to `pi --list-models`.
- `refreshModels` is registered on the provider config, so `pi update --models`
  (and any model refresh) re-fetches the live catalog without a restart and
  rewrites the cache file.
- No/invalid key never crashes pi: provider registers with zero models and the
  status line carries the error (only while a `devpass` model is active).
- Status line (`devpass balance $<balance>`) is shown only while the active
  model is `devpass/*`. Cleared on `model_select` away from this provider.
- Balance refresh: `session_start` / `model_select` (when active model is
  `devpass`), `turn_end` (assistant message from this provider), and `/devpass`.
  Failed refreshes keep the last known balance silently. `/devpass` still
  notifies the full key dump even when another provider is active.
- Rates are display/cost-tracking only — the gateway bills, pi just meters.
- Catalog cache: `~/.pi/agent/cache/devpass-models.json`, 24h TTL. Fresh cache
  serves startup with no network; fetch failure falls back to stale cache;
  successful fetches and refreshes rewrite it. `/v1/models` is public, so the
  catalog loads even without `LLM_GATEWAY_API_KEY` (status line warns; requests
  still need the key).
