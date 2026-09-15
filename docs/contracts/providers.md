# Providers (`theorum/providers`)

Single door for constructing a `ModelProvider` bound to a profile. Credentials
and runtime endpoints are always host-supplied arguments — THEORUM does not read
environment variables and does not ship `.env` files.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/providers` / `jsr:@theorum/core/providers` |
| Module | `src/providers/mod.ts` |
| Local subpath | `theorum/providers/local` → `src/providers/local/mod.ts` |
| Also on | Root `theorum` re-exports `createProvider` |

## Ownership

Owns every module under `src/providers/`.

| Module | Role |
| --- | --- |
| `create-provider.ts` | Public factory; lazy-loads every adapter on first `complete` |
| `types.ts` | Host option bags (`OpenAiGatewayConfig`, `LocalProviderConfig`) |
| `openrouter/chat.ts` | OpenRouter chat adapter (internal; lazy-loaded) |
| `openrouter/openai/compat.ts` | Shared OpenAI REST wire format (messages, tools, headers) |
| `openrouter/openai/sdk-messages.ts` | THEORUM → AI SDK `ModelMessage[]` (OpenRouter chat) |
| `openrouter/openai/chat-payload.ts` | OpenAI chat payload + OpenRouter plugins (internal) |
| `openrouter/speech.ts` | OpenAI `/audio/speech` transport (openrouter speech role) |
| `openrouter/image.ts` | OpenAI `/images` transport; chat + server tool when `includeText` |
| `openrouter/openai/image-payload.ts` | OpenAI-compat `/images` body builder |
| `google/interactions/stream.ts` | Google Interactions streaming adapter |
| `google/interactions/framing.ts` | Interactions payload / step wiring |
| `google/interactions/mod.ts` | Interactions subpath barrel |
| `google/live/stream.ts` | Google Live WebSocket streaming adapter |
| `google/live/framing.ts` | Gemini Live WebSocket protocol framing |
| `google/live/mod.ts` | Live subpath barrel |
| `google/keys.ts` | Gemini vault transport types |
| `google/urls.ts` | Interactions API endpoint constants |
| `local/local.ts` | OpenAI-compat SSE for Ollama / llama.cpp / vLLM / LM Studio |
| `local/mod.ts` | Subpath export for direct local adapter access |
| `shared/sse.ts` | SSE line parser |
| `shared/pcm.ts` | PCM → WAV for Interactions speech output |
| `shared/tool-args.ts` | Shared tool-argument JSON parse (Result; never invents `{}` / `{ _raw }`) |
| `shared/upstream-tape.ts` / `shared/upstream-tap.ts` | Test / tap hooks (not public exports) |
| `probe.ts` | Env-gated `LOADED:<label>` writer used only by `createProvider`'s lazy loader (`THEORUM_IMPORT_PROBE=1`). Not a test backdoor; adapters must not import it. |

## Package boundary

| Rule | Detail |
| --- | --- |
| No `.env` in repo | Hosts pass credentials explicitly |
| No ambient env reads | `OLLAMA_HOST` resolved by host → `local.baseUrl` |
| No key templates | Business apps own secret storage |
| Traces | Profile `observability` + optional `runTurn` sink override; not here |
| Pairs | `PROTOCOL_PROVIDERS` / `isValidPair` in `src/kernel/schema.ts` — `createProvider` does not invent extra routes |
| Multi-model | `profile.models` map + optional `defaultModel`; adapter selection uses one binding per call |

## createProvider

```ts
const provider = createProvider(profile, {
  gemini: { vault: { slotA, slotB, slotC, paid }, fetch? },
  openAiGateway: {
    // Prefer the same KEY_SLOTS vault as Google when profiles pin models.*.key:
    vault: { slotA, slotB, slotC, paid },
    // Or a single flat key when the profile omits per-model keys:
    apiKey?,
    baseUrl?, siteUrl?, siteName?, fetch?, voice?,
  },
  local: { baseUrl?, fetch? },
}, modelId?)
```

`createProvider` reads the selected **`ModelBinding`** from `profile.models`
(`protocol` / `provider` on that binding). When a profile declares multiple
models, pass optional `modelId` (defaults to `profile.defaultModel`, or the sole
model key when only one is declared).

Legal pairs are `PROTOCOL_PROVIDERS` in `src/kernel/schema.ts` (`isValidPair`).
Routing table:

| protocol | provider | Requires | Transport |
| --- | --- | --- | --- |
| `geminiInteractions` | `google` | `options.gemini` | Interactions API (chat / image / speech) |
| `openAi` | `openrouter` | `options.openAiGateway` | Lazy chat, `speech.ts`, or `image.ts` by output role |
| `openAi` | `local` | optional `options.local` | `POST /v1/chat/completions` SSE (image roles rejected) |

Errors:

- Missing credential block → `TheorumError` naming the required option.
- Unsupported pair → `TheorumError` with protocol/provider in the message.

OpenRouter Vercel AI SDK loads **only** on first `complete` for `openAi` +
`openrouter` chat. Google and local never import it.

Media part support by transport (`InteractionPart` — see `docs/contracts/kernel.md`).
The accepted MIME vocabulary is one table for every transport
(`MEDIA_INPUT_KINDS`); no adapter keeps a second list. Google Interactions and
Live take the whole table. The OpenAI-compat adapters map every
`MediaInputKind` to a wire part and forward the MIME verbatim, so their set is
open-ended. The only per-adapter refusal is the reference part, raised as a
`TheorumError` at request time:

| Transport | Inline `InteractionMediaPart` (`data`) | Reference `InteractionMediaRefPart` (`uri`) |
| --- | --- | --- |
| Google Interactions | `{ type, mime_type, data }` | `{ type, mime_type, uri }` — Files API reference, wired by `wireInteractionPart` |
| Gemini Live (`runSession`) | `inlineData` in client-content history and realtime input | **rejected** — `TheorumError('media references are not supported on geminiLive')` |
| OpenRouter / local (`openAi`, REST payload) | `image_url` / `input_audio` / `file` data URLs | **rejected** — `TheorumError('media references are not supported on openAi')` |
| OpenRouter (`openAi`, AI SDK messages) | `image` / `file` data URLs | **rejected** — same error, including tool-result parts |

## OpenRouter

Internal adapter behind `createProvider` for `openAi` + `openrouter` chat. Hosts
use `createProvider(profile, { openAiGateway })` — there is no separate public
OpenRouter entrypoint.

`OpenAiGatewayConfig` (via `CreateProviderOptions.openAiGateway`):

| Field | Role |
| --- | --- |
| `apiKey` | Bearer credential |
| `baseUrl` | Optional API base override |
| `siteUrl` / `siteName` | Optional HTTP-Referer / X-Title style metadata |
| `fetch` | Optional custom fetch |
| `voice` | Optional fallback when `outputs.speech.voice` omitted |

Chat and speech requests use `ProviderCompleteRequest.apiId` on the wire — same
field as Google Interactions and local OpenAI-compat paths.

`toOpenAiChatPayload` maps `ProviderCompleteRequest` → OpenAI chat-completions
body (messages, tools, structured output). `reasoning.effort` is set only when
`thinking` is present and not `'none'`. When `cache.mode` is `automatic`, the
payload includes top-level `cache_control`; when `system`, the system message
content block carries `cache_control`. Optional `sessionId` becomes `session_id`.

`createOpenRouterProvider(config)` (internal) streams normalized `TurnEvent`s;
terminal `done.stop` via `turnStopFromOpenAiFinishReason`. Cache policy is applied
via AI SDK `providerOptions.openrouter` (`cacheControl` / `session_id`) — the same
`cacheControlFromSpec` / `cacheControlJson` helpers as the REST payload path
(`src/providers/openrouter/cache-control.ts`). Token events may include
`cached` / `cacheWrite` from AI SDK usage details or raw `usage` chunks
(OpenRouter image turns use the same `extractUsageTokens` parser).

## Google Interactions

`createInteractionsProvider(geminiTransport)` streams normalized `TurnEvent`s.

| Concern | Behavior |
| --- | --- |
| History | `user_input` / `model_output` steps; OpenAI-shaped `assistant.tool_calls` → `function_call` (not empty text); `tool` → `function_result` |
| Multimodal | `image` / `audio` / `video` / `document` parts, inline (`data`) or by Files API reference (`uri` → `{ type, uri, mime_type }`) |
| Structured | `responseFormat` JSON schema when enforced. When structured is requested and model text is not valid JSON, providers emit an `error` event (never silently skip). |
| Output modes | responseFormat JSON schema, image, and speech are mutually exclusive; prompt-enforced structured schemas and free text are not. Image profiles may opt into interleaved text via `image.includeText`. |
| Tools | Registry builtins (`wire.interactions`) + function schemas from `generation.tools.wire`. When `googleMaps` is enabled and `TurnRequest.googleMapsLocation` is set, Interactions receives `tools: [{ type: "google_maps", latitude, longitude }]`. |
| Code execution | Builtin `codeExecution` → `{ type: "code_execution" }`. Streamed `step.start` / `step.delta` / `step.stop`, `interaction.status_update` (`requires_action` for host tools), and batched `interaction.steps` become `evidence` (`kind`, `code`, `result`, `isError`, `raw`) plus `media` for sandbox images. Search/maps/`url_context` steps in `steps[]` are also `evidence`. Structured `responseFormat` is still attached when both are requested. |
| Stream vs batch | Default SSE (`outputs.streaming.mode: 'sse'` or omitted). `'buffered'` POSTs JSON and yields the same `TurnEvent` types from `steps[]`. |
| Thinking | `thinkingLevel` / `thinkingSummaries` are attached only when the resolved request sets `thinking` / `summaries` (omitted when unset). |
| Grounding | Classic `grounding_metadata` **and** Interactions `google_search_result` / `google_maps_result` tool payloads (`search_suggestions` chips, `result[].places[]`, `place_citation` annotations). Emits `grounding` with normalized `sources` **and** classic `chunks[].maps` (`title` / `uri` / `placeId`) plus `evidence` with the raw tool payload so hosts can decide what to surface. |
| Stop | `turnStopFromInteractionStatus` on terminal status |

## Google Live

Live profiles use **`runSession`**, not `createProvider` / `ModelProvider.complete()`.

`runSession(req, { gemini, openWebSocket? })` opens a long-lived Gemini Live
WebSocket (`BidiGenerateContent`), applies inbound text prep and the live outbound
gate (canary + egress) at each conversational `turnComplete`, and returns a
`LiveSession` (`sendAudio` / `sendVideo` / `sendText` / `executeTool` /
`sendToolResponse` / `sendToolResponses` / `events` / `close`).

Registry tools should go through **`executeTool`** so live stages (`pre_tool` /
`post_tool`), permission/auth gates, deny resume (`resume.granted: false`), and
upstream tool responses stay on the session path. `sendToolResponse(s)` remain an
escape hatch for non-registry relays that skip session stages — not for UI deny.

`createProvider` **rejects** `geminiLive` — there is no turn-scoped live `complete()` adapter.

| Concern | Behavior |
| --- | --- |
| Door | `runSession` (shares resolve / tools / canary / system compose with `runTurn`) |
| Transport | `openGoogleLiveSession` — WebSocket; optional `openWebSocket` for Cloudflare fetch-upgrade |
| Handshake | `BidiGenerateContentSetup` via `buildGeminiLiveSetupMessage` |
| Turn boundary | Gemini `turnComplete` → outbound gate finalize + cycle `done` (`stop.kind: 'completed'` when no folded done) + `before_end` / `post_turn`; **session stays open** |
| Generation boundary | Gemini `generationComplete` → `done` (`stop.kind: 'generation_complete'`) without tearing down the session |
| Tools | Prefer `executeTool` (stages + gate/deny resume + upstream). Escape hatch: host replies via `sendToolResponse(s)` for non-registry pre-fail only; cancellations → `tool.phase: 'cancel'`. Every id in profile `tools.allow` + `builtInTools` is wired in `BidiGenerateContentSetup` regardless of `loadTier` (declarations cannot change mid-session) — no `t1Policy` / `t2Loader`, no structured output, no turn `inputs` / `outputs`. |
| Ingress | `live.ingress` gates `sendAudio` / `sendVideo` / `sendText`. Defaults: audio **on**, camera (video channel) **on**, text **off** unless `live.ingress.text: true`. At least one channel must stay enabled. |
| Transcription | Mid-turn `evidence` with `kind: 'input_transcription'` / `output_transcription` (optional `interim`); **not** held for egress — streams immediately |
| Session control | `goAway` → `session.kind: 'closing_soon'`; `waitingForInput` → `waiting_for_input` |
| Resumption | `sessionResumptionHandle` on `SessionRequest`; updates as `evidence.kind: 'session_resumption'` with `resumable` |
| Remote registry | `SessionRequest.snapshot` (a `TurnToolSnapshot` from `prepareTurnToolSnapshot` in the registry-owning process) supplies the setup declarations when the session runs where the registry is not registered; ids outside `tools.allow` are refused |
| Media references | Client-content history and realtime input reject `InteractionMediaRefPart` (`TheorumError`) until provider support is verified |

### Live fold → `TurnEvent` (exhaustive)

| Gemini signal | TurnEvent |
| --- | --- |
| `inputTranscription` | `evidence` + `kind: 'input_transcription'` |
| `interimInputTranscription` | same + `evidence.interim: true` |
| `outputTranscription` | `evidence` + `kind: 'output_transcription'` |
| `toolCall.functionCalls` | `tool` |
| `toolCallCancellation.ids` | `tool` + `phase: 'cancel'` |
| `goAway` | `session` + `kind: 'closing_soon'` |
| `waitingForInput` | `session` + `kind: 'waiting_for_input'` |
| `generationComplete` | `done` + `stop.kind: 'generation_complete'` |
| `interrupted` | `done` + `interrupted` + `stop.kind: 'interrupted'` |
| `sessionResumptionUpdate` | `evidence` + `kind: 'session_resumption'` |
| `groundingMetadata` | `grounding` |
| `usageMetadata` | `tokens` |
| `setupComplete` | handshake only (not a TurnEvent) |
| `turnComplete` | stream phase → `runSession` emits `done` + `completed` |

Framing helpers remain in `google/live/framing.ts` for hosts that only need setup JSON.

## Local provider

Import `theorum/providers/local` for `createLocalProvider` /
`DEFAULT_LOCAL_BASE_URL` (`http://127.0.0.1:11434`). Hosts resolve `OLLAMA_HOST`
(or similar) themselves and pass `baseUrl` here — THEORUM does not read
environment variables for local endpoints. The `local/local.ts` module header
points at this contract (`docs/contracts/providers.md`).

```ts
local: {
  baseUrl: "http://127.0.0.1:11434", // no trailing slash
  fetch: customFetch,
}
```

- Raw `fetch` + `sse.ts` — no SDK.
- Accumulates streaming tool calls; maps `finish_reason` through
  `turnStopFromOpenAiFinishReason`.
- Supports multimodal user content when the server accepts OpenAI-style parts;
  media reference parts (`uri`) are rejected with `TheorumError`.

## Image roles

When `profile.type === 'image'` and protocol/provider is
`openAi`/`openrouter`, `createProvider` returns `createImageProvider`
(`openrouter/image.ts`). When protocol/provider is `geminiInteractions`/`google`,
the same `createInteractionsProvider` handles image via polymorphic
`responseFormat`.

| Transport | Module | Path / mechanism | Notes |
| --- | --- | --- | --- |
| OpenAI | `openrouter/image.ts` | `POST /images` | Native image models; reference images via `input_references` |
| OpenAI | `openrouter/image.ts` | `POST /chat/completions` + server tool | When `image.includeText`; yields interleaved `text` + `media` |
| Interactions | `google/interactions/framing.ts` | `responseFormat` object or array | Image-only object; text + image array when `includeText` |

`openAi`/`local` image roles are rejected at `createProvider`.

## Speech roles

When `profile.type === 'speech'` and protocol/provider is
`openAi`/`openrouter`, `createProvider` returns `createSpeechProvider`
(`openrouter/speech.ts` — OpenAI `/audio/speech`). When protocol/provider is
`geminiInteractions`/`google`, the same `createInteractionsProvider`
(`google/interactions/mod.ts`) handles speech via `responseFormat: audio` +
`speechConfig`.

| Transport | Module | Path / mechanism | Notes |
| --- | --- | --- | --- |
| OpenAI | `openrouter/speech.ts` | `/audio/speech` | `mp3` allowed via `response_format` |
| Interactions | `google/interactions/mod.ts` | `responseFormat: { type: 'audio' }` | Real PCM → WAV only. Missing audio on a speech-role turn (text-only or empty) yields an `error` event — never invents PCM from text bytes. `mp3` rejected at resolve. |

Speech-role turns (`req.speech`) must receive real audio media from the model.
Missing audio — whether the model returned text only or nothing at all — yields
an `error` event. The adapter never casts text bytes into a fake WAV/PCM
container.

Tool-call argument strings that are not valid JSON objects fail the same way on
every transport (Interactions, Live, local, OpenRouter history→SDK): a `tool`
event with `phase: 'error'` / `failure.code: 'malformed_arguments'`, or a thrown
`TheorumError` when rebuilding history for the AI SDK. Nothing invents `{}` or
`{ _raw }` to paper over bad JSON.

## Key vault (provider-neutral)

`KEY_SLOTS` = `slotA` | `slotB` | `slotC` | `paid`. Profiles pin `models.*.key`
(or profile-level `key`) to an overflow slot (`OVERFLOW_KEY_SLOTS` = A/B/C).
Resolve puts the chosen id on `ResolvedGeneration.keySlot` /
`ProviderCompleteRequest.keySlot`.

| Host option | How credentials are chosen |
| --- | --- |
| `gemini.vault` | Required for Google. Adapter reads `vault[keySlot]`. |
| `openAiGateway.vault` | Optional. Used when `keySlot` is set (profile pinned a key or a builtin forced `paid`). |
| `openAiGateway.apiKey` | Flat fallback when `keySlot` is omitted. |

## Gemini transport

```ts
createProvider(profile, {
  gemini: { vault: { slotA, slotB, slotC, paid } },
})
```

| Piece | Role |
| --- | --- |
| `GeminiTransport` | Google vault + optional `fetch` |
| `KeyVault` | `Record<KeySlot, string \| undefined>` shared with OpenRouter |
| Slots | `slotA`, `slotB`, `slotC`, `paid` |
| Selection | `models.*.key` / `ModelBinding.key` / `builtInTools` (`forcePaidKey`) |

Overflow to `paid` is host policy, not inferred here.

## Exported API

From `src/providers/mod.ts`:

| Export | Kind |
| --- | --- |
| `createProvider` | function |
| `CreateProviderOptions` | type |
| `GeminiTransport`, `KeyVault` | types |
| `LocalProviderConfig`, `OpenAiGatewayConfig` | types |

From `src/providers/local/mod.ts` (`theorum/providers/local`):

| Export | Kind |
| --- | --- |
| `createLocalProvider` | function |
| `DEFAULT_LOCAL_BASE_URL` | const |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Package boundary": {
      "supports": [
        { "kind": "source", "path": "src/providers/create-provider.ts" },
        { "kind": "contract_test", "path": "tests/providers/create-provider.test.ts" }
      ]
    },
    "createProvider": {
      "supports": [
        { "kind": "source", "path": "src/providers/create-provider.ts" },
        { "kind": "contract_test", "path": "tests/providers/create-provider.test.ts" }
      ]
    },
    "OpenRouter": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter/chat.ts" },
        { "kind": "source", "path": "src/providers/openrouter/openai/chat-payload.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/chat.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/openai/chat-payload.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/openai/compat.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/openai/sdk-messages.test.ts" }
      ]
    },
    "Google Interactions": {
      "supports": [
        { "kind": "source", "path": "src/providers/google/interactions/stream.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/framing.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/mod.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/interactions/framing.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/interactions/stream.test.ts" }
      ]
    },
    "Google Live": {
      "supports": [
        { "kind": "source", "path": "src/providers/google/live/stream.ts" },
        { "kind": "source", "path": "src/providers/google/live/framing.ts" },
        { "kind": "source", "path": "src/providers/google/live/mod.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/live/framing.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/live/stream.test.ts" }
      ]
    },
    "Local provider": {
      "supports": [
        { "kind": "source", "path": "src/providers/local/local.ts" },
        { "kind": "source", "path": "src/providers/local/mod.ts" },
        { "kind": "contract_test", "path": "tests/providers/local/local.test.ts" }
      ]
    },
    "Speech roles": {
      "supports": [
        { "kind": "source", "path": "src/providers/openrouter/speech.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/stream.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/framing.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/speech.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/interactions/speech.test.ts" }
      ]
    },
    "Gemini transport": {
      "supports": [
        { "kind": "source", "path": "src/providers/google/keys.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/keys.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "contract_test", "path": "tests/providers/create-provider.test.ts" }
      ]
    }
  }
}
```
