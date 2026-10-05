# Kernel (`@theoremjs/agents/kernel`)

Type-first contracts for profiles, turns, tools, compaction, stop/resume, and
`runTurn`. Import here when a host needs the kernel surface without pulling
provider adapters.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/kernel` / `jsr:@theoremjs/agents/kernel` |
| Module | `src/kernel/mod.ts` |
| Schema subpath | `@theoremjs/agents/schema` → `src/kernel/schema.ts` |
| Interface subpath | `@theoremjs/agents/interface` → `src/interface/mod.ts` ([Headless interface](#headless-interface)) |
| Also on | Root `@theoremjs/agents` / `mod.ts` re-exports the same interface helpers and many kernel exports |

## Ownership

| Scope | Path |
| --- | --- |
| Tree | `src/kernel/` (engine, registry, `stop.ts`, `types.ts`) |

## Facts and policy

**Rule: "Host decides, Theorem runs."** Two hosts shipping contradictory
products can run the same unforked kernel version; no end user and no model
may observe a decision the host did not make.

**Facts vs policy.** Provider facts may ship (model capabilities, wire shapes,
protocol metadata — presets/google). Product policy may not (prompts, personas,
end-user copy, demo apps, channel behavior). The kernel may ship overridable
defaults for mechanism text via the guardrails lexicon; it may not ship
unreplaceable copy or bundled product. Demo fixtures live in the repo-private
`playground/` package (`@theoremjs/playground`), never in the published artifact.

| Id | Property |
| --- | --- |
| P1 | No ambient authority — `defineProfile` / `createProvider` succeed with every Deno permission denied (no env, net, read, write, run, ffi, sys). Deno loads the static module graph without consulting the permission system; construction must not exercise ambient I/O beyond that (`tests/kernel/zero-permission-import.test.ts`) |
| P2 | No unownable words — every user- or model-visible string is host-supplied or an overridable registered lexicon default |
| P3 | No buried policy — behavioral defaults are declared typed profile-schema fields, never only implementation constants |
| P4 | Inert extras — deleting optional packages (playground) changes no kernel behavior |

Continue-instruction text is the lexicon's `continue.instruction`, overridable
per profile (`lexicon`) or process-wide (`overrideLexicon`). Only text profiles
send it (`CONTINUE_INSTRUCTION_TYPES` in `src/kernel/stop.ts`, which the
playground also reads); image and speech continue by re-sending the host's
request unchanged. Composer labels in `src/interface/` are semantic
keys only; English lives in `@theoremjs/react`.

Wire shapes are facts, declared once: every turn event is a zod schema in
`src/kernel/turn-events.ts`, and its TypeScript type is that schema's inferred
type. Policy modules such as `stop.ts` import those types; they never restate them.

## Profiles

Hosts declare agents with `defineProfile` / `registerProfile` (or
`registerProfiles`). `getProfile` / `hasProfile` / `listProfiles` / `clearProfiles`
manage the default scope's profile registry; `scope.profiles` is another scope's.
Registration validates a profile's tool allow list against the same scope's
`tools`, and resolution reads tools and schemas from that scope only.

A `Profile` binds:

| Block | Role |
| --- | --- |
| `type` | Wire archetype discriminator: `'text'`, `'image'`, `'speech'`, `'live'`, `'host'`, `'decision'` (`PROFILE_TYPES`) |
| `identity` | `handle`, optional `system` / `systemByRole` — absent on `host`; `handle` only on `speech` and `decision` |
| `models` | Host-named `ModelBinding`s (each carries `protocol`, `provider`, `apiId`), `defaultModel` (registration always sets it: the declared one, else the only key), optional `allowModelSelect` / `maxSteps` / `key` — absent on `host`; `decision` binds exactly one model and never selects |
| `tools` | Allowlist ceiling (`allow: ToolId[]`) — present on `text`, `image`, `live`, `host`; absent on `speech` and `decision`. Tier loading (`t1Policy`, `t2Loader`) is declared only on `text` and `image` |
| `inputs` | Text / attachments / voice / slots / per-mime limits — present on `text`, `image`; absent on `speech` and `live` (live uses `live.ingress` instead); `decision` carries its own `DecisionInputsSpec`, not turn inputs |
| `image` / `speech` / `live` | Modality-specific pins (top-level, not nested under `outputs`) |
| `outputs` | Structured, streaming, validation — present on `text`, `image`, `speech`; absent on `live` |
| `turnBehaviour` | `resumption` (`allowContinue`, `autoContinue`, `maxContinues`) on `text` / `image` / `speech`; `allowSteering` on **text and live** (inject gate via `profileAllowsInject`; see [`stages.md`](stages.md)). Live must omit `turnBehaviour.resumption` (use `live.sessionResumption`) |
| `guardrails` | Quota, canary, prompt echo, detect, egress, network, taint — on `host` narrowed to `HostGuardrailsSpec` (`detect`, `network`); on `decision`, only pre-dispatch `disclosure` is active. A guarded `live` profile (canary or `egress.enforce`) always requests its output transcript: `resolveTurn` sets `live.transcription.output` |
| `observability` | Trace destination, scrub, include, sampling (`writeTo`, `sampleRate`, …) |

Closed unions (`protocol`, `provider`, `thinking`, stop kinds, turn stages,
MIME maps, …) live as `as const` arrays in `src/kernel/schema.ts`. Types are
derived from those arrays. `TURN_STAGES` / `TOOL_GATE_KINDS` /
`AWAITING_USER_INPUT_*` are foundation for the stages cutover
([`stages.md`](stages.md)); text `runTurn` mid-turn inject uses `TURN_STAGES` /
`onStage`. `TOOL_RESUME_CAUSES` names why a refused gate settles: `declined`,
`abandoned`, or `expired` (the host let a sign-in link run out). `EXTRA_FIELDS`
documents tool fields such as `auth.service`, the service a person signs in to. `PROFILE_FIELDS` / `fieldMeta` document every authoring
path so host UIs and docs hover the live kernel types instead of copying them.
Which profile types may set each path is owned by `PROFILE_FIELD_SCOPE`
(`src/kernel/profile-scope.ts`): every field's `FieldMeta` carries its
`profileTypes` and `profileTypesReason`, and `defineProfile` rejects a field set
on any other type with that reason. `PROFILE_GRAPH` projects those sections into
the playground authoring graph (spine / branch / optional), taking each facet's
types from the same scope; the frontend must import it rather than inventing
facet kinds. Drift is gated by `tests/kernel/profile-graph.test.ts` and
`tests/kernel/profile-scope.test.ts`.

### Decision profile

A `decision` profile is a separate, bounded execution path for typed decisions.
Its `models` map binds exactly one model with `protocol: 'decision'`,
`provider: 'typesafe' | 'openrouter'`, an `apiId`, and a key slot (its own
`key`, else the profile's; `defineProfile` refuses a decision model with neither).
The profile's `decision.contract` is the host's stable id for the decision it
makes. The id names the decision on its trace (`theorem.decision.contract`);
it is not sent to the provider and does not limit which questions a call asks. At call time,
`runDecision` accepts non-null JSON `state` and named `choice`, `noul`, or
`score` questions, then returns validated typed answers and usage.
`validateDecisionRequest` exposes the same generic request checks for hosts to
call before spending quota. TypeSafe uses `/v1/systemone`; OpenRouter uses
`/api/alpha/decisions`. Bindings may set
`timeoutMs`; omission leaves the kernel request unbounded. Retry configuration
is rejected: a decision POST is never retried. The builder chooses questions
compatible with its model. Provider-reported cost is used when available; the
decision provider usage adapter prices direct TypeSafe Jev tokens at
$0.042 per million input tokens with output free.
It has no prompt, conversation history, attachments, tools, streaming, or
turn loop; its key comes only from the host's `vault` (`RunDecisionOptions.vault`)
through that slot, and an empty slot throws
`DecisionError('authentication', "the vault has no key in slot '<slot>'")`.

`decision.guardrails.disclosure` is a host hook immediately before the request
leaves the process. It may return `allow` or `block`; a block prevents dispatch.
The shared guardrail fields are structurally accepted for compatibility but the
registry rejects quota, sanitization, redaction, canary, egress, network, and
taint configuration as inert on a decision profile. Recursive state scanning
is deliberately deferred. Decision profiles are served by `createTheoremDecisionHandler`,
`DecisionTransport`, `useTheoremDecision`, and `TheoremDecision` in `@theoremjs/react`.

Every decision writes one trace record through the profile's observability
policy, or through `RunDecisionOptions.sink` when the host passes one: a
`decide <apiId>` CLIENT root span (under `DecisionRequest.traceparent` when
given, stamped with `DecisionRequest.metadata`) carrying
`gen_ai.operation.name: decide`, `gen_ai.provider.name` from the model binding,
`gen_ai.agent.name` (the profile), the requested and answering model, token
usage and its cost (`theorem.usage.cost_usd`), `theorem.decision.contract`, and the state, questions and answers as
stored JSON content under the profile's scrub policy. Invalid local requests are rejected before creating a trace. A failed dispatched decision ends
the span `ERROR` with `error.type` its error kind. As with turns, a failed
trace write never fails the decision.

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
`TheoremError` rather than by a second MIME table (see
`docs/contracts/providers.md`).

A host declares what it accepts only in `inputs.attachments.accept` /
`inputs.voice.accept`. `mediaChannelForMime(profile, mime)` (`catalog.ts`) is the
public answer to "does this profile take this file, and on which `TurnInput`
channel" — hosts filter and route channel ingress with it and keep no MIME table
of their own.

One check decides whether a turn's files are accepted: `attachmentIssues(rules,
files, clips)` (`attachments.ts`). It returns every reason at once — channel not
accepted, MIME not accepted, too many files, a file over its byte cap, the turn
over its total — each file's issue carrying the file's `name` when the host sent
one. The turn is all-or-nothing: `assertTurnAttachments` (run by input
sanitization and by `resolveInputParts`) throws one `input` `TheoremError` whose
`copy` is a list, one lexicon line per issue (`attachmentIssueCopy`), so the
user reads every reason and the builder reads the codes in `errorInternal`
(`attachmentsRefused` builds that error). `attachmentIssueText(issue, lexicon)`
words one issue for a client that reports issues itself (the composer). An image
profile has no voice channel, and `defineProfile` refuses an attachment `accept`
entry outside images, video and PDF (`IMAGE_ATTACHMENT_ACCEPT_MIMES`); every
attachment is a reference the model reads, and `maxFiles` caps them. The
headless interface's `validateProfileInputs` runs the same check before a send.
The name is never sent to the model.

Turn media arrives on `TurnInput.attachments` as either inline bytes or a
provider file reference:

| Input | Shape | Ingress |
| --- | --- | --- |
| `TurnBlob` | `{ mimeType, data, name? }` (base64) | MIME acceptance, kind resolution, base64 check, per-file / per-turn byte limits, text-MIME sanitization |
| `TurnMediaRef` | `{ mimeType, uri, name? }` (e.g. Gemini Files `files/<id>`) | MIME acceptance, file count and kind resolution only — no base64 or byte limits; the host owns upload and cleanup |
| `InteractionMediaRefPart` | `{ type: MediaInputKind, mimeType, uri }` | Provider part emitted for a `TurnMediaRef`; `isMediaRefPart` narrows it |

`wireInteractionPart` emits `{ type, mimeType, uri }` for a reference part; the
Google Interactions adapter snake-cases it to the documented Files input
`{ "type": "video", "uri": "files/<id>", "mime_type": "video/mp4" }`. Every other
adapter (OpenAI compat, AI SDK, Gemini Live) throws `TheoremError` for reference
parts — see `docs/contracts/providers.md`.

`models.*.protocol` is `PROTOCOLS` (`geminiInteractions` | `openAi` | `geminiLive`).
`models.*.provider` is `PROVIDERS` (`google` | `openrouter` | `local`).
Legal pairs are `PROTOCOL_PROVIDERS`; `createProvider` rejects anything
outside `isValidPair`. `providersFor` / `protocolsFor` / `coerceProvider` /
`coerceProtocol` are the same table.
Each `ModelBinding` in `profile.models` carries wire ids (`apiId`), optional
`efforts` / `defaultEffort`, `summaries`, `maxOutputTokens`, `temperature`,
`builtInTools`, vault `key` (required on every non-local model, unless the
profile sets `key`), optional `compaction`, optional OpenRouter
`cache` (`mode` / `ttl`; openrouter-only), Gemini Interactions `store`
(optional) and `persistViaInteractionId` (required; Interactions-only), and an optional local
`server` name (local-only; traces report it as `gen_ai.provider.name`).

`TurnRequest.sessionId` is an optional sticky routing key forwarded to OpenRouter
as `session_id` (distinct from `projectId` and Gemini `previousInteractionId`).

`TurnTokens` shares (`thinking`, `toolUse`, `cached`, `cacheWrite`) and `cost`
appear only when the provider reports them — see [Token usage](#token-usage).

THEOREM does not invent provider-API defaults for optional wire fields.
Hosts must set required fields explicitly (`type`, `models`, per-binding
`protocol` / `provider` / `apiId`).
First-party THEOREM opinions that *are* applied when the host omits a knob:
guardrails default on, and Interactions streaming defaults to SSE
(`outputs.streaming.mode` omitted → `stream: true`).

`projectProfile` / `resolveTurn` project a registered profile + `TurnRequest`
into a `ProjectedProfile` / `ResolvedGeneration` the runner and providers consume.

## Turn lifecycle

`runTurn(request, provider, sink?)` is the single deterministic execution path
for one **turn-based** agent turn (text / image / speech). It runs on the scope it
is called from (`scope.runTurn`, or the default scope's global `runTurn`); every
step reads that scope's registries and no other. Live profiles use
`runSession` instead (long-lived session; the conversational boundary is
`interactionStatus: IDLE` when the provider sends it, else `turnComplete` — a
gate boundary, not socket teardown). When `sink` is omitted, the runner resolves
`profile.observability` via `resolveTraceWriter` (named destination, inline
sink, or noop). An explicit third-argument sink always wins for that call.

Text turns emit **stage** events and invoke optional `TurnRequest.onStage`
(`docs/contracts/stages.md`): `pre_turn` before the first provider step;
`post_tool` after each tool body (may `deny` or `mutate` the result);
`before_end` before egress/validation
finalize (inject may re-enter the step loop under `maxSteps`); terminal `done`;
then `post_turn`. Inject requires `profileAllowsInject` (`allowSteering` on
text). Invalid affordances yield a follow-up `stage` event with `stageWarnings`.
AbortSignal / stage `abort` end with cancelled `done` then `post_turn`.
Live sessions emit the same stage names around utterance cycles and
`LiveSession.executeTool` (`docs/contracts/stages.md`).

1. **Resolve** — `resolveTurn` picks model, wire `apiId`, `transport`
   (`'interactions'` for Google Interactions, `'openAiCompat'` for OpenRouter/local),
   thinking, tools, structured schema, streaming mode (`outputs.streaming.mode`
   → SSE vs buffered), canary token (minted; the runner replaces it at step 4).
2. **Sanitize** — `sanitizeTurnRequest` strips injection/sensitive spans per
   profile guardrails (unless disabled).
3. **Compaction (before)** — when `timing: 'before'` and threshold fires, kernel
   runs the compaction profile turn synchronously, then continues with the
   history it leaves (see [Compaction](#compaction)). The history meter counts media by the turn model's family
   (`mediaTokenFamily` of the resolved binding); media it cannot count is
   reported as `unknownMedia`.
4. **Canary bind** — when `guardrails.canary` is enabled, the turn's canary is the
   profile's (`profileCanary`: a hash of the profile id and the resolved system
   prompt, the same on every turn that sends that prompt, so a provider's prompt
   cache holds), and its note goes at the end of the system text.
5. **`pre_turn`** — stage emit + optional `onStage` (may inject). On a text
   turn the opening input is already the last message of turn history.
6. **Provider stream** — `provider.complete` yields partial events; runner may
   drop thoughts per `outputs.streaming.streamThoughts`. Reply text passes the
   progressive-yield gate; thoughts never stop the turn, but their leaks are
   omitted ([guardrails](./guardrails.md)). Each provider call has its own gate;
   the turn carries a possible canary opening from one call into the next
   (`canaryCarry` and `thoughtCarry` on the step state), so a token split across
   tool steps is one match.
7. **Tool loop** — while under `maxSteps`, tool calls execute via `executeRegisteredTool`
   (shared with `invokeTool`), threading the host's `credentials` source (`ToolCredentialSource`, read one slot at a time as a signed-in tool runs) for authenticated HTTP/MCP tools and the opaque `host` context slot; `pre_tool` / `post_tool` stages + `preTool` run on that path. After each
   settled tool, `post_tool` may inject. Gate (`stop.kind: 'gate'`) suspends the batch. `generation.chains`
   (a binding with `persistViaInteractionId: true`) selects an Interactions continuation
   (`previous_interaction_id` + `continuation`: the tool results and stage injects as
   kernel messages, which the adapter maps like history); otherwise the step's calls and
   results go in tool-call history. Server-side `codeExecution` does not consume a runner step.
8. **`before_end`** — stage before egress/validation; inject re-enters the step
   loop when under `maxSteps`.
9. **Validation / repair** — structured output validators (`outputs.validation`)
   may trigger repair turns with `input.repair`. The repair prompt is the next
   user message in turn history (image and speech: it replaces the prompt
   input). A retry is not resolved again: it keeps the turn's canary, tool set
   and system prompt. Under `outputs.streaming.mode: 'sse'` text and media
   stream as they arrive; under `'buffered'` they are held until the reply
   passes. Out of retries, the last attempt goes out as it is, with its
   buffered events.
10. **Egress** — progressive yield on the provider stream (canary, prompt
   echo, `guardrails.egress`) releases cleared prefixes: the bundled
   policy holds exactly what could still become a match, a host enforce a
   fixed window; end-of-attempt may still refuse, repair, or withhold. SSE streaming and egress can both stay enabled.
11. **Trace** — the turn records one `invoke_agent` span tree (model calls,
   HTTP tries, tools, stage events) and writes it as one `TraceRecord` to the
   request's sink, else `profile.observability`; failures are swallowed.
   Providers tap each request body and data row (`tapUpstream`), recorded as
   `theorem.wire.request` / `theorem.upstream.row` under the include flags
   ([observability.md](observability.md#trace-records)).
12. **Terminal `done` then `post_turn`** — one `done` event with optional
    `stop`, optional `compaction` signal (`timing: 'after'`), then observe-only
    `post_turn`. Token counts are not on `done`: each model call emitted its own
    `tokens` event (see [Token usage](#token-usage)).

`continueFrom` on `TurnRequest` resumes a resumeable stop. On a text profile the
turn's user message is the lexicon's `continue.instruction` (a continue turn takes no
`input.text`); the host passes the partial reply as the last assistant message in
`input.history`. On image and speech nothing is added: the host re-sends the
original request and the turn runs it again in full. `continueFrom` carries only
the `stop` being resumed.

Trace context on the request, all optional:

| Field | Recorded as |
| --- | --- |
| `traceparent` | W3C parent of the root span; the turn joins that trace. Without it the turn starts a new trace. A malformed value throws. |
| `conversationId` | `gen_ai.conversation.id` |
| `links` (`TurnTraceLink[]`) | Span links on the root: `{ traceparent, kind: 'resume' \| 'continue' \| 'retry', stop? }` |
| `metadata` | Stored on the record untouched |

The terminal `done` carries `traceparent` (the turn's root), which a later
request passes in `links`. `ToolContext.traceparent` is the call's
`execute_tool` span, so a tool that runs a specialist or makes its own
outbound calls parents them there. `SessionRequest` and `InvokeToolRequest`
take `traceparent`, `conversationId`, `links` and `metadata` the same way.

`runTurn`, `runSession`, `resolveTurn`, and `projectProfile` refuse a `'host'`
profile with `TheoremError` (`requireModelProfile`); host profiles only execute
tools through `invokeTool`.

`compactionProvider` on `TurnRequest` runs a `timing: 'before'` compactor.
Without it the turn's provider does, which needs a text speaker on the same
protocol and provider as the compactor's default model; otherwise `runTurn`
throws `config`.

## Stream events

`runTurn` and adapters yield `TurnEvent`:

| `type` | Payload highlights |
| --- | --- |
| `thought` | Model reasoning stream (leaks omitted, never stopped: images, links, canary, prompt echo, boundary markers; dropped when `streamThoughts: false`) |
| `text` | User-visible assistant text |
| `tool` | Tool call (`phase`: `running` / `progress` / `complete` / `gate` / `error` / `cancel`, …; `pause` deprecated) |
| `structured` | Parsed JSON object when the profile names a structured schema |
| `media` | Generated image/audio bytes + mime |
| `grounding` | Google search metadata: Live `groundingMetadata`, and Interactions tool results (`google_search_result` `search_suggestions` → `searchHtml`). Maps sources add normalized `chunks[].maps` (`title` / `uri` / `placeId`); the raw payload rides on `metadata`. The sources themselves travel as `citation` |
| `citation` | `sources` (`title` / `uri` / `type` / `placeId?`) a provider or a tool cited. From a provider: Google `url_citation` / `place_citation` annotations and `google_maps_result` places, OpenRouter citations and `url_citation` annotations. From a tool: its `sources(output)` on a completed call, with the call's `callId` (see [Tool sources](#tool-sources)) |
| `evidence` | Provider-native attachments. Google code execution sets `kind` (`code_execution_call` / `code_execution_result`) plus parsed `code` / `result` / `isError` / `id` / `callId`, and always keeps `raw`. Live ASR uses `input_transcription` / `output_transcription` (optional `interim`); Live `voiceActivity` uses `voice_activity` (`raw`); session resumption uses `session_resumption` + `resumable`. `partial: true` marks a step the provider started and never finished (the stream ended first); a partial tool call never runs. |
| `session` | Live control: `closing_soon` (optional `timeLeftMs`); `ended`, the provider's close after it warned of one — not an error: `ended { cause: 'go_away', code, closedAfterMs, errorKind? }` (`errorKind` when the code is not 1000), `timeLeftMs` (the last warning's window), `message` (the user's wording, lexicon `live.session_ended`) and the raw close as `errorInternal`; `waiting_for_input`, `turn_complete` (one spoken response ended), `working` (server still reasoning / awaiting async tools), `idle` (cycle boundary) |
| `stage` | Turn timeline (`stage`: `pre_turn` \| `pre_tool` \| `post_tool` \| `before_end` \| `post_turn`) — see [`stages.md`](stages.md) |
| `tokens` | One per model call, after that call's output: `TurnTokens` (see [Token usage](#token-usage)); may gate `meter: 'input'` |
| `response` | Adapter → runner only, never yielded by `runTurn`: the response identity (`id`, `model`) as soon as the wire names it, and again when it grows or changes. The runner records it on the call's trace span (`gen_ai.response.id` / `gen_ai.response.model`), so a call that fails or is cut by a guardrail still names the model that served it |
| `compaction` | `timing: 'before'` ran the compactor: `outcome`, the `history` the turn used, `summary` when compacted, `failure` when not, `droppedMedia`, the meter's count and message counts (see [Compaction](#compaction)) |
| `done` | Terminal or live boundary: `stop` (`completed` / `interrupted` / `generation_complete` / …), `compaction`, `tokens` (the turn's usage); when `stop.kind` is `tool` or `gate`, required `tools` (`TurnToolSnapshot`) for host `invokeTool` resume, absent otherwise |
| `error` | `errorKind` (builder), `errorInternal` (host logs only), and `error`, the user's wording for the kind (profile `lexicon` → `overrideLexicon` → default) — see [Public errors](guardrails.md#public-errors) |

### Token usage

`runTurn` emits exactly one `tokens` event per model call — each tool-loop step
and each repair attempt is a call — after that call's output and before the
next step. A provider that reports usage more than once per call contributes
its last report. Live sessions (`runSession`) pass through the one usage row
Gemini Live sends per model response; a Live response without one is not yet
estimated.

Meanings follow the OpenTelemetry GenAI conventions on every provider:

| Field | Meaning |
| --- | --- |
| `input` | Everything the model read: prompt, cached prompt, provider tool-use results (Google code execution / URL context) |
| `output` | Everything the model wrote, reasoning included |
| `total` | `input + output` |
| `thinking` | Reasoning share of `output`, counted even when thought text is not streamed |
| `toolUse` | Provider tool-use share of `input` |
| `cached` / `cacheWrite` | Cache-read / cache-write shares of `input` |
| `cost` | Provider-reported charge in US dollars (`usd`; OpenRouter also `upstreamUsd`; `partial` only on a `sumTokens` total) |
| `estimated` | Sides (`'input'` / `'output'`) the provider did not report; absent = both reported |
| `unknownMedia` | Per side, media parts an estimated side leaves out (no verified rule) |

**Estimated sides.** When a provider leaves a side out — or reports no usage at
all — the runner fills it with the shared token estimator
(`loadTokenEstimator`) and lists it in `estimated`. The prompt side counts the
system prompt, wire tool declarations, structured output schema, turn history,
and opening input; an Interactions continuation step (`previous_interaction_id`)
counts the stored interaction it extends — the previous call's prompt, that
call's text / tool calls / media, then the continuation's tool results and
stage injects. The output side counts streamed text, thought text, and tool-call
names and arguments; reasoning the provider does not stream cannot be counted.
Media is counted by the model family's verified rule (see
[History estimate](#history-estimate-meter-history)); output media is always
unknown. A call that failed with no usage emits no `tokens` event — what was
billed is unknown.

**Agent tool calls.** An agent tool's call carries the called agent's usage
as `tokens` on its `complete` or `error`, and `done.tokens` adds it in
([Agent tools](#agent-tools)); the call emits no `tokens` event of its own.

**Totals.** `sumTokens(calls)` is the one way to total calls — a turn, a
session, any range. Counts and shares add up; a side is `estimated` when any
call estimated it (its shares then cover only what providers reported);
`unknownMedia` adds up per side. `cost.usd` adds up over the calls that
reported a cost and carries `partial: true` when some did not; no reported cost
means no `cost`. `upstreamUsd` adds up where reported (OpenRouter sends it only
for BYOK). The trace record's `usage` and the CLI `test` total use it.

### Host client boundary

`runTurn` yields one stream for the host process. **Do not forward the stream
verbatim to browsers or end-user SSE** unless you intend to expose diagnostics.

| Field | Host logs / traces | End-user transport |
| --- | --- | --- |
| `error` | yes | yes |
| `errorKind` | yes | yes |
| `errorInternal` (error events, an ended session, `guardrail.errorInternal`) | yes | **never** |
| `evidence` parsed fields (`kind`, `code`, `result`, citations) | yes | when useful in UI |
| `evidence.raw` | yes | only when you explicitly want provider internals |
| `text`, `media`, `structured`, `grounding` | yes | yes (after egress/canary gates) |
| `thought` | yes (also in trace when filtered from stream) | only when profile allows |

Use `forClient` / `forClientEvents` from `@theoremjs/agents/host` before WebSocket or SSE
flush. Pass a trace sink (`memorySink`, `jsonlSink`) as the third argument to
`runTurn` for wire-level audit (`theorem.upstream.row` and
`theorem.wire.request` events; see [observability.md](./observability.md)).

`TurnHistoryMessage` preserves `role`, `content`, `parts`, `tool_calls`,
`tool_call_id`, and opaque `metadata` across turns.

`content` and `parts` are sent together, never one instead of the other:
`historyMessageParts` (`kernel/interaction-parts.ts`) puts `content` first as a
text part, then `parts`. Every adapter (Interactions, Live, OpenAI-compat, AI
SDK) builds history content from it, so a host that stores a text projection
alongside media does not lose either one.

Google Interactions code execution (`codeExecution` builtin) is a server-side
tool: THEOREM does not run Python. Hosts receive the sandbox timeline as
`evidence` events (streamed SSE deltas, or a batched replay of `steps[]` when
`outputs.streaming.mode === 'buffered'`). Generated plots/annotated images arrive as
`media`. `maxSteps` does not bound Google's internal code loop; it only bounds
host function-calling round trips. The sandbox runtime cap (~30s per execution)
is Google's, not a THEOREM setting.

Streaming is controlled solely by `outputs.streaming.mode` on the profile
(`'sse'` or `'buffered'`). When omitted, THEOREM defaults to SSE. `'buffered'`
makes one non-streaming provider call on every chat transport (Interactions,
OpenRouter, local) and yields the same `TurnEvent` types when it answers.
There is no per-turn stream override.

## Registered tools

Tools, profiles, and structured schemas live in a kernel scope (see
[Kernel scope](#kernel-scope)). A host with one tenant registers at startup into the
default scope via `registerTool` (Google builtins via `registerGooglePreset`). Profiles declare **custom** tools on `tools.allow` and **provider builtins** on
`models.*.builtInTools`. On `text` / `image` turns visibility is `loadTier` (T0 at
turn start, T1 via `tools.t1Policy`, T2 via `tools.t2Loader`). On `live` every
allowed tool (and every model builtin) is wired at session setup regardless of
`loadTier`; on `host` every allowed tool is executable with no tiers and no path
gating. Each of these facts has one owner, and every kernel, CLI, and interface
reader goes through it: `profileToolAllow` (`tools/resolve.ts`) returns a
profile's allow list, empty for `speech` and `decision`; `profileToolsSpec`
returns the tiered spec (`t1Policy`, `t2Loader`) for `text` and `image` only;
`profileInputs` (`registry/catalog.ts`) returns turn inputs for `text` and
`image` only. So projection, resolution, execute eligibility, T2 promotion, and
T1/T2 loading see no tools on `speech` and `decision`, and `invokeTool` rejects
`decision` explicitly.

A builtin names itself per transport in `wire` (`interactions`, `live`,
`openRouter`). Resolution copies each builtin's `{ id, wire }` onto the provider
request, so providers never read a registry; every transport reads the wire with
`builtinWire`, which throws for a builtin that has no name on that transport.

A `complete` or `error` tool event carries `readBack`: the text the model read
for that call, after guardrails. History replays it (`appendToolExchangeToHistory`),
so a continued turn sends the provider exactly what `runTurn` / `invokeTool` sent,
and a live session sends Gemini the same text. Replaying a settled call without
one throws.

### Kernel scope

A `KernelScope` is one set of registries (`tools`, `profiles`, `schemas`) and the
runs bound to them: `runTurn`, `runSession`, `invokeTool`, `resolveTurn`,
`projectProfile`, `runDecision`. `createKernelScope()` returns empty registries,
isolated from every other scope; a run reads only the scope it was started on.
Two scopes can register the same tool, profile, and schema names without either
seeing the other's.

The global functions (`registerTool`, `registerProfile`, `registerStructured`,
`runTurn`, …) are `defaultKernelScope`'s methods. There is no ambient or
request-local lookup: a host serving many tenants, such as the playground, builds
a scope per request and runs on it. `registerHarnessTools()` and
`registerGooglePreset()` fill the default scope; another scope registers
`askUserTool` and `GOOGLE_BUILTIN_TOOLS` itself.

Register a scope's tools and schemas before its profiles: a profile is checked
against them when it registers. An `outputs.structured` id that names no
registered schema, or an `outputs.validation.fields` path no such schema reaches
through object properties, is refused then.

### Tool sources

A function, HTTP or MCP tool may declare `sources: (output) => Source[]`. Once a
call completes (after `post_tool`, on the output it settles with), the kernel
runs it and emits one `citation { sources, callId }` before the terminal
`complete` event; the transcript shows them on that call. It never runs for a
call that failed, gated or was refused. Every source is checked against
`sourceSchema`: one that fails is not cited, and the call gets one tool
`warning` (`code: 'sources_invalid'`) naming each failure; a throw is the same
warning and cites nothing. The call still completes and the model's result is
unchanged. The call's `execute_tool` span records the cited sources as a
`theorem.grounding` event, and every tool warning (the tool's own and
`sources_invalid`) as a `theorem.tool.warning` event. A tool that cites nothing
omits `sources`.

### Agent tools

An agent tool (`type: 'agent'`) runs one turn of another registered profile and
returns its reply. The called agent is a standalone profile, not a part of the
caller: any agent may call it, and it answers the caller, never the user. The
kernel chooses nothing beyond running the one turn; any routing, chaining or
state is the host's, through `onAgentCall` and stages.

| Field | Meaning |
| --- | --- |
| `profile` | The agent to run: a `text`, `image` or `speech` profile that takes text, registered before the tool |
| `maxCallsPerTurn` | Calls allowed in one turn of the caller; a call past it fails `call_limit` (`declined`) |
| `preTool` | As on a function tool, with the input `{ text }` |

Input is always `{ text }`. Output is `{ text, structured?, parts? }`: the
reply's text, its last structured reply, and its images or audio as `parts`.

**Registration.** `register` throws `config` when the profile is missing, is
another type, takes no text, allows a tool that is not registered, or allows a
tool that can stop on a gate (permission other than `auto`, or a sign-in
other than `onUnauthenticated: 'report_to_model'`). A gate inside the called
agent would have no one to answer it. A `live` profile can't allow an agent
tool. Agents call agents only in registration order, so calls can't loop.

**The host's hook.** `TurnRequest.onAgentCall(call)` (and the same field on
`InvokeToolRequest`) runs before each call with `{ tool, callId, profile,
input, caller, depth, metadata?, signal? }`. It returns nothing to run the call
as is, `{ refuse }` to fail it (`refused_by_host`, `declined`, the model reads
`refuse`), or fields for the called agent's request: `input`, `model`,
`effort`, `metadata`, `onStage`, `conversationId`, `provider`. The hook passes
down to the called agent's own calls, with `depth` counting up from 1.

**Provider.** The hook's `provider`, else the caller's when the called agent's
model has the same provider and protocol; otherwise the call throws `config`.
`invokeTool` uses `InvokeToolRequest.provider` (or the hook's) as given.

**Outcomes.** The call completes with the reply when the agent's turn completes.
Any other stop, or an error the agent's turn reports, fails the call
(`agent_failed`, with the agent's error kind or `failed`). `config`,
`request`, `auth` and `internal` errors are the host's to fix and are thrown, as
a compactor's are. Host abort cancels both turns.

**Events and trace.** The called agent's events stream as the call's
`progress` (`data: { agent, event }`). Its `invoke_agent` span is a child of the
call's `execute_tool` span in the caller's record, sharing its canaries.

**Trust.** A called agent with no tools and no model builtins read only what it
was sent, so its result is `origin: 'local'`. One with tools is `delegated`
(depth 2) and taints the turn like any remote result.

**Usage.** The call's `complete` or `error` carries the called agent's own
`tokens`. The caller's `done.tokens` includes them; the caller's span keeps
only its own calls.

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
id in the snapshot outside it is refused with `TheoremError`. Without a snapshot
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
invokeTool({ profile, name: 'record_lookup', input: {...}, resume: { granted: true }, snapshot, promoted: ['record_lookup'], turnInput });

// Tool `preTool` returning `confirm` gates once; `resume.granted: true` skips preTool on the next invoke (same as `always_confirm` permission).

// Host direct invoke (command palette)
invokeTool({ profile, name: 'lookup_order', input: {...} });
```

| Layer | Owner | Role |
| --- | --- | --- |
| Registry | Host startup | Schema, handler, `access`, `loadTier`, `permission`, wire metadata |
| Profile | Host | `tools.allow` / `tools.t1Policy` / `tools.t2Loader`; `models.*.builtInTools` |
| Turn | Host | `sessionPermissions` for consent; `credentials` source for authenticated HTTP/MCP tools (read per slot, only when a tool signs in); path / input / transport |
| Execution | Kernel | Shared `executeRegisteredTool` for model and `invokeTool` paths |

**Activity labels.** A tool's `labels.activity` and `labels.activityPast` say what
a call is doing and what it did, in the tool's words: `'Saving {title} to your
collection'`. Each `{path}` is a dot path into the call: the kernel fills it from
the input, then the output (`{results.0.name}` steps into a list by position).
Only text and numbers fill a placeholder. Text collapses its whitespace and is cut
at 40 characters; numbers keep at most two decimals. The `running` phase carries
`activity` filled from the input, and `complete` carries `activityPast` filled from
the input and output. When a placeholder has no such value, the phase carries no
label and the transcript names the tool in words instead.

`labels.request` says what a gated call would do, as the rest of "@agent wants
to …": `'check the weather in {city}'`. The kernel fills it from the input onto
the gate (`ToolGate.request`) of a permission or confirmation gate, beside the
tool's `access`; the approval card names the tool in words when the request is
unset or a placeholder has no value.

Builtins (`type: 'builtin'`) are provider-native — kernel pins capabilities in
`generation.builtins` but does not execute handlers.
Function tools (`type: 'function'`) run host TypeScript handlers.
Declarative HTTP tools (`type: 'http'`) call REST APIs directly with templated URLs, query parameters, headers, and body mapping.
Remote MCP tools (`type: 'mcp'`) call external Model Context Protocol servers over Streamable HTTP.
The preferred revision is `2026-07-28`; the kernel negotiates downward through
`MCP_PROTOCOL_VERSIONS` (`2026-07-28` → `2025-11-25` → `2025-06-18` → `2025-03-26`)
when a server rejects an unsupported protocol version (JSON-RPC or HTTP error body).
Calls are stateless. A server that answers `400` naming `Mcp-Session-Id` gets a
session: `initialize` at `2025-11-25` (no redirects followed, no client
capabilities, only the session ID and version read back), then
`notifications/initialized`, then the call. Sessions live in memory on the
scope's tool registry (`tools.mcpSessions`), keyed by server URL and a SHA-256 of
the credential headers, capped at 256 and dropped after 30 idle minutes; they
are never persisted. The ID travels as an origin-bound header, must be 1–256
visible ASCII characters, and stays out of events. A `404` in a session reopens
it once; a second fails the call with `mcp_session_expired`.
An MCP result is read as its `structuredContent` when that passes the tool's
`output` schema, else as its text blocks joined (a `resource` block's `text`, a
`resource_link`'s `uri`) and parsed against `output`. `image` and `audio` blocks
with base64 `data` and a `mimeType` become the call's media parts: they ride
the model's result as `parts` and the `complete` event as `parts`, and a
`post_tool` edit that replaces the output keeps them.

HTTP and MCP tools, and function tools that declare `auth`, integrate with:
- **Network Guardrails** (`guardrails.network`): SSRF protection blocking loopback and private subnets unless `allowPrivateNetworks: true` is configured. Owned by the guardrails contract — see `docs/contracts/guardrails.md#network`.
- **Stateless OAuth 2.1 & PKCE** (`src/kernel/auth`): RFC 7636 PKCE S256, RFC 9728 discovery, RFC 8414 AS metadata, RFC 9207 `iss` mix-up defense, RFC 8707 resource indicators (a token is only sent to URLs inside its resource — `tokenAudienceCovers`), and stateless state envelopes (`v1.salt.iv.ciphertext`) encrypted with AES-256-GCM under a per-state key derived by HKDF-SHA256 from a ≥32-byte, 256-bit-entropy secret and a fresh salt, with the version authenticated. Every flow's token is bound to its `resourceServerUrl`; `redirectUri` (https, loopback http, or reverse-domain app scheme, no fragment), `clientId` (a URL must be https), scope tokens and `stateTtlMs` are validated. The envelope carries the SHA-256 of a required host `sessionBinding`, and the exchange refuses a callback whose session doesn't match it (login CSRF, RFC 6749 §10.12). The PKCE verifier never leaves the envelope. Discovery and token requests are network-guarded and never follow redirects.
- **Unauthenticated Handling**: Gates the turn via `ToolGate { kind: 'auth' }` (`tool.phase: 'gate'`, `stop.kind: 'gate'`) or reports synthetic error findings to the model per `onUnauthenticated: 'gate' | 'report_to_model'` (default `gate`).
- **Sign-in**: a tool that signs in names its `auth.service` (the service as the person knows it); registration refuses one without it. The auth gate carries it, and its `readBack` is the `sign_in.pending` note. A live session holds a sign-in gate for its decision as any gate, or with `signInGate: 'answer'` answers the model with that note at once and releases the call, for a host whose sign-in finishes outside the session; the outcome, or `sign_in.expired` after `gateTtlMs`, reaches the model as the call's next result. A call the person signed in for (`resume.signIn` on a grant) has its result read after the `sign_in.done` note; a refused one reads `sign_in.declined`, or `sign_in.expired` for the `expired` cause.
- **Refused credentials**: a 401 to a request that carried a credential gates for a new sign-in. A 403 `insufficient_scope` (RFC 6750) gates when every scope it asks for is one the tool declares in `auth.scopes`; otherwise the call fails `out_of_scope` with the `sign_in.out_of_scope` note, and a `progress` event `{ kind: 'auth_scope_refused', slot, requested, declared }` (`theorem.auth.scope_refused` on the tool span) records what was asked. Only well-formed scope tokens are read from the challenge.
- **Token Rotation**: Proactively refreshes expiring OAuth tokens during turns. The refreshed credential goes to the host's source with `set(slot, credential)`, and the call goes on only once that resolves, so a rotated refresh token is persisted before it is used; a `progress` event `{ kind: 'auth_token_refreshed', slot }` records it, and no token rides the event stream. Concurrent calls holding the same grant share one refresh. A confidential client's secret comes from the source's optional `clientSecret(clientId)` at refresh time and is sent in the token request body; it is never on the stored credential. A refused refresh emits `{ kind: 'auth_token_refresh_failed', slot }` with the server's text in `errorInternal` only; the model and the gate read fixed text. An OAuth credential without a `resource` is not sent anywhere; the call is unauthenticated.
- **Credential echo**: a tool response repeating the credential value it was sent with has it replaced by `[omitted - credential]` in the output, the model finding, and failure text.
- **Function tools that sign in**: a function tool may declare the same `auth`. The kernel resolves it at the same point (after permission, before `preTool`) with the same gate, refresh and `onUnauthenticated` rules, then hands the handler `ctx.signedInFetch(url, { method, headers, body })`: a guarded fetch that sends the credential to the URL's own origin only, never across a redirect, and an OAuth token only inside its `resource`. The handler never holds the credential. A 401, or a 403 `insufficient_scope`, throws `CredentialRefusedError` (exported so a handler that wraps its own errors can rethrow it untouched) out of `signedInFetch` and settles as under **Refused credentials**; any other response reaches the handler. Echoes of the credential in the output or failure text are omitted as for remote tools.
- **Endpoint templates**: the scheme and host are fixed text; a placeholder there is refused at registration and at call time, so tool input never chooses where a credential goes.

Catalog `conflictsWith` is an optional host-declared mutual exclusion on registered builtins; the Google preset does not set it.
MIME classification (`MEDIA_INPUT_KINDS`, `ATTACHMENT_ACCEPT_MIMES`, …) lives in
`schema.ts`. Tool catalog constants: `TOOL_LOAD_TIERS`, `TOOL_ACCESS`,
`TOOL_PERMISSION`, `TOOL_TYPES`, `HTTP_METHODS`, `TOOL_AUTH_TYPES`,
`AUTH_UNAUTHENTICATED_POLICIES`. `src/kernel/tools/types.ts` imports those unions
for `HttpToolDef` / `ToolAuthConfig` and re-exports them — do not redefine
closed unions in the tools module.

## Outputs and guardrails

Profile `outputs` pins behavior the kernel enforces before adapters run:

| Pin | Effect |
| --- | --- |
| `structured` | Schema id or slot-mapped ids; `responseFormat` vs prompt enforcement |
| `streaming` | `mode`, `streamThoughts` |
| `validation` | Field validators, `maxRetries` (repair guidance is the lexicon's `repair.default_guidance`) |

Top-level modality pins (after `model`, not under `outputs`):

| Block | Effect |
| --- | --- |
| `image` | Optional aspect ratio, resolution, mime, max input images (type `'image'` only) |
| `speech` | TTS voice + `format` (unset sends none, so the provider picks; `pcm` → WAV; the kernel holds the `SPEECH_AUDIO_FORMATS` vocabulary; Gemini speech takes only `GOOGLE_SPEECH_FORMATS` and its provider refuses `mp3`) (type `'speech'` only) |
| `live` | Voice, VAD, transcription, sessionResumption, contextCompression (type `'live'` only; omit → provider defaults) |

### Live profile (`type: 'live'`)

Live is a **session** contract (`runSession`), not a turn contract (`runTurn`). The profile shape is intentionally smaller than text/image:

| Block | On live? | Notes |
| --- | --- | --- |
| `identity` | yes | `handle`, `system` / `systemByRole` |
| `model` | yes | `protocol: 'geminiLive'`, `provider: 'google'` only |
| `live` | yes | Voice, VAD, transcription, resumption, compression, **`ingress`** (realtime mic / camera / text toggles; text off unless `ingress.text: true`) |
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
fire on the `invokeTool` path: `detect` (the
detectors run over model-supplied arguments, tool result text, and tool failure
text), `network` (SSRF clearance for declarative HTTP and MCP targets), and
`taint` (the confused-deputy gate, plus its advisory guidance on fenced remote
results). `defineProfile` throws a `TheoremError` naming the field for
`guardrails.quota`, `guardrails.canary`, and `guardrails.egress`: a host profile
runs no model, so quota counts nothing, no system prompt exists for a canary to
bind to, and egress gates user-visible model text in the turn runner, which a
host profile never enters.

| Block | On host? | Notes |
| --- | --- | --- |
| `tools` | yes | `{ allow: ToolId[] }` — registered custom tools (`function`, `http`, `mcp`; `HostProfileToolsSpec`); builtins are rejected |
| `guardrails` | optional | `HostGuardrailsSpec` only — `detect`, `network` |
| `observability` | optional | Same shape as every other profile |
| `models` / `identity` / `inputs` / `outputs` / `turnBehaviour` / `key` / `maxSteps` | **no** | `registerProfile` rejects them when supplied |

Each `invokeTool` writes its own trace record, rooted at `execute_tool {name}`
under the request's `traceparent`, with `conversationId` as
`gen_ai.conversation.id`, `links` as span links (for example to the paused turn
it resumes), and `metadata` stored on the record untouched. The `host` slot is
never recorded. A `resume` sets `theorem.tool.approved` to the answer it
carried. See [observability.md](./observability.md#trace-records).

A browser reaches a host through `createTheoremHostHandler`
(`@theoremjs/react/server`) and `<TheoremHost />`. For a host the tools are the
interface, so its `describe` is the one exception to tool ids only: each
allowed tool's name, description, kind, access, permission, and input and
output JSON Schema (`hostInterface`), never its endpoint, headers or
credentials. `interfaceFromProfile` still refuses a host.

`resolveTurnTools` for a host profile yields `gated = visible = executable =
tools.allow`, `builtins = []`, and `wire` from `buildWire`. `expandT1Policy`,
`promoteLoadedTools`, and the T2 loader promotion are no-ops. `ModelProfile`
(`Exclude<Profile, HostProfile | DecisionProfile>`) names every type that runs
a model turn (a decision profile binds one model but runs through `runDecision`); `requireModelProfile` narrows to it and throws for `host` and
`decision`.

Profile `turnBehaviour` (top-level on chat/image/speech):

| Field | Effect |
| --- | --- |
| `resumption.allowContinue` | Stops after which the host offers the user a Continue (`isResumeableStop`); host UI policy, not enforced on `continueFrom`; omitted → all three; `[]` → none |
| `resumption.autoContinue` | Stops the host continues once on its own; omitted → length and stream_incomplete, `[]` → none |
| `resumption.maxContinues` | How many times one reply may be continued (enforced); omitted → no cap |
| `allowSteering` | **Text and live.** Gates **inject** via `profileAllowsInject` / stages. Stage events always emit. Image/speech must omit |

Stop / cancel is not a profile field: composer `ProfileInterface` always projects `canStop: true`
(`TurnRequest.signal`). Text interfaces also project resolved `allowSteering`.

### Mid-turn steering

**Branch:** stage events + `onStage` — [`docs/contracts/stages.md`](stages.md).
Text and live mid-turn / mid-cycle inject use stages (`onStage`). Tool `pre_tool`
gates and `LiveSession.executeTool` are on the same contract.

On text turns the runner always yields `{ type: 'stage', stage }`:

1. `pre_turn` — once before the first provider step.
2. `post_tool` — per tool call, before its terminal `tool` event (inject window before the next model step; may `deny` / `mutate` the result).
3. `before_end` — before egress/validation; inject may re-enter the step loop under `maxSteps`.
4. `post_turn` — after terminal `done` (sees compaction-after when attached).

Inject applies only when `profileAllowsInject(profile)` (text + live when
`allowSteering !== false`). Where a named inject lands, the runner yields
`{ type: 'stage', stage, injected: [{ id }] }` (see [stages.md](stages.md)).

A text turn's opening input (`input.text`, attachments, voice) has one owner:
turn history. It becomes the last user message of history when the turn opens,
with or without `onStage`, so stage handlers see it in `history` and every tool
result, inject and repair lands after it on every provider. Providers get
`input: []` on text turns. Image and speech turns are a single call that reads
only the input, so they keep it there.

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
| `quota` | Host HTTP helper only (`@theoremjs/agents/guardrails`); not enforced inside `runTurn` |
| `canary` | Canary token at the end of the system prompt, the same for the same prompt; egress checks leakage unless the model was given it this turn |
| `detect` | What each detector does with a match at each boundary: `ignore`, `flag`, `redact` or `block` |
| `egress` | Exactly one of `checks` (the bundled checks: `true`, `false` or `EgressChecks`) or a host `enforce` hook; `onBlock`: `reject_to_agent` or `refuse_to_user`; `maxRetries`; `holdback` (host enforce only: mid-stream lookback, default 256; 96 on Live; the bundled policy holds exactly and rejects it); repair guidance is the lexicon's `egress.default_repair_guidance` |

## Compaction

Optional per-model policy on `ModelBinding.compaction`. Kernel owns trigger, split,
and timing; host owns persistence/reassembly unless `timing: 'before'` runs the
compactor inline. History tokens come from the host (`input.historyTokens`) or
the shared token estimator (below).

```ts
compaction: {
  maxTokens: 2000,
  compactAt: 0.75,
  previousExchanges: 8,
  profile: "my.compactor", // leave out to compact itself
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
| `input` | Full prompt: the turn's last model-call `tokens.input` (after), else `input.inputTokens` (before, or after with no call count) |

With neither count positive, compaction does not fire and `trigger` is not
called. `tokens` events always stream; they gate compaction only when
`meter: 'input'`. The `input` meter's estimate, when the provider reports no
count, covers the whole prompt: current-turn media, system, tools and schema.
`done.compaction.promptTokens` carries the last call's input tokens under either
meter; when that side is `estimated`, it is the estimate and
`promptTokensEstimated` is `true`. Under `meter: 'input'`, `unknownMedia`
carries the prompt media the estimate left out.

### History estimate (`meter: 'history'`)

1. Host `historyTokens` wins when set.
2. Else estimate from `input.history`:
   - **Text** — the `o200k_base` encoding (`TOKEN_TEXT_ENCODING`, via
     `gpt-tokenizer`) over content, text parts, tool-call names and arguments;
     an estimate for every family, since o200k is not every model's tokenizer.
     Loads **lazily** on first estimate (`loadTokenEstimator`).
   - **Media** — counted only by the model family's verified rule
     (`mediaTokenFamily` of the turn's binding), measured against billed
     usage. Gemini 3 flash / pro text models (`google` directly or `google/…`
     via OpenRouter; live and other variants have no rule): images by the
     1120-budget patch grid; audio `⌈25 × decoded seconds⌉` (raw PCM from its
     MIME parameters; ADTS AAC runs 2–3 over); video a 70-budget grid per
     second (rounded half up) plus the audio under those frames, for ISO-BMFF
     (MP4 / MOV / 3GP) and Matroska / WebM identified by their bytes; PDF 520
     per page; UTF-8 text documents as their text. Every other media part is
     **unknown**: `uri` references, unreadable headers, other containers, video
     whose audio length cannot be read exactly (Matroska audio other than
     unlaced Opus) or shorter than half a second, PDFs whose page tree cannot be
     read, non-UTF-8 text, inputs Gemini converts first (`text/md`, mono L16) or
     refuses (`audio/alaw`, `audio/mulaw`, `audio/pcm` with parameters, L16
     without `rate` / `channels`), and families without a rule. Unknown media is
     left out of `tokens` and counted in `unknownMedia` on `CompactionTokens`,
     `CompactionSignal`, `CompactionTriggerContext`, and the `compaction`
     event. Rules and live verification: `src/kernel/engine/token-estimate.ts`.
   - Current-turn attachments/voice are **not** history.

### `previousExchanges`

| Value | Retain |
| --- | --- |
| `≥ 1` integer | That many recent user-started exchanges |
| `(0, 1)` fraction | Tail fitting in `fraction * maxTokens` (must be `< compactAt`), by the estimator; unknown media counts as 0 |
| `0` | Compact everything |

### Compaction profile

A compaction profile is a registered text profile that takes text. Minimal
summarizer:

```ts
registerProfile(defineProfile({
  type: "text",
  id: "my.compactor",
  identity: {
    handle: "Compactor",
    system: "Summarize this conversation concisely. Preserve unresolved issues, "
      + "decisions, and key facts.",
  },
  models: { summarizer: summarizerBinding },
  key: "main",
  maxSteps: 1,
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: "my.summary.schema" },
  guardrails: { canary: false, detect: 'ignore' },
}));
```

Leave `profile` out and the agent compacts its own history. The summary turn
runs on the model being compacted for, with the agent's own instructions and no
tools, so the agent writes the summary as itself. Only a text profile that
takes text can compact itself, and that summary turn never compacts.

Compaction applies to `runTurn` profiles (`text`, `image`, `speech`);
`live` compacts with `live.contextCompression`.

### What the compactor reads

The compactor gets `toCompact` as its history, with the lexicon's
`compaction.request` as its input:

- Media its `inputs` do not accept is left out and counted in `droppedMedia`;
  a message left with nothing is skipped. Its byte limits are not applied to
  history, so `maxTokens` must fit the compactor's context.
- Tool calls and results become assistant text (`compaction.tool_call`,
  `compaction.tool_result`) naming the tool, so no provider needs the tools
  declared.
- An earlier summary in `toCompact` is summarized with the rest.

A completed, non-empty reply is the summary: the structured output as JSON,
else the text. It replaces `toCompact` as an assistant message with
`metadata.compactionSummary: true`.

### Outcomes

Anything else is a failure: a stop other than `completed`, an `error` event, a
thrown error, or an empty reply. When everything in `toCompact` is media the
compactor does not take, it does not run and that is a failure too. A failure
never leaves a partial summary.

| `outcome` | History after |
| --- | --- |
| `compacted` | The summary, then `toRetain` |
| `deferred` | Unchanged: the compactor failed and the metered count is within `maxTokens`, so the next turn tries again |
| `dropped` | Earlier summaries in `toCompact`, then `toRetain`: the compactor failed over `maxTokens` |

`failure` carries the compactor's `stop`, `error` kind, `empty: true`, or
`unreadable: true`.

Errors only the host can fix are thrown, not failures: a compactor that throws
or reports a `config`, `request`, `auth` or `internal` error throws it from
`runTurn` before the turn's model call, or from `compactHistory`. The host's
abort is not a failure either: the turn ends `cancelled`, with no `compaction`
event. The `theorem.compaction` trace event records `outcome`, the message
counts, `dropped_media`, `failure_stop` / `failure_error` / `failure_empty` / `failure_unreadable`
and the `summary`; `gen_ai.conversation.compacted` is set only on
`compacted`.

### After-turn signal

```ts
for await (const event of runTurn(req, provider)) {
  if (event.type === "done" && event.compaction?.needed) {
    const { history, tokens, unknownMedia, meter, promptTokens, promptTokensEstimated } =
      event.compaction;
    const result = await compactHistory(
      { profile: req.profile, model, history, tokens },
      provider,
    );
    if (result) persistHistory(result.history);
  }
}
```

`compactHistory` runs the compactor on the history `done.compaction` carried,
with the same split, reading, outcomes and trace event as `before`, in a trace
of its own (`traceparent`, `conversationId` and `metadata` join it to the
turn's). `model` defaults to the profile's default model, which must have
`compaction`. It returns `CompactionResult` (`outcome`, `toCompact`,
`history`, `summary` / `failure`, `droppedMedia`, the compactor's `tokens`),
or `undefined` when the split leaves nothing to compact. `provider` runs the
compactor.

No signal is attached when the turn has no history. `timing: 'before'` emits no
`compaction` event when the split leaves nothing to compact.

### Compaction exports

| Export | Role |
| --- | --- |
| `CompactionSpec` / `CompactionMeter` / `CompactionTriggerContext` | Config types |
| `CompactionSignal` | `done.compaction` payload |
| `compactHistory` / `CompactHistoryRequest` / `CompactionResult` / `CompactionOutcome` / `CompactionFailure` | Run the compactor after the turn |
| `CompactionSplit` / `CompactionTokens` | Split + resolved counts |
| `compactionMeter` / `resolveHistoryTokens` / `resolveCompactionTokens` | Meter resolution |
| `loadTokenEstimator` / `mediaTokenFamily` / `TOKEN_TEXT_ENCODING` / `MediaTokenFamily` / `TokenEstimator` / `TokenCount` / `MediaPayload` | Shared token estimator (o200k text, verified media rules) |
| `sumTokens` | Total of several calls' `TurnTokens` (see Token usage) |
| `compactionNeeded` / `shouldCompact` | Threshold / custom trigger |
| `splitForCompaction` | `{ toCompact, toRetain }` |

Register-time validation: `maxTokens`, `compactAt`, `previousExchanges`, `profile` and `timing`
are set, `maxTokens > 0`, `compactAt ∈ (0,1)`,
`previousExchanges ≥ 0`, an integer when `≥ 1` and `< compactAt` when fractional, meter ∈ `{history,input}`,
compaction profile registered first and a text profile that takes text.

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
(Google Interactions implicit hits via `total_cached_tokens` included; OpenRouter
`prompt_tokens_details.cached_tokens` / `cache_write_tokens`).

## Stop and resume

`TurnStopKind` values are the `TURN_STOP_KINDS` array in `src/kernel/schema.ts`.
Providers map native finish reasons into `TurnStop` on terminal `done` events.
Its shape is `turnStopSchema` in `src/kernel/turn-events.ts`; `src/kernel/stop.ts`
re-exports the type and owns only the resume policy below.

| `kind` | Meaning |
| --- | --- |
| `completed` | Normal completion |
| `length` | Output / budget cut off |
| `tool` | The model called tools and the turn hands them to the host; `done.tools` is the turn's tool snapshot |
| `gate` | A `pre_tool` gate (confirm / permission / auth) stopped a call before it ran; `done.tools` is the snapshot. Host resumes via `invokeTool` (live: `executeTool` with a `decision`) |
| `filtered` | Output blocked: the provider's content filter, or a Theorem guardrail (`native: 'canary'` for a canary leak, `'egress'` for an egress block, withheld or replaced by policy copy) |
| `provider_error` | Upstream failure: a finish reason that says so, or any `error` the provider sent during the call (it outranks the call's own `done`) |
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
| `isContinueStopKind` | Narrow to continue-eligible kinds |
| `isResumeableStop` | Profile `allowContinue` (`[]` allows none) or, when omitted, the default; always false outside ContinueStopKind |
| `shouldAutoContinue` | One silent resume under the profile's resumption policy (`autoContinue` and `allowContinue`); never outside ContinueStopKind |
| `isUserCancelledStop` | `kind === 'cancelled'` |
| `profileTurnResumption` | Read `turnBehaviour.resumption` |
| `profileAllowsSteering` | Text + `allowSteering !== false` (interface inject projection) |
| `profileAllowsInject` | Stage inject gate: text + live when `allowSteering !== false`; never image / speech / host ([`stages.md`](stages.md)) |

### Continue turn

```ts
for await (const event of runTurn({
  profile: "my.agent",
  input: {
    history: [...priorHistory, { role: "assistant", content: bufferedAssistantText }],
  },
  continueFrom: { stop: previousDone.stop },
}, provider)) { /* … */ }
```

`GenerationStopError` / `isGenerationStopError` optional throw path for hosts
that prefer exceptions over stream `done.stop`.

## Validation

Beyond compaction rules (above), `registerProfile` / `defineProfile` assert:

- Each `tools.allow` id is a registered **custom** tool (builtins rejected here).
- Each `models.*.builtInTools` id is a registered **builtin**.
- Each key in `models` is a host-named model id with a full `ModelBinding`.
- Profiles with attachments or voice set `maxFiles`, `maxBytes`, `maxTurnBytes`;
  those and every `limitsByMime` value are positive integers.
- Each non-local model (`google`, `openrouter`, and a decision model) has
  `models.*.key` or the profile has `key`; there is no flat key.
- Each `efforts` level is one of `THINKING_LEVELS`. Which of those a model
  takes is not the kernel's to say: the Google providers refuse a level
  outside `GOOGLE_THINKING_LEVELS` (`unsupported`).
- A slot-mapped `outputs.structured` names a slot in `inputs.slots`, and its
  `map` keys are that slot's choices. At turn time `resolveTurn` rejects a slot
  the profile does not declare, or a value outside its choices (`request`).
- `models.*.cache` only when `protocol: 'openAi'` and `provider: 'openrouter'`.
- `models.*.server` only when `provider: 'local'`, as a non-empty string.
- `models.*.store` / `persistViaInteractionId` only when
  `protocol: 'geminiInteractions'` and `provider: 'google'`.
  **Breaking:** previously these fields were accepted on any binding and ignored
  at runtime; `defineProfile` now rejects them outside Interactions+google.
- `models.*.persistViaInteractionId` is required on every
  `geminiInteractions` binding (`config`): `true` chains each step and turn on
  Google's stored interaction, `false` sends the host's history (`input.history`)
  plus this turn's steps every call. There is
  no default, so chaining is always a choice the profile states. `true` with
  `store: false` is refused, since Google chains only from a stored interaction.
  At turn time `resolveTurn` refuses (`request`) a `previousInteractionId` on a
  model that does not chain, and a `store: false` turn on one that does.

Runtime structured validation uses `outputs.validation.fields` keyed by dotted
paths; failures can trigger repair turns via `input.repair`.

## Headless interface

Framework-neutral helpers for profile-driven runtime UIs, published at
`@theoremjs/agents/interface`. `@theoremjs/react` renders them.

`ProfileInterface` is `Profile` as JSON, what a host sends the browser:
resolved `inputs` (with `acceptAttr`), tool ids (`ProfileToolsView`; a tool's
definition, including its endpoint and headers, stays on the host), and
`models`, `outputs`, `guardrails` and `observability` without host functions
(`ModelBindingView` drops a compaction `trigger`; `ProfileOutputsView` drops
`validation`). Projection flows through kernel `projectProfileObject` /
`projectProfile`, then through `profileInterfaceSchema`, its one schema: a
field the schema does not name never leaves the host, and the browser's
transport checks `describe` against the same schema (`bad_response` when it
fails).

| Concern | Entrypoints |
| --- | --- |
| Spec | `interfaceFromProfile(profile, tools)` (projects against that tool registry), `interfaceFromProjected` (an already projected profile) |
| Inputs | `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime` |
| Draft | `sanitizeUserDraft`, `prepareUserTurn` |
| Transcript | `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `streamThoughtsEnabled` |
| History | `appendUserDraftToHistory`, `appendToolExchangeToHistory` (replays `readBack`), `toolReadBack`, `userDraftToSteerInject`, … |
| Composer intents | `createComposerPendingMessage`, `orderComposerPendingMessages`, `consumeNextComposerSteer` / `Queue`, `convertSteersToFrontQueued`, `resolveComposerPrimary`, `resolveComposerMenuActions` |

`foldTurnEvents` maps kernel `media` events (base64) and also promotes http(s)
image / video / audio URLs found in completed tool `output` into `media` blocks
with `url` set (extension-based MIME guess). Copies of one file are promoted
once: a MediaWiki `/thumb/…/<N>px-` resize and its original share a key
(last two host labels + path, `utm_*` params ignored); the largest copy is
`url` and the smallest, when different, is `previewUrl`. Tool JSON in the tool
block is unchanged. `historyFromTranscriptBlocks` still ignores media blocks — the tool
exchange already carries the URL.

The `observability` view is the resolved policy without functions: `record`,
`sampleRate`, `include`, `scrub`, `resource`, `retainForDays`, `rotateAfterMiB`,
`writeTo` as absent, `false`, a registered id, or `'custom'` for an inline sink, and
`hasOnWriteError`.

A gated call's `auth` (`ToolGateAuth`: `slot`, `authType`, `service`) is the
one shape the kernel's gate answer and the interface's gated-tool context share.

### Composer pending intents

Headless contract for stash / queue / steer (Seance-aligned). Kernel owns stages +
`onStage` inject + `AbortSignal`; the interface owns pending list ops and the action matrix;
`@theoremjs/react` owns UI.

| Intent | Lifetime |
| --- | --- |
| `stash` | Never auto-sent; user promotes |
| `queue` | New user turn after the **agent run fully ends** (not on tool pause resolve) |
| `steer` | Inject at next inject-capable stage via host `onStage` (same run — `docs/contracts/stages.md`) |
| `send_now` | Immediate abort + send (not a pending kind) |

Primary matrix: idle+payload → Send; streaming+empty → Stop; streaming/gated+payload → Queue.
Enter matches primary. Menu offers Queue / Steer / Send now / Stash as applicable.
The run names each steer it took in on a `stage` event's `injected` (by the steer's id); the client drops those from pending, and the steers still undelivered convert to the front of the queue when the run ends.
Tool **gate** does not drain the queue and does not offer Steer (not an inject stage).
Send now while gated walks away from every waiting gate in the message's own
request (`abandon` on the turn request, `walkAway` in `@theoremjs/react`): the
host settles each call cancelled, and the model reads those answers before the
message. Awaiting completions (`ask_user`) are not composer
`gated` — the turn may already be idle; use `awaitingFromEvents`.

```ts
import { interfaceFromProfile, foldTurnEvents, streamThoughtsEnabled } from '../src/interface/mod.ts';

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
| Compaction | `compactHistory`, `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Token estimate | `loadTokenEstimator`, `mediaTokenFamily`, `TOKEN_TEXT_ENCODING`, `MediaPayload`, `MediaTokenFamily`, `TokenCount`, `TokenEstimator`, `sumTokens` |
| Runner | `runTurn`, `runSession`, `runDecision`, `validateDecisionRequest`, `RunSessionOptions`, `SignInGatePolicy`, `RunDecisionOptions`, `DecisionError`, `prepareLiveInboundText`, `liveIngressEnabled`, `liveIngressEnabledFromSpec`, `liveIngressChannelDefault`, `hasAnyLiveIngress`, `assertLiveIngress`, `assertLiveIngressConfigured`, `LiveIngressChannel` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaChannelForMime`, `MediaInputChannel`, `mediaKindForMime`, `getTool`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `registerTools`, `requireModelBinding`, `resetTools` |
| Schema | `PROFILE_FIELDS`, `PROFILE_GRAPH`, `PROFILE_TYPES`, `PROFILE_TYPE_PROTOCOLS`, `protocolsForProfileType`, `isValidProfileProtocol`, `EXTRA_FIELDS`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `spineFacetsForProfileType`, `profileGraphFacet`, `ProfileGraphFacet`, `ProfileGraphFacetId`, `ProfileGraphEditor`, `ProfileGraphRole`, `PROTOCOLS`, `PROVIDERS`, `PROTOCOL_PROVIDERS`, `providersFor`, `protocolsFor`, `isValidPair`, `coerceProvider`, `coerceProtocol`, `THINKING_LEVELS`, `KEY_SLOT_NAME`, `isKeySlotName`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `IMAGE_ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `COMPACTION_METERS`, `COMPACTION_OUTCOMES`, `COMPACTION_TIMINGS`, `CACHE_MODES`, `CACHE_TTLS`, `TURN_STOP_KINDS`, `CONTINUE_STOP_KINDS`, `TURN_STAGES`, `TURN_INJECT_STAGES`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION`, `TOOL_TYPES`, `AUTH_UNAUTHENTICATED_POLICIES`, `HTTP_METHODS`, `PLAYGROUND_AUTH_TYPES`, `TOOL_AUTH_TYPES`, `AuthUnauthenticatedPolicy`, `CustomToolType`, `HttpMethod`, `PlaygroundAuthType`, `ToolAccess`, `ToolAuthType`, `ToolPermission`, `ToolType`, `ToolGateKind`, `TurnStage`, `TurnInjectStage`, `AwaitingUserInputKind`, `EGRESS_ON_BLOCK`, `EgressOnBlock` |
| Utilities | `base64ToBytes`, `bytesToBase64`, `isRecord`, `Equals` (compile-time type equality, for exact-shape checks) |
| Scope | `KernelScope`, `createKernelScope`, `defaultKernelScope`, `KernelRegistry`, `createKernelRegistry` |
| Profiles | `ProfileDefinition`, `ProfileDefinitionBase`, `TextProfileDefinition`, `ImageProfileDefinition`, `SpeechProfileDefinition`, `LiveProfileDefinition`, `HostProfileDefinition`, `DecisionProfileDefinition`, `ProfileRegistry`, `createProfileRegistry`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `projectProfileObject`, `requireModelProfile`, `resolveTurn` |
| Tools | `ToolRegistry`, `createToolRegistry`, `registerTool`, `registerTools`, `invokeTool`, `GATE_DECISIONS`, `GateDecision`, `answerGatedCall`, `GateAnswerRequest`, `HeldGatedCall`, `AnsweredGate`, `ToolGateAuth`, `gateExpired`, `resolveGateTtlMs`, `sessionPermissionsAfterApproval`, `askUserTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `resetTools`, `formatToolResult`, `projectForModel`, `coerceToolResultParts`, `leanToolResultData`, `wireInteractionPart`, `isMediaRefPart`, `prepareTurnToolSnapshot`, `buildHttpToolTarget`, `executeHttpTool`, `executeMcpTool`, `parseMcpRpcResponse`, `isUnsupportedMcpProtocolError`, `MCP_PROTOCOL_VERSIONS`, `McpProtocolVersion`, `resolveToolAuth` |
| Auth (stateless OAuth/PKCE) | `createOAuthPkceFlow`, `exchangeOAuthPkce`, `refreshOAuthToken`, `discoverResourceMetadata`, `discoverAuthServerMetadata`, `validateIssuer`, `tokenAudienceCovers`, `generateCodeVerifier`, `computeCodeChallenge`, `sealStatePayload`, `unsealStatePayload`, `sealSecret`, `openSecret`, `SealSecretInput`, `OpenSecretInput`, `ToolCredentialSource`, `memoryCredentialSource` |
| Structured | `SchemaRegistry`, `createSchemaRegistry`, `getStructured`, `registerStructured` |
| Stop / resume | `ProfileTurnBehaviourSpec`, `MediaTurnBehaviourSpec`, `ProfileTurnResumptionSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `ContinueStopKind`, `CONTINUE_STOP_KINDS`, `AUTO_CONTINUE_DELAY_MS`, `DEFAULT_ALLOW_CONTINUE`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isContinueStopKind`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `profileAllowsSteering`, `profileAllowsInject`, `profileTurnResumption`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |
| Stages (target foundation) | `TURN_STAGES`, `TURN_INJECT_STAGES`, `STAGE_AFFORDANCES`, `STAGE_AFFORDANCE_MATRIX`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `applyStageResult`, `awaitingUserInputSchema`, `toolGateSchema`, `isTurnStage`, `isTurnInjectStage`, `isToolGateKind`, `isAwaitingUserInput`, `stageAllowsAffordance`, `stageEventFields`, `profileAllowsInject`, `StageAffordance`, `StageContext`, `StageResult`, `StageMutate`, `StageHandler`, `StageApplyInput`, `StageApplyOutput`, `StageApplyWarning`, `StageApplyWarningCode`, `StageEventExtra`, `AwaitingUserInput`, `ToolGate` — see [`stages.md`](stages.md). Slices 1–3 landed on branch; publish when release cut matches docs. |
| Turn events | `TurnEvent`, `TurnEventOf`, `TurnEventType`, `ProviderEvent`, `CallDone`, `DoneFields`, `SessionEvent`, `SessionEventOf`, `TURN_EVENT_SCHEMAS` (each kind's schema, for a wire parser), `turnEventSchema`, `turnHistoryMessageSchema`, `turnToolSnapshotSchema`, `turnDoneOf`, `z` (the zod these schemas are built with; compose them with it, since two copies of zod do not mix) |
| Interface (headless) | `interfaceFromProfile`, `interfaceFromProjected`, `profileInterfaceSchema`, `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime`, `sanitizeUserDraft`, `prepareUserTurn`, `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `resetBlockIds`, `streamThoughtsEnabled`, `collectPromotedMediaFromToolOutput`, `promotedMediaFromUrlString`, `PromotedToolMedia`, `defaultInterfaceEffort`, `effortSelectEnabled`, `generationSelectEnabled`, `interfaceEffortOptions`, `interfaceModelOptions`, `modelSelectEnabled`, `appendAssistantEventsToHistory`, `appendToolDenialToHistory`, `appendToolExchangeToHistory`, `appendUserDraftToHistory`, `historyFromTranscriptBlocks`, `toolReadBack`, `applyTurnEventsToSession`, `branchInterfaceTurnSession`, `emptyInterfaceTurnSession`, `gatedToolFromEvents`, `awaitingFromEvents`, `promotedToolIdsFromEvents`, `toolSnapshotFromEvents`, `gatedToolsFromEvents`, `toolCallsOf`, `settlesToolCall`, `toolCallRanWith`, `appendPausedTurnToHistory`, `answerOpenToolCalls`, `assertOpenToolCalls`, `removeLandedSteers`, `SettledToolCallEvent`, `ToolGateAuth`, `COMPOSER_PENDING_KINDS`, `cloneUserTurnDraft`, `composerPendingPreview`, `consumeNextComposerQueue`, `consumeNextComposerSteer`, `convertSteersToFrontQueued`, `createComposerPendingMessage`, `moveComposerPendingWithinKind`, `orderComposerPendingMessages`, `promoteComposerPendingKind`, `removeComposerPendingMessage`, `resolveComposerMenuActions`, `resolveComposerPrimary`, `updateComposerPendingDraft`, `userDraftHasPayload`, `userDraftToSteerInject`, `AttachmentValidationCode`, `AttachmentValidationIssue`, `AttachmentValidationParams`, `AttachmentValidationResult`, `AwaitingToolContext`, `ComposerActionContext`, `ComposerInterfaceFields`, `ComposerMenuAction`, `ComposerPendingKind`, `ComposerPendingMessage`, `ComposerPrimaryAction`, `ComposerProfileInterface`, `ComposerRunPhase`, `CreateComposerPendingMessageArgs`, `FoldTurnEventsOptions`, `GatedToolContext`, `ImageProfileInterface`, `InterfaceEffortOption`, `InterfaceModelOption`, `LiveProfileInterface`, `ModelBindingView`, `PendingAttachment`, `PrepareUserTurnResult`, `ProfileGuardrailsView`, `ProfileObservabilityView`, `ProfileInputsInterface`, `ProfileInterface`, `ProfileOutputsView`, `ProfileToolsView`, `SpeechProfileInterface`, `TextProfileInterface`, `TranscriptBlock`, `TranscriptBlockKind`, `UserTurnDraft`, `UserTurnHistoryMedia`, `InterfaceTurnSession` |
| Attachments (kernel) | `attachmentIssues`, `attachmentIssueCopy`, `attachmentIssueText`, `attachmentsRefused`, `assertTurnAttachments`, `maxBytesForMime`, `requireMediaLimits`, `resolveMediaLimits`, `sanitizeCsvText`, `sanitizeTurnBlobs`, `AttachmentFacts`, `AttachmentRules` |

`PromotedToolMedia` and `media` `TranscriptBlock`s carry an optional
`previewUrl`: a smaller copy of `url` for thumbnails, when the tool output
offered one.

```theorem-evidence
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
    "Facts and policy": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/lexicon.ts" },
        { "kind": "source", "path": "src/kernel/stop.ts" },
        { "kind": "contract_test", "path": "tests/kernel/two-hosts-boundary.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/zero-permission-import.test.ts" }
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
    "Decision profile": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/decision.ts" },
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "contract_test", "path": "tests/kernel/decision.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" }
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
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/turn-stages.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/abort.test.ts" }
      ]
    },
    "Stream events": {
      "supports": [
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Kernel scope": {
      "supports": [
        { "kind": "source", "path": "src/kernel/scope.ts" },
        { "kind": "source", "path": "src/kernel/default-scope.ts" },
        { "kind": "source", "path": "src/kernel/registry/kernel-registry.ts" },
        { "kind": "contract_test", "path": "tests/kernel/scope.test.ts" }
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
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/network.test.ts" }
      ]
    },
    "Outputs and guardrails": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Compaction": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/compaction.ts" },
        { "kind": "source", "path": "src/kernel/engine/token-estimate.ts" },
        { "kind": "source", "path": "src/kernel/engine/media-probe" },
        { "kind": "contract_test", "path": "tests/kernel/token-estimate.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/media-probe.test.ts" },
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
        { "kind": "contract_test", "path": "tests/react/gate-resume.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "source", "path": "src/interface/mod.ts" },
        { "kind": "source", "path": "src/kernel/auth/mod.ts" },
        { "kind": "source", "path": "src/guardrails/network.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/auth.test.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/network.test.ts" },
        { "kind": "contract_test", "path": "tests/interface/headless.test.ts" }
      ]
    }
  }
}
```
