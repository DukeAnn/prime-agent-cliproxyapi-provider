# pi-cliproxyapi-provider

Pi provider extension that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and registers them for use in pi. It supports catalog-driven OpenAI Fast mode and also ships a small TUI helper that shows elapsed runtime and a TPS summary after each agent turn.

## What it does

1. Registers a provider that always appears in `/login` (account sign-in path).
2. Interactive setup collects `baseUrl` + `apiKey` via `/login CLIProxyAPI` or `/login cliproxyapi`.
3. Fetches `{root}/v1/models?client_version=pi`.
4. Maps the CLIProxyAPI catalog into pi models, including Fast service-tier capability.
5. Routes each request to the protocol that matches the model family (`transportMode`, default `auto`): GPT and Grok use `{root}/v1`, Claude uses `{root}`, Gemini uses `{root}/v1beta`, and everything else stays on the Codex transport `{root}/backend-api/`.
6. Provides `/fast` to toggle OpenAI priority processing for supported models (`/cliproxyapi-fast` on hosts that already own `/fast`).
7. Caches the model catalog in `~/.pi/agent/cliproxyapi-models.json`, refreshes it in the background on startup, and provides `/cliproxyapi-refresh` to force a refresh.
8. In interactive TUI sessions, shows footer elapsed time during runs and a TPS / token usage toast when the agent settles.
9. After compaction, closes the reused Codex WebSocket for that session so CLIProxyAPI's server-side context resets with the compacted client messages.

## Install

```bash
# from npm
pi install npm:@router-for-me/pi-cliproxyapi-provider

# from a local checkout
pi install /absolute/path/to/pi-cliproxyapi-provider

# or temporarily for one run
pi -e /absolute/path/to/pi-cliproxyapi-provider
```

## Login-style setup (recommended)

This plugin needs both **baseUrl** and **apiKey**. pi's built-in `/login` only supports multi-field prompts on the account/OAuth path, so CLIProxyAPI appears under **Sign in with an account** (not API key).

### Preferred: /login shortcuts

```text
/login CLIProxyAPI
```

or:

```text
/login cliproxyapi
```

These shortcuts jump straight into CLIProxyAPI's multi-field baseUrl + API key prompts. The provider is registered as OAuth-only, so pi does not ask you to choose between API key and account first.

### Menu path

```text
/login
```

Then choose:

1. **Sign in with an account**
   (required for multi-field baseUrl + API key prompts)
2. **CLIProxyAPI**
3. Enter:
   - base URL — preferred form is host:port, e.g. `http://127.0.0.1:8317`
   - API key

Final login validation calls `{root}/v1/models?client_version=pi` (this always bypasses the model cache and forces a fresh remote query):

- **HTTP 200** → login succeeds (empty model list is still OK) and the model cache is rewritten
- **non-200 / network error** → login fails and you are prompted to re-enter base URL + API key

On success:

- models are registered immediately in the current session (0 models is allowed)
- `baseUrl` / `apiKey` are written to `~/.pi/agent/cliproxyapi.json`
- pi also stores the returned credential in `~/.pi/agent/auth.json`

Re-run `/login CLIProxyAPI` or `/login cliproxyapi` anytime to reconfigure. The built-in `/logout` command only removes credentials saved in `auth.json`; it does not erase `cliproxyapi.json`. Remove or update that file if you also need to clear the provider configuration.

## Non-interactive configuration

You can still configure without `/login`.

### Config file

`~/.pi/agent/cliproxyapi.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "apiKey": "12345",
  "fast": false,
  "pause": false,
  "transportMode": "auto"
}
```

Optional fields:

| Field | Default | Description |
| ------- | --------- | ------------- |
| `baseUrl` | `http://127.0.0.1:8317` | CLIProxyAPI address |
| `apiKey` | _(required unless set via /login or env)_ | Bearer token / CPA API key |
| `providerId` | `cliproxyapi` | Provider id shown in `/model` |
| `providerName` | `CLIProxyAPI` | Display name in `/login` and UI |
| `fast` | `false` | Persisted Fast mode preference; only applies to catalog-supported models |
| `pause` | `false` | Persisted request-pause preference; provider requests wait until it is cleared |
| `transportMode` | `auto` | Protocol routing: `auto`, `native` or `codex`. See [Protocol routing](#protocol-routing-transportmode) |

### Environment overrides

| Variable | Overrides |
| ---------- | ----------- |
| `CLIPROXYAPI_BASE_URL` | `baseUrl` |
| `CLIPROXYAPI_API_KEY` | `apiKey` |
| `CLIPROXYAPI_PROVIDER_ID` | `providerId` |
| `CLIPROXYAPI_PROVIDER_NAME` | `providerName` |
| `CLIPROXYAPI_FAST` | `fast` (`true` / `false`, also accepts `1`, `0`, `yes`, `no`, `on`, `off`) |
| `CLIPROXYAPI_TRANSPORT_MODE` | `transportMode` (`auto` / `native` / `codex`) |
| `CLIPROXYAPI_DEBUG` | Opt-in debug logging (`true` / `false`, same boolean forms as `CLIPROXYAPI_FAST`) |

Two more variables only affect the Codex transport and are documented in [Codex transport](#codex-transport-cliproxyapi_transport):

| Variable | Purpose |
| ---------- | --------- |
| `CLIPROXYAPI_TRANSPORT` | Codex wire transport: `auto`, `websocket` or `sse` |
| `CLIPROXYAPI_WS_IDLE_TTL_MS` | Idle lifetime of a cached Codex WebSocket session |

Resolution order for connection settings:

1. Environment variables
2. `cliproxyapi.json`
3. `/login` credentials in `auth.json`
4. Default baseUrl `http://127.0.0.1:8317`

The Fast preference resolves separately as `CLIPROXYAPI_FAST` → `cliproxyapi.json` → `false`.

### baseUrl normalization

Preferred form is **host:port only**:

| Input | Inference baseUrl | Models URL |
| ------- | ------------------- | ------------ |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=pi` |
| `http://127.0.0.1:8317/backend-api` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `http://127.0.0.1:8317/v1` | `http://127.0.0.1:8317/backend-api/` | same models URL |
| `127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | same models URL |

With `transportMode: "codex"` pi then sends inference traffic to `{inference}/codex/responses`. In `auto` (default) and `native` modes, GPT/Grok/Claude/Gemini models instead use the native endpoint of their family; see [Protocol routing](#protocol-routing-transportmode).

## Fast mode

OpenAI Fast mode requests the priority service tier. It can reduce latency for supported models, but consumes more OpenAI/Codex credits or incurs priority-processing pricing.

Fast is **off by default**. Toggle the global preference with:

```text
/fast
```

On hosts that already provide a `/fast` command (for example Prime Agent), the provider registers `/cliproxyapi-fast` instead. Fast injection works for both Codex-routed and natively routed models.

Each invocation switches Fast between on and off and writes the result to `~/.pi/agent/cliproxyapi.json`. On the next startup, a persisted `true` value immediately enables Fast for catalog-supported models. Fast remains ineffective for unsupported models, so their requests are left unchanged. If `CLIPROXYAPI_FAST` is set, that environment variable still takes precedence on startup.

When Fast is effective, pi's model status appends a yellow lowercase `fast`, for example `gpt-5.6-sol • xhigh • fast`. When Fast is off or the selected model is unsupported, the original model status remains unchanged. Supported models do not produce a separate status notification. Running `/fast` with an unsupported model still updates the global preference; enabling it warns that the current model cannot use Fast.

Fast capability is catalog-driven: the plugin considers a CLIProxyAPI model Fast-capable when its `service_tiers` field is a non-empty array. The `additional_speed_tiers` field is ignored. For supported models, Fast injects `service_tier: "priority"`; unsupported models are left unchanged. Fast is independent from pi's reasoning/thinking level. When `models.dev` provides `experimental.modes.fast.cost`, the registered model cost switches to those Fast rates as well; the provider is refreshed when `/fast` is toggled. If no Fast price is published, the standard price is retained. The plugin does not guess Fast prices from `-pro`/`-fast` model IDs.

## Protocol routing (transportMode)

CLIProxyAPI exposes one native endpoint per model family. `transportMode` selects which protocol this plugin uses for each model. The model id is always sent unchanged; a route prefix such as `relay-apikeyfun/claude-sonnet-5` is only used to detect the family.

| Mode | GPT `gpt-*` | Grok `grok-*` | Claude `claude-*`, `*/claude-*` | Gemini `gemini-*` | Other ids |
| ------ | ------------- | --------------- | --------------------------------- | ------------------- | ----------- |
| `auto` (default) | `openai-responses` → `{root}/v1` | `openai-responses` → `{root}/v1` | `anthropic-messages` → `{root}` | `google-generative-ai` → `{root}/v1beta` | Codex → `{root}/backend-api/` |
| `native` | same as `auto` | same as `auto` | same as `auto` | same as `auto` | `openai-completions` → `{root}/v1` |
| `codex` | Codex → `{root}/backend-api/` | Codex | Codex | Codex | Codex |

Details:

- Every registered model keeps the custom api id `cliproxyapi-codex-responses`, so Fast, `/pause`, retry normalization and proactive compaction stay active for native routes as well. The provider picks the real protocol per request and hands native routes to pi's built-in adapter.
- Claude routes are registered with `compat.supportsEagerToolInputStreaming = false`, because CLIProxyAPI does not accept per-tool `eager_input_streaming`.
- `auto` keeps unknown model ids on the Codex transport. Use `native` only when the proxy serves every model over an OpenAI-compatible endpoint.
- If the host does not expose the pi-ai stream dispatcher, native routes fall back to the Codex transport and a warning is logged.

### Rollback

Set the mode back to the previous behavior at any time:

```json
{ "transportMode": "codex" }
```

or

```bash
export CLIPROXYAPI_TRANSPORT_MODE=codex
```

`codex` reproduces the pre-routing behavior exactly: every model uses the patched Codex responses transport at `{root}/backend-api/`.

## Codex transport (CLIPROXYAPI_TRANSPORT)

`CLIPROXYAPI_TRANSPORT` is **not** related to `transportMode`. It only selects the wire transport **inside** the Codex protocol:

| Value | Behavior |
| ------- | ---------- |
| `auto` (default) | Try the persistent WebSocket, fall back to SSE when the connection cannot be started |
| `websocket` | Force the WebSocket transport |
| `sse` | Force plain SSE |

A failed WebSocket connection is retried a finite number of times (up to `maxRetries`, capped at 5). If the stream has not started yet, the request falls back to SSE and records a transport diagnostic; once events have been emitted the error is raised instead of silently restarting. `CLIPROXYAPI_WS_IDLE_TTL_MS` overrides the idle lifetime of a cached WebSocket session (default 30 minutes).

Summary: `transportMode` picks the **protocol and endpoint**; `CLIPROXYAPI_TRANSPORT` picks **websocket or SSE** inside the Codex protocol.

## Debug logging

Set `CLIPROXYAPI_DEBUG=true` to print one line per routing decision and per request:

- selected model, family, api id and `transportMode`
- context tool count and tool names for Codex requests
- outbound payload tool count and tool names
- response HTTP status

The log never contains API keys, credentials, prompt text, tool arguments or request/response bodies. Debug logging is off by default.

### Tool retention guard

When a context declares tools but the outbound Codex payload contains none, the request is rejected with an explicit error instead of being sent. A tool-less request looks successful and then ends the turn after one message, which is much harder to diagnose.

## Prime Agent hosts

The extension also runs inside Prime Agent hosts, which differ from Pi in a few ways:

- Host detection uses two signals: a non-empty `PRIME_AGENT_CODING_AGENT_DIR`, or a resolved agent directory that ends with `.prime/agent`. A default Prime run does not always export the env var.
- A non-empty `PRIME_AGENT_CODING_AGENT_DIR` is used as the agent directory, so `cliproxyapi.json`, `auth.json` and the model cache are read from the Prime agent directory.
- Prime Agent already owns `/fast`, so the provider registers `/cliproxyapi-fast` instead. `/pause`, `/continue` and `/cliproxyapi-refresh` keep their names.
- The `@earendil-works/pi-ai/compat` subpath does not exist on Prime Agent 0.9.5, so the compat api registration is skipped there. The provider stream chain is unaffected.
- The credential in `auth.json` is parsed directly instead of importing the host `readStoredCredential` helper.
- `~/.prime/agent/npm` is probed when the Codex protocol module is resolved.

## Pausing provider requests

Pause provider requests with:

```text
/pause
```

Use `/continue` to clear the pause:

```text
/continue
```

Both commands persist the `pause` boolean in `~/.pi/agent/cliproxyapi.json`. Before every provider request, the extension rereads this setting. When it is `true`, the request waits asynchronously and checks again every 200 ms until `/continue` sets it to `false`. A pause issued during an active run lets that run finish before Elapsed stops; a run that starts while paused excludes its waiting time from Elapsed and TPS.

## Model cache

The provider keeps a separate cache file so startup stays fast when CLIProxyAPI is slow or briefly unreachable:

`~/.pi/agent/cliproxyapi-models.json`

The cache stores only model metadata and derived endpoint URLs — the model list, Fast-capable IDs, `inferenceBaseUrl`, `modelsUrl`, the `transportMode` it was mapped for, and a `fetchedAt` timestamp. It **never** stores your API key or other credentials. A cache written for a different `transportMode` is discarded and refetched.

| Property | Value |
|----------|-------|
| Cache file | `~/.pi/agent/cliproxyapi-models.json` |
| Remote query timeout | 60 seconds |
| Scope | tied to the current `baseUrl` and `transportMode` (a different base URL or mode ignores the existing cache) |

### Startup / resume behavior

When the provider loads (including session resume):

1. If a cache exists for the configured `baseUrl`, its models are registered immediately. A remote query to `{root}/v1/models?client_version=pi` then runs in the background; on success, the cache is rewritten and the registered model list is refreshed. If the query fails, the existing cache remains active.
2. If no matching cache exists, the remote query runs synchronously. On success, the cache is written and the fetched models are registered. If it fails, startup logs a warning and no models are registered until the proxy responds.

Use `/cliproxyapi-refresh` to force an immediate remote refresh of the model catalog.

### Refresh commands

- `/cliproxyapi-refresh` — force an immediate remote refresh of the model catalog, rewrite the cache, and update registered models. Use this after adding or removing models on the proxy without restarting pi.
- `/login CLIProxyAPI` / `/login cliproxyapi` — re-entering credentials always forces a fresh models query and rewrites the cache.

Delete `~/.pi/agent/cliproxyapi-models.json` to clear the cache manually.

## Model mapping

From CPA catalog entry → pi model:

| CPA field | Pi field |
| ----------- | ---------- |
| `slug` | `id` |
| `display_name` | `name` |
| `context_window` | `contextWindow` |
| `input_modalities` | `input` (`text` / `image`) |
| `supported_reasoning_levels[].effort` | `thinkingLevelMap` + `reasoning` |
| `visibility: "hide"` | skipped |

Unsupported pi thinking levels are set to `null` so they are hidden in the UI. When available, prices are matched against canonical model entries in `models.dev`; `cost.tiers[].tier.size` becomes pi's `inputTokensAbove`, including thresholds such as `272000`. The legacy `context_over_200k` field is used only when no explicit tiers are present. Ambiguous reseller prices are not selected arbitrarily and fall back to zero. These are catalog/list prices, not a guarantee of CPA's own markup or billing.

The raw `models.dev` response is cached for 24 hours at `~/.pi/agent/tmp/models-dev-cache.json`. A fresh cache avoids the network request; an expired cache is refreshed with a three-second timeout, and stale data is retained if refresh fails. If neither the network nor a previous cache is available, pricing safely falls back to zero. A small explicit alias table covers known CLIProxyAPI variants such as `gemini-pro-agent` → `gemini-3.1-pro-preview`; unknown variants are not guessed.

## Migration from static models.json

If you previously maintained a static provider such as `cpa-responses` in `~/.pi/agent/models.json`:

1. Install this package and run `/login CLIProxyAPI` or `/login cliproxyapi` (or set `cliproxyapi.json`).
2. Point `defaultProvider` / `enabledModels` at `cliproxyapi/<model-id>` (or set `providerId` to `cpa-responses` for a drop-in id).
3. Remove the hand-maintained models array once the dynamic list looks correct.

## Elapsed time and TPS (TUI)

The package also registers `extensions/tps.ts`, which only activates for the primary interactive TUI session (`ctx.hasUI && ctx.mode === "tui"`):

- While the agent is running, the footer shows `Elapsed …` (updates every second).
- When the agent settles, the footer keeps the final elapsed time and a notification reports approximate TPS plus token usage (`out` / `in` / cache r/w / total).
- Subagent and print-mode sessions do not own the timer, clear the parent footer, or emit TPS toasts.

Disable just this helper via `pi config` if you only want the CLIProxyAPI provider.

## Failure behavior

- CLIProxyAPI `closed network connection` responses are normalized as transient network errors so pi's agent-level retry policy reconnects and restarts the interrupted assistant turn. Completed conversation and tool results remain available; token streaming does not resume from the exact interruption point.
- Before setup / without credentials: provider still appears in `/login`; no models are listed yet.
- After successful `/login`: models are registered; credentials are stored in `auth.json` and mirrored to `cliproxyapi.json`.
- The built-in `/logout` command removes only the matching `auth.json` credential; environment variables and `cliproxyapi.json` are unchanged.
- If a models request returns **HTTP 401** or CPA is unreachable during startup, an existing matching cache remains in use while the background refresh fails. Only when no cache is available is a warning logged; reconfigure via `/login CLIProxyAPI` or fix config/env.
- Login final step validates credentials by requesting models:
  - HTTP 200 (including empty catalog) → credentials are persisted
  - non-200 / network / invalid baseUrl → nothing is persisted; re-enter baseUrl + API key
- If CPA returns HTTP 200 with a reduced or empty catalog: matching cached models remain available for seven days from when they first disappear. Missing models are marked stale, and the provider refreshes the catalog in the background. Models that return have their stale flag cleared. Retention never mixes caches from different transport modes.
- If the selected model does not provide a non-empty `service_tiers` array: the request is left unchanged; `/fast` still updates the global preference and warns when enabling it.
- After `/compact`, threshold compaction, or overflow recovery, the provider closes the reused Codex WebSocket for the current session. CLIProxyAPI binds server-side context to the connection, so a reused socket would keep reporting a near-full `cacheRead` and retrigger proactive compaction even though the client context is now small. SSE is unaffected because it bills from the request body.
