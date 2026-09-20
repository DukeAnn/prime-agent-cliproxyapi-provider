# Prime compatibility contract

Use this checklist while reviewing upstream diffs and resolving merge conflicts. Search by symbol because line numbers move.

## Required behavior

### Tool and prompt retention

- Preserve classic-to-transcript and transcript-to-classic adaptation where required by the loaded `pi-ai` version.
- Preserve top-level `context.tools` and `context.systemPrompt` when the Codex adapter expects transcript system messages.
- Preserve `adaptContextForModule`, `ensureTranscriptContext`, `supportsTranscriptSource`, `assertOutboundToolsRetained`, and `withCodexToolGuard`, or replace them with proven equivalent behavior.
- Refuse to send a Codex request when input tools exist but the outbound payload has lost all tools.
- Never replace structured tools with prompt text.

### Protocol routing

- Preserve `transportMode: auto | native | codex` and `CLIPROXYAPI_TRANSPORT_MODE`.
- GPT and Grok native routes use OpenAI Responses under `{root}/v1`.
- Claude native routes use Anthropic Messages under `{root}`.
- Gemini native routes use Google Generative AI under `{root}/v1beta`.
- `auto` sends unknown model families to Codex.
- `native` sends unknown model families to OpenAI Completions.
- `codex` sends every model to `{root}/backend-api/`.
- Keep model IDs unchanged. Prefixes classify routes only.
- Native dispatcher failure may fall back to Codex, but Fast and tool retention must remain.

### Prime 0.9.5 host compatibility

- Detect Prime from either a non-empty `PRIME_AGENT_CODING_AGENT_DIR` or a resolved agent dir ending in `.prime/agent`.
- Compute `primeHost` once and pass the stable result to command naming, native stream loading, debug metadata, and compat registration.
- Register `/cliproxyapi-fast` on Prime and `/fast` only on Pi.
- Skip `@earendil-works/pi-ai/compat` on Prime 0.9.5.
- Keep the package manifest key named `pi`, not `prime`.
- Parse the stored credential locally when the host does not export `readStoredCredential`.

### Installation model

- The formal package source is the local pinned clone under `~/.prime/agent/git/github.com/DukeAnn/prime-agent-cliproxyapi-provider`.
- Prime's production Git installer omits the peer/dev modules this compatibility version needs. Run `npm ci` after every installed checkout.
- Do not reactivate `~/.prime/agent/extensions/cliproxyapi-provider-compat.ts`; the provider now handles Prime command naming itself.
- Do not remove the old local package or global npm package until the user explicitly retires the rollback path.

### Fast, retry, and lifecycle

- Decide Fast from the actual request model inside the route that is executed, not from a session-selected `ctx.model`.
- Preserve caller `onPayload` hooks.
- Preserve Fast when a native-family request degrades to Codex.
- Keep WebSocket retry finite and fall back to SSE only under the defined pre-response failure conditions.
- Close retained WebSocket sessions during shutdown and compaction where applicable.
- Keep pause, continue, refresh, model cache, TPS, proactive compaction, and retry behavior.

### URL and logging safety

- Accept only valid HTTP or HTTPS roots with a hostname.
- Do not log the base URL because it may contain userinfo or query tokens.
- Do not log API keys, credentials, prompts, tool arguments, request bodies, response bodies, or authorization headers.
- Preserve intentional suffix normalization for `/v1`, `/v1beta`, and `/backend-api`; call out its proxy-root ambiguity as a non-blocking risk.

## Required automated coverage

At minimum retain meaningful tests for:

- classic/transcript context adaptation
- outbound tool-retention failure
- native family routing and Codex rollback
- invalid root URLs
- env-absent `~/.prime/agent` detection and `.pi/agent` control
- Prime `/cliproxyapi-fast` and Pi `/fast`
- OAuth `auth.json` reading
- cache separation by transport mode
- Fast payload composition and degraded fallback
- bounded WebSocket retry and SSE fallback

Do not require an exact historical test count after an upstream merge. Require every repository test to pass and explain any removed test.

## Live acceptance matrix

For routing changes, require actual tool execution for representative models:

| Family | Representative model | Expected native endpoint |
|---|---|---|
| GPT | `cliproxyapi/gpt-5.5` | `/v1/responses` |
| Astra | `cliproxyapi/gpt-6-astra` | `/v1/responses` |
| Claude | `cliproxyapi/claude-fable-5-1` | `/v1/messages` |
| Gemini | `cliproxyapi/gemini-3.8-flash-high` | `/v1beta/...:streamGenerateContent` |
| Grok | `cliproxyapi/grok-4.6` | `/v1/responses` |

Also validate `cliproxyapi/gpt-5.6-sol` in `auto`, forced Codex SSE, and forced Codex WebSocket when those paths changed.

## Initial rollback anchor

The first known-good compatibility commit is:

```text
c30882fea3892ee3f3e4b79f077b097236d7b282
```

Prefer the immediately previous verified installed commit for future rollbacks; do not keep treating this initial anchor as the newest stable version after later successful activations.
