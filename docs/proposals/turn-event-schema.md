# Turn event schema — one checked definition per event kind

Status: proposal · ships as a 2.0.x patch (breaking changes stay on 2.0.x)

## Invariant

**Every value the code acts on has been proven to be the type the code says it is, by one definition, and anything that fails that proof is a named, reported failure.**

1. **Checked where it enters.** Every value that crosses a wire (NDJSON reply, live WebSocket, relay) is parsed before any code touches it. No `as`, no non-null assertion.
2. **One shape, checked both ways.** Each public type is a hand-written, documented type (what builders read in their editor and in the JSR docs; JSR's `no-slow-types` rule forbids publishing inferred types). Its zod schema is exported as `z.ZodType<T>`, and a compile-time exact-equality check fails the build if the schema and the type differ in any field, optional or not (decided). The old interfaces that had no schema are replaced by these pairs.
3. **Closed sets.** Every kind, stage and sub-kind is listed. The unrecognised gets a named slot that carries the raw value, never an open `string`.
4. **Failures are loud and named.** A value that fails the check ends the turn with a `bad_response` error. It is never dropped, defaulted or passed through.

**Defensive, not brittle.** A sender adding something new is not a failure. Anthropic's versioning policy says it may "add additional values to the output" and "add new variants to enum-like output values (for example, streaming event types)", and its streaming docs say code "should handle unknown event types gracefully"; Google's APIs evolve the same way. Theorem's own server and client also drift apart whenever a browser runs an older bundle. So:

| What arrives | Result |
|---|---|
| A field the schema does not list | Dropped. Wire schemas use plain `z.object` (zod strips unknown keys); `.strict()` and `.passthrough()` are not used on them. No code can act on a field it did not check. |
| A kind the schema does not list | A named slot, reported — never a failure. Provider → Theorem: `provider_step`. Theorem → client: `unsupported`. |
| A listed field that is missing or the wrong type | `bad_response`. |

For the user and the agent: **nothing the user sees, and nothing the agent believes happened, rests on an unchecked value.** A turn that fails, or a reply that is cut off, is recorded in the history the agent reads next turn.

## Why

Today, three places on the wire trust what arrives:

| Site | Today |
|---|---|
| `react/src/client/transport.ts:154` | `JSON.parse(line) as Line & HostErrorBody` — any NDJSON line is taken as an event |
| `react/src/client/live-messages.ts` `isTurnEvent` | any object with a `type` field counts as an event |
| `react/src/client/live-messages.ts:50,74` | trace record and `executeToolResult.gate` cast |

Hand-written parsers that duplicate the types: `parseToolGate` (`src/kernel/stages.ts:251`), `parseAwaitingUserInput` (`stages.ts:180`), `hostError`/`isErrorKind` (`transport.ts`).

What the user sees today when an event is malformed: a confirmation card that never resolves, a reply drawn half-way, a live call that hangs until timeout. None of it is reported.

## The event kinds (complete)

`TurnEvent` becomes a discriminated union on `type`. Each kind lists its fields; a field a kind does not list is dropped (see "Defensive, not brittle").

| `type` | Fields |
|---|---|
| `thought` | `text` |
| `text` | `text` |
| `structured` | `structured` (unknown — the profile's schema validates it) |
| `media` | `media: { mimeType, data }` |
| `grounding` | `grounding` (`GroundingEvent`, search metadata only — sources move to `citation`) |
| `citation` | `sources: Source[]`, `callId?` (see Additions) |
| `compaction` | see Additions |
| `evidence` | `evidence` (see Evidence), `text?`, `sessionResumptionHandle?` |
| `tokens` | `tokens` (`TurnTokens`), `interactionId?` |
| `response` | `response` (`TurnResponse`) — provider → runner only |
| `session` | `session` (see Session), `errorInternal?` |
| `guardrail` | `guardrail` (`GuardrailEvent`) |
| `stage` | `stage`, `callId?`, `toolName?`, `callNotStarted?`, `awaiting?`, `gate?`, `stop?`, `stageWarnings?` |
| `tool` | `tool` (see Tool), `errorInternal?` (an untrusted server's words about the call, e.g. a refused token refresh; builder only) |
| `done` | `stop`, `tokens?` (the turn's summed usage), `traceparent?`, `tools?`, `compaction?`, `interrupted?`, `interactionId?` |
| `error` | `errorKind`, `error?`, `errorCopy?`, `errorInternal?` |

Two unions are exported:

- `turnEventSchema` (`TurnEvent`) — what `runTurn` yields: what hosts receive and what the wire parsers check.
- `ProviderEvent` — a type only: `TurnEvent` plus `response`, with a call's `done` (`CallDone`) before the runner decides its stop. It never crosses a wire, so it has no schema.

`done.tools` is required when `stop.kind` is `tool` or `gate` and absent otherwise (refinement).

### Tool — one schema per stage (`tool.phase`)

The model's raw call (phase absent) is the first event hosts receive for every call, in turns as in live sessions, and the one owner of its arguments; phase events never repeat them (decided). Readers join a call's events by `callId`.

Every stage carries `name` and `callId`. The provider-native `id` is folded into `callId` at the provider; `id` is deleted. Today a cancel carries only `id` and history reads `tool.id ?? tool.callId`.

| `phase` | Fields |
|---|---|
| absent (the model's raw call) | `arguments` |
| `running` | `edited?` (`{ from, to }` — see "Edit arguments on approval"; `to` is the input that runs) |
| `progress` | `data` |
| `trace` | `step` (`ToolTraceStep`) |
| `artifact` | `artifact` |
| `warning` | `warning` (`ToolWarning`) |
| `complete` | `output`, `awaiting?` |
| `gate` | `gate` (`ToolGate`) |
| `error` | `failure` (`ToolFailure`) |
| `cancel` | — |

A refusal is already typed: phase `error` with `failure.kind` `declined` (the user said no) or `blocked` (a guardrail or hook said no); `cancelled` is a call the user walked away from. No separate phase — see "A refusal goes through the kernel" under Additions.

`pause` is deleted, along with the `ToolPause` type and `ToolCallEvent.pause`. How a tool waits for the user:

- **Before it runs** (confirmation, permission, sign-in): phase `gate`; the turn ends with stop `gate` and a snapshot of the turn's tools.
- **After it runs** (asks the user something): phase `complete` with `awaiting_user_input` output.

`ToolGate` is a union on `kind`: `auth` requires `authChallenge` (its own named schema, `toolAuthChallengeSchema`); `confirmation` and `permission` carry none. `tool`, `summary`, and the challenge's `slot`/`message`/scopes are trimmed, non-empty text. `AwaitingUserInput` is a union on `kind`: `choice` requires at least one option. These are the rules `parseToolGate` / `parseAwaitingUserInput` applied by hand; the schemas now own them, and the hand parsers' lenient drops (an unknown `permission`, a blank `summary`, a `fallbackTool`) are gone — a wrong listed field fails the parse.

The HTTP tool auth option `onUnauthenticated: 'pause'` is renamed to `'gate'` (`AUTH_UNAUTHENTICATED_POLICIES = ['gate', 'report_to_model']`). This is a breaking profile change.

### Evidence — one schema per `evidence.kind`

Every evidence carries `provider` and may carry `raw` and `partial`. `raw` is the provider's own payload, for the builder; `forClient` strips it unless `includeEvidenceRaw`, so no kind requires it.

| `kind` | Fields |
|---|---|
| `code_execution_call` | `code`, `language?`, `id` |
| `code_execution_result` | `result?`, `isError?`, `callId?` |
| `input_transcription` / `output_transcription` | `interim?` (text rides on the event) |
| `voice_activity` | — (the signal is in `raw`) |
| `session_resumption` | `resumable` (handle rides on the event) |
| `url_context` | — (Live; the step is in `raw`) |
| `provider_step` | `step` (the provider's own step type, e.g. `google_search_call`, `url_context_call`) |

`provider_step` replaces the open `kind: string`. A new Google built-in parses as a `provider_step` without a release.

### Session

`session.kind`: `closing_soon` · `ended` · `waiting_for_input` · `turn_complete` · `working` · `idle`. `ended` requires `ended` (`SessionEnded`) and `message`. The others do not list them (dropped if sent). `timeLeftMs?` is allowed on `closing_soon` and `ended`.

### Stop

`TURN_STOP_KINDS` is unchanged. Remove the `@deprecated` note on `tool`: it is how every turn that calls a tool ends (`src/kernel/stop.ts:198,216`), not the old pause.

### Existing subtypes that become schemas

`GroundingEvent`, `GuardrailEvent` (+ hits, `Provenance`), `TurnHistoryMessage` (+ `InteractionPart` — it rides on `compaction` events and request bodies), `TurnTokens`, `TurnResponse`, `CompactionSignal`, `TurnStop`, `TurnToolSnapshot`, `ToolGate`, `ToolFailure`, `ToolWarning`, `ToolTraceStep`, `StageApplyWarning`, `SessionEnded`, `ErrorCopy`, `AwaitingUserInput`, `TraceRecord` (+ `TraceSpan`). Each interface is deleted and replaced by `z.infer` of its schema. Homes: `src/kernel/turn-events.ts` (events and kernel subtypes), `src/guardrails/event-schemas.ts` (`ErrorKind`/`ErrorCopy`/guardrail shapes — guardrails never import the kernel), `src/observability/trace-schema.ts` (trace record; the recursive attribute value keeps a hand-written type the schema is checked against). Enums build from the existing `as const` arrays (`TURN_STOP_KINDS`, `TURN_STAGES`, `TOOL_GATE_KINDS`, `ERROR_KINDS`).

## Where the check runs

The kernel keeps building events as typed values; the types come from the schemas, so nothing drifts. Parsing happens only where a value crosses a wire:

| Boundary | Change |
|---|---|
| `react/src/client/transport.ts` | `readNdjsonStream(response, lineSchema, onLine)`. `lineSchema` is `turnEventSchema`, or `turnEventSchema.or(hostLineSchema)` when a host adds its own line types. Removes the `Line extends StreamLine` generic and the cast. `hostError` reads a parsed `error` event. |
| `react/src/client/live-messages.ts` | `liveServerEnvelopeSchema` (`ready`, `events`, `trace`, `error`, `executeToolResult`) replaces the hand parsers, `isTurnEvent` and both casts. |
| `react/src/client/live-client.ts:440` | `liveServerEnvelopeSchema.safeParse(JSON.parse(data))`. |
| Browser → server (`react/src/server/handler.ts`) | `/turn`, `/invoke`, `/steer` bodies parse with `theoremTurnRequestSchema`, `theoremInvokeRequestSchema` (gains `decision` and `input`), `theoremSteerRequestSchema`. `readJson<T>` and `assertTurnBody`/`assertInvokeBody`/`assertSteerBody` are deleted. A bad body stays a `request` error (400), as today. |
| Browser → live relay | The client's `executeTool` message gets a schema, exported for hosts' relays to parse with. |
| `parseToolGate`, `parseAwaitingUserInput`, `isErrorKind` | Become `toolGateSchema.safeParse` etc. The hand-written versions are deleted. |
| Provider adapters (`src/providers`) | A provider event or step the adapter does not map becomes `provider_step` (carrying `step`, with the step in `raw`) instead of being ignored or failing. |

**Unknown kinds on the client.** When a line's `type` (or a live envelope's kind) is not one the client knows, the client parser yields `{ type: 'unsupported', received, raw }` to the same handler as every other event, instead of `bad_response`. `unsupported` is never emitted by the server and is not in `turnEventSchema`; it exists only in the client's parse result. The turn continues. The host decides what to show; Theorem adds no copy for it.

A failed parse ends the turn as `error` with `errorKind: 'bad_response'` and the profile's existing `bad_response` wording (decided). `errorInternal` carries the zod issue path and the kind that failed, never the payload.

## History: the agent knows what happened

Today `historyFromTranscriptBlocks` (`src/interface/history.ts`) records failed and denied tool calls, but:

- drops `error` blocks, so the next turn doesn't know the last reply failed;
- saves a cut-off reply as if it were complete.

Change (decided: the agent is told):

| Turn ended with | History gets |
|---|---|
| `error` | an assistant note naming the failure kind |
| stop `stream_incomplete` / `cancelled` / `interrupted` with partial text | the partial text, followed by a note that the reply was cut off and why |

The note text comes from the lexicon (so hosts can reword it). **Locked lines:**

- `history.turn_failed`: "[My previous reply failed ({kind}) and did not reach the user.]"
- `history.reply_cut_off`: "[My previous reply was cut off ({reason}); the user saw only the text above.]"

Once this ships, Bonsai moves iMessage delivery failure (`imessage-outbound-delivery-failure.ts`) onto this path, so the fact has one owner.

## Additions from the Seance review (decided)

Theorem makes anything possible; it does not build everything possible. Host-specific cards stay with the host.

### On the wire (this patch)

| Change | Detail |
|---|---|
| Citations are first-class | New event kind `citation`: `{ sources: Source[], callId? }`. `Source` = `{ title, uri, type, placeId? }` (today's `GroundingSource`, with `type` widened past `maps`/`web` as providers need). Google grounding, OpenRouter `citations`/`annotations` and tool results all emit it; `callId` ties a citation to the tool that produced it. `grounding` keeps only search metadata; `evidence.citations`/`sources` and the evidence `citations` kind are deleted. Today the React layer rebuilds chips from three shapes (`react/src/client/source-chips.ts`) — that collapses to one. |
| Tools can attach sources | A tool declares `sources: (output) => Source[]` at registration (function, HTTP and MCP alike, so remote tools need no output wrapper). On a completed call the kernel runs it on the settled output and emits a `citation` with the call's `callId` before `complete`. A source that fails `sourceSchema`, or a throw, is a `sources_invalid` tool warning and is not cited; the call and the model's result are unchanged. The `execute_tool` span records the cited sources as `theorem.grounding`. (DECIDED 26/09/2026, option D.) |
| Tool timing | Every tool phase event carries `at` (epoch ms). The transcript derives start (`running`) and end (`complete`/`error`/`cancel`/`gate`) — the latency timer — without the trace. |
| A refusal goes through the kernel | The kernel already types a refusal: `resume: { granted: false }` settles as phase `error`, `failure.kind: 'declined'`, runs `post_tool`, and records a `denied` span (`src/kernel/tools/execute.ts:920–932`; frozen in `docs/contracts/stages.md` "Deny resume … do not skip settle"). Live uses it (`react/src/client/live/run-live-tool-call.ts:26`). Web does not: `resumeDeniedGatedTool` (`react/src/client/run-session.ts:238`) makes up the failure in the browser (with an `as TurnEvent` cast and no `kind`), so no `post_tool` fires, the trace never records the refusal, and the server's pending gate lives on until its TTL. Web refusals go to `/invoke` with `decision: 'deny'`; the server drops the gate and runs `invokeTool` with `granted: false`. Walking away from a gate (sending a new message instead) goes the same way with `decision: 'abandon'`, which settles as `failure.kind: 'cancelled'` (`InvokeToolResume` gains `cause: 'declined' \| 'abandoned'`). The browser-made failures in `run-session.ts` and `session.ts:201–227` are deleted. The deprecated `InvokeToolResume.value` is deleted. A resume continues the model's call, so `InvokeToolRequest` gains `callId`: the handler passes the gate's id and the invoke's phase events join the raw call the turn already announced. A host's own call (no `callId`) gets a fresh id and announces its raw call first. |
| Token use on `done` | `done` carries `tokens`: `sumTokens` (`src/kernel/engine/usage.ts:138`) over the turn's own `tokens` events — the same sum the trace's root span already uses (`src/kernel/engine/turn-trace.ts:905`). Every field is published: input, output, thinking, toolUse, cached, cacheWrite, total, cost (incl. `partial`), estimated, unknownMedia, byModality, grounding. The host decides what to show. Per-call `tokens` events stay. |
| Compaction is an event | New event kind `compaction`: `{ timing, meter, tokensBefore, unknownMedia, messagesBefore, messagesAfter, summary, history, tokens? }`, emitted when Theorem compacts (`timing: 'before'`). `history` is the compacted history the host must keep; `tokens` is the compaction call's own usage. `done.compaction` (the `after` signal) keeps its payload instead of being folded to a boolean. |
| Tool labels | Done (2026-09-30), differently from first proposed: the kernel fills `ToolBase.labels` per call, with `{path}` placeholders from the input and output, and the `running` / `complete` phases carry the filled `activity` / `activityPast` (`docs/contracts/kernel.md`, "Activity labels"). A transcript shows "Reading about Paris" rather than `wikipedia_summary`. The unwritten `TurnToolSnapshot.labels` is removed. |
| Live sessions hold their own calls | Today `LiveSession.executeTool` (`src/kernel/engine/session/mod.ts:654`) runs whatever `name`, `input` and `resume` its caller passes, and the live client sends all three from the browser (`react/src/client/live-client.ts:646`) through a relay each host writes. A relay that forwards them lets the browser skip permission and `preTool` (`granted: true`) and choose any input for any allowed tool. The session already sees every call the model makes (the `tool` events it emits), so it keeps them: callId → name, input, and, once gated, the gate and `createdAt`. `executeTool` takes `{ callId, decision?, input?, credentials?, host? }`: it runs only a call the model made, with the model's input, once. `decision` (`approve` · `deny` · `abandon`) is accepted only for a call waiting on a gate; `input` only with `approve` on a gated call (the edit — `preTool` runs, `edited.from` is the stored input). An unknown, already-settled or expired callId is a `request` error. Gates expire after `gateTtlMs` (a `runSession` option) — the same setting as `createTheoremHandler`'s: same name, one shared default constant (30 minutes), one shared validator (a non-positive or non-finite value is refused at construction), and the same refusal (`session.gate_expired`). The relay only forwards; it holds no authority. `stages.md` ("`LiveSession.executeTool`") and `host.md` (custom relays) say so. The live client's `executeTool` message carries only these fields. |
| Edit arguments on approval | `invokeTool` already takes the host's `input` and validates it against the tool's schema (`startToolExecution`, `src/kernel/tools/events.ts`). Two things are missing. **Rules:** `granted: true` skips the tool's own `preTool` (`src/kernel/tools/stage-run.ts:98`), because it assumes the call is the one the user saw. An edited call is not, so it runs `preTool` in full: its `deny` applies and its `confirm` gates again on the edited arguments. Without this, an edit slips past a tool's own business rule (the README's refund limit). **Provenance:** the resume carries `edited: { from }`; the tool events, the transcript and history record both — the model proposed X, the user changed it to Y — so the agent is not told it sent arguments it didn't. On web, `from` is the arguments the server stored with the gate (`PendingToolGate.arguments`, renamed from `input`: they are the model's arguments), never a value the browser sends. An edit that fails the schema re-opens the gate with the issue; it never runs. |

### In the transcript (`src/interface`)

| Change | Detail |
|---|---|
| Token use per turn | `TurnDoneBlock.tokens` comes from `done.tokens`. Today `done` never carries tokens, so the field is always empty, and `tokens` events are skipped (`blocks.ts:227`). No second summing in the interface. |
| Compaction | A `compaction` block (marker) from the `compaction` event; the interface session replaces its history with the event's `history`. `TurnDoneBlock.compaction` carries the full `CompactionSignal`. |
| Tool block | Keeps `startedAt`/`endedAt`, `arguments` (and `edited.from`), `labels`, and an `artifacts[]` list. Today each `artifact` event overwrites the last (`upsertToolBlock` spreads the patch) — a bug. |
| Tool media | Media comes from the tool's declared `ModelToolResult.parts` (image, audio, video, document) — the first-class carrier the model already receives. Today the transcript instead scans output for http(s) URLs and guesses the type from the file extension (`src/interface/tool-media.ts`); that guessing is deleted. |
| Failed or stopped turn | The partial reply stays in the transcript, marked failed (with the error's kind) or stopped, and the turn — user message included — is committed to the session and history with the locked note. Today `use-theorem-chat.ts:104–111` discards the streamed blocks (`setStreamBlocks([])`), leaves the session unchanged, and shows the error only in the composer until the next send. `run-session`/`run-commit` return the partial blocks and session on failure. History is held by the client (the server stores only permissions, gates and interaction ids — `react/src/server/session-store.ts`), so the commit is client-side. |

### In the React UI (`react/src`)

| Change | Detail |
|---|---|
| Status line | `WorkStatus.phase` adds `waiting` (gate open), `stopped` (user stop), `failed` (error) alongside `working`/`worked`, from `done.stop` and the gate. Wording comes from the lexicon. |
| Tool item | Shows the label, arguments, live latency timer while running and duration after, the tool's own citations, and its media. |
| Approval card | Lets the user edit arguments before approving (schema-driven form from the tool's input). |
| Artifact slot | `renderArtifact?` on `ChatTranscript` so a host renders its own cards. |

### Later (not this patch)

Loop detection; retry/regenerate (frontend package); an explicit narration signal (the split stays positional).

## Pressure test

Each claim below was checked against the code on `feat/otel-turn-traces` at `0f6f40b`.

### What the checks changed

| Assumption | What the code says | Consequence |
|---|---|---|
| Error kind is lost at the transcript | In web chat an `error` line is thrown by the transport (`transport.ts:155`) and lands in `chat.failure` with its kind; `ErrorBlock` only exists for in-process folds. The kind is not lost. | The real gap is the failed turn itself: its streamed reply is discarded and nothing is committed (see "Failed or stopped turn"). |
| Token totals need a new sum | `sumTokens` exists and the trace's root span uses it. | `done.tokens` reuses it; the interface does no summing. |
| Compaction only needs a richer `done` signal | `timing: 'before'` compaction replaces history inside `runTurn` (`runner/mod.ts:548–567`) and records it only on the trace. The host never receives the compacted history. | A **bug**, not just a display gap: the host re-sends the full history every turn, so Theorem re-summarizes it every turn (cost, latency, a summary that shifts turn to turn), and neither the user nor the agent's host knows compaction happened. The `compaction` event fixes both. |
| `CompactionSignal` has before/after counts | It has the decision (tokens, meter, promptTokens, history); before/after message counts and the summary exist only on the trace event `theorem.compaction`. | The `compaction` event carries them. |
| Editing arguments needs a new resume path | `invokeTool` already takes host `input` and validates it. | Only provenance is new — without it, history would say the model sent arguments it never sent (agent blindness). |
| Tool media needs a wider URL scan | Tools already declare media in `ModelToolResult.parts`, which the model receives. The transcript ignores `parts` and guesses from URL file extensions. | `parts` becomes the one source; the guessing is deleted. A tool that only mentions a URL in its text no longer shows media — it must declare it. Decided: a typed package does not guess media from text. |
| A refusal needs its own phase (my earlier call, retracted) | `ERROR_KINDS` already has `declined` (user) and `blocked` (guardrail or hook), and the kernel settles a refusal through `granted: false`. `cancelled` on an abandoned gate is correct, not an overload. | No new phase. The bug is that web makes the refusal up in the browser instead of settling it through the kernel. |
| `granted: true` re-checks the call | It skips the tool's `preTool`. | Edited arguments must run `preTool`; otherwise approval-with-edit bypasses tool rules. |
| The server keeps history | It keeps only authority: permissions, gates, interaction ids. History comes from the browser each turn (role-filtered by `conversationOnly`). | Committing a failed turn is client-side only. |
| Every wire into Theorem is listed | The browser → server bodies (`/turn`, `/invoke`, `/steer`) are read with `readJson<T>` (a cast) and checked for one or two fields; `attachments`, `voice`, `model`, `effort`, `turnId` pass unchecked. | Added to "Where the check runs". |
| A live relay exists to parse | No Theorem server serves the live client's `executeTool` message; each host writes its own. The browser sends `resume.granted` and `input`, and `LiveSession.executeTool` trusts both; no contract tells a relay to hold the gate (checked with theorem/eval). | Decided: the live session holds the model's calls and gates itself (see Additions), in this patch. |
| Tool labels exist but need plumbing | `ToolBase.labels` is read nowhere in `src` or `react/src`. | Filled per call and carried on the `running` / `complete` phases. |

### Risks

- **Strict parsing of live traffic.** A listed field changing shape becomes a visible `bad_response` instead of passing silently. That is the intent. Additions (new fields, new kinds) do not fail: fields are dropped, kinds land in `provider_step` / `unsupported` (see Invariant). The round-trip harness guards the rest: every event the kernel and each provider emit in the existing suites must parse.
- **`provider_step` stays open by design.** It carries the step name as data; that is the one place an unknown value is accepted, and it is named, not an open `kind`.
- **Committing failed turns** grows history with partial replies. The locked note tells the agent what the user saw; compaction bounds the growth.
- **Timing on every tool event** (`at`) puts wall-clock time on the wire. It is already in the trace; hosts that persist events store one more number per event.
- **Breaking for hosts** (Bonsai, Seance): the union, `callId`, `citation`, `compaction`, `onUnauthenticated: 'gate'`. Shipped together as one 2.0.x patch so hosts migrate once.
- **Live call authority** moves into the session (see Additions), so `LiveExecuteToolArgs` changes shape. Every live host's relay must follow; Bonsai's live path is in scope of its upgrade.

### Also found (not in this patch)

- `src/interface/from-profile.ts` casts `as ProfileInterface` four times — the same class of problem this spec removes on the wire. It belongs in a Theorem-wide cast census.

## Out of scope

- Bonsai's web frontend readers (`frontend/src/lib/agent-ndjson.ts`, `run-live-tool-calls.ts`): the frontend is being rebuilt on Theorem's headless interface package and UI.
- Bonsai backend, which consumes events in-process (`run-theorem-turn.ts`, `collect-turn.ts`, worker live relay). It gets the new types by upgrading and fixing whatever the stricter union flags. No Bonsai-side schemas (`docs/THEOREM_HOST_CONTRACT.md`).

## Tests

- **Per kind:** one valid fixture parses; each missing required field and each wrong enum value is rejected; an extra field parses and is absent from the result.
- **Unknown kinds:** an unknown line `type` or live envelope kind yields `unsupported` and the turn continues; an unmapped provider event yields `provider_step`.
- **Guard:** no wire schema uses `.strict()` or `.passthrough()`.
- **Per tool phase and per evidence kind:** the same.
- **Round trip:** every event the kernel and each provider emit in the existing suites parses under `turnEventSchema` (checked by a wrapper in the test harness), which proves the schemas match the emitters.
- **Transport:** a malformed NDJSON line ends the stream with `bad_response`; a host line type parses only when its schema is supplied.
- **Live:** a malformed envelope, an event without a valid kind, and a malformed gate each end the session with `bad_response`.
- **History:** an error block produces `history.turn_failed`; a cut-off reply keeps its text and adds `history.reply_cut_off`.
- **Failed/stopped turn:** the partial reply and the user message are committed to session and history (client, `run-session`, `run-commit`); the transcript marks the reply failed or stopped.
- **Compaction:** a `before` compaction emits one `compaction` event (`after` is the host's to run, signalled on `done.compaction`); the session adopts its `history`; the next turn does not compact again on the same history.
- **Citation:** every provider's sources (grounding, annotations, tool `sources`) arrive as `citation`; source chips read only that kind.
- **Refusal:** a web deny goes through `/invoke` → `granted: false` → phase `error`, `failure.kind: 'declined'`, `post_tool` fires, the trace records a `denied` span, the server gate is gone; an abandon does the same with `cancelled`. Web and live produce the same events.
- **Edited args and tool rules:** an edit that `preTool` denies is denied; an edit `preTool` wants confirmed gates again on the edited input; `edited.from` is the server-stored input even when the browser sends a different one.
- **Live authority:** `executeTool` with a callId the model never made, one already settled, or an expired gate is a `request` error and runs nothing; a first call runs with the model's stored input whatever the caller sends; `decision` on an ungated call and `input` without `approve` are rejected; an edited approve runs `preTool` and records `edited.from` from the stored input; traces keep one `execute_tool` record per call, parented by callId (`tests/react/live-client.test.ts:77–84` mock updated).
- **Request bodies:** each malformed `/turn`, `/invoke`, `/steer` field (wrong type or missing) is a 400 `request` error; an extra field is dropped.
- **Edited args:** an approved edit runs with the edited input; events, transcript and history carry `edited.from`; an edit that fails the tool's input schema reopens the gate.
- **`done.tokens`:** equals `sumTokens` over the turn's `tokens` events (same number as the trace root).
- **Tool block:** two artifacts on one call both survive; media comes from `parts` only; `startedAt`/`endedAt` come from `at`.

## Breaking changes (2.0.x)

`react/` and `src/interface/` are repo-private (not in the JSR/npm package), so their changes break only in-repo hosts (Seance, the playground). The published package breaks on the kernel items.

**Package (kernel)**

- `TurnEvent` is a union: `event.text` needs `event.type === 'text'` (or `thought`/`evidence`) first.
- `tool.id` removed → `tool.callId`.
- `pause` phase, `ToolPause`, `ToolCallEvent.pause` removed.
- `onUnauthenticated: 'pause'` → `'gate'`.
- `evidence.kind` closed; Google built-ins arrive as `provider_step`.
- New kinds `citation` and `compaction`; `evidence.citations`/`sources`/`annotations` and `grounding.sources` removed.
- `done.tokens` added.
- `InvokeToolResume.value` removed; `cause` added.
- An edited, approved call runs the tool's `preTool`.
- `LiveSession.executeTool` takes `{ callId, decision?, input?, secret?, credentials?, host? }`; `name` and `resume` are removed; `secret` (only with `approve` on a sign-in gate) becomes the gate slot's credential for the session; `runSession` takes `gateTtlMs`.
- `LiveSession.sendToolResponse(s)` are removed. `LiveSession.answerToolCall({ callId, events })` settles a held call whose body ran in the registry-owning process.
- An `error` tool event carries `readBack`, like `complete`; the live session sends Gemini that text.
- `GATE_DECISIONS` and `GateDecision` are exported.
- The live client's `executeToolResult` envelope is `{ callId, status: 'settled' | 'gated' | 'refused' }` (`gate` when gated, `body` when refused); the relay forwards and holds nothing.

**Repo-private (interface, React)**

- `readNdjsonStream` takes a schema.
- Client handlers receive `unsupported` for event kinds the client does not know.
- `/invoke` takes `decision` (`approve` · `deny` · `abandon`) and optional `input`; web refusals settle on the server.
- `TurnDoneBlock.compaction` is the signal, not a boolean.
- Tool media in the transcript comes only from `parts`; URL guessing removed.
- Failed and stopped turns are committed (session, history, transcript) instead of discarded.

## Order

1. Schemas + `z.infer` types; delete the interfaces (kernel, tools, observability).
2. Kernel and providers emit the new shapes: `callId`, `provider_step`, `citation`, `at`, `compaction`, `done.tokens`; remove `pause` and `InvokeToolResume.value`; add `cause`; edited calls run `preTool`; rename the auth option.
3. Live sessions hold the model's calls and gates; `executeTool` by callId; shared gate TTL constant. Coordinate with the Astryx session (`createKernelScope` in `execute.ts`, `stages.ts`, `decision.ts`) before touching `execute.ts` / `stage-run.ts`.
4. Wire parsers (transport, live messages, live client, handler request bodies, live `executeTool` message); delete the hand parsers and `readJson<T>`. Web refusal/abandon through `/invoke`.
5. Transcript: tool block (timing, args, `edited.from`, labels, `artifacts[]`, `parts` media), compaction block, committed failed/stopped turns, history notes (copy locked).
6. React: status states, tool item, editable approval card, `renderArtifact` slot.
7. Round-trip harness and tests; docs `contracts/kernel.md` (its Stream events table still says `stop.kind === 'tool'` for the snapshot), `host.md`, `stages.md`. Docs-truth requires every changed behavioral section to cite at least two `contract_test` supports, and Stryker mutates the changed tool and guardrail files on merge.
