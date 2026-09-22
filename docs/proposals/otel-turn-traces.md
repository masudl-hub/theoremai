# OpenTelemetry-shaped turn traces — proposed specification

**Status:** proposed; decisions locked 22/09/2026. Not implemented.
**Version:** ships within `@theoremai/agents` 2.x (decided 22/09/2026). The `TraceRecord` shape changes, so every reader updates in the same change.

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

Turn outcomes carried on the root: `completed | tool | gate | cancelled | error | thrown`. Each maps one-to-one to `theorem.stop.kind` and `status`.

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
- `toOtlpJson` output parses against the OTLP/JSON trace schema.
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
const root = startSpan({ name: 'bonsai.turn', traceparent? });   // host root
const end = root.child('bonsai.load_context'); … end();
runTurn({ …, traceparent: root.traceparent }, provider, sink);      // Theorem spans nest under it
await root.flush(sink);
```

- There is one builder, and the kernel uses it too; there is no host copy.
- `flushMintTrace` becomes one call on this builder: it adds a `cutout` child span to the turn's trace. Its public name stays; its record shape changes with the new format.

Bonsai consumers added:
- `agent-turn-trace.ts`: `AgentTurnTraceCollector` is replaced by the builder.
- `run-host-turn.ts`, `load-host-turn-context.ts`, `assemble-host-turn-prompt.ts`, `run-orchestrator-generation.ts`, `handle-agent-turn-policy.ts`, `context/load-live-context.ts`, `paths/web/handler/path-web-authed-turn.ts`: callers move to the builder.
- `theorem-turn-observability.ts`: the round and tool timing inference is deleted, because the kernel spans replace it.
- **Frontend:** `frontend/src/lib/agent-turn-timing.ts` (+ test, `web-chat-reply.ts`, `use-web-chat-send.ts`, `use-web-message-actions.ts`) keeps a hand-copied mirror of the backend span and usage types that `done.timing` carries. The hand-copied types are deleted. The frontend imports the span type from `@theoremai/agents/observability`, as it already does for `TurnEvent` from `@theoremai/agents/kernel`.

## Live sessions (from decision 6)

```
invoke_agent {live profile}            ← whole session (open → close / drop)
├─ chat {model}  response 1            ← opens at the first model output, closes at turnComplete / interrupted
│   └─ execute_tool {name}
├─ chat {model}  response 2  (status UNSET, theorem.stop.kind=interrupted on barge-in)
```

- **Durability:** a session can last minutes, and its worker can be evicted. So one record is flushed per completed response, with the session span as its parent, and the session root is flushed at close. If the process dies, the completed responses are kept and the root is missing. A viewer shows that as a trace with no root span, which is honest, not invented.
- **Usage:** Google Live reports tokens only, so there is no cost attribute.
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
- **F. Declared server identity.** A `local` profile may declare its server name (e.g. `ollama`), which becomes `gen_ai.provider.name`. When it isn't declared, the attribute is absent (unknown), not guessed. Why it matters: without it, a trace can't say which server produced an answer, so evals can't compare servers.
- **G. Reference, not copy.** A generic `include` reference mode in Theorem, as proposed. Content already held by a host store is written as its id. Only content stored nowhere else stays in the trace.
- **H. Retention.** The default is unlimited; it's configurable through Theorem's existing trace retention setting. Each row stores `retain_until`, computed at write time from that setting (null = keep forever). A `pg_cron` job deletes rows past `retain_until`, so the job decides nothing itself and the setting has one owner. The profile cascade still deletes traces whenever the account goes.
  - **Survey finding (verified):** today `retainForDays` applies only to the JSONL destination (`src/observability/types.ts:82`). It is a required number, so there is no way to say "keep forever", and the default of 14 is defined twice (`resolve-policy.ts:18`, `trace.ts:16`), which is drift.
  - **Fix in this change:** one default constant. The resolved retention is passed to every destination, including a host `TraceSink`, so the Supabase sink reads the same setting the JSONL writer does.
  - **I-1 (locked):** `retainForDays: null` means keep forever. The type becomes `number | null`; `0` and negative numbers are rejected at profile validation.
  - **I-2 (locked):** Theorem's default stays 14 days. Bonsai's profiles declare `retainForDays: null`.
