# OpenTelemetry-shaped turn traces — proposed specification

**Status:** decisions locked 22/09/2026. Steps 1 (usage), 2 (spans + v3 record, including Live), 3 (retention), 4 (OTLP) and 5 (CLI/docs, Theorem side) implemented 23/09/2026; the theoremai-frontend copy awaits approval; step 6 not yet. The shipped contract is [observability.md](../contracts/observability.md).
**Version:** ships within `@theoremai/agents` 2.x (decided 22/09/2026). The `TraceRecord` shape changes, so every reader updates in the same change.
**Worked example (step-2 target, approved 23/09/2026; `gen_ai.*` names kept wherever semconv defines the exact meaning, `theorem.*` otherwise):** [otel-turn-traces-example.md](./otel-turn-traces-example.md) — the v3 record drawn across a 12-exchange conversation.

## Goal

A Theorem turn should produce a trace that any OpenTelemetry GenAI tool can read without translation: one span per agent run, per model call, and per tool call, with real timing, real usage and real cost.

The evaluation layer is built on top of this trace. That is the next spec, not this one.

Theorem stays unopinionated:
- No OTel SDK dependency in the kernel. The kernel emits plain data.
- Exporting to a viewer is an optional mapping function.
- Hosts decide where traces go, through the `TraceSink` they already use.

## What the survey found (read-only, 22/09/2026)

| # | Finding | Evidence |
|---|---|---|
| F1 | **Usage is under-counted on multi-step turns.** Every model call emits its own `tokens` event, but the trace keeps only the last one. | `trace-usage.ts` `tokensFromEvents` returns the last event. The step loop in `runner/steps.ts:466` makes one provider call per step. |
| F2 | Bonsai already works around F1 on its side, but only for Google: it re-parses `upstreamLog` `interaction.completed` rows to sum rounds. This is drift, because the provider fact is decided twice. | `theorem-interaction-wire-budget.ts` (`googleInputBilledTotal`, "Terminal usage on the trace record (last round)") |
| F3 | Tool events carry no timestamps. Bonsai infers tool duration as "time since the last event it saw". | `TurnEvent` has no time field. `theorem-turn-observability.ts` `handleToolEvent` uses `ctx.now - state.lastMilestone`. |
| F4 | Cost is dropped. OpenRouter returns `usage.cost` and `cost_details.upstream_inference_cost` on every stream, and `extractUsageTokens` keeps only token counts. | Live probe earlier; `delta.ts:928` |
| F5 | **Specialist turns write no trace at all.** All 10 specialist callers go through `runBonsaiProfileTurn` → `collectTurn` with no sink. | `infrastructure/theorem/run-profile-turn.ts` |
| F6 | Compaction turns are invisible: `runCompactionTurn` calls `runTurn` with no sink. | `runner/mod.ts` |
| F7 | Live sessions (`runSession`) write no trace. | No `writeTrace`/`buildRecord` under `engine/session`. |
| F8 | When a provider reports no usage, the kernel invents token counts (characters ÷ 4). Those counts are indistinguishable from reported ones. This breaks "unknown is first-class". | `runner/tokens.ts` `calculateFallbackTokens` |
| F9 | Bonsai keeps a second span system: `AgentTurnTraceCollector`, flat `{name, ms}` spans that go to `done.timing` for DevTools. Its Theorem spans are rebuilt from the event stream. | `agent-turn-trace.ts`, `theorem-turn-observability.ts` |
| F11 | **Four token estimators, one real one.** Theorem's `estimateHistoryTokens` counts text with the o200k tokenizer (tiktoken's encoding, via `gpt-tokenizer`) and counts media with per-type minimums: image or document 258, audio 32/s, video 263/s. Only compaction uses it. The fallback (F8) uses characters ÷ 4 instead. Bonsai has two more characters ÷ 4 copies: `estTokensDiv4` in the wire budget, which the frontend mirrors, and `estimateTokens` in `context/format.ts`, which `build-prompt.ts` uses for history budgeting and truncation. | `kernel/engine/history-tokens.ts`, `runner/tokens.ts`, `theorem-interaction-wire-budget.ts`, `context/format.ts` |
| F12 | Token counts mean different things per provider: Google's output leaves reasoning out, OpenRouter's includes it (see P2). | Live probes, 22/09/2026 |
| F10 | `flushMintTrace` (a host-side audit row written after an image cutout) has no Bonsai caller. | grep |

F1, F8, F11 and F12 are correctness bugs. The rest are gaps.

## Shape

### Span tree for one turn

```
trace (traceId)
└─ invoke_agent {profile}                 ← one per runTurn
   ├─ chat {model}          step 1        ← one per provider call
   ├─ execute_tool {name}   step 1        ← pre_tool … post_tool inclusive
   │    events: theorem.stage pre_tool / post_tool (affordance used, hook ms)
   │    └─ invoke_agent {specialist}      ← host passed the tool's traceparent (F5)
   ├─ chat {model}          step 2
   ├─ invoke_agent {compaction profile}   ← F6, child of the turn
   events: theorem.guardrail, theorem.stage pre_turn / before_end / post_turn
```

### Record (plain data, shaped like OTLP/JSON)

```ts
interface TraceRecord {
  v: 3;                          // record format version (not the package version)
  schemaUrl: string;             // pinned semconv-genai commit (repo has no releases yet; 8ffdf56 as of 22/09/2026)
  resource: { 'service.name'?: string };   // host-supplied; see P7 for a Theorem version
  metadata?: Record<string, unknown>;   // host-owned, passed through untouched
  spans: TraceSpan[];            // root first, then in start order
}

interface TraceSpan {
  traceId: string;               // 32 hex
  spanId: string;                // 16 hex
  parentSpanId?: string;
  name: string;                  // "chat openai/gpt-…", "execute_tool ground_plant_knowledge"
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean | string[]>;
  events: { name: string; timeUnixNano: string; attributes: Record<string, …> }[];
  status: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string };
}
```

- Field names follow OTLP/JSON, so export is a pure reshape. The one difference: OTLP writes attributes as `KeyValue[]` arrays, and the export function converts them.
- `TraceSink.write(record)` stays as it is. `noopSink`, `jsonlSink` and `memorySink` all stay.

### Attributes

| Span | Standard (`gen_ai.*`, `error.type`) | Theorem namespace (`theorem.*`) |
|---|---|---|
| invoke_agent (kind INTERNAL) | `operation.name`, `agent.name`=profile, `conversation.id` (when the host sets it), `usage.*` = **sum of chat spans**. No `request.model`: semconv says to leave it off agents that allow per-request model selection, which Theorem does. | `stop.kind`, `key_slot`, `model_select`, `attempts`, `usage.cost_usd` (sum) |
| chat (kind CLIENT) | `provider.name` (**required**: `gcp.gemini`, or `openrouter` as a custom value), `request.model`, `request.stream`, `request.reasoning.level`=effort, `request.temperature` / `max_tokens` / `top_p`, `response.model`=apiId, `response.id`, `response.finish_reasons`, `response.time_to_first_chunk`, `usage.input_tokens`, `usage.output_tokens`, `usage.reasoning.output_tokens`, `usage.cache_read.input_tokens`, `usage.cache_write.input_tokens`, `conversation.compacted` (when compaction ran) | `step`, `attempt`, `usage.cost_usd`, `usage.upstream_cost_usd`, `usage.source` (`provider`/`estimated`) |
| execute_tool (kind INTERNAL) | `tool.name`, `tool.call.id`, `tool.call.arguments` / `tool.call.result` (opt-in, same gating as content), `error.type` | `tool.outcome`: `ok` / `error` / `denied` / `gated` / `paused` / `cancelled` (replaces the ok/error collapse) |

- Message content follows semconv opt-in content (`gen_ai.input.messages` / `output.messages`). It is gated by the existing `include` and `scrub` policy. Media stays hash-only.
- `upstreamLog` and `wire` become span events on the `chat` span. They stay gated by `include`, and nothing is lost.

## Kernel changes

1. **Clock.** The kernel stamps start and end times, using `Date.now()` for the epoch and `performance.now()` for durations. No `TurnEvent` gets a new public time field. Spans are built from kernel checkpoints, not from host-visible events.
2. **Checkpoints** (where each span opens and closes):
   - `chat`: opens around each provider stream in `executeAutonomousStep` and closes at the stream's end or on throw.
   - `execute_tool`: opens in `handlePendingTools` before `executeRegisteredTool`, which covers `pre_tool`, the tool body and `post_tool`. It closes at settlement. Hook durations are recorded as `theorem.stage` events.
   - `invoke_agent`: opens at `runTurn` entry and closes at flush. If a span is still open at flush, it closes with `ERROR` / `unclosed`.
3. **Usage (fixes F1).** Each `chat` span holds its own round's usage. The turn total is the sum. `trace-usage.ts`'s "last event" logic is deleted.
4. **Cost (fixes F4).** `TurnTokens` gains `cost?: { usd: number; upstreamUsd?: number }`, filled only from provider-reported fields. OpenRouter fills it; Google Live and Interactions leave it out.
5. **Parent link.**
   - `TurnRequest.traceparent?: string` (W3C) sets the root's `traceId` and `parentSpanId`.
   - The tool handler context gains `traceparent` for its own `execute_tool` span, so a tool that runs a specialist can pass it along.
   - Compaction passes its parent span internally (fixes F6).
6. **Estimated tokens (F8, F11).** `runner/tokens.ts` is deleted, and the fallback calls the one estimator (decision 3). The `chat` span is labeled `theorem.usage.source=estimated`.

## Consumers updated in the same change

**Theorem**
- `observability/`: `trace-record.ts`, `trace-attach.ts`, `trace-usage.ts`, `trace.ts`, `types.ts`, `policy.ts`, `destinations.ts`, `mod.ts`; new `trace-span.ts` (span builder); new `otlp.ts` (optional export mapping).
- `kernel/`: `engine/history-tokens.ts` → `engine/token-estimate.ts`, `engine/compaction.ts`, `engine/runner/tokens.ts` (deleted), `mod.ts` (export rename), `engine/runner/{mod,steps}.ts`, `tools/execute.ts`, `engine/delta.ts` (cost), `providers/openrouter/chat.ts` (cost), `types.ts`, `schema.ts`.
- `cli/`: `event-log.ts`, `commands/{run,test,bench}.ts`, `index.ts`; `interface/{types,from-profile}.ts`; `host/mint-trace.ts` (see question 5).
- Tests: `tests/observability/*` (6 files), `tests/cli/event-log.test.ts`, `tests/host/host.test.ts`, `tests/kernel/{abort,theorem,tools}.test.ts`, `tests/providers/shared/upstream-tape.test.ts`.
- Docs: `docs/contracts/observability.md` (Trace records section rewritten), `stages.md` (stage span events), `kernel.md` (`traceparent`), `_map.mjs` ownership for the new files, lexicon for any new copy.
- theoremai-frontend: `unified-docs.ts`, `architecture.ts`.

**Bonsai** (on the package bump)
- `theorem-interaction-wire-budget.ts`: reads `chat` spans. The Google-only `upstreamLog` summing is deleted (fixes F2).
- `run-theorem-turn.ts`: `traceRecords[0]` becomes `record.spans`.
- `run-profile-turn.ts`: forwards `traceparent` and a sink (fixes F5). Its 10 callers pass the tool context's `traceparent`.
- Tests: `host-turn-request.wire.test.ts`, `theorem-specialist-turn.test.ts`, `registered-schema.wire.test.ts`.
- `theorem-turn-observability.ts` round and tool timing inference: see question 4.

## State map — one span

```
            open
             │
   ┌─────────┼──────────┬──────────┬───────────┐
   ▼         ▼          ▼          ▼           ▼
  OK       ERROR     cancelled   paused/gated  unclosed at flush
                     (abort →    (tool stop,   (throw path →
                      UNSET +     UNSET +       ERROR "unclosed")
                      stop.kind)  outcome)
```

The root carries the turn's `theorem.stop.kind` (any `TurnStopKind`, with `native`), or `thrown` when the runner threw. A call that ended on a provider `error` is `provider_error`; a guardrail block is `filtered` (`native: 'canary'` / `'egress'`). `status` is ERROR for `provider_error` and `thrown`, UNSET otherwise.

## Dependency map

```
provider stream ──usage/cost──► chat span ─┐
tools/execute ──pre/post_tool──► tool span ─┼─► buildRecord ─► TraceSink ─► host (memory / jsonl / own)
guardrails, stages ──► span events ─────────┘         │                          │
TurnRequest.traceparent ──► root parent               └─ toOtlpJson() (opt) ─► viewer
tool ctx.traceparent ──► specialist runTurn (host)
```

Unaffected: `TurnEvent` stream semantics, `onStage` affordances, guardrail decisions, scrub and hash policy (same rules, new locations). Hooks stay host control points; the kernel measures around them.

Does this bypass the agent? No. It is observation only; nothing reaches the user.
Would the agent know? Not applicable, since there is no change the agent can see.

## Proof (contract tests)

- A 3-step turn: the root usage equals the sum of three `chat` spans (F1 regression).
- Every child span nests within its parent's time window, and tool spans include the hook time.
- An OpenRouter fixture with `cost` produces `cost_usd`. A Google fixture has no cost attribute.
- A `traceparent` passed in gives the same `traceId`, and the root's parent equals the caller's span.
- An abort in the middle of a tool: the tool span closes as `cancelled` and nothing is left unclosed.
- Scrub, hash and canary behavior is unchanged (existing policy tests, moved to the new locations).
- `toOtlpJson` output matches the OTLP/JSON trace shape (structural contract test; a Collector or Phoenix ingest run waits for approval to run one).
- Token normalization: a Google fixture with 1 output + 506 thought gives `output_tokens=507`, `reasoning.output_tokens=506`. An OpenRouter fixture with 424 completion (423 reasoning) gives 424 / 423. Both use the live-probe numbers.
- Every `chat` span carries `gen_ai.provider.name`.

## Pressure test (22/09/2026)

Each assumption was checked against a primary source (live provider calls, the semconv repo, and Phoenix's and Cloudflare's own code and docs).

| # | Assumption | Result | Spec change |
|---|---|---|---|
| P1 | Our attribute names match semconv | **Mostly.** Checked against `open-telemetry/semantic-conventions-genai` @ `8ffdf56`. Semconv already has `usage.reasoning.output_tokens`, `request.reasoning.level`, `request.stream`, `response.time_to_first_chunk` and `conversation.compacted`, so our `theorem.*` versions of these were unnecessary. `provider.name` is **required** on chat spans and was missing. Semconv has **no cost attribute**, so `theorem.usage.cost_usd` stays ours. | Attribute table corrected (above). |
| P2 | "Output tokens" means the same thing on every provider | **False (F12).** The same prompt, live on `gemini-3.8-flash`: Google reports `total_output_tokens: 1` and `total_thought_tokens: 506` separately, while OpenRouter reports `completion_tokens: 424` **including** `reasoning_tokens: 423`. Theorem passes both through as `output`. Theorem also never reads OpenRouter's reasoning count (`completion_tokens_details` is not searched). Semconv rule: output **includes** reasoning, and input **includes** cached tokens. | Adapters normalize `TurnTokens` to the semconv meaning (Google: output = output + thought; OpenRouter: thinking from `completion_tokens_details.reasoning_tokens` / AI SDK `outputTokenDetails.reasoningTokens`). The only Bonsai readers are the two diagnostic files already being rewritten; no quota or billing code reads output tokens. |
| P3 | Google's reported counts are the billed counts | **Yes for the `total_*` fields.** Google's pricing page lists "Output price (including thinking tokens)", so billed output = `total_output_tokens` + `total_thought_tokens`. That confirms P2's normalization. Live probe, same ~7,900-token prompt sent 3 times: `total_input_tokens` stayed 7,899 while `total_cached_tokens` went 0 → 4,079, so cached tokens are **inside** input, as semconv requires. `raw_prompt_token` (always input + 31) and `model_invocation_token_counts` are **undocumented** in the Interactions reference, so Theorem does not read them. | Google adapter: `input_tokens = total_input_tokens`, `cache_read = total_cached_tokens`, `output_tokens = total_output + total_thought`, `reasoning.output_tokens = total_thought`. The contract cites the pricing page and the probe. |
| P4 | Phoenix reads OTel GenAI spans | **Yes, recently.** `phoenix/trace/gen_ai/conversion.py` maps `chat` / `execute_tool` / `invoke_agent` to its LLM / TOOL / AGENT views, including tokens, messages and tool calls. It does **not** map reasoning tokens or any cost, and Phoenix's own conventions (OpenInference) take precedence when both are present. | Cost and reasoning appear in Phoenix only if the export also writes OpenInference `llm.cost.*` / `llm.token_count.completion_details.reasoning`. Open question B. |
| P5 | `toOtlpJson` can feed Phoenix directly | **False.** Phoenix's `/v1/traces` accepts `application/x-protobuf` only. The official encoder (`@opentelemetry/otlp-transformer`) pulls in the SDK trace, metrics and logs packages. | Open question A. |
| P6 | The kernel's clock gives real durations everywhere | **Not in a Cloudflare Worker.** Cloudflare's docs: "`Date.now()` returns the time of the last I/O. It does not advance during code execution." Live sessions run in the Worker (`bonsai-runtime/src/live`). Normal turns run in the brain Container (Deno, real clock). | Spans in a Worker are measured to I/O boundaries. Model calls and I/O-bound tools are real; pure-CPU work shows 0. The contract says so, and the spans carry `theorem.clock=io` when running in a Worker. |
| P7 | Theorem can stamp its own version on traces | **No runtime constant exists.** The version lives only in `deno.json` and `package.json`. | Dropped `theorem.version` from the resource. Adding one needs a single source kept in sync by the release script; deferred unless you want it. |
| P8 | Specialists can receive the tool's parent link | **Yes.** Every Bonsai tool goes through `runBonsaiTool(name, input, ctx, action)`, which builds the `BonsaiToolCall` passed to each action. | `traceparent` rides on `BonsaiToolCall`. Actions that call specialists pass it to `runBonsaiProfileTurn`. Specialists called outside a tool stay roots. |
| P9 | Readers can keep taking `records[0]` | **False once children exist.** A compaction or specialist record can reach the sink before its parent's. | Readers select the root by `parentSpanId` / trace id, never by position. `run-theorem-turn.ts` changes accordingly. |
| P11 | Every provider is Google or OpenRouter | **False.** Theorem also ships `providers/local` (OpenAI-compatible local servers), which Bonsai doesn't use. It asks for `include_usage`, but local servers may not honor it, so the estimator matters most there. | The `local` adapter gets the same normalization tests. `provider.name` is the configured server identity when known; otherwise the span carries no `provider.name` guess. Open question F. |
| P10 | The tokenizer's size matters in the Worker | **No.** The Worker never runs `build-prompt` (live context is assembled in the brain Container). For reference, o200k ranks are 2,4 MB raw / 1,07 MB gzipped. | None. |

## Decisions (locked 22/09/2026)

1. **Parent link:** `traceparent` is optional on `TurnRequest` (a turn with no parent is a root) and is provided on the tool context.
2. **Viewer:** local only. The self-hosted Phoenix container is the first candidate; testing it needs your go-ahead to run. `toOtlpJson` ships in this change.
3. **Estimated tokens:** kept and labeled `theorem.usage.source=estimated`. One estimator, the existing one: `history-tokens.ts` becomes a general `token-estimate.ts`. It counts everything sent: system prompt, history, current user text and repair text, tool definitions, current attachments and voice (using the per-type media rule), and output text. Compaction and the fallback both call it, and the characters ÷ 4 fallback is deleted.
4. **Bonsai's second timing system:** deleted. Bonsai's host steps become spans in the same tree now (see "Host spans").
5. **`flushMintTrace`:** kept for other Theorem users. It is rebuilt on the shared span builder (see "Host spans").
6. **Live sessions:** in scope (see "Live sessions").

## Host spans (from decisions 4 and 5)

Theorem exports the span builder the kernel itself uses (`@theoremai/agents/observability`), so hosts write the same shape:

```ts
const tree = startTrace('bonsai.turn', { traceparent });            // host root
const load = tree.root.child('bonsai.load_context'); … load.end();
runTurn({ …, traceparent: tree.root.traceparent() }, provider, sink); // Theorem spans nest under it
tree.root.end();
await writeTrace(sink, buildRecord({ spans: tree.collect(), policy }));
```

- There is one builder, and the kernel uses it too; there is no host copy. Host text goes through `traceContent` / `traceBytes` / `traceJson`, so `buildRecord` scrubs and hashes it like the kernel's; `contentOf` reads it back.
- `flushMintTrace` is built on it (done): it writes the held turn record, then a record with one `cutout` span (CLIENT) under the turn's root. Error text is an `exception` event stored by hash, never status text, because it is free text and must pass the scrub.

Bonsai consumers added:
- `agent-turn-trace.ts`: `AgentTurnTraceCollector` is replaced by the builder.
- `run-host-turn.ts`, `load-host-turn-context.ts`, `assemble-host-turn-prompt.ts`, `run-orchestrator-generation.ts`, `handle-agent-turn-policy.ts`, `context/load-live-context.ts`, `paths/web/handler/path-web-authed-turn.ts`: callers move to the builder.
- `theorem-turn-observability.ts`: the round and tool timing inference is deleted, because the kernel spans replace it.
- **Frontend:** `frontend/src/lib/agent-turn-timing.ts` (+ test, `web-chat-reply.ts`, `use-web-chat-send.ts`, `use-web-message-actions.ts`) keeps a hand-copied mirror of the backend span and usage types that `done.timing` carries. The hand-copied types are deleted. The frontend imports the span type from `@theoremai/agents/observability`, as it already does for `TurnEvent` from `@theoremai/agents/kernel`.

## Live sessions (from decision 6)

```
invoke_agent {live profile}            ← whole session (open → close / drop); its own record, written at close
├─ generate_content {apiId}  response 1   ← its own record, written at turnComplete; starts at its first input frame
│   └─ execute_tool {name}                ← its own record, under the response that asked for it
├─ generate_content {apiId}  response 2   (theorem.stop.kind=interrupted on barge-in)
```

- **Durability:** a session can last minutes, and its worker can be evicted. So one record is flushed per completed response, with the session span as its parent, and the session root is flushed at close. If the process dies, the completed responses are kept and the root is missing. A viewer shows that as a trace with no root span, which is honest, not invented.
- **Usage:** Google Live reports tokens only, so there is no cost attribute. A response with no `usageMetadata` is estimated with the one estimator and labeled estimated.
- **Session events (done):** setup, resumption (a handle is a credential: recorded only as issued), voice activity, `goAway`, waiting / working / idle, and `closed {code, reason, initiator}` are events on the session span. The session status is ERROR when something was thrown or the provider closed with a code other than 1000; `theorem.stop.kind` is set only when the host cancelled.
- **Limits (recorded in the example, §6):** a response's duration includes listening time; frames after close are not recorded; the input estimate runs high under sliding-window compression.
- **Checkpoints** are in `engine/session/mod.ts` (the `turnComplete` / `interrupted` boundaries at around lines 224 and 503, and the `done` handling).
- Consumers: the live tests under `tests/kernel`, and Bonsai's live relay path (enumerated at implementation).

## One token estimator (decided 22/09/2026)

Theorem owns the only token estimator, and Theorem and Bonsai both call it.

```ts
const estimator = await loadTokenEstimator();   // lazy-loads o200k once, then cached
estimator.text(s);                              // sync from here on
estimator.media(kind, { seconds? });            // per-type rule
estimator.messages(history);                    // what compaction uses today
```

- It loads once asynchronously and counts synchronously afterwards. Hosts that never estimate never pay the tokenizer import. Sync call sites stay sync; they receive the loaded estimator rather than becoming async.
- **Theorem:** compaction, the usage fallback, and the Bonsai-facing export.
- **Bonsai:**
  - `context/format.ts` `estimateTokens`: deleted, along with its test.
  - `context/build-prompt.ts`: history trail budget (`trimLiveMessagesToTokenBudget`) and long-message truncation (`renderMessageSpeechContent`, `renderMessageMetaExtras`, `renderMessageContent`) take the estimator.
  - Their callers pass it in: `assemble-host-turn-history.ts`, `paths/imessage/imessage-group-history-build.ts`, `paths/imessage/imessage-group-history-prose.ts`. Tests: `live-trail.test.ts`, `format.test.ts`.
  - The wire budget (`estTokensDiv4`) and its frontend mirror use the estimator. The field is renamed `estTokens`.
- **Behavior change the agent can notice:** where old history is cut short and how much history a proactive wake keeps now follow real token counts. For English text this is close to today; emoji, other languages and code count more accurately. Nothing else changes.
- Not in scope: the `TEXT_TRUNCATE_TOKENS` (10,000) and `PROACTIVE_LIVE_TOKEN_BUDGET` limits themselves. They are flagged for a separate review.

## Re-check after main merge (22/09/2026, 29e81c9)

- The cited files changed mostly by the Theorum → Theorem rename; the line references still hold.
- **New: OpenRouter drops thought events when `summaries: 'none'`** (`providers/openrouter/chat.ts`, `shouldEmitProviderEvent`). The trace then has no reasoning *text*, but `gen_ai.usage.reasoning.output_tokens` still comes from provider usage. Contract test: reasoning count present, thought text absent, under `summaries: 'none'`.
- **New: `validateTraceDir`** rejects trace directories inside the project checkout. The main path (`registerTraceDestination` / `jsonlDestination`) throws at startup. The optional helpers `resolveTraceDir` / `sinkFromDir` instead fell back silently to a second directory or to discarding traces. **J (locked): deleted** in this branch, along with their exports, tests and doc rows, so a bad trace directory fails at startup on the one remaining path.

## Decisions (locked 22/09/2026, round 2)

- **A. Collector.** Theorem ships only `toOtlpJson` (no encoder dependency). Getting data into a viewer goes through the standard OpenTelemetry Collector (OTLP/JSON in, protobuf out). Theorem documents a reference Collector config. The host owns running it: for Bonsai that's local dev tooling in the Bonsai repo, not Theorem.
- **B. Viewer attributes.** A separate, optional exporter module (`@theoremai/agents/observability/openinference`) adds OpenInference `llm.cost.*` and reasoning-token attributes. The kernel and `toOtlpJson` stay viewer-neutral. Hosts that don't use Phoenix never load it.
- **C. Google counts.** Verified (P3).

## Other hosts (Theorem is not Bonsai)

Every Theorem-side item was re-read for Bonsai assumptions:

| Item | Bonsai assumption found | Fix |
|---|---|---|
| Token estimator media rule | **Yes.** 258 per image, 32/s audio, 263/s video are *Gemini's* published rates, applied to every provider. OpenAI and Anthropic price images differently. | Open question E. |
| `provider.name` | Only Google and OpenRouter were considered. | P11. |
| Clock | Generic (runtime detection, not "Bonsai runs on Cloudflare"). | None. |
| Parent link | Generic W3C `traceparent`. `BonsaiToolCall` appears only in the Bonsai consumer section. | None. |
| Where traces go | Generic `TraceSink` / `registerTraceDestination`. No storage opinion in Theorem. | None. |
| Content in traces | Theorem assumed the trace is the only copy of the conversation. Hosts with their own message store (Bonsai, and any real app) would store it twice. | Open question G. |
| Viewer | Phoenix-specific attributes live in an opt-in exporter only (B). | None. |

## Decisions (locked 22/09/2026, round 3)

- **D. Bonsai trace storage.** Supabase, one row per trace record, as proposed: `profile_id` → `profiles(id) ON DELETE CASCADE` (null for turns with no user), `environment`, RLS service-role only, written after the reply. Deletion rides the existing profile cascade; `purge-user` covers traces with no new path.
- **E. Media estimation per provider family.** Each family uses its own published rule, cited in code. Google (ai.google.dev/gemini-api/docs/tokens): images ≤384 px on both sides = 258; larger images tiled 768×768 at 258 per tile; audio 32/s; video 263/s for static processing only. Agentic video processing "varies", so it counts as unknown. Other families (OpenAI, Anthropic) get their own rules only after each rule is read from that vendor's docs and checked against a live count. OpenRouter uses the rule of the routed model's family. `local` and any family without a published rule: media is **unknown** (`theorem.usage.source=estimated` plus `theorem.usage.media=unknown`), never a borrowed rate.
  - **Revised 22/09/2026 (live check).** The 258-per-tile rule is wrong for Gemini 3. `countTokens` on gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.5-flash-lite and gemini-3.8-flash (identical on all four; gemini-2.5-flash returns 404 to new users) at the default media resolution, which Theorem always uses because it never sends `media_resolution`:
    - **Image:** a patch grid inside a 1120-token budget that keeps the aspect ratio, `⌊√(1120·w/h)⌋ × ⌊√(1120·h/w)⌋`. 50×50 → 1089, 1024² → 1089, 1920×1080 → 1100, 3000×2000 → 1080, 1000×250 → 1056, 500×1000 → 1081, 100×3000 → 1098. Pixel count doesn't matter; only the aspect ratio does. Matches the media-resolution page (1120 default).
    - **Audio:** 32 tokens per second (5 s → 160, 10 s → 320).
    - **PDF:** 560 per page. Text on the page adds nothing: a blank page and a text page both count 560.
    - **Video:** **unknown**. 5 / 10 / 20 s count 515 / 1102 / 2060, which matches neither 263/s nor 70 per frame.
    - Other documents (plain text, CSV, JSON, …), file references (`uri`), and unreadable headers: **unknown**.
  - **Revised again 22/09/2026 (billed usage).** `countTokens` is not what Gemini bills. Interactions `usage` and `generateContent` `usageMetadata` agree exactly with each other on gemini-3.8-flash, and differ from `countTokens`:
    - **Image:** unchanged (the 1120 grid).
    - **Audio:** 25 per second of decoded audio, rounded up (2.2 s → 56). Bare `audio/pcm` is 16 kHz mono; `audio/L16` needs `rate` and `channels`; `audio/pcm` with parameters, `alaw` and `mulaw` are refused.
    - **PDF:** 520 per page.
    - **Video:** `frames × ⌊√(70·w/h)⌋ × ⌊√(70·h/w)⌋ + ⌈min(audio, frames) × 25⌉`, frames = video seconds rounded half up (66 per frame at 16:9, 63 at 4:3). Under half a second is refused. Read from MP4 / MOV / 3GP and WebM headers; other containers are unknown.
    - **Text documents:** counted as their text (o200k). Types Gemini converts first (`text/md`, `application/x-python`, mono `audio/L16`) add undocumented text tokens and are unknown.
    - **Known gap:** ADTS AAC, where Gemini estimates length from bitrate (2–3 tokens under ours at 10 s).
    - **Parked:** the full probe (WebM / MOV / 3GP video, anamorphic video, other Gemini 3 models, OpenRouter) and the open decisions are tracked in [theoremai#18](https://github.com/masudl-hub/theoremai/issues/18), to pick up when a provider stops reporting counts.
  - **Family resolution:** by model generation. `gemini-3*` flash/pro text models, direct or `google/…` via OpenRouter, get the rule. Everything else is unknown until verified live.
  - **Every estimate reads the facts it needs** from the payload: image size from PNG/JPEG/GIF/WebP/HEIC headers, decoded audio length from WAV/AIFF/FLAC/Ogg/WebM/MP4/MP3/ADTS headers, video length and frame size from MP4 and WebM headers, and the PDF page count from the page tree, including trees inside compressed object streams. Page counts were checked against PDFKit on real pdfTeX and Chrome PDFs.
  - **Compaction:** the history meter now reports media it could not count (`unknownMedia`) instead of adding 258.
- **F. Declared server identity.** A `local` profile may declare its server name (e.g. `ollama`), which becomes `gen_ai.provider.name`. When it isn't declared, the attribute is absent (unknown), not guessed. Why it matters: without it, a trace can't say which server produced an answer, so evals can't compare servers.
- **G. Reference, not copy.** A generic `include` reference mode in Theorem, as proposed. Content already held by a host store is written as its id. Only content stored nowhere else stays in the trace.
  - **Revised 22/09/2026 → content stored once, by hash.** Survey: a stored row is not what the model saw. Bonsai renders `conversations` rows before sending them (long old messages cut to 400 characters, voice transcripts merged in, media hints added, Zone A/B rules in `build-prompt.ts`). Tools store `outcome.data`, but the model sees `toolResultForModel(outcome)` and then Theorem's `formatToolResult`. A reference would describe the source material, not the model's input.
  - **Shape:** `TraceRecord.content: Record<sha256, text>` holds each exact, scrubbed text once. Span attributes carry hashes (`{ type: 'text', content_sha256 }` parts), never inline text. Each `chat` span lists exactly what that call sent. Across steps and turns a repeated text is the same hash, so history costs 64 characters per message per call instead of its full text.
  - **Sinks:** JSONL writes the record as is. A host sink can split `content` into its own table keyed by hash. Bonsai: a `trace_content (profile_id, sha256, text)` table with the same profile cascade. `toOtlpJson` inlines the text back, so viewers see standard semconv messages.
  - **Media** stays hash-only: bytes are never stored. No include flag is added; content was always recorded and still is.
- **H. Retention.** The default is unlimited; it's configurable through Theorem's existing trace retention setting. Each row stores `retain_until`, computed at write time from that setting (null = keep forever). A `pg_cron` job deletes rows past `retain_until`, so the job decides nothing itself and the setting has one owner. The profile cascade still deletes traces whenever the account goes.
  - **Survey finding (verified):** today `retainForDays` applies only to the JSONL destination (`src/observability/types.ts:82`). It is a required number, so there is no way to say "keep forever", and the default of 14 is defined twice (`resolve-policy.ts:18`, `trace.ts:16`), which is drift.
  - **Fix in this change:** one default constant. The resolved retention is passed to every destination, including a host `TraceSink`, so the Supabase sink reads the same setting the JSONL writer does.
  - **I-1 (locked):** `retainForDays <= 0` means keep forever, matching `maxSteps` (`src/kernel/schema.ts:659`: "<=0 unbounded"). It stays a plain `number`; the Supabase sink writes `retain_until` null for any value <= 0.
  - **I-2 (locked):** Theorem's default stays 14 days. Bonsai's profiles declare `retainForDays: 0`. Known difference from `maxSteps`: leaving `maxSteps` out means unbounded, while leaving `retainForDays` out means 14 days.

## Usage normalization (step 1, done 22/09/2026)

- **One `tokens` event per model call.** The runner holds each provider report and emits one event after the call's output; the last report per call wins. `done` no longer carries tokens. A call that failed with no usage emits none.
- **P3 revised (live probes, gemini-3.8-flash).** `total_tokens` = input + output + thought + tool use on every call. For inputs Google converts first (Markdown, Python, mono `audio/L16`), `total_input_tokens` comes back 0 while `total_tokens` still holds the sum, so input is derived: `total − output − thought − tool use` (**D1**). `model_invocation_token_counts` is not what is billed and is never read. Usage is read only from `interaction.completed`.
- **Missing sides (D2).** A reported 0 input counts as missing. The reported side is kept, and the missing side is estimated and listed in `TurnTokens.estimated`. With no usage at all, both sides are estimated. `unknownMedia` is per side.
- **Prompt estimate.** System + wire tool declarations + structured schema + conversation. An Interactions continuation (`previous_interaction_id`) counts the previous call's conversation, that call's replayed output (text, tool calls, media; no thoughts), then the continuation's tool results and injects.
- **Compaction (D3).** `meter: 'input'` uses the estimate when the provider reported none. `CompactionSignal.promptTokensEstimated` labels it.
- **Deleted:** `runner/tokens.ts` (characters ÷ 4).
- **Live:** reported per response (`usageMetadata`). A response without one is not estimated yet; that lands with the Live spans in step 2.

## Decisions (locked 22/09/2026, round 4)

**Invariant:** the trace has the highest possible fidelity, accuracy and precision. A developer can answer any question over any span of time (one call, one turn, a session, a date range) from traces alone.

**Build order:** 1 usage (done) → continuation input → usage sum → CLI label → probe fixture → Live / grounding probes → 2 spans + v3 record → 3 retention → 4 OTLP → 5 CLI/docs → 6 Bonsai. Nothing ships until every step is done.

- **R4-1. `trace-span.ts`** (done): wired in by step 2 and exported from `@theoremai/agents/observability`; the dead-code gate is green.
- **R4-2. Gate order (done).** `check:ci` runs `verify:publish` before `lint:fallow`: fallow writes `coverage/`, which the publish check rejects on purpose. CI is unaffected (separate jobs).
- **R4-3. Usage sum (done; exported as `sumTokens`).** One function sums `TurnTokens` across calls. It is used by the trace record, the CLI total, and later the `invoke_agent` span. Counts add up. A side is estimated if any call estimated it. `unknownMedia` adds up per side. Cost: summed over the calls that reported it, and marked `partial` when some calls did and others did not. When no call reported a cost, the cost is absent (unknown). `upstreamUsd` sums where present; OpenRouter reports it only for BYOK, so absence is not missing data.
- **R4-4. Continuation input (done).** `interactionOnlyInput` (raw Interactions steps built by the runner) is replaced by kernel messages that the Google provider maps with `historySteps`. The wire does not change; the public request type does. The runner stops building provider wire. This is a step-2 prerequisite, because chat spans record what each call sent in kernel terms.
  - **Same change:** Interactions `functionCallArguments` stops inventing `{}` and `{ value: raw }`. It uses the shared parser, and history with bad arguments fails with `TheoremError`, as the AI SDK path does.
- **R4-5. Live tool history (probed 23/09/2026; done 23/09/2026).** Probe whether Live `clientContent` accepts `functionCall` / `functionResponse` parts in replayed history before choosing a fix. This is separate from step 2.
  - **Probe** (gemini-3.1-flash-live-preview; history in `clientContent` with `historyConfig.initialHistoryInClientContent: true`, question via `realtimeInput.text`; a question inside `clientContent` hangs):
    - `functionCall` parts in `model` turns and `functionResponse` parts in `user` turns are accepted and read (the model answered from the tool result).
    - Role `function` closes the socket with 1007 (invalid argument).
    - `functionResponse.response: { result: '<string>' }` works. Model text plus `functionCall` in one turn works.
    - Media in a tool result works nested (`functionResponse.parts: [{ inlineData }]`) and as a sibling `inlineData` part; both cost about 1,092 more prompt tokens (the image) and the model read it. The control without the image guessed.
    - Two results in one `user` turn and in two `user` turns give the same answer and the same prompt tokens (354), so one message maps to one turn.
  - **Today:** an assistant message with only `tool_calls` is sent as `{ role: 'model', parts: [] }` (accepted, 0 tokens: the call is lost), and the tool result is sent as user text, which gives untrusted tool output the user's voice.
  - **Fix (done):** assistant → its text/media parts, then one `functionCall { id, name, args: historyToolArguments(arguments) }` per call. Tool message → a `user` turn with `functionResponse { id: tool_call_id, name, response: { result: content }, parts: media inlineData }`.
  - **Done:** `buildGeminiLiveClientContent` sends exactly that. Text parts of a tool message are newline-joined into `result` (the same collapse as the AI SDK path); `id` / `name` are sent only when history carries them, so a missing one reaches the API unfilled and its error is the answer. `thoughtSignature` is not sent (Live never emits one). Verified by sending the builder's own output to Live: it read a text result and an image result correctly. Malformed history arguments throw `TheoremError`, as on the other transports.
  - **Aligned (23/09/2026):** OpenAI-compat invented `call_<name>` / `call_tool` and the AI SDK path invented tool name `'tool'`; Interactions sent `''` for both. All four transports now share `historyToolIdentity`: id and name only where history carries them. A missing one reaches the provider unfilled (the AI SDK rejects it before sending). `fallbackToolCallId` and both `stringDefault` copies are deleted.
- **R4-6. CLI label (done; `TestRunResult.tokens` replaces `tokensTotal`).** A passing `test` whose total includes estimates prints `✓ STATUS: PASSED (took 2.31s, 1234 tokens, includes estimates)`. The result object carries the flag.
- **R4-7. Grounding (done; probed 23/09/2026).** Probe Interactions with `google_search`. Delete any `grounding_metadata` read that the recorded stream does not show.
  - **Interactions** (gemini-3.8-flash, `google_search` and `google_maps`, streamed and buffered; thinking `low`, since this model rejects `minimal` and `none`): no `grounding_metadata` / `groundingMetadata` anywhere. Grounding is `result[].search_suggestions`, `result[].places[]` (`name`, `url`, `place_id`; maps also sends `widget_context_token`) and `annotations[]` (`url_citation`: `url`, `title`; `place_citation`: `url`, `name`, `place_id`; both with `start_index` / `end_index`). Streams carry them on `step.delta`; buffered bodies on `steps[]`, annotations under `content[]`.
  - **Live** (gemini-3.1-flash-live-preview, `googleSearch`): one `serverContent.groundingMetadata` per turn, camelCase only: `groundingChunks[].web` (`uri`, `title`), `groundingSupports[]` (`groundingChunkIndices`, `segment`), `searchEntryPoint.renderedContent`, `webSearchQueries`.
  - **Done:** the parser reads only those shapes (every guessed camel/snake alias deleted). Buffered bodies were emitting no grounding at all (the parser read `interaction.steps`, the body has top-level `steps`); `eventsFromInteractionEnd` now owns buffered grounding and the buffered path no longer asks twice. Tests use the recorded shapes with synthetic values (the recorded maps rows carry a location, so they stay out of the public repo).
  - **Step 2 fidelity inputs:** `usage.grounding_tool_count[]` (`type`, `count`, `search_query_count`), `input_tokens_by_modality`, and the per-invocation `prompt_tokens_details` / `candidates_tokens_details`. Citation offsets and `groundingSupports` stay on the raw `metadata`.
- **R4-9. Unobserved wire aliases (done 23/09/2026).** Every guessed alias outside grounding was probed; what the wire does not send is deleted, what it sends is read in its one observed spelling. Documented-but-unobserved fields are kept and marked as such.
  - **Interactions, deleted:** event types `content.delta` / `interaction.complete`, `payload.type` beside `event_type`, camel `mimeType` in deltas, top-level `status` on `interaction.completed`, `output_image` / `outputs`, the `interaction.steps` read on the completed row (streams carry no `steps` there). The stream fold is now one model: `step.start` / `step.delta` / `step.stop` per `index`; `function_call`, code execution and builtin steps merge and emit once, whole, at `step.stop`; buffered bodies emit the same events from `steps[]` (`eventsFromStep`, `eventsFromInteractionEnd`).
  - **Live, deleted:** snake aliases `interaction_status`, `url_context_metadata`, `waiting_for_input`, `generation_complete`, `turn_complete`; a numeric `goAway.timeLeft` (the wire sends a Duration string, `"50s"`).
  - **Tape:** the scrub finds inline bytes by the shapes the wire and Theorem send (`inlineBytesKey`): `mime_type` + `data` (Interactions request, deltas, steps), `mimeType` + `data` (Theorem media parts in a tool's raw output; Live `inlineData`), `media_type` + `b64_json` (OpenRouter `/images`) and `data:<mime>;base64,` URLs anywhere (OpenRouter chat `message.images`). Bytes become their sha256 (`dataKind: 'sha256'`; a data URL becomes `data:<mime>;sha256,<hex>`). Inline data that is not base64 is hashed as text and labelled (`dataKind: 'text_sha256'`, `data:<mime>;text_sha256,<hex>`); a `$bytes` marker that is not base64 resolves to `{invalid_base64: true, text_sha256}`. One bad blob never loses the record. `data` without a mime (e.g. `reasoning.encrypted`) is kept.
  - **Bugs the probes exposed (fixed, with regression tests):** (1) Live read `interactionStatus` at the top level; it lives under `serverContent`, so an extended-thinking turn closed while `IN_PROGRESS`. (2) The Interactions stream dropped code execution evidence. (3) Builtin steps were emitted twice and incomplete. (4) Buffered mode dropped `function_call` steps. (5) Buffered mode dropped thought summaries. (6) Buffered mode emitted media twice. (7) 24000 Hz was hardcoded on every transport; the rate and channels now come from the mime (`shared/pcm.ts`), and Live `part.thought: true` is now a `thought`, not text. (8) OpenRouter chat image generation (`image.includeText`) always failed: images arrive in `message.images[]`, and the parser read markdown and content parts. Only the first `/images` entry was kept; every entry is now `media`. (9) An Interactions stream cut off before `interaction.completed` ended as `completed`; it is now `stream_incomplete`, and a non-terminal status keeps its `native`.
  - **Wire facts recorded:** gemini-3.1-flash-lite buffers a thought summary but streams none (pro streams it). A search-result delta gives a `grounding` with 0 sources plus `searchHtml`. Live `goAway` arrived twice about 9 minutes in, then close 1008 at the session limit; a second Live model sent none in 20 minutes; an idle session with no keepalive closed with 1008 at 153 s and no `goAway`. The Interactions TTS model rejects a system instruction. OpenRouter `/images` returns `data[]{b64_json, media_type}` with usage and cost; chat with `openrouter:image_generation` returns `message.images[]{image_url.url}` as a data URL beside a string `content`; an image-output model given the tool returns 404.
  - **Follow-ups (decided 23/09/2026):**
    - **Tape coverage (done).** OpenRouter `/images`, interleaved chat and speech are taped (speech's audio body as an `http_body` row). Live frames are taped with step 2's per-response Live records (F7), since Live has no record to hold them yet.
    - **Stream-end open steps (done).** A step with no `step.stop` is `evidence` with `partial: true`; a partial `function_call` never runs.
    - **`sse_unparsed` rows (done).** A row that is not a JSON object is an `error`.
    - **Layering (done).** Gemini parsing left the kernel: `google/grounding.ts`, `google/interactions/steps.ts`, `shared/structured-output.ts`; `kernel/engine/delta.ts` is gone.
    - **Audio packaging (closed, no change).** Every transport already emits WAV through `shared/pcm.ts`: a whole body as one WAV (buffered Interactions, OpenRouter speech), a stream as one WAV per chunk, in wire order (Interactions deltas, 46 for one TTS reply; Live). Each chunk states its own format, so a host queues them back to back; joining would hold playback until the reply ends.
    - **Error-ended turns (done).** The runner defaulted a turn with no recorded stop to `completed`, so a provider failure or a guardrail block read as success. A provider `error` now ends the call as `provider_error` (outranking its `done`), and resumption follows the profile's `turnBehaviour.resumption`; a canary leak or egress block ends it as `filtered` with `native: 'canary'` / `'egress'`, which is not continue-eligible.
    - **OpenRouter builtins (done).** A builtin with no `wire.openRouter` (Maps, URL context, code execution) was silently dropped; it now throws through `requireBuiltinWire`, as on Interactions and Live, and the call ends as an `error` before any request is sent. `builtinWire` is gone.
    - **Live (done, probe 23/09/2026 on four Live models).** Builtins were silently dropped (no `wire.live`) and, had one been set, declared as a function named after the builtin; they are now their own setup tools (`{ googleSearch: {} }`) and a builtin with no Live wire throws, as on Interactions. `voiceActivity` is `evidence` (`voice_activity`). `codeExecutionResult` parts are `evidence` (`code_execution_result`); `executableCode` was never sent, so nothing reads it. A cancel carries the name of the call this connection issued; an unknown id is an `error`. Realtime input sends the host's mime as given, and `LiveSession.sendAudio` / `sendVideo` now require `mimeType` (breaking for hosts that omitted it). The duplicate `buildGeminiLiveRealtimeText` is gone.
- **R4-10. `thinking: 'none'` on Interactions (closed 23/09/2026, no change).** Interactions framing sends whatever level the host's binding maps to; gemini-3.8-flash rejects `none` (and `minimal`) with 400. Which levels a model accepts is provider-shaped and changes, so the kernel does not validate it: the host's binding decides and the API error is the answer (it reaches the trace as the call's error). Presets are the only place a level list could live; the Google preset declares no model bindings or efforts today, so nothing maps to `none`.
- **R4-11. Concurrent tool execution (noted 23/09/2026, open, out of scope).** Same-step tool calls execute in order by contract (`stages.md` → same-round batch rules; `handlePendingTools`), because the gate, taint accumulation, stage hooks and result order all depend on it. The design question is tracked in [#19](https://github.com/masudl-hub/theoremai/issues/19). Traces need no change for it: every `execute_tool` span carries its own start and end times, so concurrent execution would show as overlapping siblings. The example's E5 wording describes today's behaviour.
- **R4-8 (done).** Fix `tests/fixtures/probes/create-provider-load.ts` so it passes `deno check`; the typecheck gate (CI and `check:ci`) now includes `tests/fixtures/probes/`, which tests spawn without type-checking.

## Step 2 (done 23/09/2026)

Every writer builds a v3 record through `buildRecord`: `runTurn`, specialists, `invokeTool`, Live (response, tool and session records), and `flushMintTrace`. The literal shape is the [worked example](./otel-turn-traces-example.md), corrected where it disagreed with the code.

Found and fixed while wiring it:
- **Sampling split traces.** `sampleRate` drew a random number per record, so a turn could be kept while its specialist or Live responses were dropped. It is now decided by trace id (OpenTelemetry `TraceIdRatioBased`), so a trace is kept or dropped whole, in any process.
- **Cutout error text bypassed the scrub.** It rode as status text; it is now an `exception` event stored by hash.
- **`invokeTool` records lost host metadata.** `InvokeToolRequest.metadata` now rides on its record, as `TurnRequest.metadata` does.
- **Compaction was invisible in the parent turn.** A `theorem.compaction` event on the turn root records every decision (timing, meter, budget, threshold, tokens before, whether it was needed, whether it compacted); the compaction run itself is its own `invoke_agent` record.

## Step 3 (done 23/09/2026)

- **One owner.** `retainForDays` resolves once, in `resolve-policy.ts` (`DEFAULT_RETAIN_DAYS`, `DEFAULT_ROTATE_MIB`); the copies in `trace.ts` are gone.
- **Every destination receives it.** `TraceSink.write(record, context)` takes a `TraceWriteContext` (`{ retainForDays }`) from the policy of the profile that wrote the record; `writeTrace(sink, record, policy)` builds it, so every writer (turn, invoke, Live, cutout) passes it the same way. An explicit sink receives it too.
- **JSONL reads the same value.** `jsonlSink` prunes by the record's `retainForDays`; its own `retainForDays` option and the legacy `now`-function overload are removed (`{ now }` remains, for tests).
- **I-1.** `retainForDays <= 0` keeps records forever: the JSONL writer prunes nothing, and profile validation accepts it (it rejected anything `<= 0` before). A host store writes `retain_until` null.
- **Cutout writes** now go through `resolveTraceWriter`, so the host sink also receives the profile's `onWriteError` binding, as every other writer's does.

## Step 4 (done 23/09/2026)

- **`toOtlpJson(records)`** (`src/observability/otlp.ts`): one `resourceSpans` per record, one scope `@theoremai/agents` with the record's `schemaUrl`, OTLP enum numbers, hex ids, `intValue` as a decimal string, `null` left out. No encoder dependency (decision A); the contract doc carries a reference Collector config (OTLP/JSON in, protobuf out) that the host runs.
- **References name their kind.** `$json` values were referenced as `content_sha256`, the same key as text, so a reader could not tell stored JSON from text that happens to be JSON. They are now `{ json_sha256 }`; text stays `{ content_sha256 }`; a blob's `content_sha256` sits beside `bytes` and is not in `content`. The worked example changed with it.
- **`inlineContent(record, value)`** rebuilds any value from its references; `toOtlpJson` and the CLI's `--verbose` rows use it, so a viewer reads standard semconv messages.
- **Not exported to OTLP:** `metadata` (host-owned; no OTLP slot) and blob bytes (never stored).
- **`@theoremai/agents/observability/openinference`** (decision B): `withOpenInference(records)` adds `llm.token_count.completion_details.reasoning` and `llm.cost.total` to model-call spans only (an agent's usage is already their sum), and never writes a partial cost as a total. Names checked against the OpenInference spec; Phoenix's GenAI conversion merges beside them without skipping (read in its source, not run).
- **Not yet verified by a run:** ingest into a Collector or Phoenix. Needs approval to start one.

## Step 5 (done 23/09/2026, Theorem side)

- **CLI:** `--trace` prints the v3 record; `--verbose` prints its upstream rows through `inlineContent`. `bench` labelled its trace micro-benchmark per event after the step 2 rename (the per-turn check matched a stale label); each result now carries its own unit.
- **`kernel.md`:** the Trace lifecycle step described the v2 wire snapshot (`toInteractionsBody`, which no longer exists); rewritten. A trace-context table documents `traceparent`, `conversationId`, `links`, `metadata`, `done.traceparent` and `ToolContext.traceparent`.
- **`stages.md`:** `theorem.stage` span events and which span each stage records on.
- **theoremai-frontend (`unified-docs.ts`, `architecture.ts`):** stale — names `dirSink`, `sinkFromDir`, `resolveTraceDir`, `trace-attach.ts` and `trace-usage.ts`, none of which exist. Public copy, so the lines wait for approval.

