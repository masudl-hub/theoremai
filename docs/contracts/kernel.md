# Kernel (`theorum/kernel`)

Type-first contracts for profiles, turns, tools, compaction, stop/resume, and
`runTurn`. Import here when a host needs the kernel surface without pulling
provider adapters.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/kernel` / `jsr:@theorum/core/kernel` |
| Module | `src/kernel/mod.ts` |
| Also on | Root `theorum` / `mod.ts` re-exports the same interface helpers and many kernel exports |

## Ownership

| Scope | Path |
| --- | --- |
| Tree | `src/kernel/` (engine, registry, `stop.ts`, `types.ts`) |

## Profiles

Hosts declare agents with `defineProfile` / `registerProfile` (or
`registerProfiles`). `getProfile` / `hasProfile` / `listProfiles` / `clearProfiles`
manage the in-memory registry.

A `Profile` binds:

| Block | Role |
| --- | --- |
| `type` | Wire archetype discriminator: `'text'`, `'image'`, `'speech'`, `'live'` |
| `identity` | `handle`, optional `system` / `systemByRole` |
| `model` | `protocol`, `provider`, `allow`, `config`, optional `select` / `thinking` / `controls` / `maxSteps` / `key` |
| `tools` | Allowlist ceiling (`allow: ToolId[]`) — present on `text`, `image`, `live` |
| `inputs` | Text / attachments / voice / slots / per-mime limits — present on `text`, `image`; absent on `speech` and `live` (live uses `live.ingress` instead) |
| `image` / `speech` / `live` | Modality-specific pins (top-level, not nested under `outputs`) |
| `outputs` | Structured, streaming, validation — present on `text`, `image`, `speech`; absent on `live` |
| `turnResumption` | `allowContinue`, `autoContinue`, `maxContinues` — present on `text`, `image`, `speech` |
| `guardrails` | Quota, canary, sanitize, redact, egress |

Closed unions (`protocol`, `provider`, `thinking`, stop kinds, MIME maps, …)
live as `as const` arrays in `src/kernel/schema.ts`. Types are derived from
those arrays. `PROFILE_FIELDS` / `fieldMeta` document every authoring path so
host UIs and docs hover the live kernel types instead of copying them.

Multimodal ingress uses provider-neutral `InteractionPart` values;
`InteractionMediaPart.type` is `MediaInputKind` (`image` | `audio` | `video` |
`document`). MIME → kind mapping lives in `MEDIA_INPUT_KINDS` (`schema.ts`)
and is applied by `mediaKindForMime` (`catalog.ts`).

`models.*.protocol` is `PROTOCOLS` (`geminiInteractions` | `openAi` | `geminiLive`).
`models.*.provider` is `PROVIDERS` (`google` | `openrouter` | `local`).
Legal pairs are `PROTOCOL_PROVIDERS`; `createProvider` rejects anything
outside `isValidPair`. `providersFor` / `protocolsFor` / `coerceProvider` /
`coerceProtocol` are the same table.
Each `ModelBinding` in `profile.models` carries wire ids (`apiId`), optional
`efforts` / `defaultEffort`, `summaries`, `maxOutputTokens`, `temperature`,
`builtInTools`, optional vault `key`, optional `compaction`.

THEORUM does not invent provider-API defaults for optional wire fields.
Hosts must set required fields explicitly (`type`, `models`, per-binding
`protocol` / `provider` / `apiId`).
First-party THEORUM opinions that *are* applied when the host omits a knob:
guardrails default on, and Interactions streaming defaults to SSE
(`outputs.streaming.mode` omitted → `stream: true`).

`projectProfile` / `resolveTurn` project a registered profile + `TurnRequest`
into a `ProjectedProfile` / `ResolvedGeneration` the runner and providers consume.

## Turn lifecycle

`runTurn(request, provider, sink?)` is the single deterministic execution path
for one **turn-based** agent turn (text / image / speech). Live profiles use
`runSession` instead (long-lived session; conversational `turnComplete` is a
gate boundary, not socket teardown). Pipeline for `runTurn` (see `engine/runner/mod.ts`):

1. **Resolve** — `resolveTurn` picks model, wire `apiId`, `transport`
   (`'interactions'` for Google Interactions, `'openAiCompat'` for OpenRouter/local),
   thinking, tools, structured schema, streaming mode (`outputs.streaming.mode`
   → SSE vs buffered), canary token.
2. **Sanitize** — `sanitizeTurnRequest` strips injection/sensitive spans per
   profile guardrails (unless disabled).
3. **Compaction (before)** — when `timing: 'before'` and threshold fires, kernel
   runs the compaction profile turn synchronously, then continues with trimmed
   history.
4. **Canary bind** — `bindCanary` embeds the per-turn canary in system text when
   `guardrails.canary` is enabled.
5. **Provider stream** — `provider.complete` yields partial events; runner may
   gate thoughts/media per `outputs.streaming`.
6. **Tool loop** — while under `maxSteps`, tool calls execute via `executeRegisteredTool`
   (shared with `invokeTool`), threading host `credentials` for authenticated HTTP/MCP tools; results feed the next step. `generation.transport` selects
   Interactions continuation (`previous_interaction_id` + `function_result` steps) vs
   OpenAI-compat tool-call history. Server-side `codeExecution` does not consume a runner step.
7. **Validation / repair** — structured output validators (`outputs.validation`)
   may trigger repair turns with `input.repair`.
8. **Egress** — `guardrails.egress.enforce` may block, refuse, or retry with
   repair guidance before releasing user-visible text.
9. **Trace** — optional sink receives a `TraceRecord`; failures are swallowed.
   Runner threads `profile.model.protocol` and upstream tap rows (`tapUpstream`).
   Interactions turns snapshot `wire` via `toInteractionsBody`; OpenAI-compat turns
   omit wire and classify ok/cancelled from terminal `done.stop` on the event stream.
10. **Terminal `done`** — one `done` event with tokens, optional `stop`,
    optional `compaction` signal (`timing: 'after'`).

`continueFrom` on `TurnRequest` prepends `CONTINUE_INSTRUCTION` and carries
partial assistant text/artifact from a resumeable stop.

Optional `compactionProvider` on `TurnRequest` when the compactor profile uses a
different transport than the primary turn.

## Stream events

`runTurn` and adapters yield `TurnEvent`:

| `type` | Payload highlights |
| --- | --- |
| `thought` | Model reasoning stream (may be gated) |
| `text` | User-visible assistant text |
| `tool` | Tool call (`phase`: `running` / `progress` / `complete` / `pause` / `error` / `cancel`, …) |
| `structured` | Parsed JSON object when schema enforced |
| `media` | Generated image/audio bytes + mime |
| `grounding` | Search/maps grounding metadata (classic `grounding_metadata` and Interactions tool results such as `google_search_result.search_suggestions`, `google_maps_result.result[].places`, and `place_citation` annotations). Normalized to `sources` plus classic `chunks[].maps` (`title` / `uri` / `placeId`) |
| `evidence` | Provider-native attachments. Google code execution sets `kind` (`code_execution_call` / `code_execution_result`) plus parsed `code` / `result` / `isError` / `id` / `callId`, and always keeps `raw`. Live ASR uses `input_transcription` / `output_transcription` (optional `interim`); session resumption uses `session_resumption` + `resumable`. |
| `session` | Live control: `closing_soon` (optional `timeLeftMs`), `waiting_for_input` |
| `tokens` | `input` / `output` / `total` usage (billing; may gate `meter: 'input'`) |
| `done` | Terminal or live boundary: `stop` (`completed` / `interrupted` / `generation_complete` / …), `tokens`, `compaction`; when `stop.kind === 'tool'`, optional `tools` (`TurnToolSnapshot`) for host `invokeTool` resume |
| `error` | Public-safe `error` string; optional `errorInternal` for host logs only |

### Host client boundary

`runTurn` yields one stream for the host process. **Do not forward the stream
verbatim to browsers or end-user SSE** unless you intend to expose diagnostics.

| Field | Host logs / traces | End-user transport |
| --- | --- | --- |
| `error` | yes | yes |
| `errorInternal` | yes | **never** |
| `evidence` parsed fields (`kind`, `code`, `result`, citations) | yes | when useful in UI |
| `evidence.raw` | yes | only when you explicitly want provider internals |
| `text`, `media`, `structured`, `grounding` | yes | yes (after egress/canary gates) |
| `thought` | yes (also in trace when filtered from stream) | only when profile allows |

Use `forClient` / `forClientEvents` from `theorum/host` before WebSocket or SSE
flush. Pass a trace sink (`memorySink`, `jsonlSink`) as the third argument to
`runTurn` for wire-level audit (`upstreamLog`).

`TurnHistoryMessage` preserves `role`, `content`, `parts`, `tool_calls`,
`tool_call_id`, and opaque `metadata` across turns.

Google Interactions code execution (`codeExecution` builtin) is a server-side
tool: THEORUM does not run Python. Hosts receive the sandbox timeline as
`evidence` events (streamed SSE deltas, or a batched replay of `steps[]` when
`outputs.streaming.mode === 'buffered'`). Generated plots/annotated images arrive as
`media`. `maxSteps` does not bound Google's internal code loop; it only bounds
host function-calling round trips. The sandbox runtime cap (~30s per execution)
is Google's, not a THEORUM setting.

Streaming is controlled solely by `outputs.streaming.mode` on the profile
(`'sse'` or `'buffered'`). When omitted, THEORUM defaults to SSE
(`ResolvedGeneration.stream === true`).
There is no per-turn stream override.

## Registered tools

Tools are registered once at host startup via `registerTool` (Google builtins via
`registerGooglePreset`). Profiles declare **custom** tools on `tools.allow` and **provider builtins** on
`models.*.builtInTools`. Visibility is `loadTier` (T0 at turn start, T1 via
`tools.t1Policy`, T2 via `tools.t2Loader`).

```ts
// Startup
registerTool({
  type: 'function',
  name: 'lookup_order',
  description: 'Fetch order state',
  category: 'operations',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'session_consent',
  input: z.object({ orderId: z.string() }),
  output: z.object({ finding: z.string() }),
  handler: async (input) => ({ finding: `Order ${input.orderId} is in transit.` }),
});

// Profile — custom allow + optional T1 policy + optional T2 loader
tools: {
  allow: ['lookup_order', 'load_tools', 'deferred_order_tool'],
  t1Policy: (ctx) => (ctx.input?.text?.includes('order') ? ['deferred_order_tool'] : []),
  t2Loader: 'load_tools',
}
// models.fast.builtInTools: ['googleMaps', 'urlContext']

// Turn
runTurn({
  profile,
  input: { text: '...' },
}, provider);

// Host resume (interactive, confirmation, permission) — pass turn snapshot from tool-pause `done.tools`
invokeTool({ profile, name: 'ask_user', input: {...}, resume: { value: 'yes' }, snapshot, turnInput });
invokeTool({ profile, name: 'risky_tool', input: {...}, resume: { granted: true }, snapshot, turnInput });
// T2 resume after loader: include `promoted: ['record_lookup']` (or rely on snapshot.visible when emitted on `done`)
invokeTool({ profile, name: 'record_lookup', input: {...}, resume: { value: true }, snapshot, promoted: ['record_lookup'], turnInput });

// Preflight returning `kind: 'confirmation'` pauses once; `resume.granted: true` skips preflight on the next invoke (same as `always_confirm` permission).

// Host direct invoke (command palette)
invokeTool({ profile, name: 'lookup_order', input: {...} });
```

| Layer | Owner | Role |
| --- | --- | --- |
| Registry | Host startup | Schema, handler, `access`, `loadTier`, `permission`, wire metadata |
| Profile | Host | `tools.allow` / `tools.t1Policy` / `tools.t2Loader`; `models.*.builtInTools` |
| Turn | Host | `sessionPermissions` for consent; `credentials` bag for authenticated HTTP/MCP tools; path / input / transport |
| Execution | Kernel | Shared `executeRegisteredTool` for model and `invokeTool` paths |

Builtins (`type: 'builtin'`) are provider-native — kernel pins capabilities in
`generation.builtins` but does not execute handlers.
Function tools (`type: 'function'`) run host TypeScript handlers.
Declarative HTTP tools (`type: 'http'`) call REST APIs directly with templated URLs, query parameters, headers, and body mapping.
Remote MCP tools (`type: 'mcp'`) call external Model Context Protocol servers over Streamable HTTP (revision 2026-07-28).

Both HTTP and MCP tools integrate with:
- **Network Guardrails** (`guardrails.network`): SSRF protection blocking loopback and private subnets unless `allowPrivateNetworks: true` is configured.
- **Stateless OAuth 2.1 & PKCE** (`theorum/auth`): RFC 7636 PKCE S256, RFC 9728 discovery, RFC 8414 AS metadata, RFC 9207 `iss` mix-up defense, RFC 8707 resource indicators, and stateless HMAC-signed state envelopes.
- **Unauthenticated Handling**: Pauses the turn via `ToolPause { kind: 'auth' }` or reports synthetic error findings to the model per `onUnauthenticated: 'pause' | 'report_to_model'`.
- **Token Rotation**: Proactively refreshes expiring OAuth tokens during turns, emitting progress events so the host can update its credential store.

Catalog `conflictsWith` is an optional host-declared mutual exclusion on registered builtins; the Google preset does not set it.
MIME classification (`MEDIA_INPUT_KINDS`, `ATTACHMENT_ACCEPT_MIMES`, …) lives in
`schema.ts`. Tool catalog constants: `TOOL_LOAD_TIERS`, `TOOL_ACCESS`,
`TOOL_PERMISSION`, `TOOL_TYPES`, `HTTP_METHODS`, `TOOL_AUTH_TYPES`,
`AUTH_UNAUTHENTICATED_POLICIES`. `src/kernel/tools/types.ts` imports those unions
for `HttpToolDef` / `HttpToolAuthConfig` and re-exports them — do not redefine
closed unions in the tools module.

## Outputs and guardrails

Profile `outputs` pins behavior the kernel enforces before adapters run:

| Pin | Effect |
| --- | --- |
| `structured` | Schema id or slot-mapped ids; `responseFormat` vs prompt enforcement |
| `streaming` | `mode`, `streamThoughts` |
| `validation` | Field validators + `maxRetries` + `repairGuidance` |

Top-level modality pins (after `model`, not under `outputs`):

| Block | Effect |
| --- | --- |
| `image` | Optional aspect/size, mime, max input images (type `'image'` only) |
| `speech` | TTS voice + `format` (`pcm` → WAV; `mp3` requires `protocol: 'openAi'` — see `speechFormatsForProtocol`) (type `'speech'` only) |
| `live` | Voice, VAD, transcription, sessionResumption, contextCompression, proactiveAudio (type `'live'` only; omit → provider defaults) |

### Live profile (`type: 'live'`)

Live is a **session** contract (`runSession`), not a turn contract (`runTurn`). The profile shape is intentionally smaller than text/image:

| Block | On live? | Notes |
| --- | --- | --- |
| `identity` | yes | `handle`, `system` / `systemByRole` |
| `model` | yes | `protocol: 'geminiLive'`, `provider: 'google'` only |
| `live` | yes | Voice, VAD, transcription, resumption, compression, proactive audio, **`ingress`** (realtime mic / camera / text toggles; text off unless `ingress.text: true`) |
| `tools` | yes | `{ allow: ToolId[] }` only — each allowlisted (and `builtInTools`) id must be `loadTier: 'T0'`; declarations wired once at Gemini Live setup |
| `guardrails` | optional | Canary, sanitize, egress (live outbound gate) |
| `inputs` | **no** | Turn file attachments — use `live.ingress` for realtime channels instead |
| `outputs` | **no** | No structured JSON or SSE/buffered turn streaming on Gemini Live |
| `turnResumption` | **no** | Use `live.sessionResumption` + `SessionRequest.sessionResumptionHandle` |
| `tools.t1Policy` / `tools.t2Loader` / T1–T2 tools | **no** | Declarations are fixed after setup; host cannot add schemas mid-session |

Profile `turnResumption` (top-level on chat/image/speech):

| Field | Effect |
| --- | --- |
| `allowContinue` | Stop kinds eligible for a continueFrom turn |
| `autoContinue` | Stop kinds the host may auto-continue without a CTA |
| `maxContinues` | Max continueFrom rounds the kernel accepts (enforced) |

Profile `guardrails`:

| Flag | Effect |
| --- | --- |
| `quota` | Host HTTP helper only (`theorum/guardrails`); not enforced inside `runTurn` |
| `canary` | Per-turn canary token; egress checks leakage |
| `sanitizeInput` / `redactSensitive` | Pre-provider text/blob scrub |
| `egress` | Host `enforce` hook; `onBlock`: `reject_to_agent` or `refuse_to_user` |

## Compaction

Optional per-model policy on `ModelBinding.compaction`. Kernel owns trigger, split,
and timing; host owns persistence/reassembly unless `timing: 'before'` runs the
compactor inline.

```ts
compaction: {
  maxTokens: 2000,
  compactAt: 0.75,
  previousExchanges: 8,
  profile: "my.compactor",
  timing: "after",
  meter: "history",
  trigger: (ctx) =>
    ctx.tokens > ctx.compactAt * ctx.maxTokens || hostRamPressure(),
}
```

### Meter

| Value | Counts |
| --- | --- |
| `history` (default) | `input.historyTokens` or local estimate of `history` only |
| `input` | Full prompt: `input.inputTokens` (before) or `tokens.input` (after) |

Provider `tokens` events always stream; they gate compaction only when
`meter: 'input'`.

### History estimate (`meter: 'history'`)

1. Host `historyTokens` wins when set.
2. Else estimate from `input.history`:
   - **Text** — tiktoken `o200k_base` (`HISTORY_TEXT_ENCODING`) over content,
     text parts, tool-call arguments. Loads **lazily** on first text estimate.
   - **Media** — stubs when size unknown (`HISTORY_MEDIA_TOKENS`: image/document
     258, audio 32, video 263).
   - Current-turn attachments/voice are **not** history.

### `previousExchanges`

| Value | Retain |
| --- | --- |
| `≥ 1` integer | That many recent user-started exchanges |
| `(0, 1)` fraction | Tail fitting in `fraction * maxTokens` (must be `< compactAt`) |
| `0` | Compact everything |

### Compaction profile

A compaction profile is a normal registered profile. Minimal summarizer:

```ts
registerProfile(defineProfile({
  type: "text",
  id: "my.compactor",
  identity: {
    handle: "Compactor",
    system: "Summarize this conversation concisely. Preserve unresolved issues, "
      + "decisions, and key facts.",
  },
  model: { /* allow + config */, maxSteps: 1, thinking: "none" },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: "my.summary.schema" },
  guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
}));
```

### After-turn signal

```ts
for await (const event of runTurn(req, provider)) {
  if (event.type === "done" && event.compaction?.needed) {
    const { history, tokens, meter, promptTokens } = event.compaction;
    // host runs compactor async, rewrites persisted history
  }
}
```

### Compaction exports

| Export | Role |
| --- | --- |
| `CompactionSpec` / `CompactionMeter` / `CompactionTriggerContext` | Config types |
| `CompactionSignal` | `done.compaction` payload |
| `CompactionSplit` / `CompactionTokens` | Split + resolved counts |
| `resolveHistoryTokens` / `resolveCompactionTokens` | Meter resolution |
| `estimateHistoryTokens` | Local BPE + media stubs |
| `compactionNeeded` / `shouldCompact` | Threshold / custom trigger |
| `splitForCompaction` | `{ toCompact, toRetain }` |

Register-time validation: `maxTokens > 0`, `compactAt ∈ (0,1)`, integer
`previousExchanges ≥ 1`, fractional `< compactAt`, meter ∈ `{history,input}`,
compaction profile registered first.

## Stop and resume

`TurnStopKind` values are the `TURN_STOP_KINDS` array in `src/kernel/schema.ts`.
Providers map native finish reasons into `TurnStop` on terminal `done` events.

| `kind` | Meaning |
| --- | --- |
| `completed` | Normal completion |
| `length` | Output / budget cut off |
| `tool` | Model requested tool use |
| `filtered` | Content filter |
| `provider_error` | Upstream failure |
| `cancelled` | User / host abort |
| `stream_incomplete` | Stream ended without terminal reason |

Mappers: `turnStopFromOpenAiFinishReason`, `turnStopFromInteractionStatus`,
`turnStopFromClientStreamEnd` (host SSE drop).

### Resume policy

```ts
outputs: {
  resume: {
    allowContinue: ['length', 'stream_incomplete', 'provider_error'],
    autoContinue: ['length', 'stream_incomplete'],
  },
}
```

| Constant / helper | Value / role |
| --- | --- |
| `DEFAULT_ALLOW_CONTINUE` | length, stream_incomplete, provider_error |
| `DEFAULT_AUTO_CONTINUE` | length, stream_incomplete |
| `AUTO_CONTINUE_DELAY_MS` | `1500` — suggested pause before one-shot auto-continue |
| `CONTINUE_INSTRUCTION` | Fixed continue system text (do not replace per app) |
| `isResumeableStop` | Profile `allowContinue` or default |
| `shouldAutoContinue` | One silent resume; never for `cancelled` |
| `isUserCancelledStop` | `kind === 'cancelled'` |

### Continue turn

```ts
for await (const event of runTurn({
  profile: "my.agent",
  input: { text: "" },
  continueFrom: {
    stop: previousDone.stop,
    partialText: bufferedAssistantText,
  },
}, provider)) { /* … */ }
```

`GenerationStopError` / `isGenerationStopError` optional throw path for hosts
that prefer exceptions over stream `done.stop`.

## Validation

Beyond compaction rules (above), `registerProfile` asserts:

- Each `tools.allow` id is a registered **custom** tool (builtins rejected here).
- Each `models.*.builtInTools` id is a registered **builtin**.
- Each key in `models` is a host-named model id with a full `ModelBinding`.
- Profiles with attachments or voice set `maxFiles`, `maxBytes`, `maxTurnBytes`.

Runtime structured validation uses `outputs.validation.fields` keyed by dotted
paths; failures can trigger repair turns via `input.repair`.

## Headless interface

Framework-neutral helpers for profile-driven runtime UIs. Import from
`@theorum/core/interface` or the root barrel.

`ProfileInterface` is `Profile` with resolved `inputs`/`tools` and a serializable
`guardrails` view — not a parallel schema. Projection flows through kernel
`projectProfileObject` / `projectProfile`; the interface layer only adds
`acceptAttr` on inputs.

| Concern | Entrypoints |
| --- | --- |
| Spec | `interfaceFrom`, `interfaceFromProfile`, `interfaceFromProjected` |
| Inputs | `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime` |
| Draft | `sanitizeUserDraft`, `prepareUserTurn` |
| Transcript | `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `streamThoughtsEnabled` |

```ts
import { interfaceFromProfile, foldTurnEvents, streamThoughtsEnabled } from '@theorum/core/interface';

const iface = interfaceFromProfile(profile);
const blocks = foldTurnEvents(events, { showThoughts: streamThoughtsEnabled(iface.outputs) });
```

Svelte or other UI layers map `ProfileInterface` and `TranscriptBlock` to
components; this module does not ship UI.

## Exported API

Live barrel: `src/kernel/mod.ts`. Type surface: `export type *` from
`types.ts` (all public kernel types).

| Group | Symbols |
| --- | --- |
| Compaction | `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `estimateHistoryTokens`, `HISTORY_MEDIA_TOKENS`, `HISTORY_TEXT_ENCODING`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Runner | `runTurn`, `runSession`, `RunSessionOptions`, `prepareLiveInboundText`, `liveIngressEnabled`, `liveIngressEnabledFromSpec`, `liveIngressChannelDefault`, `hasAnyLiveIngress`, `assertLiveIngress`, `assertLiveIngressConfigured`, `LiveIngressChannel` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaKindForMime`, `getTool`, `listBuiltinIds`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `registerTools`, `requireModelBinding`, `resetTools` |
| Schema | `PROFILE_FIELDS`, `PROFILE_TYPES`, `PROFILE_TYPE_PROTOCOLS`, `protocolsForProfileType`, `isValidProfileProtocol`, `EXTRA_FIELDS`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `PROTOCOLS`, `PROVIDERS`, `PROTOCOL_PROVIDERS`, `providersFor`, `protocolsFor`, `isValidPair`, `coerceProvider`, `coerceProtocol`, `coerceSpeechFormat`, `isSpeechFormatAllowedForProtocol`, `speechFormatsForProtocol`, `THINKING_LEVELS`, `KEY_SLOTS`, `OVERFLOW_KEY_SLOTS`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `SCHEMA_ENFORCEMENTS`, `COMPACTION_METERS`, `COMPACTION_TIMINGS`, `EGRESS_ON_BLOCK`, `TURN_STOP_KINDS`, `TOOL_LOAD_TIERS`, `LIVE_TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION`, `TOOL_TYPES`, `AUTH_UNAUTHENTICATED_POLICIES`, `HTTP_METHODS`, `PLAYGROUND_AUTH_TYPES`, `TOOL_AUTH_TYPES`, `AuthUnauthenticatedPolicy`, `CustomToolType`, `HttpMethod`, `PlaygroundAuthType`, `ToolAccess`, `ToolAuthType`, `ToolPermission`, `ToolType` |
| Profiles | `ProfileDefinition`, `ProfileDefinitionBase`, `TextProfileDefinition`, `ImageProfileDefinition`, `SpeechProfileDefinition`, `LiveProfileDefinition`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `resolveTurn` |
| Tools | `registerTool`, `registerTools`, `invokeTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `listBuiltinIds`, `listFunctionIds`, `resetTools`, `formatToolResult`, `prepareTurnToolSnapshot`, `buildHttpToolTarget`, `executeHttpTool`, `executeMcpTool`, `parseMcpRpcResponse`, `resolveToolAuth` |
| Guardrails (network) | `assertSafeUrl`, `isLocalhostName`, `isPrivateOrLocalAddress`, `NetworkGuardrailSpec` |
| Auth (stateless OAuth/PKCE) | `createOAuthPkceFlow`, `exchangeOAuthPkce`, `refreshOAuthToken`, `discoverResourceMetadata`, `discoverAuthServerMetadata`, `validateIssuer`, `generateCodeVerifier`, `computeCodeChallenge`, `sealStatePayload`, `unsealStatePayload` |
| Structured | `getStructured`, `registerStructured` |
| Stop / resume | `ProfileTurnResumptionSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `AUTO_CONTINUE_DELAY_MS`, `CONTINUE_INSTRUCTION`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |
| Interface (headless) | `interfaceFrom`, `interfaceFromProfile`, `interfaceFromProjected`, `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime`, `sanitizeUserDraft`, `prepareUserTurn`, `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `resetBlockIds`, `streamThoughtsEnabled`, `defaultInterfaceEffort`, `defaultInterfaceModel`, `effortSelectEnabled`, `generationSelectEnabled`, `interfaceEffortOptions`, `interfaceModelOptions`, `modelSelectEnabled`, `appendAssistantEventsToHistory`, `appendToolDenialToHistory`, `appendToolExchangeToHistory`, `appendUserDraftToHistory`, `historyFromTranscriptBlocks`, `applyTurnEventsToSession`, `branchInterfaceTurnSession`, `emptyInterfaceTurnSession`, `pausedToolFromEvents`, `promotedToolIdsFromEvents`, `toolSnapshotFromEvents`, `AttachmentValidationCode`, `AttachmentValidationIssue`, `AttachmentValidationResult`, `FoldTurnEventsOptions`, `ComposerProfileInterface`, `ImageProfileInterface`, `InterfaceEffortOption`, `InterfaceModelOption`, `LiveProfileInterface`, `LiveResolvedTools`, `PendingAttachment`, `PrepareUserTurnResult`, `ProfileGuardrailsView`, `ProfileInputsInterface`, `ProfileInterface`, `ProfileInterfaceSource`, `ResolvedTools`, `SpeechProfileInterface`, `TextProfileInterface`, `TranscriptBlock`, `TranscriptBlockKind`, `UserTurnDraft`, `UserTurnHistoryMedia`, `InterfaceTurnSession`, `PausedToolContext` |
| Attachments (kernel) | `maxBytesForMime`, `resolveMediaLimits`, `fileTooLargeMessage`, `tooManyFilesMessage`, `turnTooLargeMessage` |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Profiles": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/profiles.ts" },
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "source", "path": "src/kernel/schema.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/schema.test.ts" }
      ]
    },
    "Turn lifecycle": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/mod.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/steps.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/state.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/stream.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "source", "path": "src/kernel/registry/resolve.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Stream events": {
      "supports": [
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "source", "path": "src/kernel/engine/delta.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/delta.test.ts" }
      ]
    },
    "Registered tools": {
      "supports": [
        { "kind": "source", "path": "src/kernel/tools/mod.ts" },
        { "kind": "source", "path": "src/kernel/tools/execute.ts" },
        { "kind": "source", "path": "src/kernel/tools/resolve.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/steps.ts" },
        { "kind": "source", "path": "src/kernel/schema.ts" },
        { "kind": "source", "path": "src/guardrails/network.ts" },
        { "kind": "contract_test", "path": "tests/kernel/tools.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/network.test.ts" }
      ]
    },
    "Outputs and guardrails": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Compaction": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/compaction.ts" },
        { "kind": "source", "path": "src/kernel/engine/history-tokens.ts" },
        { "kind": "contract_test", "path": "tests/kernel/compaction.test.ts" }
      ]
    },
    "Stop and resume": {
      "supports": [
        { "kind": "source", "path": "src/kernel/stop.ts" },
        { "kind": "contract_test", "path": "tests/kernel/turnStop.test.ts" }
      ]
    },
    "Validation": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/profiles.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/schema-validation.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" }
      ]
    },
    "Headless interface": {
      "supports": [
        { "kind": "source", "path": "src/interface/mod.ts" },
        { "kind": "source", "path": "src/interface/from-profile.ts" },
        { "kind": "source", "path": "src/interface/inputs.ts" },
        { "kind": "source", "path": "src/interface/inputs.ts" },
        { "kind": "source", "path": "src/interface/blocks.ts" },
        { "kind": "contract_test", "path": "tests/interface/headless.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "source", "path": "src/interface/mod.ts" },
        { "kind": "source", "path": "src/kernel/auth/mod.ts" },
        { "kind": "source", "path": "src/guardrails/network.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/auth.test.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/network.test.ts" },
        { "kind": "contract_test", "path": "tests/interface/headless.test.ts" }
      ]
    }
  }
}
```
