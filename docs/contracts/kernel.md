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
| `type` | Wire archetype discriminator: `'text'`, `'image'`, `'speech'`, `'live'`, `'host'` (`PROFILE_TYPES`) |
| `identity` | `handle`, optional `system` / `systemByRole` — absent on `host` |
| `model` | `protocol`, `provider`, `allow`, `config`, optional `select` / `thinking` / `controls` / `maxSteps` / `key` — absent on `host` |
| `tools` | Allowlist ceiling (`allow: ToolId[]`) — present on `text`, `image`, `live`, `host` |
| `inputs` | Text / attachments / voice / slots / per-mime limits — present on `text`, `image`; absent on `speech` and `live` (live uses `live.ingress` instead) |
| `image` / `speech` / `live` | Modality-specific pins (top-level, not nested under `outputs`) |
| `outputs` | Structured, streaming, validation — present on `text`, `image`, `speech`; absent on `live` |
| `turnBehaviour` | `resumption` (`allowContinue`, `autoContinue`, `maxContinues`) on `text` / `image` / `speech`; `allowSteering` on **text and live** (inject gate via `profileAllowsInject`; see [`stages.md`](stages.md)). Live must omit `turnBehaviour.resumption` (use `live.sessionResumption`) |
| `guardrails` | Quota, canary, sanitize, redact, egress, network, taint — on `host` narrowed to `HostGuardrailsSpec` |
| `observability` | Trace destination, scrub, include, sampling (`writeTo`, `sampleRate`, …) |

Closed unions (`protocol`, `provider`, `thinking`, stop kinds, turn stages,
MIME maps, …) live as `as const` arrays in `src/kernel/schema.ts`. Types are
derived from those arrays. `TURN_STAGES` / `TOOL_GATE_KINDS` /
`AWAITING_USER_INPUT_*` are foundation for the stages cutover
([`stages.md`](stages.md)); text `runTurn` mid-turn inject uses `TURN_STAGES` /
`onStage`. `PROFILE_FIELDS` / `fieldMeta` document every authoring
path so host UIs and docs hover the live kernel types instead of copying them.
`PROFILE_GRAPH` projects those sections into the playground authoring graph
(spine / branch / optional); the frontend must import it rather than inventing
facet kinds. Drift is gated by `tests/kernel/profile-graph.test.ts`.

Multimodal ingress uses provider-neutral `InteractionPart` values;
`InteractionMediaPart.type` is `MediaInputKind` (`image` | `audio` | `video` |
`document`). MIME → kind mapping lives in `MEDIA_INPUT_KINDS` (`schema.ts`)
and is applied by `mediaKindForMime` (`catalog.ts`).

`MEDIA_INPUT_KINDS` is the package's complete media-input vocabulary — every
MIME any supported transport can take on a turn, and nothing else. It is the
union of the documented provider input lists: Google Interactions / Live
(images `png`, `jpeg`, `webp`, `heic`, `heif`; audio `wav`, `mp3`, `mpeg`,
`aiff`, `aac`, `ogg`, `flac`, `m4a`, `l16`, `opus`, `alaw`, `mulaw`, `webm`;
video `mp4`, `mpeg`, `mov`, `avi`, `x-flv`, `mpg`, `webm`, `wmv`, `3gpp`;
documents `application/pdf`, `text/plain`, `text/html`, `text/css`,
`text/markdown`/`text/md`, `text/csv`, `text/xml`, `text/rtf`,
`text/javascript`/`application/x-javascript`,
`text/x-python`/`application/x-python`, `application/json`), verified
2026-09-12, plus
provider alias essences (`image/jpg`, `audio/x-wav`, `video/x-ms-wmv`, …). The
OpenAI-compat adapters forward a part's MIME verbatim on every `MediaInputKind`,
so their accepted set is open-ended and contributes no additional rows; what
they cannot carry — a `uri` reference part — is refused at request time with
`TheorumError` rather than by a second MIME table (see
`docs/contracts/providers.md`).

A host declares what it accepts only in `inputs.attachments.accept` /
`inputs.voice.accept`. `mediaChannelForMime(profile, mime)` (`catalog.ts`) is the
public answer to "does this profile take this file, and on which `TurnInput`
channel" — hosts filter and route channel ingress with it and keep no MIME table
of their own. `resolveInputParts` applies the same acceptance on the turn and
throws `TheorumError` for a MIME the profile does not accept.

Turn media arrives on `TurnInput.attachments` as either inline bytes or a
provider file reference:

| Input | Shape | Ingress |
| --- | --- | --- |
| `TurnBlob` | `{ mimeType, data }` (base64) | MIME acceptance, kind resolution, base64 check, per-file / per-turn byte limits, text-MIME sanitization |
| `TurnMediaRef` | `{ mimeType, uri }` (e.g. Gemini Files `files/<id>`) | MIME acceptance and kind resolution only — no base64 or byte limits; the host owns upload and cleanup |
| `InteractionMediaRefPart` | `{ type: MediaInputKind, mimeType, uri }` | Provider part emitted for a `TurnMediaRef`; `isMediaRefPart` narrows it |

`wireInteractionPart` emits `{ type, mimeType, uri }` for a reference part; the
Google Interactions adapter snake-cases it to the documented Files input
`{ "type": "video", "uri": "files/<id>", "mime_type": "video/mp4" }`. Every other
adapter (OpenAI compat, AI SDK, Gemini Live) throws `TheorumError` for reference
parts — see `docs/contracts/providers.md`.

`models.*.protocol` is `PROTOCOLS` (`geminiInteractions` | `openAi` | `geminiLive`).
`models.*.provider` is `PROVIDERS` (`google` | `openrouter` | `local`).
Legal pairs are `PROTOCOL_PROVIDERS`; `createProvider` rejects anything
outside `isValidPair`. `providersFor` / `protocolsFor` / `coerceProvider` /
`coerceProtocol` are the same table.
Each `ModelBinding` in `profile.models` carries wire ids (`apiId`), optional
`efforts` / `defaultEffort`, `summaries`, `maxOutputTokens`, `temperature`,
`builtInTools`, optional vault `key`, optional `compaction`, optional OpenRouter
`cache` (`mode` / `ttl`; openrouter-only), and Gemini Interactions optional
`store` / `persistViaInteractionId` (Interactions-only).

`TurnRequest.sessionId` is an optional sticky routing key forwarded to OpenRouter
as `session_id` (distinct from `projectId` and Gemini `previousInteractionId`).

`TurnTokens` may include `cached` / `cacheWrite` when the provider reports cache
read/write counts.

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
gate boundary, not socket teardown). When `sink` is omitted, the runner resolves
`profile.observability` via `resolveTraceWriter` (named destination, inline
sink, or noop). An explicit third-argument sink always wins for that call.

Text turns emit **stage** events and invoke optional `TurnRequest.onStage`
(`docs/contracts/stages.md`): `pre_turn` before the first provider step;
`post_tool` after each settled tool; `before_end` before egress/validation
finalize (inject may re-enter the step loop under `maxSteps`); terminal `done`;
then `post_turn`. Inject requires `profileAllowsInject` (`allowSteering` on
text). Invalid affordances yield a follow-up `stage` event with `stageWarnings`.
AbortSignal / stage `abort` end with cancelled `done` then `post_turn`.
Live sessions emit the same stage names around utterance cycles and
`LiveSession.executeTool` (`docs/contracts/stages.md`).

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
5. **`pre_turn`** — stage emit + optional `onStage` (may fold opening input /
   inject).
6. **Provider stream** — `provider.complete` yields partial events; runner may
   gate thoughts/media per `outputs.streaming`.
7. **Tool loop** — while under `maxSteps`, tool calls execute via `executeRegisteredTool`
   (shared with `invokeTool`), threading host `credentials` for authenticated HTTP/MCP tools and the opaque `host` context slot; `pre_tool` / `post_tool` stages + `preTool` run on that path. After each
   settled tool, `post_tool` may inject. Gate (`stop.kind: 'gate'`) suspends the batch. `generation.transport` selects
   Interactions continuation (`previous_interaction_id` + `function_result` steps) vs
   OpenAI-compat tool-call history. Server-side `codeExecution` does not consume a runner step.
8. **`before_end`** — stage before egress/validation; inject re-enters the step
   loop when under `maxSteps`.
9. **Validation / repair** — structured output validators (`outputs.validation`)
   may trigger repair turns with `input.repair`.
10. **Egress** — progressive-yield lookback on the provider stream (canary,
   sensitive/PII, host `guardrails.egress.enforce`) releases cleared prefixes
   while holding a rolling window; end-of-attempt may still refuse, repair, or
   withhold. SSE streaming and egress can both stay enabled.
11. **Trace** — optional sink receives a `TraceRecord`; failures are swallowed.
   Runner threads `profile.model.protocol` and upstream tap rows (`tapUpstream`).
   Interactions turns snapshot `wire` via `toInteractionsBody`; OpenAI-compat turns
   omit wire and classify ok/cancelled from terminal `done.stop` on the event stream.
12. **Terminal `done` then `post_turn`** — one `done` event with tokens, optional
    `stop`, optional `compaction` signal (`timing: 'after'`), then observe-only
    `post_turn`.

`continueFrom` on `TurnRequest` prepends `CONTINUE_INSTRUCTION` and carries
partial assistant text/artifact from a resumeable stop.

`runTurn`, `runSession`, `resolveTurn`, and `projectProfile` refuse a `'host'`
profile with `TheorumError` (`requireModelProfile`); host profiles only execute
tools through `invokeTool`.

Optional `compactionProvider` on `TurnRequest` when the compactor profile uses a
different transport than the primary turn.

## Stream events

`runTurn` and adapters yield `TurnEvent`:

| `type` | Payload highlights |
| --- | --- |
| `thought` | Model reasoning stream (may be gated) |
| `text` | User-visible assistant text |
| `tool` | Tool call (`phase`: `running` / `progress` / `complete` / `gate` / `error` / `cancel`, …; `pause` deprecated) |
| `structured` | Parsed JSON object when schema enforced |
| `media` | Generated image/audio bytes + mime |
| `grounding` | Search/maps grounding metadata (classic `grounding_metadata` and Interactions tool results such as `google_search_result.search_suggestions`, `google_maps_result.result[].places`, and `place_citation` annotations). Normalized to `sources` plus classic `chunks[].maps` (`title` / `uri` / `placeId`) |
| `evidence` | Provider-native attachments. Google code execution sets `kind` (`code_execution_call` / `code_execution_result`) plus parsed `code` / `result` / `isError` / `id` / `callId`, and always keeps `raw`. Live ASR uses `input_transcription` / `output_transcription` (optional `interim`); session resumption uses `session_resumption` + `resumable`. |
| `session` | Live control: `closing_soon` (optional `timeLeftMs`), `waiting_for_input` |
| `stage` | Turn timeline (`stage`: `pre_turn` \| `pre_tool` \| `post_tool` \| `before_end` \| `post_turn`) — see [`stages.md`](stages.md) |
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
`models.*.builtInTools`. On `text` / `image` turns visibility is `loadTier` (T0 at
turn start, T1 via `tools.t1Policy`, T2 via `tools.t2Loader`). On `live` every
allowed tool (and every model builtin) is wired at session setup regardless of
`loadTier`; on `host` every allowed tool is executable with no tiers and no path
gating.

### Host context slot

Application context reaches tool hooks through one opaque slot. The kernel never
reads, logs, traces, or serializes it — it is not on `TurnEvent`, `ToolPause`,
pause `input`, `TraceRecord`, or `ProviderCompleteRequest`.

| Field | Reaches |
| --- | --- |
| `TurnRequest.host?: unknown` | `ToolContext.host` for every tool the turn executes; `ToolLoadContext.host` for `tools.t1Policy` |
| `InvokeToolRequest.host?: unknown` | Same, for a host-initiated `invokeTool` |
| `InvokeToolRequest.onStage?: StageHandler` | Optional `pre_tool` / `post_tool` only ([`stages.md`](stages.md)) |
| `ToolContext.host?: unknown` | Read by `handler`, `preTool` |
| `ToolLoadContext.host?: unknown` | Read by `tools.t1Policy` |

`SessionRequest` has no host slot today. Target stages attach `SessionRequest.onStage`
for the session lifetime (immutable; no `setOnStage`) and require
`LiveSession.executeTool` for live tool execute — see [`stages.md`](stages.md).
Until that cutover, hosts still execute live tool calls through `invokeTool`.

### Session snapshot across a process boundary

`SessionRequest.snapshot?: TurnToolSnapshot` lets a relay process that does not
own the tool registry open a session. The registry-owning process resolves the
snapshot with `prepareTurnToolSnapshot(profile, request, modelId)` and hands it
across as data; `runSession` declares `snapshot.wire` at setup instead of
resolving locally. The profile's `tools.allow` remains the ceiling: any custom
id in the snapshot outside it is refused with `TheorumError`. Without a snapshot
and without the registry, a session declares no tools.

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

// Host resume for pre_tool gates (permission / confirm / auth) — pass snapshot from gate `done.tools`
invokeTool({ profile, name: 'risky_tool', input: {...}, resume: { granted: true }, snapshot, turnInput });
// ask_user completes with awaiting_user_input; answers are a new user turn (not resume on same call_id)
// T2 resume after loader: include `promoted: ['record_lookup']` (or rely on snapshot.visible when emitted on `done`)
invokeTool({ profile, name: 'record_lookup', input: {...}, resume: { value: true }, snapshot, promoted: ['record_lookup'], turnInput });

// Tool `preTool` returning `confirm` gates once; `resume.granted: true` skips preTool on the next invoke (same as `always_confirm` permission).

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
Remote MCP tools (`type: 'mcp'`) call external Model Context Protocol servers over Streamable HTTP.
The preferred revision is `2026-07-28`; the kernel negotiates downward through
`MCP_PROTOCOL_VERSIONS` (`2026-07-28` → `2025-11-25` → `2025-06-18` → `2025-03-26`)
when a server rejects an unsupported protocol version (JSON-RPC or HTTP error body).

Both HTTP and MCP tools integrate with:
- **Network Guardrails** (`guardrails.network`): SSRF protection blocking loopback and private subnets unless `allowPrivateNetworks: true` is configured. Owned by the guardrails contract — see `docs/contracts/guardrails.md#network`.
- **Stateless OAuth 2.1 & PKCE** (`theorum/auth`): RFC 7636 PKCE S256, RFC 9728 discovery, RFC 8414 AS metadata, RFC 9207 `iss` mix-up defense, RFC 8707 resource indicators, and stateless HMAC-signed state envelopes.
- **Unauthenticated Handling**: Gates the turn via `ToolGate { kind: 'auth' }` (`tool.phase: 'gate'`, `stop.kind: 'gate'`) or reports synthetic error findings to the model per `onUnauthenticated: 'pause' | 'report_to_model'` (schema policy name remains `pause`).
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
| `tools` | yes | `{ allow: ToolId[] }` only — every allowlisted id and every model `builtInTools` id is wired once at Gemini Live setup regardless of `loadTier` (declarations cannot be added mid-session, so on live every allowed tool is effectively T0) |
| `guardrails` | optional | Canary, sanitize, egress (live outbound gate) |
| `inputs` | **no** | Turn file attachments — use `live.ingress` for realtime channels instead |
| `outputs` | **no** | No structured JSON or SSE/buffered turn streaming on Gemini Live |
| `turnBehaviour` | **no** | Use `live.sessionResumption` + `SessionRequest.sessionResumptionHandle` |
| `tools.t1Policy` / `tools.t2Loader` | **no** | Declarations are fixed after setup; the whole allow list is the session declaration set |

### Host profile (`type: 'host'`)

A `host` profile is the explicit tool ceiling for host-driven execution — MCP
servers, web UIs, schedulers — and never runs a model. `invokeTool` under a
`host` profile executes any tool in `tools.allow` with no visibility or loading
tiers and no path gating; `preTool`, permission/auth **gates**, and the
tool-result guardrails (`resolveGuardrailPolicy(profile.guardrails)`) apply
unchanged.

`guardrails` on a host profile is `HostGuardrailsSpec` — a `Pick` of the one
guardrail vocabulary, not a second hierarchy. It carries only the switches that
fire on the `invokeTool` path: `sanitizeInput` and `redactSensitive` (the
detectors run over model-supplied arguments, tool result text, and tool failure
text), `network` (SSRF clearance for declarative HTTP and MCP targets), and
`taint` (the confused-deputy gate, plus its advisory guidance on fenced remote
results). `defineProfile` throws a `TheorumError` naming the field for
`guardrails.quota`, `guardrails.canary`, and `guardrails.egress`: a host profile
runs no model, so quota counts nothing, no system prompt exists for a canary to
bind to, and egress gates user-visible model text in the turn runner, which a
host profile never enters.

| Block | On host? | Notes |
| --- | --- | --- |
| `tools` | yes | `{ allow: ToolId[] }` — registered function tools only (`HostProfileToolsSpec`); builtins are rejected |
| `guardrails` | optional | `HostGuardrailsSpec` only — `sanitizeInput`, `redactSensitive`, `network`, `taint` |
| `observability` | optional | Same shape as every other profile |
| `models` / `identity` / `inputs` / `outputs` / `turnBehaviour` / `key` / `maxSteps` | **no** | `registerProfile` rejects them when supplied |

`resolveTurnTools` for a host profile yields `gated = visible = executable =
tools.allow`, `builtins = []`, and `wire` from `buildWire`. `expandT1Policy`,
`promoteLoadedTools`, and the T2 loader promotion are no-ops. `ModelProfile`
(`Exclude<Profile, HostProfile>`) names every type that binds models;
`requireModelProfile` narrows to it and throws for `host`.

Profile `turnBehaviour` (top-level on chat/image/speech):

| Field | Effect |
| --- | --- |
| `resumption.allowContinue` | Stop kinds eligible for a continueFrom turn |
| `resumption.autoContinue` | Stop kinds the host may auto-continue without a CTA |
| `resumption.maxContinues` | Max continueFrom rounds the kernel accepts (enforced) |
| `allowSteering` | **Text and live.** Gates **inject** via `profileAllowsInject` / stages. Stage events always emit. Image/speech must omit |

Stop / cancel is not a profile field: composer `ProfileInterface` always projects `canStop: true`
(`TurnRequest.signal`). Text interfaces also project resolved `allowSteering`.

### Mid-turn steering

**Branch:** stage events + `onStage` — [`docs/contracts/stages.md`](stages.md).
Text and live mid-turn / mid-cycle inject use stages (`onStage`). Tool `pre_tool`
gates and `LiveSession.executeTool` are on the same contract.

On text turns the runner always yields `{ type: 'stage', stage }`:

1. `pre_turn` — once before the first provider step (fold opening input when `onStage` is set).
2. `post_tool` — per settled tool call (inject window before the next model step).
3. `before_end` — before egress/validation; inject may re-enter the step loop under `maxSteps`.
4. `post_turn` — after terminal `done` (sees compaction-after when attached).

Inject applies only when `profileAllowsInject(profile)` (text + live when
`allowSteering !== false`).

```ts
for await (const event of runTurn({
  profile: 'my.agent',
  input: { text: 'first message' },
  onStage: ({ stage }) => {
    if (stage === 'post_tool' && pendingFollowUp) {
      return { inject: [{ role: 'user', content: pendingFollowUp }] };
    }
  },
}, provider)) {
  if (event.type === 'stage') {
    // UI: safe point to flush a client-held follow-up via host onStage
  }
}
```

Orchid-style durable absorb belongs in the host `onStage` implementation (claim/accept/consume), not in the kernel.

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

## Prompt cache (OpenRouter)

Optional per-model `ModelBinding.cache` (openrouter-only):

```ts
cache: { mode: "automatic" | "system", ttl?: "5m" | "1h" }
```

- `automatic` — top-level `cache_control` on the OpenRouter request.
- `system` — `cache_control` on the system instruction only.
- Omit — no opt-in (some upstream models may still auto-cache).

Pass `TurnRequest.sessionId` for OpenRouter sticky `session_id` routing.
`TurnTokens.cached` / `cacheWrite` report provider cache read/write when present
(Google Interactions implicit hits via `total_cached_tokens` included).

## Stop and resume

`TurnStopKind` values are the `TURN_STOP_KINDS` array in `src/kernel/schema.ts`.
Providers map native finish reasons into `TurnStop` on terminal `done` events.

| `kind` | Meaning |
| --- | --- |
| `completed` | Normal completion |
| `length` | Output / budget cut off |
| `tool` | @deprecated Shipping pause fiction (`tool.phase: 'pause'`). Target: `gate` for confirm/permission/auth; awaiting is a completed tool result ([`stages.md`](stages.md)) |
| `gate` | Target / foundation: honest `pre_tool` suspension (confirm / permission / auth). Host resumes via `invokeTool` / `executeTool` |
| `filtered` | Content filter |
| `provider_error` | Upstream failure |
| `cancelled` | User / host abort |
| `stream_incomplete` | Stream ended without terminal reason |
| `interrupted` | Live barge-in |
| `generation_complete` | Live utterance boundary |

Mappers: `turnStopFromOpenAiFinishReason`, `turnStopFromInteractionStatus`,
`turnStopFromClientStreamEnd` (host SSE drop).

### Resume policy

`allowContinue` / `autoContinue` accept only `ContinueStopKind`
(`CONTINUE_STOP_KINDS`: `length` | `stream_incomplete` | `provider_error`).
`tool` uses host `invokeTool` + `resume`. `cancelled` / `completed` / `filtered` /
live boundaries are not continueFrom-eligible — `defineProfile` rejects them.

```ts
turnBehaviour: {
  resumption: {
    allowContinue: ['length', 'stream_incomplete', 'provider_error'],
    autoContinue: ['length', 'stream_incomplete'],
  },
  // text only — omit on image/speech
  allowSteering: true,
}
```

| Constant / helper | Value / role |
| --- | --- |
| `CONTINUE_STOP_KINDS` | length, stream_incomplete, provider_error |
| `DEFAULT_ALLOW_CONTINUE` | = `CONTINUE_STOP_KINDS` |
| `DEFAULT_AUTO_CONTINUE` | length, stream_incomplete |
| `AUTO_CONTINUE_DELAY_MS` | `1500` — suggested pause before one-shot auto-continue |
| `CONTINUE_INSTRUCTION` | Fixed continue system text (do not replace per app) |
| `isContinueStopKind` | Narrow to continue-eligible kinds |
| `isResumeableStop` | Profile `allowContinue` or default; always false outside ContinueStopKind |
| `shouldAutoContinue` | One silent resume; never outside ContinueStopKind |
| `isUserCancelledStop` | `kind === 'cancelled'` |
| `profileTurnResumption` | Read `turnBehaviour.resumption` |
| `profileAllowsSteering` | Text + `allowSteering !== false` (interface inject projection) |
| `profileAllowsInject` | Stage inject gate: text + live when `allowSteering !== false`; never image / speech / host ([`stages.md`](stages.md)) |

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

Beyond compaction rules (above), `registerProfile` / `defineProfile` assert:

- Each `tools.allow` id is a registered **custom** tool (builtins rejected here).
- Each `models.*.builtInTools` id is a registered **builtin**.
- Each key in `models` is a host-named model id with a full `ModelBinding`.
- Profiles with attachments or voice set `maxFiles`, `maxBytes`, `maxTurnBytes`.
- `models.*.cache` only when `protocol: 'openAi'` and `provider: 'openrouter'`.
- `models.*.store` / `persistViaInteractionId` only when
  `protocol: 'geminiInteractions'` and `provider: 'google'`.
  **Breaking:** previously these fields were accepted on any binding and ignored
  at runtime; `defineProfile` now rejects them outside Interactions+google.

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

`foldTurnEvents` maps kernel `media` events (base64) and also promotes http(s)
image / video / audio URLs found in completed tool `output` into `media` blocks
with `url` set (extension-based MIME guess). Tool JSON in the tool block is
unchanged. `historyFromTranscriptBlocks` still ignores media blocks — the tool
exchange already carries the URL.
| History | `appendUserDraftToHistory`, `userDraftToSteerInject`, … |
| Composer intents | `createComposerPendingMessage`, `orderComposerPendingMessages`, `consumeNextComposerSteer` / `Queue`, `convertSteersToFrontQueued`, `resolveComposerPrimary`, `resolveComposerMenuActions` |

### Composer pending intents

Headless contract for stash / queue / steer (Seance-aligned). Kernel owns stages +
`onStage` inject + `AbortSignal`; the interface owns pending list ops and the action matrix;
`@theorum/react` owns UI.

| Intent | Lifetime |
| --- | --- |
| `stash` | Never auto-sent; user promotes |
| `queue` | New user turn after the **agent run fully ends** (not on tool pause resolve) |
| `steer` | Inject at next inject-capable stage via host `onStage` (same run — `docs/contracts/stages.md`) |
| `send_now` | Immediate abort + send (not a pending kind) |

Primary matrix: idle+payload → Send; streaming+empty → Stop; streaming/gated+payload → Queue.
Enter matches primary. Menu offers Queue / Steer / Send now / Stash as applicable.
Undelivered steers convert to the front of the queue when the run ends.
Tool **gate** does not drain the queue and does not offer Steer (not an inject stage).
Send now while gated uses `abandonGatedToolSession` (alias `abandonPausedToolSession`)
then starts a new user turn. Awaiting completions (`ask_user`) are not composer
`gated` — the turn may already be idle; use `awaitingFromEvents`.

```ts
import { interfaceFromProfile, foldTurnEvents, streamThoughtsEnabled } from '@theorum/core/interface';

const iface = interfaceFromProfile(profile);
const blocks = foldTurnEvents(events, { showThoughts: streamThoughtsEnabled(iface.outputs) });
```

React or other UI layers map `ProfileInterface` and `TranscriptBlock` to
components; this module does not ship UI.

## Exported API

Live barrel: `src/kernel/mod.ts`. Type surface: `export type *` from
`types.ts` (all public kernel types).

| Group | Symbols |
| --- | --- |
| Compaction | `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `estimateHistoryTokens`, `HISTORY_MEDIA_TOKENS`, `HISTORY_TEXT_ENCODING`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Runner | `runTurn`, `runSession`, `RunSessionOptions`, `prepareLiveInboundText`, `liveIngressEnabled`, `liveIngressEnabledFromSpec`, `liveIngressChannelDefault`, `hasAnyLiveIngress`, `assertLiveIngress`, `assertLiveIngressConfigured`, `LiveIngressChannel` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaChannelForMime`, `MediaInputChannel`, `mediaKindForMime`, `getTool`, `listBuiltinIds`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `registerTools`, `requireModelBinding`, `resetTools` |
| Schema | `PROFILE_FIELDS`, `PROFILE_GRAPH`, `PROFILE_TYPES`, `PROFILE_TYPE_PROTOCOLS`, `protocolsForProfileType`, `isValidProfileProtocol`, `EXTRA_FIELDS`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `spineFacetsForProfileType`, `profileGraphFacet`, `ProfileGraphFacet`, `ProfileGraphFacetId`, `ProfileGraphEditor`, `ProfileGraphRole`, `PROTOCOLS`, `PROVIDERS`, `PROTOCOL_PROVIDERS`, `providersFor`, `protocolsFor`, `isValidPair`, `coerceProvider`, `coerceProtocol`, `coerceSpeechFormat`, `isSpeechFormatAllowedForProtocol`, `speechFormatsForProtocol`, `THINKING_LEVELS`, `KEY_SLOTS`, `OVERFLOW_KEY_SLOTS`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `SCHEMA_ENFORCEMENTS`, `COMPACTION_METERS`, `COMPACTION_TIMINGS`, `CACHE_MODES`, `CACHE_TTLS`, `TURN_STOP_KINDS`, `CONTINUE_STOP_KINDS`, `TURN_STAGES`, `TURN_INJECT_STAGES`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION`, `TOOL_TYPES`, `AUTH_UNAUTHENTICATED_POLICIES`, `HTTP_METHODS`, `PLAYGROUND_AUTH_TYPES`, `TOOL_AUTH_TYPES`, `AuthUnauthenticatedPolicy`, `CustomToolType`, `HttpMethod`, `PlaygroundAuthType`, `ToolAccess`, `ToolAuthType`, `ToolPermission`, `ToolType`, `ToolGateKind`, `TurnStage`, `TurnInjectStage`, `AwaitingUserInputKind`, `EGRESS_ON_BLOCK`, `EgressOnBlock` |
| Profiles | `ProfileDefinition`, `ProfileDefinitionBase`, `TextProfileDefinition`, `ImageProfileDefinition`, `SpeechProfileDefinition`, `LiveProfileDefinition`, `HostProfileDefinition`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `projectProfileObject`, `requireModelProfile`, `resolveTurn` |
| Tools | `registerTool`, `registerTools`, `invokeTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `listBuiltinIds`, `listFunctionIds`, `resetTools`, `formatToolResult`, `projectForModel`, `coerceToolResultParts`, `leanToolResultData`, `wireInteractionPart`, `isMediaRefPart`, `prepareTurnToolSnapshot`, `buildHttpToolTarget`, `executeHttpTool`, `executeMcpTool`, `parseMcpRpcResponse`, `isUnsupportedMcpProtocolError`, `MCP_PROTOCOL_VERSIONS`, `McpProtocolVersion`, `resolveToolAuth` |
| Auth (stateless OAuth/PKCE) | `createOAuthPkceFlow`, `exchangeOAuthPkce`, `refreshOAuthToken`, `discoverResourceMetadata`, `discoverAuthServerMetadata`, `validateIssuer`, `generateCodeVerifier`, `computeCodeChallenge`, `sealStatePayload`, `unsealStatePayload` |
| Structured | `getStructured`, `registerStructured` |
| Stop / resume | `ProfileTurnBehaviourSpec`, `ProfileTurnResumptionSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `ContinueStopKind`, `CONTINUE_STOP_KINDS`, `AUTO_CONTINUE_DELAY_MS`, `CONTINUE_INSTRUCTION`, `DEFAULT_ALLOW_CONTINUE`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isContinueStopKind`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `profileAllowsSteering`, `profileAllowsInject`, `profileTurnResumption`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |
| Stages (target foundation) | `TURN_STAGES`, `TURN_INJECT_STAGES`, `STAGE_AFFORDANCES`, `STAGE_AFFORDANCE_MATRIX`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `applyStageResult`, `parseAwaitingUserInput`, `parseToolGate`, `isTurnStage`, `isTurnInjectStage`, `isToolGateKind`, `isAwaitingUserInput`, `stageAllowsAffordance`, `stageEventFields`, `profileAllowsInject`, `StageAffordance`, `StageContext`, `StageResult`, `StageHandler`, `StageApplyInput`, `StageApplyOutput`, `StageApplyWarning`, `StageApplyWarningCode`, `StageEventExtra`, `AwaitingUserInput`, `ToolGate` — see [`stages.md`](stages.md). Text `runTurn` + tool execute cutover landed; live still outstanding. |
| Interface (headless) | `interfaceFrom`, `interfaceFromProfile`, `interfaceFromProjected`, `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime`, `sanitizeUserDraft`, `prepareUserTurn`, `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `resetBlockIds`, `streamThoughtsEnabled`, `collectPromotedMediaFromToolOutput`, `promotedMediaFromUrlString`, `PromotedToolMedia`, `defaultInterfaceEffort`, `defaultInterfaceModel`, `effortSelectEnabled`, `generationSelectEnabled`, `interfaceEffortOptions`, `interfaceModelOptions`, `modelSelectEnabled`, `appendAssistantEventsToHistory`, `appendToolDenialToHistory`, `appendToolExchangeToHistory`, `appendUserDraftToHistory`, `historyFromTranscriptBlocks`, `applyTurnEventsToSession`, `branchInterfaceTurnSession`, `emptyInterfaceTurnSession`, `abandonGatedToolSession`, `abandonPausedToolSession`, `gatedToolFromEvents`, `pausedToolFromEvents`, `awaitingFromEvents`, `promotedToolIdsFromEvents`, `toolSnapshotFromEvents`, `COMPOSER_PENDING_KINDS`, `COMPOSER_MENU_ACTION_DESCRIPTIONS`, `COMPOSER_MENU_ACTION_LABELS`, `COMPOSER_PRIMARY_LABELS`, `cloneUserTurnDraft`, `composerPendingPreview`, `consumeNextComposerQueue`, `consumeNextComposerSteer`, `convertSteersToFrontQueued`, `createComposerPendingMessage`, `moveComposerPendingWithinKind`, `orderComposerPendingMessages`, `promoteComposerPendingKind`, `removeComposerPendingMessage`, `resolveComposerMenuActions`, `resolveComposerPrimary`, `updateComposerPendingDraft`, `userDraftHasPayload`, `userDraftToSteerInject`, `AttachmentValidationCode`, `AttachmentValidationIssue`, `AttachmentValidationResult`, `AwaitingToolContext`, `ComposerActionContext`, `ComposerMenuAction`, `ComposerPendingKind`, `ComposerPendingMessage`, `ComposerPrimaryAction`, `ComposerProfileInterface`, `ComposerRunPhase`, `CreateComposerPendingMessageArgs`, `FoldTurnEventsOptions`, `GatedToolContext`, `ImageProfileInterface`, `InterfaceEffortOption`, `InterfaceModelOption`, `LiveProfileInterface`, `LiveResolvedTools`, `PendingAttachment`, `PrepareUserTurnResult`, `ProfileGuardrailsView`, `ProfileObservabilityView`, `ProfileInputsInterface`, `ProfileInterface`, `ProfileInterfaceSource`, `ResolvedTools`, `SpeechProfileInterface`, `TextProfileInterface`, `TranscriptBlock`, `TranscriptBlockKind`, `UserTurnDraft`, `UserTurnHistoryMedia`, `InterfaceTurnSession`, `PausedToolContext` |
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
        { "kind": "source", "path": "src/kernel/engine/runner/stages.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/state.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/stream.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "source", "path": "src/kernel/registry/resolve.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/turn-stages.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/abort.test.ts" }
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
        { "kind": "source", "path": "src/interface/blocks.ts" },
        { "kind": "source", "path": "src/interface/pending.ts" },
        { "kind": "source", "path": "src/interface/composer-actions.ts" },
        { "kind": "contract_test", "path": "tests/interface/headless.test.ts" },
        { "kind": "contract_test", "path": "tests/interface/composer-pending.test.ts" },
        { "kind": "contract_test", "path": "tests/interface/abandon-paused.test.ts" }
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
