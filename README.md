# pi-devpass-provider

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that registers a `devpass` model provider backed by [LLM Gateway](https://llmgateway.io) and the [DevPass](https://devpass.llmgateway.io) coding plan.

- Models and $/M rates are fetched live from the gateway at startup, with a 24 h on-disk cache and stale fallback when offline
- DevPass credit balance shows in the status line as `devpass balance $<balance>` while a `devpass/*` model is active
- `/devpass` prints the full key status, loaded-model count, and premium credit usage

## Install

```sh
pi install npm:pi-devpass-provider
```

Or from a local checkout:

```sh
pi install /abs/path/to/pi-devpass-provider
```

## Setup

1. Get a DevPass plan key (`llmgtwy_...`) from <https://devpass.llmgateway.io>.
2. Make it available to pi, either by running `/login devpass` inside pi and pasting the key (stored in `~/.pi/agent/auth.json`), or by exporting it:

```sh
export LLM_GATEWAY_API_KEY=llmgtwy_...
```

A saved `/login` credential takes precedence over the environment variable.

## Usage

- `/model`: pick a `devpass/*` model. DevPass plan keys use root model ids (`claude-sonnet-4-5`); provider-pinned ids (`anthropic/...`) are unavailable on coding plans.
- `/devpass`: show the credit balance and key status at any time.

## Configuration

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_API_KEY` | DevPass plan key, used when no `/login devpass` credential is saved |
| `LLM_GATEWAY_BASE_URL` | Override the gateway base URL (default `https://api.llmgateway.io/v1`), e.g. for a self-hosted gateway or proxy |

## Notes

- The model catalog is cached at `~/.pi/agent/cache/devpass-models-*.json` (24 h TTL, keyed per base URL). `/v1/models` is public, so models load even without a key; requests and the balance display still need one.
- Rates shown by pi are for display and cost tracking only; the gateway meters and bills your actual usage.
- A missing or invalid key never crashes pi: the provider registers with zero models and the status line carries the error.

## Development

```sh
npm install
npm run check   # tsc --noEmit + selfcheck asserts
```

Try it live with `pi -e .`, then `/login devpass` and `/model`.

## License

[MIT](./LICENSE)
