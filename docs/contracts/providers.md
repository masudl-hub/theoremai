# Providers (`@theoremjs/agents/providers`)

Single door for constructing a `ModelProvider` bound to a profile. Credentials
and runtime endpoints are always host-supplied arguments — THEOREM does not read
environment variables and does not ship `.env` files.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/providers` / `jsr:@theoremjs/agents/providers` |
| Module | `src/providers/mod.ts` |
| Local subpath | `@theoremjs/agents/providers/local` → `src/providers/local/mod.ts` |
| Live subpath | `@theoremjs/agents/providers/google/live` → `src/providers/google/live/mod.ts` |
| Also on | Root `@theoremjs/agents` re-exports `createProvider` |

## Ownership

Owns every module under `src/providers/`.

| Module | Role |
| --- | --- |
| `create-provider.ts` | Public factory; lazy-loads every adapter on first `complete` |
| `types.ts` | Host option bags (`OpenAiGatewayConfig`, `LocalProviderConfig`) |
| `openrouter/chat.ts` | OpenRouter chat adapter (internal; lazy-loaded) |
| `openrouter/openai/compat.ts` | Shared OpenAI REST wire format (messages, tools, headers) |
| `openrouter/openai/sdk-messages.ts` | THEOREM → AI SDK `ModelMessage[]` (OpenRouter chat) |
| `openrouter/openai/usage.ts` | OpenAI-compatible `usage` → `TurnTokens` (`openAiUsageTokens`), shared by OpenRouter chat, OpenRouter images, and local |
| `openrouter/speech.ts` | OpenAI `/audio/speech` transport (openrouter speech role) |
| `openrouter/image.ts` | OpenAI `/images` transport; chat + server tool when `includeText` |
| `openrouter/openai/image-payload.ts` | OpenAI-compat `/images` body builder |
| `google/interactions/stream.ts` | Google Interactions streaming adapter |
| `google/interactions/framing.ts` | Interactions payload / step wiring |
| `google/interactions/steps.ts` | Interactions steps and deltas → `TurnEvent` (text, thoughts, media, code execution and builtin evidence, usage, terminal status) |
| `google/interactions/mod.ts` | Interactions subpath barrel |
| `google/live/stream.ts` | Google Live WebSocket streaming adapter |
| `google/live/framing.ts` | Gemini Live WebSocket protocol framing |
| `google/live/mod.ts` | Live subpath barrel |
| `google/grounding.ts` | Google grounding → `grounding` events for Interactions and Live: one source shape, one dedupe |
| `google/keys.ts` | Gemini fetch with backoff and the fallback retry |
| `shared/vault.ts` | Reads a slot from the vault; bearer fetch with the fallback retry |
| `google/urls.ts` | Interactions API endpoint constants |
| `local/local.ts` | OpenAI-compat SSE for Ollama / llama.cpp / vLLM / LM Studio |
| `local/mod.ts` | Subpath export for direct local adapter access |
| `shared/sse.ts` | SSE line parser |
| `shared/pcm.ts` | PCM → WAV for every transport that returns raw audio (Live, Interactions, OpenRouter speech). The format comes from the mime each transport states (`rate=`, `channels=`); a raw PCM mime without `rate=` passes through unwrapped. Samples are 16-bit little-endian on all three (measured 23/09/2026). Base64 via the one kernel codec, `src/kernel/util/base64.ts`; adapters do not define their own |
| `shared/structured-output.ts` | `structuredEvent`: model text → a `structured` event, or a `bad_response` error event (OpenRouter, Interactions) |
| `shared/tool-args.ts` | Shared tool-argument JSON parse: `parseToolArgumentsObject` (Result, for streamed calls) and `historyToolArguments` (throws `TheoremError`, for history rebuilt into a request). Never invents `{}` / `{ _raw }`; an empty or absent argument string is a no-argument call. `historyToolIdentity` keeps a history tool message's call id and name only where present — no adapter invents either (Interactions, Live, OpenAI-compat, AI SDK). |
| `shared/upstream-tape.ts` / `shared/upstream-tap.ts` | Test / tap hooks (not public exports) |
| `probe.ts` | Env-gated `LOADED:<label>` writer used only by `createProvider`'s lazy loader (`THEOREM_IMPORT_PROBE=1`). Not a test backdoor; adapters must not import it. |

## Package boundary

| Rule | Detail |
| --- | --- |
| No `.env` in repo | Hosts pass credentials explicitly |
| No ambient env reads | `OLLAMA_HOST` resolved by host → `local.baseUrl` |
| No key templates | Business apps own secret storage |
| Traces | Profile `observability` + optional `runTurn` sink override; not here |
| Pairs | `PROTOCOL_PROVIDERS` / `isValidPair` in `src/kernel/schema.ts` — `createProvider` does not invent extra routes |
| Multi-model | `profile.models` map + optional `defaultModel`; adapter selection uses one binding per call |
| No registry reads | Builtins (`{ id, wire }`) and the structured schema (`{ id, jsonSchema }`) arrive resolved on `ProviderCompleteRequest`; an adapter never looks up a tool or schema by id |

## createProvider

```ts
const provider = createProvider(profile, {
  vault: { main, spare }, // one vault for every provider; slot names are yours
  gemini: { fetch?, wait? },
  openAiGateway: { baseUrl?, siteUrl?, siteName?, fetch?, voice? },
  local: { baseUrl?, fetch? },
}, modelId?)
```

`createProvider` reads the selected **`ModelBinding`** from `profile.models`
(`protocol` / `provider` on that binding). When a profile declares multiple
models, pass optional `modelId` (defaults to `profile.defaultModel`, which
registration always sets: the declared default, else the sole model key).

Legal pairs are `PROTOCOL_PROVIDERS` in `src/kernel/schema.ts` (`isValidPair`).
Routing table:

| protocol | provider | Requires | Transport |
| --- | --- | --- | --- |
| `geminiInteractions` | `google` | `options.vault` | Interactions API (chat / image / speech) |
| `openAi` | `openrouter` | `options.vault` | Lazy chat, `speech.ts`, or `image.ts` by output role |
| `openAi` | `local` | `options.local` | `POST /v1/chat/completions` SSE (image roles rejected) |

Errors:

- No `vault` for a `google` or `openrouter` profile → `TheoremError('config', …)`
  naming the provider (`createProvider requires a vault for openrouter models`).
- A model with no slot, or a slot the vault leaves empty → `TheoremError('auth', …)`
  at call time (`the vault has no key in slot '<slot>'`).
- A `local` profile without `options.local` → `TheoremError('config', …)`: a profile
  can name `local`, but only the host can say a local server is there to reach.
- Unsupported pair → `TheoremError('config', …)` with protocol/provider in the message.
- Every adapter names the kind where the failure happens and emits
  `toErrorEvent(err)` (`errorKind` + `errorInternal`, no user wording): a non-OK
  status through `kindOfHttpStatus`; a request that never reached the provider
  is `network` (`networkError` / `networkFetch` in `shared/upstream-tap.ts`); an
  unreadable payload is `bad_response`. OpenRouter reads the AI SDK error's
  `statusCode`; a mid-stream provider error without one is `unavailable`. Gemini
  Live closes map by close code (1006 → `network`, 1007 / 1008 →
  `unsupported`, others → `unavailable`), except a close whose reason names a
  quota, which is `rate_limit` whatever its code (Google refuses an over-quota
  key at setup with 1011 "You exceeded your current quota, …" — probe
  24/09/2026): during setup the open rejects; once
  open, any close other than 1000 reaches the host as an `error` event before
  the session ends — unless the provider warned first (`goAway`). A warned
  close, whatever its code, ends the session with a `session` `ended` event
  instead (the close's kind as `ended.errorKind`, the raw close as
  `errorInternal`). See
  [Public errors](guardrails.md#public-errors).

OpenRouter Vercel AI SDK loads **only** on first `complete` for `openAi` +
`openrouter` chat. Google and local never import it.

Media part support by transport (`InteractionPart` — see `docs/contracts/kernel.md`).
The accepted MIME vocabulary is one table for every transport
(`MEDIA_INPUT_KINDS`); no adapter keeps a second list. Google Interactions and
Live take the whole table. The OpenAI-compat adapters map every
`MediaInputKind` to a wire part and forward the MIME verbatim, so their set is
open-ended. The only per-adapter refusal is the reference part, raised as a
`TheoremError` at request time:

| Transport | Inline `InteractionMediaPart` (`data`) | Reference `InteractionMediaRefPart` (`uri`) |
| --- | --- | --- |
| Google Interactions | `{ type, mime_type, data }` | `{ type, mime_type, uri }` — Files API reference, wired by `wireInteractionPart` |
| Gemini Live (`runSession`) | `inlineData` in client-content history and realtime input | **rejected** — `TheoremError('media references are not supported on geminiLive')` |
| OpenRouter / local (`openAi`, REST payload) | `image_url` / `input_audio` / `file` data URLs | **rejected** — `TheoremError('media references are not supported on openAi')` |
| OpenRouter (`openAi`, AI SDK messages) | `image` / `file` data URLs | **rejected** — same error, including tool-result parts |

## OpenRouter

Internal adapter behind `createProvider` for `openAi` + `openrouter` chat. Hosts
use `createProvider(profile, { vault, openAiGateway })` — there is no separate
public OpenRouter entrypoint. The key comes only from `vault`, through the slot
the model or profile names in `key`.

`OpenAiGatewayConfig` (via `CreateProviderOptions.openAiGateway`):

| Field | Role |
| --- | --- |
| `baseUrl` | Optional API base override |
| `siteUrl` / `siteName` | Optional HTTP-Referer / X-Title style metadata |
| `fetch` | Optional custom fetch |
| `voice` | Optional fallback when `outputs.speech.voice` omitted |

Chat and speech requests use `ProviderCompleteRequest.apiId` on the wire — same
field as Google Interactions and local OpenAI-compat paths.

`createOpenRouterProvider(config)` (internal) streams normalized `TurnEvent`s
(`streamText`), or on a buffered profile reads one reply (`generateText`, raw
body kept for usage, cost and citations) into the same events;
terminal `done.stop` via `turnStopFromOpenAiFinishReason`. Request options ride
AI SDK `providerOptions.openrouter`: `reasoning.effort` whenever `thinking` is
set (`'none'` turns reasoning off), `response_format` for structured output, and optional
`sessionId` as `session_id`. Structured output also sends
`provider.require_parameters: true`: OpenRouter routes only to an endpoint that
supports every parameter sent, and answers 404 when none does. A profile must
set only what its model supports (for example, no `temperature` on a model that
rejects it); Theorem does not drop parameters for it. When `cache.mode` is `automatic`, `cacheControl`
is top-level; when `system`, the system message carries it instead of
`instructions` (`cacheControlJson`, `src/providers/openrouter/cache-control.ts`).
Builtins map through `wire.openRouter` on each `req.builtins` entry: `web`
becomes `web_search_options`, every other wire a plugin; a builtin with no
`wire.openRouter` throws. A tool result the adapter reports sets `readBack` on
its `complete` event, the same text `formatToolResult` gives `runTurn`.

Usage: the raw OpenRouter `usage` row is read first (`openAiUsageTokens`); AI
SDK `totalUsage` (`tokensFromUsage`) is used only when the stream carried no
row. `prompt_tokens` includes cached tokens (`prompt_tokens_details.cached_tokens`
→ `cached`, `cache_write_tokens` → `cacheWrite`); `completion_tokens` includes
reasoning (`reasoning_tokens` → `thinking`). OpenRouter `cost` → `cost.usd`,
`cost_details.upstream_inference_cost` → `cost.upstreamUsd`. Image turns read
the Images API `input_tokens` / `output_tokens` with the same parser. A row
that reports 0 input counts that side as missing; the runner estimates it (see
Token usage in the kernel contract).

## Google Interactions

`createInteractionsProvider(geminiTransport)` streams normalized `TurnEvent` events.

| Concern | Behavior |
| --- | --- |
| History | `user_input` / `model_output` steps; OpenAI-shaped `assistant.tool_calls` → `function_call` (not empty text; arguments via `historyToolArguments`); `tool` → `function_result`, taking the name of its call when it has none (Google rejects a nameless result, live 29/09/2026). A call carrying `thoughtSignature` is preceded by a `{ type: "thought", signature }` step; Google rejects a current-turn call replayed without it, and rejects a `thought_signature` field on the call (probe 25/09/2026). A continuation request (`previousInteractionId` + `continuation`) maps its messages the same way instead of history + input. Every step carries `historyMessageParts` (`content` as a text part, then `parts`); a message with neither is one empty text part. |
| Multimodal | `image` / `audio` / `video` / `document` parts, inline (`data`) or by Files API reference (`uri` → `{ type, uri, mime_type }`) |
| Structured | `responseFormat` from `req.structured.jsonSchema` whenever the profile names a structured schema. When structured is requested and model text is not valid JSON, providers emit an `error` event (never silently skip). |
| Output modes | A structured JSON schema, image, and speech are mutually exclusive. Image profiles may opt into interleaved text via `image.includeText`. |
| Tools | Request builtins (`req.builtins`, each `wire.interactions`; one without it throws) + function schemas from `generation.tools.wire`. When `googleMaps` is enabled and `TurnRequest.googleMapsLocation` is set, Interactions receives `tools: [{ type: "google_maps", latitude, longitude }]`. |
| Code execution | Builtin `codeExecution` → `{ type: "code_execution" }`. `code_execution_call` (`arguments.code`, `arguments.language`, `id`) and `code_execution_result` (`result`, `is_error`, `call_id`) steps become one `evidence` each (`kind`, `code`, `result`, `isError`, `raw`). Search/maps/`url_context` steps are also `evidence`. Structured `responseFormat` is still attached when both are requested. |
| Stream fold | One step, two deliveries (probed 23/09/2026). SSE rows are `step.start` / `step.delta` / `step.stop` per `index`, then `interaction.completed` (no `steps`). `function_call`, code execution and builtin steps merge their start and deltas and are emitted once, whole, at `step.stop` (`arguments_delta` strings concatenate); `thought` and `model_output` deltas emit as they arrive. A step still open when the stream ends is emitted as `evidence` with `partial: true` (`raw` holds what arrived); a partial `function_call` never becomes a tool call. A row that is not a JSON object is an `error`. Buffered bodies emit the same events from `steps[]`. `interaction.created` / `interaction.status_update` emit nothing. |
| Thoughts | Stream: `thought_summary` deltas (`content.text`) → `thought`. Buffered: `thought.summary[]`. A thought's signature (a `thought_signature` delta when streamed, `thought.signature` when buffered) is held and set as `thoughtSignature` on the next `function_call`'s tool event; its parallel siblings share that thought and carry none (probe 25/09/2026). gemini-3.1-flash-lite streams no summary but buffers one; gemini-3.1-pro streams it (probe 23/09/2026). |
| Audio | Stream deltas are `audio/l16` with `sample_rate` / `channels` fields, folded into the mime; buffered content states `audio/l16; rate=24000; channels=1`. Each delivery becomes WAV via `shared/pcm.ts` (one WAV per delta). |
| Stream vs batch | Default SSE (`outputs.streaming.mode: 'sse'` or omitted). `'buffered'` POSTs JSON and yields the same `TurnEvent` types from `steps[]`. |
| Thinking | `thinkingLevel` / `thinkingSummaries` are attached only when the resolved request sets `thinking` / `summaries` (omitted when unset). |
| Grounding | Read only from the recorded wire shapes (probe 23/09/2026); Interactions sends no `grounding_metadata`. `google_search_result` / `google_maps_result` steps give `result[].search_suggestions` (chips HTML → `searchHtml`) and `result[].places[]` (`name`, `url`, `place_id`); `model_output` gives `annotations[]` (`url_citation`: `url`, `title`; `place_citation`: `url`, `name`, `place_id`). Streams read them from each `step.delta`; buffered bodies from `steps[]` (annotations under `content[]`), merged into one `grounding` event (search chips, `chunks[].maps` (`title` / `uri` / `placeId`) for maps sources, the raw step on `metadata`) and one `citation` event with the normalized `sources`, plus `evidence` with the raw tool payload so hosts can decide what to surface. Every place is a source, review places included; the host decides which to show. |
| Stop | `turnStopFromInteractionStatus` on `interaction.status`; a non-terminal status (`in_progress`, `queued`) is `stream_incomplete` with the status as `native`. A stream that ends before any status is `stream_incomplete`, never `completed`. |
| Usage | Read only from `interaction.completed` (`interaction.usage`), or the buffered response. `total_thought_tokens` is added to output, `total_tool_use_tokens` to input; cached tokens are already inside input. When `total_input_tokens` is 0 (inputs Google converts first), input is `total_tokens` − output − thought − tool use. `model_invocation_token_counts` is not billed and is not read. |

## Google Live

Live profiles use **`runSession`**, not `createProvider` / `ModelProvider.complete()`.

`runSession(req, { gemini, openWebSocket? })` opens a long-lived Gemini Live
WebSocket (`BidiGenerateContent`), applies inbound text prep and the live outbound
gate (canary, system-prompt echo, egress) at each conversational `turnComplete`, and returns a
`LiveSession` (`sendAudio` / `sendVideo` / `sendText` / `sendContext` / `executeTool` /
`answerToolCall` / `events` / `close`).

The session holds each call the model makes. The host runs one by id with
**`executeTool({ callId })`**, so live stages (`pre_tool` / `post_tool`),
permission/auth gates, gate answers (`decision`), and upstream tool responses
stay on the session path; there is no raw tool-response escape hatch. See
[`stages.md`](stages.md) ("`LiveSession.executeTool`").

A sign-in gate waits for its decision like any gate (`signInGate: 'hold'`, the
default). With `signInGate: 'answer'` the session answers the model at once
with the gate's `sign_in.pending` note and releases the call, for a host whose
sign-in finishes outside the call. A released call still takes its outcome for
`gateTtlMs` (`executeTool` with a decision, or `answerToolCall`); the model reads
it as the call's next `functionResponse` (probe 30/09/2026,
gemini-3.1-flash-live: a second response for an answered `NON_BLOCKING` call is
accepted and spoken). Unanswered by then, the model reads `sign_in.expired`.

`createProvider` **rejects** `geminiLive` — there is no turn-scoped live `complete()` adapter.

| Concern | Behavior |
| --- | --- |
| Door | `runSession` (shares resolve / tools / canary / system compose with `runTurn`) |
| Transport | `openGoogleLiveSession` — WebSocket; optional `openWebSocket` for Cloudflare fetch-upgrade |
| Handshake | `BidiGenerateContentSetup` via `buildGeminiLiveSetupMessage` |
| Turn boundary | Gemini `serverContent.interactionStatus: IDLE` when the server sends it, else `turnComplete` → outbound gate finalize + cycle `done` (`stop.kind: 'completed'` when no folded done) + `before_end` / `post_turn`; **session stays open**. `interactionStatus: IN_PROGRESS` keeps the cycle open across `turnComplete` — background reasoning / async tool calls may still emit audio or tool calls |
| Generation boundary | Gemini `generationComplete` → `done` (`stop.kind: 'generation_complete'`) without tearing down the session |
| Tools | Builtins are their own setup tools from `wire.live` (`{ googleSearch: {} }`, `googleMaps`, `urlContext`, `codeExecution`); a builtin with no `wire.live` throws. Which a model takes is the API's answer (probe 23/09/2026: search on every Live model; gemini-3.8-live and -extended-thinking close with 1007 on the other three; gemini-2.5-flash-native-audio takes `urlContext`; gemini-3.1-flash-live accepts all four but used only search). `googleMapsLocation` is not sent on Live. Every function declaration is wired `behavior: NON_BLOCKING`: the host runs calls through `executeTool` while the model keeps speaking. `executeTool` by `callId` runs every call (stages + gate answers + upstream); a call the provider already failed is answered by the session; cancellations → `tool.phase: 'cancel'` with the call's name. Every id in profile `tools.allow` + `builtInTools` is wired in `BidiGenerateContentSetup` regardless of `loadTier` (declarations cannot change mid-session) — no `t1Policy` / `t2Loader`, no structured output, no turn `inputs` / `outputs`. |
| Ingress | `live.ingress` gates `sendAudio` / `sendVideo` / `sendText` / `sendContext`. `sendContext` sends the text as `clientContent` with `turnComplete: false` (probe 01/10/2026, gemini-3.8-live, 3 of 3 runs): the model reads it as background and speaks no reply, where `sendText` (`realtimeInput.text`) is the caller speaking and always draws one. It opens no turn and records no user text; inbound guardrails run as for `sendText`. `sendAudio` / `sendVideo` take the host's `mimeType` and send it as given (probe 23/09/2026: `audio/pcm` with no rate is accepted everywhere; gemini-2.5-flash-native-audio rejects `audio/l16`). Defaults: audio **on**, camera (video channel) **on**, text **off** unless `live.ingress.text: true`. At least one channel must stay enabled. |
| Transcription | Mid-turn `evidence` with `kind: 'input_transcription'` / `output_transcription` (optional `interim`); **not** held for egress — streams immediately |
| Session control | `goAway` → `session.kind: 'closing_soon'` (`timeLeft` is a Duration string, e.g. `"50s"`; observed on gemini-3.1-flash-live-preview about 9 minutes in, twice, then close 1008 at the limit — probe 23/09/2026; on gemini-2.5-flash-native-audio-latest once at 541 s with `"50s"`, then no close: the idle session stayed open until the probe closed it at 1200 s — probe 24/09/2026. A warning is not a promise to close); a close after `goAway` → `ended` (see Errors); `waitingForInput` → `waiting_for_input`; `turnComplete` → `turn_complete`; `serverContent.interactionStatus` → `working` / `idle` |
| Resumption | `sessionResumptionHandle` on `SessionRequest`; updates as `evidence.kind: 'session_resumption'` with `resumable` |
| Remote registry | `SessionRequest.snapshot` (a `TurnToolSnapshot` from `prepareTurnToolSnapshot` in the registry-owning process) supplies the setup declarations when the session runs where the registry is not registered; ids outside `tools.allow` are refused |
| History | Client-content turns (`user` / `model`) carry `historyMessageParts` — text as `text`, media as `inlineData`. Assistant `tool_calls` follow as `functionCall { id, name, args }` parts in the same `model` turn (arguments via `historyToolArguments`). A `tool` message is a `user` turn with one `functionResponse { id, name, response: { result }, parts }`: its text parts newline-joined as `result`, its media as nested `inlineData`; `id` / `name` are sent only when the message carries them. Role `function` is never sent (Live closes with 1007). `thoughtSignature` is not sent: Live never emits one. Probed 23/09/2026 on gemini-3.1-flash-live-preview. |
| Media references | Client-content history and realtime input reject `InteractionMediaRefPart` (`TheoremError`) until provider support is verified |

### Live fold → `TurnEvent` (exhaustive)

| Gemini signal | TurnEvent |
| --- | --- |
| `modelTurn.parts[]` | `text` → `text`; `text` with `thought: true` → `thought`; `inlineData` → `media` (`audio/pcm;rate=24000` becomes WAV via `shared/pcm.ts`); `codeExecutionResult { outcome, output }` → `evidence` + `kind: 'code_execution_result'` (`result`, `isError` when `outcome` is not `OUTCOME_OK`, `raw`) — gemini-2.5-flash-native-audio reports each search / URL fetch this way. No `executableCode` part was seen on any Live model (probe 23/09/2026). |
| `inputTranscription` | `evidence` + `kind: 'input_transcription'` |
| `interimInputTranscription` | same + `evidence.interim: true` |
| `outputTranscription` | `evidence` + `kind: 'output_transcription'` |
| `toolCall.functionCalls` | `tool` |
| `toolCallCancellation.ids` | `tool` + `phase: 'cancel'`, named from the call this connection issued (the wire sends ids only; gemini-3.8-live never sends it). An id the connection never issued is an `error`. |
| `voiceActivity` | `evidence` + `kind: 'voice_activity'`, the `{ type: ACTIVITY_START \| ACTIVITY_END, audioOffset }` message as `raw` (gemini-3.1-flash-live only, probe 23/09/2026) |
| `goAway` | `session` + `kind: 'closing_soon'` |
| `waitingForInput` | `session` + `kind: 'waiting_for_input'` |
| `generationComplete` | `done` + `stop.kind: 'generation_complete'` |
| `interrupted` | `done` + `interrupted` + `stop.kind: 'interrupted'` |
| `sessionResumptionUpdate` | `evidence` + `kind: 'session_resumption'` |
| `groundingMetadata` | `grounding`: raw on `metadata`, `groundingChunks` as `chunks`, `web` chunks (`uri`, `title`) as `sources`, `searchEntryPoint.renderedContent` as `searchHtml` (probe with `googleSearch`, 23/09/2026) |
| `usageMetadata` | `tokens`, one per model response, covering that response. `thoughtsTokenCount` is added to output, `toolUsePromptTokenCount` to input. A response without one is not yet estimated. |
| `setupComplete` | handshake only (not a TurnEvent) |
| `turnComplete` | `session` + `kind: 'turn_complete'`; stream phase `complete` only when no `IN_PROGRESS` status accompanies it |
| `serverContent.interactionStatus` | `session` + `kind: 'working'` (`IN_PROGRESS`) or `'idle'` (`IDLE`); `IDLE` is the stream-phase boundary → `runSession` emits `done` + `completed` |

Framing helpers remain in `google/live/framing.ts` for hosts that only need setup JSON.

## Local provider

Import `@theoremjs/agents/providers/local` for `createLocalProvider`. Hosts
resolve `OLLAMA_HOST` (or similar) themselves and pass `baseUrl` — THEOREM does
not read environment variables for local endpoints and has no default address.
`createProvider` routes a `local` profile only when the host passes `local`: a
profile cannot point the host at its own loopback.

```ts
local: {
  baseUrl: "http://127.0.0.1:11434", // no trailing slash
  fetch: customFetch,
}
```

- Raw `fetch` + `sse.ts` — no SDK. A buffered profile sends `stream: false` and
  reads one JSON reply into the same events.
- Accumulates streaming tool calls; maps `finish_reason` through
  `turnStopFromOpenAiFinishReason`.
- Supports multimodal user content when the server accepts OpenAI-style parts;
  media reference parts (`uri`) are rejected with `TheoremError`.
- Requests `stream_options.include_usage`; the final `usage` row goes through
  `openAiUsageTokens`. A server that sends none is estimated by the runner.

## Image roles

When `profile.type === 'image'` and protocol/provider is
`openAi`/`openrouter`, `createProvider` returns `createImageProvider`
(`openrouter/image.ts`). When protocol/provider is `geminiInteractions`/`google`,
the same `createInteractionsProvider` handles image via polymorphic
`responseFormat`.

| Transport | Module | Path / mechanism | Notes |
| --- | --- | --- | --- |
| OpenAI | `openrouter/image.ts` | `POST /images` | Native image models; the model gets the prompt text and the reference images only, never the system prompt or history; reference images via `input_references`, bytes as data URLs and `http(s)` references passed through as URLs (other schemes are refused); OpenRouter documents `prompt` as required, so an image-only turn is refused. Every `data[]` entry with `b64_json` + `media_type` is one `media` (probe 23/09/2026). |
| OpenAI | `openrouter/image.ts` | `POST /chat/completions` + server tool | When `image.includeText`. `message.content` (a string) is `text`; every `message.images[].image_url.url` data URL is one `media` (probe 23/09/2026). No image is an `error`. |
| Interactions | `google/interactions/framing.ts` | `responseFormat` object or array | Image-only object; text + image array when `includeText`. No image is an `error`, as no audio is for speech. |

Image profile pins `quality`, `background`, `n`, `seed` and `outputCompression`: unset ones are omitted from the wire. OpenRouter `/images` sends all five. OpenRouter chat (`includeText`) sends `quality`, `background` and `output_compression`, and refuses `n` and `seed`, which its server tool does not document. Google sends `seed` as `generationConfig.seed` and refuses the other four. A pin a transport cannot send is `unsupported`, never dropped.

An image profile's `image.references` (bytes or `uri`, images only) go into every turn's input ahead of the user's attachments, so each transport sends them as it sends any other reference image. The kernel checks only that each is an image with a source; how many a model takes is the transport's and the model's to refuse.

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
| OpenAI | `openrouter/speech.ts` | `/audio/speech` | `speech.format` rides `response_format` when set; unset sends none, and the upstream picks. `mp3` allowed. The response carries no usage; the runner estimates the call. The response's `content-type` states the audio; raw PCM with a rate is wrapped as WAV. The endpoint answers whole or not at all, so a body with audio ends `done` with stop `completed`. |
| Interactions | `google/interactions/mod.ts` | `responseFormat: { type: 'audio' }` | Real PCM → WAV only. Missing audio on a speech-role turn (text-only or empty) yields an `error` event — never invents PCM from text bytes. `mp3` is refused (`unsupported`) when the request is framed; Gemini speech takes only `GOOGLE_SPEECH_FORMATS`. |

Speech turns carry no system prompt. The input text is the transcript: Gemini
TTS rejects developer instructions ("Developer instruction is not enabled") and
`/audio/speech` has no field for one. So `defineProfile` rejects
`identity.system` / `identity.systemByRole` and any canary on a speech profile
(registration stores `guardrails.canary: false`), and `resolveTurn` rejects a
host `TurnRequest.system` on a speech turn.

Speech-role turns (`req.speech`) must receive real audio media from the model.
Missing audio — whether the model returned text only or nothing at all — yields
an `error` event. The adapter never casts text bytes into a fake WAV/PCM
container.

Tool-call argument strings that are not valid JSON objects fail the same way on
every transport (Interactions, Live, local, OpenRouter history→SDK): the
model's raw call (`arguments: {}`) followed by its `tool` event with
`phase: 'error'` / `failure.code: 'malformed_arguments'` and the bad string in
`failure.details.raw` (`malformedToolCall`), or a thrown
`TheoremError` (`historyToolArguments`) when rebuilding history for the AI SDK,
Interactions or Live. The raw call's empty `arguments` records that the model
gave none usable; the call never runs, and nothing invents `{}` or `{ _raw }`
to paper over bad JSON — the bad string rides the failure.

History `content` and `parts` reach every transport together — `content` first
as a text part, then `parts` (see `historyMessageParts` in the kernel
contract). Assistant text or media that accompanies `tool_calls` precedes the
calls: a `model_output` step before `function_call` steps (Interactions), text
and file parts before `tool-call` parts (AI SDK), text and `inlineData` parts
before `functionCall` parts (Live), and `content` beside `tool_calls`
(OpenAI-compat). Text-only content collapses to one
newline-joined string on OpenAI-compat and AI SDK messages.

## Key vault (provider-neutral)

A slot is a name the host picks: letters, digits, `-` and `_`, up to 32
characters (`KEY_SLOT_NAME`, `isKeySlotName`), as many as it wants. A profile
names slots and never holds a key; the host's vault fills them. No slot name
means anything to the kernel.

A model's calls use `models.*.key`, else the profile's `key`, and its fallback
is `models.*.fallbackKey`, else the profile's `fallbackKey`: the slot a call
retries on once when its key is refused for quota. There is no fallback unless
the profile names one, and `defineProfile` refuses a fallback equal to its key.
Every model but a local one must name a slot: `defineProfile` refuses a
`google`, `openrouter` or decision model with neither `models.*.key` nor the
profile's `key`. There is no flat key.
Resolve puts the slots on `ResolvedGeneration.keySlot` / `fallbackKeySlot` and
the same fields of `ProviderCompleteRequest`.

The host passes one `vault` to `createProvider` and `runSession`, and every
adapter reads it: a slot holds whatever secret the host put there, whichever
provider the model calls. `runDecision` and the decision handler take the same
`vault`, and nothing else: a decision whose slot the vault leaves empty throws
`DecisionError('authentication', "the vault has no key in slot '<slot>'")`.

| Provider | Key |
| --- | --- |
| Google | `vault[keySlot]`; a Google model must name a slot |
| OpenRouter | `vault[keySlot]`; an OpenRouter model must name a slot |
| Local | `vault[keySlot]` as a bearer token when the model names a slot, else none |

| Piece | Role |
| --- | --- |
| `KeyVault` | `Record<KeySlot, string \| undefined>`, one for every provider |
| `GeminiOptions` | Optional `fetch` and backoff `wait` for Google |
| Slots | Any names the host picks |
| Selection | `models.*.key`, else `key`; no tool picks a key |

A quota refusal retries once on the fallback slot when the profile names one
and the vault holds a different key there. Over HTTP (a 429: `fetchGemini` for
Google, `bearerFetch` for OpenRouter and local), each try's span names its
`theorem.key_slot`. A Live setup refused for quota (`openGoogleLiveSession`) is
tapped as a `ws_fallback` row; the session trace records
`theorem.session { kind: "key_fallback" }` and its responses name the fallback
slot. With no fallback named, or an empty one, the refusal stands.

A profile that names no key where one is required is `TheoremError('config', …)`;
a slot the host's vault leaves empty is `auth`.

## Exported API

From `src/providers/mod.ts`:

| Export | Kind |
| --- | --- |
| `createProvider` | function |
| `CreateProviderOptions` | type |
| `GeminiOptions`, `KeyVault` | types |
| `LocalProviderConfig`, `OpenAiGatewayConfig` | types |

From `src/providers/local/mod.ts` (`@theoremjs/agents/providers/local`):

| Export | Kind |
| --- | --- |
| `createLocalProvider` | function |

From `src/providers/google/live/mod.ts` (`@theoremjs/agents/providers/google/live`):

| Export | Kind |
| --- | --- |
| `openGoogleLiveSession` | function |
| `GoogleLiveConnection`, `OpenLiveWebSocket` | types |

```theorem-evidence
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
        { "kind": "contract_test", "path": "tests/providers/openrouter/chat.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/openai/compat.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/openrouter/openai/sdk-messages.test.ts" }
      ]
    },
    "Google Interactions": {
      "supports": [
        { "kind": "source", "path": "src/providers/google/interactions/stream.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/framing.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/mod.ts" },
        { "kind": "source", "path": "src/providers/google/interactions/steps.ts" },
        { "kind": "source", "path": "src/providers/google/grounding.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/interactions/framing.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/interactions/stream.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/interactions/steps.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/grounding.test.ts" }
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
    "Key vault (provider-neutral)": {
      "supports": [
        { "kind": "source", "path": "src/providers/shared/vault.ts" },
        { "kind": "source", "path": "src/providers/google/keys.ts" },
        { "kind": "source", "path": "src/kernel/registry/vault.ts" },
        { "kind": "contract_test", "path": "tests/providers/shared/vault.test.ts" },
        { "kind": "contract_test", "path": "tests/providers/google/keys.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/vault.test.ts" }
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
