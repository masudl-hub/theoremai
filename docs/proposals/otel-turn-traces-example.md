# Trace record v3: a worked example

**Status:** approved 23/09/2026. This is the step-2 target from [otel-turn-traces.md](./otel-turn-traces.md): every rule below is drawn once, in a concrete conversation.

**Invariant:** the trace has the highest possible fidelity, accuracy and precision. A developer can answer any question over any stretch of time (one call, one turn, a conversation, a date range) from traces alone. Anything Theorem does not know is absent or labeled with where it came from; it is never invented.

Attribute names are checked against `open-telemetry/semantic-conventions-genai` @ `8ffdf56`. Names under `theorem.*` are ours, because semconv has nothing equivalent.

## 1. The record

One record is written per `runTurn` (one exchange). The other writers:
- A Live session writes one record per model response, one per tool call, and one for the session root (§4.12).
- A tool the host invokes (`invokeTool`) writes its own record, rooted at its `execute_tool` span (§4.4).
- A specialist run by a tool writes its own record in the same trace (§4.7).
- A host that records a side effect made after a turn (for example an image cutout) writes one more record with a single `cutout` span (CLIENT) under the turn's root, using `flushMintTrace` from `@theoremai/agents/host`. The span carries `server.address`, `url.path`, the host's input and output hashes (`theorem.cutout.input.sha256`, `theorem.cutout.output.sha256`), the upstream exchange as a `theorem.upstream.row`, and any error text as an `exception` stored by hash.

```ts
interface TraceRecord {
  v: 3;
  schemaUrl: string;                       // pinned semconv-genai commit
  resource: Record<string, TraceAttributeValue>;   // host-supplied, e.g. service.name
  metadata?: Record<string, unknown>;      // host-owned, passed through untouched
  spans: TraceSpan[];                      // this record's spans: root first, then in start order
  content: Record<string, string>;         // sha256 hex → exact scrubbed text; every hash the spans reference
}

interface TraceSpan {
  traceId: string;                         // 32 hex
  spanId: string;                          // 16 hex
  parentSpanId?: string;
  name: string;                            // "{gen_ai.operation.name} {model | profile | tool}"
  kind: 'INTERNAL' | 'CLIENT';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: TraceAttributes;
  events: TraceSpanEvent[];                // { name, timeUnixNano, attributes }
  links: TraceSpanLink[];                  // { traceId, spanId, attributes }: resume / continue edges
  status: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string };
}
```

**Content is stored once, by hash (G).**
- A span never carries text inline. A text part is `{ "type": "text", "content_sha256": "<hex>" }`.
- Everything is hashed the same way: system instructions, tool definitions, every message, tool arguments and results, and reasoning text.
- Media bytes are never stored. A media part is `{ "type": "blob", "modality", "mime_type", "content_sha256", "bytes" }`, and its hash covers the raw bytes.
- `content` maps each text hash to the exact text *after* the profile's scrub policy ran. A hash therefore identifies what was recorded; when scrub is off, that is what the model saw.
- Provider rows, wire bodies, grounding payloads, server tool parts and a tool's raw output are JSON. Each is scrubbed, its own strings equal to a recorded text are replaced by `{ "content_sha256" }`, and the JSON is stored in `content` under its hash, referenced as `{ "json_sha256": "<hex>" }`. So a reference says how to read it: `content_sha256` is text, `json_sha256` is JSON, and `content_sha256` beside `bytes` is a blob hash that is not in `content`.
- `content` makes a record self-contained. A sink may deduplicate across records by hash.
- `inlineContent(record, value)` rebuilds any value from its references. `toOtlpJson` uses it, so a viewer reads standard semconv messages.

**Notation in this document.**
- Hashes are written `#label` (for example `#sys.support`). Real keys are 64-character sha256 hex.
- The span trees show JSON references inlined (as `inlineContent` would read them); the literal records in §4.4 show them as stored.
- Times are shown as seconds from the record's root start (`[1.612 → 1.655]`). The record stores unix-nanosecond strings. §4.4 shows one record with real values.

## 2. Span catalogue

The shipped wording for every span, attribute, event and value is the trace catalog in code (`src/observability/trace-catalog.ts`, see [the observability contract](../contracts/observability.md#trace-catalog)); where these tables and the catalog differ, the catalog is current.

### `invoke_agent {profile}`: one turn (INTERNAL)

**Opens** when `runTurn` is entered. **Closes** at flush. A span still open at flush closes as `ERROR` / `unclosed`.

| Attribute | Meaning |
|---|---|
| `gen_ai.operation.name` | `invoke_agent` |
| `gen_ai.agent.name` | profile id |
| `gen_ai.conversation.id` | from the host (`TurnRequest`); absent when the host sets none |
| `gen_ai.input.messages` | the turn's new user input only (text, attachments, voice), as parts |
| `gen_ai.output.messages` | what the host received: one assistant message folded from the events the turn delivered, after guardrails (text, `reasoning` when the profile streams thoughts, `tool_call` once per call, media, `structured`). Its `finish_reason` is the last `done`'s. Each call's own `output.messages` is what the model produced. |
| `gen_ai.usage.*` | sum (`sumTokens`) of this agent's own model calls. Nested agents (compaction, specialists) carry their own usage, so nothing is counted twice. |
| `gen_ai.conversation.compacted` | `true` when compaction ran in this turn |
| `theorem.stop.kind` | the last `done`'s stop: `completed` / `length` / `tool` / `gate` / `filtered` / `provider_error` / `cancelled` / `stream_incomplete` / `interrupted` / `generation_complete`. Absent when the turn threw before any `done`. |
| `theorem.attempts`, `theorem.steps` | attempts made; model calls made |
| `theorem.request.effort`, `theorem.request.model_select`, `theorem.project.id` | as requested |
| `theorem.usage.cost_usd`, `theorem.usage.cost_partial`, `theorem.usage.upstream_cost_usd` | summed cost. It is absent when no call reported a cost, and `partial` when only some calls did. |
| `theorem.usage.estimated` | sides (`input`, `output`) where any call's count was estimated |
| `theorem.usage.unknown_media` | media counted by no rule, per side |
| `theorem.record.include`, `theorem.record.scrub` | the include and scrub flags that were on (for example `["upstreamLog", "outboundWire", "usage", "guardrailDecisions"]`), so a missing field reads as "not recorded" and never as "did not happen" |
| `theorem.error.public` | hash of the error the caller received, on a failed turn |
| `error.type` | the failure's kind (`rate_limit`, `unavailable`, … — see [Public errors](../contracts/guardrails.md#public-errors)), or the failing stop (`provider_error`, `stream_incomplete`) when nothing named a kind |
| `theorem.clock` | `io` inside a Cloudflare Worker (P6) |

**Status:** `ERROR` for `provider_error`, `stream_incomplete` or a throw. `OK` for `completed`, `length` and `generation_complete`. `UNSET` for the stops a person or policy chose (`tool`, `gate`, `filtered`, `cancelled`, `interrupted`).

**Events:**
- `theorem.stage`: `{ stage, affordance, hook_ms?, warnings? }` for `pre_turn` / `before_end` / `post_turn`.
  - `affordance` lists what the handlers applied (`inject`, `abort`, `deny`, `confirm`, `mutate`); `[]` when they applied nothing.
  - `hook_ms` is present only when handlers ran. `warnings` lists warning codes.
- `theorem.guardrail`: decisions on input, egress and injected history (shape below).
- `theorem.attempt.retry`: `{ attempt, reason }`, where `reason` is `egress` or `validation`.
- `theorem.compaction`: the compaction decision (§4.8).
- `exception`: `exception.type` and `exception.message` (a hash of the scrubbed message).

**Links:** each carries `theorem.link.kind = resume | continue | retry` and, when the host knows it, the earlier turn's `theorem.stop.kind`.

**`theorem.guardrail` shape** (on any span):

```json
{ "stage": "tool_result", "trust": "untrusted", "action": "redact",
  "hits": [{ "rule": "tool_result.redacted", "severity": "medium", "start": 212, "end": 301, "match": "…" }],
  "provenance": { "origin": "http", "tool": "track_shipment", "depth": 1 } }
```

- `action` is `redact`, `flag` or `block`.
- `start` / `end` are present when the check had offsets.
- `match` is kept only under `guardrailMatchPreview`.
- The whole event is kept only under `guardrailDecisions`.

### `{chat | generate_content} {model}`: one model call (CLIENT)

**Opens** before the provider request. **Closes** at the end of the stream or on a throw. The operation is `chat` for chat-completions providers (OpenRouter, local) and `generate_content` for Gemini (Interactions, Live), following semconv's operation list.

| Attribute | Meaning |
|---|---|
| `gen_ai.provider.name` | `gcp.gemini`, `openrouter`, or a declared `local` server; absent when unknown |
| `gen_ai.request.model` / `gen_ai.response.model` | api id sent / model the provider says answered |
| `theorem.model.id` | the profile's model alias |
| `gen_ai.request.stream` | `true` only when the call streamed: its HTTP body asked for a stream, or it is a Live response. Absent means not streamed, as semconv reads it. |
| `gen_ai.request.temperature`, `.max_tokens`, `.reasoning.level` | as requested |
| `gen_ai.request.previous_response.id` | Interactions continuation |
| `theorem.request.builtins` | provider-run tools requested (`[]` when none) |
| `theorem.request.store`, `.summaries`, `.structured`, `.session_id`, `.cache`, `.image`, `.speech`, `.live` | request controls semconv has no names for, as requested. `live` holds voice, VAD, session resumption, context compression, proactive audio, transcription and `resumed`; a resumption handle is a credential and is never recorded. |
| `gen_ai.response.id` | as the provider reported it; absent when not reported |
| `gen_ai.response.finish_reasons` (chat) / `gen_ai.response.status` (Gemini) | the provider's own stop value. Absent when the call was stopped (cancelled, interrupted), because the provider never said. |
| `gen_ai.response.time_to_first_chunk` | seconds from the start of the successful streamed HTTP try to its first chunk |
| `gen_ai.system_instructions`, `gen_ai.tool.definitions` | hash parts (identical across calls, so one hash each) |
| `gen_ai.input.messages` | everything the model read on this call, in kernel order. On a continuation this includes the stored interaction. |
| `theorem.input.sent_from` | index in `input.messages` where the wire payload starts (continuations send only the tail) |
| `gen_ai.output.messages` | one assistant message whose `finish_reason` is semconv's (`stop`, `length`, `tool_call`, `content_filter`, `error`). Its parts are text, `reasoning`, `tool_call`, `server_tool_call` / `server_tool_call_response` and media, exactly as received. A cancelled call keeps what arrived before the cancel. |
| `gen_ai.output.type` | `text` / `json` / `image` / `speech`. A Live response is `speech`: Live answers in audio. |
| `theorem.stop.kind` | this call's stop |
| `error.type` | on a failed call: the failure's kind; the HTTP status stays on each `POST` |
| `gen_ai.usage.input_tokens`, `.output_tokens`, `.reasoning.output_tokens`, `.cache_read.input_tokens`, `.cache_write.input_tokens` | normalized (step 1) |
| `gen_ai.usage.{text,image,audio}.{input,output}_tokens` | per-modality counts, when the provider reports them (Google does; OpenRouter does not). Other modalities go under `theorem.usage.*`. |
| `theorem.usage.tool_use.input_tokens` | Google tool-use tokens (already inside input) |
| `theorem.usage.grounding` | `[{ type, count, search_query_count }]` (Interactions `grounding_tool_count`) |
| `theorem.usage.cost_usd`, `.upstream_cost_usd`, `.estimated`, `.unknown_media` | as reported, or as estimated with the sides listed |
| `theorem.step`, `theorem.attempt`, `theorem.key_slot` | position in the turn; the key slot that finally answered |

**Status:** `ERROR` when the provider reported an error or the call threw; `UNSET` when it was stopped; `OK` otherwise.

**Parts:**
- A text part may carry `theorem.source` (for example `input_transcription`, `output_transcription`) and `theorem.interim: true` for an interim transcription chunk rather than a final one.
- A media part is `{ type: "blob", modality, mime_type, content_sha256, bytes }`. When the data is not base64 it is `{ …, invalid_base64: true, text_sha256 }`: the text is hashed as given rather than lost.

**Events:**
- `theorem.upstream.row`: each provider data row at its arrival time. Media is replaced by its hash, and any string equal to a known content text is replaced by its text reference; the row is a JSON reference. Kept only under `upstreamLog`.
- `theorem.grounding`: `{ sources, search_html?, raw? }` from Google grounding, or `{ provider, sources?, citations?, annotations?, raw? }` from other evidence, each payload a JSON reference. Citation annotations live here, not on text parts. `raw` is kept only under `evidenceRaw`.
- `theorem.guardrail`: output-scan decisions.
- `exception`: one per provider error (`exception.type: "provider_error"`, message by hash), plus a throw.

**Children:** one `POST` HTTP client span per try (HTTP semconv).
- Attributes: `http.request.method`, `server.address`, `url.path` (never the query), `http.response.status_code`, `http.request.resend_count`, `error.type` (the status, or the thrown error's name — HTTP convention), `theorem.key_slot`, and `theorem.retry.backoff_ms`, the wait before this try.
- Headers are recorded as `http.request.header.<name>` / `http.response.header.<name>` (`[value]`). Any header whose name matches key, auth, cookie, secret or token is `[redacted]` before a span sees it.
- Events: `theorem.wire.request` (the request body, interned like rows; `{ body_kind }` when the body is not JSON), kept only under `outboundWire`; the provider's error body as a `theorem.upstream.row`; `exception` when the try threw.
- **Status:** `ERROR` for a status of 400 or higher, or a throw. A provider error inside a 200 body is the call's failure, not the try's. `UNSET` when the call was stopped mid-body.
- Live has no HTTP children; its socket lifecycle is recorded as events on the session root (§4.12).

### `execute_tool {name}`: one tool call that Theorem ran (INTERNAL)

**Opens** before `pre_tool`. **Closes** at settlement. So the span covers the hooks, the gates and the tool body.

| Attribute | Meaning |
|---|---|
| `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type` | `function` for registered tools |
| `gen_ai.tool.call.arguments` | hash of the arguments exactly as the model sent them (raw string when they did not parse) |
| `gen_ai.tool.call.result` | hash of what the model reads back (after `formatToolResult` / failure formatting and the tool-result guardrail) |
| `theorem.tool.call.result.parts` | media and other parts the result carried, as parts |
| `theorem.tool.data` | JSON reference to the tool's raw output, before formatting |
| `theorem.tool.outcome` | `ok` / `error` / `denied` / `gated` / `paused` / `cancelled` |
| `theorem.tool.origin` | `local` / `builtin` / `http` / `mcp` / `delegated` (taint source) |
| `theorem.tool.permission` | `auto` / `session_consent` / `always_confirm` |
| `theorem.tool.approved` | `true` when the host resumed the call with approval |
| `theorem.step` | the model call that asked for it |
| `error.type` | on `error`: the failure's kind (for example `bad_response`, `failed`) |
| `theorem.tool.failure.code` | on `error`: the failure's code (for example `malformed_arguments`, `handler_error`) |

**Events:**
- `theorem.stage`: `pre_tool` / `post_tool`, same shape as on the turn.
- `theorem.gate`: `{ kind, permission?, summary?, auth? }`. `kind` is `permission`, `confirmation` or `auth`; `summary` is a hash; `auth` is `{ slot, type, issuer?, resource?, required_scopes? }` and never the challenge state.
- `theorem.guardrail`: sensitive arguments and the taint gate (stage `tool_call`), and redaction and directive signals on the result (stage `tool_result`).
- `exception`.

**Status:** `ERROR` only when the tool failed. `denied`, `gated`, `paused` and `cancelled` are `UNSET`: the tool did not fail, a policy or the user stopped it.

**Provider-run tools** (Google search, maps, code execution) are not `execute_tool` spans: Theorem did not run them. They appear as semconv `server_tool_call` / `server_tool_call_response` parts in the model call's output. The kernel sees a step only once it is whole, so the part records its arrival as `theorem.observed_end`, and `theorem.partial: true` when the provider sent it incomplete. The row events hold every earlier row's arrival.

**A tool the host invokes** (`invokeTool`) writes its own record. Its root is the `execute_tool` span, under the host's `traceparent`, carrying `gen_ai.agent.name`, `gen_ai.conversation.id`, the request's links and its metadata.

## 3. The conversation

The example app is the support agent of an outdoor-gear shop (`service.name: harbor-support`). It is not Bonsai, and nothing in it is Bonsai-specific. All exchanges share `gen_ai.conversation.id: conv_7Qm2`.

| Profile | Provider / model | Tools |
|---|---|---|
| `support` | OpenRouter `google/gemini-3.8-flash` | `lookup_order` (local), `track_shipment` (origin `http`), `issue_refund` (origin `http`, permission `session_consent`), `draft_email` (local), `send_email` (origin `http`, `read-write`). Guardrails: `taint.afterRemoteRead: "write"`. |
| `support.research` | Interactions `gemini-3.8-flash` | builtin `googleSearch`, `lookup_order` |
| `support.compact` | OpenRouter `google/gemini-3.8-flash` | none (compaction) |
| `writer` | OpenRouter `google/gemini-3.8-flash` | none (specialist) |
| `support.summary` | OpenRouter `google/gemini-3.8-flash`, structured `ticket_summary` | none |
| `support.voice` | Live `gemini-3.1-flash-live-preview` | `lookup_order` |

| # | User | What happens | What it shows |
|---|---|---|---|
| E1 | "Where's my order A1042?" | Three model calls. The first call gets a 429, then succeeds on a retry. Then `lookup_order` → `track_shipment` → the answer. | HTTP try spans, backoff, multi-step usage sum, cache reads, cost |
| E2 | Photo of a snapped tent pole | One call with an image | media by hash, image tokens unknown per modality (OpenRouter) |
| E3 | "Refund the pole, $38.00" | `issue_refund` needs approval, so the turn stops | `gated` outcome, stop `gate` |
| E4 | Approves for the session | The host resumes the gated call with `invokeTool`; the payment API times out. The host then runs the next turn, where the model retries the refund and it succeeds. | a host-invoked tool record, resume links, tool `ERROR`, recovery, full literal records (§4.4) |
| E5 | "When does the replacement arrive, and has A1077 shipped?" | Two `track_shipment` calls. One result carries an injection; the model then tries `send_email`, and the taint gate denies it. | guardrail on a tool result, taint, `denied` |
| E6 | "Is the Ridgeline 2 rated for snow? Check the maker's site." | `support.research`: Google search runs on the provider, then `lookup_order`, then an Interactions continuation. | server tool parts, grounding, per-modality usage, `previous_response.id`, no cost |
| E7 | "Draft an email to Ridgeline about a warranty replacement." | The first `draft_email` call has malformed arguments; the second works. The tool runs the `writer` specialist. | `malformed_arguments`, a nested agent in its own record, same trace |
| E8 | "Remind me what we've done so far." | Compaction runs before the call | nested compaction agent, `conversation.compacted` |
| E9 | Long question, then presses stop | Call 1 calls a tool (cost reported); call 2 is cancelled mid-stream | partial output, estimated usage, partial cost, `cancelled` |
| E10 | (host) "Summarize this ticket" | Attempt 1 returns invalid JSON; the repair attempt returns valid JSON | attempts, `theorem.attempt.retry` |
| E11 | "Can you check A1099?" | 502, 502, 503: retries exhausted | `ERROR`, public vs internal error, no usage (unknown, not 0) |
| E12 | Switches to voice | Live session: response 1 calls `lookup_order`, response 2 reads the result and answers; the user interrupts response 3 | session root, per-response records, audio tokens, interruption |

## 4. The traces

### 4.1 E1: three calls, a retried 429

```
invoke_agent support                          [0.000 → 4.912]  OK  stop=completed steps=3
├─ chat google/gemini-3.8-flash  step 1       [0.004 → 1.610]  OK
│  ├─ POST /api/v1/chat/completions           [0.004 → 0.212]  ERROR 429  resend_count=0
│  └─ POST /api/v1/chat/completions           [0.612 → 1.610]  OK 200     resend_count=1 backoff_ms=400
├─ execute_tool lookup_order                  [1.612 → 1.655]  OK  origin=local
├─ chat google/gemini-3.8-flash  step 2       [1.657 → 2.902]  OK
│  └─ POST …                                  [1.657 → 2.902]  OK 200
├─ execute_tool track_shipment                [2.904 → 3.781]  OK  origin=http
└─ chat google/gemini-3.8-flash  step 3       [3.783 → 4.905]  OK
   └─ POST …                                  [3.783 → 4.905]  OK 200
```

| Span | input | cache_read | output | reasoning | cost_usd | TTFC s |
|---|---|---|---|---|---|---|
| chat 1 | 1,284 | 0 | 38 | 21 | 0.000512 | 0.369 |
| chat 2 | 1,402 | 1,152 | 29 | 12 | 0.000351 | 0.412 |
| chat 3 | 1,530 | 1,280 | 64 | 18 | 0.000498 | 0.388 |
| **root (sum)** | **4,216** | **2,432** | **131** | **51** | **0.001361** | none |

Chat 3's `gen_ai.input.messages`:

```json
[
  { "role": "user", "parts": [{ "type": "text", "content_sha256": "#e1.u" }] },
  { "role": "assistant", "parts": [
      { "type": "reasoning", "content_sha256": "#e1.c1.think" },
      { "type": "tool_call", "id": "call_e1_1", "name": "lookup_order", "arguments": { "content_sha256": "#e1.c1.args" } } ] },
  { "role": "tool", "parts": [{ "type": "tool_call_response", "id": "call_e1_1", "response": { "content_sha256": "#e1.t1.result" } }] },
  { "role": "assistant", "parts": [
      { "type": "tool_call", "id": "call_e1_2", "name": "track_shipment", "arguments": { "content_sha256": "#e1.c2.args" } } ] },
  { "role": "tool", "parts": [{ "type": "tool_call_response", "id": "call_e1_2", "response": { "content_sha256": "#e1.t2.result" } }] }
]
```

- Reasoning appears in input only if the provider actually replays it on the wire. The wire event is what settles that.
- Each `POST` carries its own `theorem.wire.request`, so the retried body is recorded exactly as resent.
- The 429 try carries `error.type: "429"`, `theorem.key_slot: "primary"`, its response headers (for example `http.response.header.retry-after`) and a `theorem.upstream.row` event holding the provider's error body.

### 4.2 E2: an image

```
invoke_agent support                          [0.000 → 2.388]  OK
└─ chat google/gemini-3.8-flash  step 1       [0.003 → 2.381]  OK  input 2,871 (cache_read 1,408) output 112 (reasoning 40) cost 0.000874
```

- **Root `gen_ai.input.messages`:**
  ```json
  [{ "role": "user", "parts": [
      { "type": "blob", "modality": "image", "mime_type": "image/jpeg", "content_sha256": "#e2.photo", "bytes": 842113 },
      { "type": "text", "content_sha256": "#e2.u" }]}]
  ```
- **No per-modality usage:** OpenRouter does not report image tokens, so `gen_ai.usage.image.input_tokens` is **absent**. It is not 0, and it is not our estimate.

### 4.3 E3: stops for approval

```
invoke_agent support                          [0.000 → 1.488]  UNSET  stop=gate
├─ chat google/gemini-3.8-flash  step 1       [0.003 → 1.476]  OK  input 3,066 (cache_read 2,688) output 41 (reasoning 19) cost 0.000402
└─ execute_tool issue_refund                  [1.478 → 1.484]  UNSET  outcome=gated permission=session_consent
     events: theorem.stage pre_tool; theorem.gate { kind: "permission", permission: "session_consent" }
```

- `gen_ai.tool.call.result` is absent (the tool never ran).
- Chat output: `tool_call call_e3_1 issue_refund { order_id: "A1042", amount: 38.00, currency: "USD" }` (as a hash).

### 4.4 E4: resume, tool timeout, recovery (full literal records)

The host handles the approval in one request of its own (span `7a3f1c9e2b4d6081` in trace `4bf9…`). It passes that span as `traceparent` to both calls, and links both to E3's turn, so the two records read as one trace.

**Record A**, written by `invokeTool({ name: "issue_refund", resume: { granted: true }, … })`:

```json
{
  "v": 3,
  "schemaUrl": "https://github.com/open-telemetry/semantic-conventions-genai/tree/8ffdf56",
  "resource": { "service.name": "harbor-support" },
  "metadata": { "ticket": "HS-2291" },
  "spans": [
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "b7ad6b7169203331",
      "parentSpanId": "7a3f1c9e2b4d6081",
      "name": "execute_tool issue_refund",
      "kind": "INTERNAL",
      "startTimeUnixNano": "1790157972003000000",
      "endTimeUnixNano": "1790157982007000000",
      "attributes": {
        "gen_ai.agent.name": "support",
        "gen_ai.conversation.id": "conv_7Qm2",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "issue_refund",
        "gen_ai.tool.call.id": "call_e3_1",
        "gen_ai.tool.type": "function",
        "gen_ai.tool.call.arguments": { "content_sha256": "#e3.c1.args" },
        "theorem.tool.origin": "http",
        "theorem.tool.permission": "session_consent",
        "theorem.tool.approved": true,
        "gen_ai.tool.call.result": { "content_sha256": "#e4.t1.failure" },
        "theorem.tool.outcome": "error",
        "error.type": "failed",
        "theorem.tool.failure.code": "handler_error",
        "theorem.record.include": ["upstreamLog", "outboundWire", "usage", "guardrailDecisions"],
        "theorem.record.scrub": ["sensitive", "injection", "canary"]
      },
      "events": [
        { "name": "theorem.stage", "timeUnixNano": "1790157972004000000", "attributes": { "stage": "pre_tool", "affordance": [] } },
        { "name": "exception", "timeUnixNano": "1790157982005000000", "attributes": { "exception.type": "TimeoutError", "exception.message": { "content_sha256": "#e4.t1.exc" } } },
        { "name": "theorem.stage", "timeUnixNano": "1790157982006000000", "attributes": { "stage": "post_tool", "affordance": [] } }
      ],
      "links": [
        { "traceId": "a3ce929d0e0e47364bf92f3577b34da6", "spanId": "53995c3f42cd8ad8", "attributes": { "theorem.link.kind": "resume", "theorem.stop.kind": "gate" } }
      ],
      "status": { "code": "ERROR", "message": "failed" }
    }
  ],
  "content": {
    "#e3.c1.args": "{\"order_id\":\"A1042\",\"amount\":38.00,\"currency\":\"USD\"}",
    "#e4.t1.exc": "payments.example: no response after 10000 ms",
    "#e4.t1.failure": "Tool issue_refund failed: the payment service did not respond. No refund was issued."
  }
}
```

**Record B**, written by the next `runTurn` (`sessionPermissions: ["issue_refund"]`, history ending in record A's result):

```json
{
  "v": 3,
  "schemaUrl": "https://github.com/open-telemetry/semantic-conventions-genai/tree/8ffdf56",
  "resource": { "service.name": "harbor-support" },
  "metadata": { "ticket": "HS-2291" },
  "spans": [
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "00f067aa0ba902b7",
      "parentSpanId": "7a3f1c9e2b4d6081",
      "name": "invoke_agent support",
      "kind": "INTERNAL",
      "startTimeUnixNano": "1790157982008000000",
      "endTimeUnixNano": "1790157985520000000",
      "attributes": {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "support",
        "gen_ai.conversation.id": "conv_7Qm2",
        "gen_ai.input.messages": [],
        "gen_ai.output.messages": [
          { "role": "assistant", "finish_reason": "stop", "parts": [
            { "type": "reasoning", "content_sha256": "#e4.c1.think" },
            { "type": "tool_call", "id": "call_e4_1", "name": "issue_refund", "arguments": { "content_sha256": "#e3.c1.args" } },
            { "type": "reasoning", "content_sha256": "#e4.c2.think" },
            { "type": "text", "content_sha256": "#e4.c2.text" }
          ] }
        ],
        "gen_ai.usage.input_tokens": 6491,
        "gen_ai.usage.cache_read.input_tokens": 6016,
        "gen_ai.usage.output_tokens": 115,
        "gen_ai.usage.reasoning.output_tokens": 37,
        "theorem.usage.cost_usd": 0.000822,
        "theorem.stop.kind": "completed",
        "theorem.attempts": 1,
        "theorem.steps": 2,
        "theorem.record.include": ["upstreamLog", "outboundWire", "usage", "guardrailDecisions"],
        "theorem.record.scrub": ["sensitive", "injection", "canary"]
      },
      "events": [
        { "name": "theorem.stage", "timeUnixNano": "1790157982008500000", "attributes": { "stage": "pre_turn", "affordance": [] } },
        { "name": "theorem.stage", "timeUnixNano": "1790157985516000000", "attributes": { "stage": "before_end", "affordance": [] } },
        { "name": "theorem.stage", "timeUnixNano": "1790157985518000000", "attributes": { "stage": "post_turn", "affordance": [] } }
      ],
      "links": [
        { "traceId": "a3ce929d0e0e47364bf92f3577b34da6", "spanId": "53995c3f42cd8ad8", "attributes": { "theorem.link.kind": "resume", "theorem.stop.kind": "gate" } }
      ],
      "status": { "code": "OK" }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "c1e4f07a2d9b6e10",
      "parentSpanId": "00f067aa0ba902b7",
      "name": "chat google/gemini-3.8-flash",
      "kind": "CLIENT",
      "startTimeUnixNano": "1790157982009000000",
      "endTimeUnixNano": "1790157983402000000",
      "attributes": {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openrouter",
        "gen_ai.request.model": "google/gemini-3.8-flash",
        "gen_ai.response.model": "google/gemini-3.8-flash",
        "gen_ai.request.stream": true,
        "gen_ai.request.reasoning.level": "low",
        "gen_ai.request.max_tokens": 4096,
        "gen_ai.response.id": "gen-1790157982-Qk3xv",
        "gen_ai.response.finish_reasons": ["tool_calls"],
        "gen_ai.response.time_to_first_chunk": 0.402,
        "gen_ai.system_instructions": [{ "type": "text", "content_sha256": "#sys.support" }],
        "gen_ai.tool.definitions": { "content_sha256": "#tools.support" },
        "theorem.request.builtins": [],
        "gen_ai.input.messages": [
          { "role": "user", "parts": [{ "type": "text", "content_sha256": "#e1.u" }] },
          { "role": "…", "parts": ["… every E1–E3 message by hash, in order …"] },
          { "role": "assistant", "parts": [{ "type": "tool_call", "id": "call_e3_1", "name": "issue_refund", "arguments": { "content_sha256": "#e3.c1.args" } }] },
          { "role": "tool", "parts": [{ "type": "tool_call_response", "id": "call_e3_1", "response": { "content_sha256": "#e4.t1.failure" } }] }
        ],
        "gen_ai.output.messages": [
          { "role": "assistant", "finish_reason": "tool_call", "parts": [
            { "type": "reasoning", "content_sha256": "#e4.c1.think" },
            { "type": "tool_call", "id": "call_e4_1", "name": "issue_refund", "arguments": { "content_sha256": "#e3.c1.args" } }
          ] }
        ],
        "gen_ai.output.type": "text",
        "gen_ai.usage.input_tokens": 3190,
        "gen_ai.usage.cache_read.input_tokens": 2944,
        "gen_ai.usage.output_tokens": 44,
        "gen_ai.usage.reasoning.output_tokens": 22,
        "theorem.usage.cost_usd": 0.000377,
        "theorem.stop.kind": "tool",
        "theorem.model.id": "flash",
        "theorem.step": 1,
        "theorem.attempt": 1,
        "theorem.key_slot": "primary"
      },
      "events": [
        { "name": "theorem.upstream.row", "timeUnixNano": "1790157982412000000", "attributes": { "row": { "json_sha256": "#e4.c1.row1" } } },
        { "name": "theorem.upstream.row", "timeUnixNano": "1790157983399000000", "attributes": { "row": { "json_sha256": "#e4.c1.row9" } } }
      ],
      "links": [],
      "status": { "code": "OK" }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "d2a90c55e1f37b48",
      "parentSpanId": "c1e4f07a2d9b6e10",
      "name": "POST",
      "kind": "CLIENT",
      "startTimeUnixNano": "1790157982010000000",
      "endTimeUnixNano": "1790157983401000000",
      "attributes": {
        "http.request.method": "POST",
        "server.address": "openrouter.ai",
        "url.path": "/api/v1/chat/completions",
        "http.response.status_code": 200,
        "http.request.resend_count": 0,
        "theorem.key_slot": "primary"
      },
      "events": [
        { "name": "theorem.wire.request", "timeUnixNano": "1790157982010000000", "attributes": { "body": { "json_sha256": "#e4.c1.wire" } } }
      ],
      "links": [],
      "status": { "code": "OK" }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "e5b1a7c3940d2f61",
      "parentSpanId": "00f067aa0ba902b7",
      "name": "execute_tool issue_refund",
      "kind": "INTERNAL",
      "startTimeUnixNano": "1790157983404000000",
      "endTimeUnixNano": "1790157984260000000",
      "attributes": {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "issue_refund",
        "gen_ai.tool.call.id": "call_e4_1",
        "gen_ai.tool.type": "function",
        "theorem.step": 1,
        "gen_ai.tool.call.arguments": { "content_sha256": "#e3.c1.args" },
        "gen_ai.tool.call.result": { "content_sha256": "#e4.t2.result" },
        "theorem.tool.data": { "json_sha256": "#e4.t2.data" },
        "theorem.tool.outcome": "ok",
        "theorem.tool.origin": "http",
        "theorem.tool.permission": "session_consent"
      },
      "events": [
        { "name": "theorem.stage", "timeUnixNano": "1790157983405000000", "attributes": { "stage": "pre_tool", "affordance": [] } },
        { "name": "theorem.stage", "timeUnixNano": "1790157984259000000", "attributes": { "stage": "post_tool", "affordance": [] } }
      ],
      "links": [],
      "status": { "code": "OK" }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "f60c2b8e7a1d5394",
      "parentSpanId": "00f067aa0ba902b7",
      "name": "chat google/gemini-3.8-flash",
      "kind": "CLIENT",
      "startTimeUnixNano": "1790157984262000000",
      "endTimeUnixNano": "1790157985515000000",
      "attributes": {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openrouter",
        "gen_ai.request.model": "google/gemini-3.8-flash",
        "gen_ai.response.model": "google/gemini-3.8-flash",
        "gen_ai.request.stream": true,
        "gen_ai.request.reasoning.level": "low",
        "gen_ai.request.max_tokens": 4096,
        "gen_ai.response.id": "gen-1790157984-Z8m1p",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.response.time_to_first_chunk": 0.377,
        "gen_ai.system_instructions": [{ "type": "text", "content_sha256": "#sys.support" }],
        "gen_ai.tool.definitions": { "content_sha256": "#tools.support" },
        "theorem.request.builtins": [],
        "gen_ai.input.messages": ["… the chat above's input, then its output message, then:",
          { "role": "tool", "parts": [{ "type": "tool_call_response", "id": "call_e4_1", "response": { "content_sha256": "#e4.t2.result" } }] }
        ],
        "gen_ai.output.messages": [
          { "role": "assistant", "finish_reason": "stop", "parts": [
            { "type": "reasoning", "content_sha256": "#e4.c2.think" },
            { "type": "text", "content_sha256": "#e4.c2.text" }
          ] }
        ],
        "gen_ai.output.type": "text",
        "gen_ai.usage.input_tokens": 3301,
        "gen_ai.usage.cache_read.input_tokens": 3072,
        "gen_ai.usage.output_tokens": 71,
        "gen_ai.usage.reasoning.output_tokens": 15,
        "theorem.usage.cost_usd": 0.000445,
        "theorem.stop.kind": "completed",
        "theorem.model.id": "flash",
        "theorem.step": 2,
        "theorem.attempt": 1,
        "theorem.key_slot": "primary"
      },
      "events": ["… one theorem.upstream.row per provider row …"],
      "links": [],
      "status": { "code": "OK" }
    },
    {
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "spanId": "0a7d3e9c51b8f246",
      "parentSpanId": "f60c2b8e7a1d5394",
      "name": "POST",
      "kind": "CLIENT",
      "startTimeUnixNano": "1790157984263000000",
      "endTimeUnixNano": "1790157985514000000",
      "attributes": {
        "http.request.method": "POST",
        "server.address": "openrouter.ai",
        "url.path": "/api/v1/chat/completions",
        "http.response.status_code": 200,
        "http.request.resend_count": 0,
        "theorem.key_slot": "primary"
      },
      "events": [
        { "name": "theorem.wire.request", "timeUnixNano": "1790157984263000000", "attributes": { "body": { "json_sha256": "#e4.c2.wire" } } }
      ],
      "links": [],
      "status": { "code": "OK" }
    }
  ],
  "content": {
    "#sys.support": "You are Harbor Outfitters' support agent. …",
    "#tools.support": "[{\"name\":\"lookup_order\",…},{\"name\":\"issue_refund\",…}]",
    "#e3.c1.args": "{\"order_id\":\"A1042\",\"amount\":38.00,\"currency\":\"USD\"}",
    "#e4.t1.failure": "Tool issue_refund failed: the payment service did not respond. No refund was issued.",
    "#e4.t2.data": "{\"refund_id\":\"rf_88Kd2\",\"status\":\"succeeded\",\"amount\":38.00,\"currency\":\"USD\"}",
    "#e4.t2.result": "{\"refund_id\":\"rf_88Kd2\",\"status\":\"succeeded\",\"amount\":38.00,\"currency\":\"USD\"}",
    "#e4.c2.text": "Done — your $38.00 refund (rf_88Kd2) went through. It usually shows on your card in 3–5 business days.",
    "…": "every other hash the spans reference, E1–E3 history included"
  }
}
```

- The call the model retries in record B runs without a gate: the host granted `issue_refund` for the session. It carries no `theorem.tool.approved`, because no gated call was resumed.
- Record B's turn took 3.5 s; the 10 s timeout is on record A, in the same trace.

Root sum check: input 3,190 + 3,301 = 6,491. Cache read 2,944 + 3,072 = 6,016. Output 44 + 71 = 115. Reasoning 22 + 15 = 37. Cost 0.000377 + 0.000445 = 0.000822.

### 4.5 E5: injection in a tool result, taint gate

```
invoke_agent support                          [0.000 → 6.140]  OK  stop=completed
├─ chat … step 1                              tool_calls: track_shipment ×2
├─ execute_tool track_shipment  (A1042-R)     [1.402 → 2.110]  OK  origin=http
├─ execute_tool track_shipment  (A1077)       [2.112 → 2.960]  OK  origin=http
│    events: theorem.guardrail { stage: "tool_result", trust: "untrusted", action: "redact",
│              hits: [{ rule: "tool_result.redacted", severity: "medium" },
│                     { rule: "tool_result.names-callable-tool", severity: "high" },
│                     { rule: "tool_result.imperative", severity: "medium" }],
│              provenance: { origin: "http", tool: "track_shipment", depth: 1 } }
├─ chat … step 2                              tool_call: send_email (to: an external address)
├─ execute_tool send_email                    [4.001 → 4.003]  UNSET  outcome=denied
│    events: theorem.guardrail { stage: "tool_call", trust: "untrusted", action: "block",
│              hits: [{ rule: "tool_call.steered-turn", severity: "high" }],
│              provenance: { origin: "http", tool: "send_email", depth: 1 } }
└─ chat … step 3                              text answer
```

- The tools run **in sequence**: the kernel executes a step's calls one at a time, by contract (`stages.md`, same-round batch rules). Concurrent execution is an open design question in [#19](https://github.com/masudl-hub/theoremai/issues/19). If it lands, the only change here is that these `execute_tool` spans overlap in time; the record shape stays the same.
- **The result guardrail:** `redact` because scrubbing changed the text the model reads. The directive hits say the result named a callable tool and gave an order. The raw output is `theorem.tool.data`; what the model read is `gen_ai.tool.call.result`. Comparing the two shows exactly what changed.
- **The taint gate:** the turn had read remote content, and the profile refuses writes after that (`afterRemoteRead: "write"`). The rule is `steered-turn` rather than `tainted-turn` because that content also looked directive. The span is `UNSET` with outcome `denied`: policy stopped it, and the tool did not fail.
- The denied `send_email` records its arguments by hash, and its `gen_ai.tool.call.result` holds the refusal the model read. So "what did the injected model try to do, and what did it hear back" has an exact answer.
- Matched text is absent from the hits because this profile does not include `guardrailMatchPreview`.

### 4.6 E6: provider-run search, continuation, grounding

```
invoke_agent support.research                 [0.000 → 7.380]  OK  cost absent (Google reports none)
├─ generate_content gemini-3.8-flash step 1   [0.003 → 4.120]  OK  status=requires_action
│    output parts: server_tool_call google_search { queries: ["Ridgeline 2 snow load rating", …] }
│                  (theorem.observed_end 1.004)
│                  server_tool_call_response google_search { search_suggestions: "#e6.chips" } (theorem.observed_end 1.980)
│                  tool_call lookup_order
│    usage: input 1,944 (text 1,944) output 156 (reasoning 88)
│           theorem.usage.grounding [{ type: google_search, count: 1, search_query_count: 2 }]
│    events: theorem.grounding { sources: [] , search_html: "#e6.chips" }
├─ execute_tool lookup_order                  [4.122 → 4.170]  OK
└─ generate_content gemini-3.8-flash step 2   [4.172 → 7.371]  OK  status=completed
     gen_ai.request.previous_response.id = "v1_ChdwS…"   theorem.input.sent_from = 3
     output parts: text "#e6.c2.text"
     usage: input 2,410 (text 2,410; tool_use 0) output 188 (reasoning 102)
     events: theorem.grounding { sources: [{ type: web, uri, title: "ridgeline.example" }, …] }
             theorem.grounding { provider: "google", annotations: [{ type: url_citation, start_index: 0, end_index: 187, url, title }] }
```

- Citation annotations are recorded on a `theorem.grounding` event, not on the text part. Their offsets index the call's output text.
- A server tool part has only `theorem.observed_end`: the kernel sees a step once it is whole. The earlier rows' arrival times are on the `theorem.upstream.row` events.

Root `gen_ai.usage.input_tokens` is 4,354 and `gen_ai.usage.text.input_tokens` is 4,354. Per-modality counts sum only when **every** call reported them. Otherwise the root omits that modality.

### 4.7 E7: malformed arguments, then a specialist in its own record

```
record A (trace T7)
invoke_agent support                          OK
├─ chat … step 1        tool_call draft_email, arguments: raw string "{\"to\": \"warranty@ridgeline" (truncated JSON)
├─ execute_tool draft_email                   ERROR  error.type=bad_response  failure.code=malformed_arguments  (arguments hash = the raw string)
├─ chat … step 2        tool_call draft_email (valid)
├─ execute_tool draft_email   spanId=9c3e…    OK
└─ chat … step 3        text

record B (trace T7, written by the host's writer run)
invoke_agent writer     parentSpanId=9c3e…    OK
└─ chat … step 1        text (the draft)
```

- **How it links:** the tool's handler context passes `traceparent` naming span `9c3e…`, and the host passes it to the specialist's `runTurn`.
- **Usage:** record A's root sums only A's chats. The trace total is the sum of every `chat` span in trace T7.

### 4.8 E8: compaction

```
invoke_agent support                          OK  gen_ai.conversation.compacted=true
│  events: theorem.compaction { timing: "before", meter: "input", budget: 32000, threshold: 0.75,
│            tokens_before: 24310, unknown_media: 0, needed: true, compacted: true,
│            messages_before: 41, messages_after: 9, summary: "#e8.summary" }
├─ invoke_agent support.compact               OK
│  └─ chat … step 1                           input 24,310 output 612
└─ chat … step 1        input.messages = [summary, last 8 messages, new input]
```

- The compaction agent is nested in the same record, because the same runtime started it. Its usage is its own; the parent's root sums only the parent's calls.
- **Every decision is recorded, not only the compactions.** A turn that checked and did not need to compact carries `theorem.compaction { …, needed: false }`. When compaction was needed but nothing could be folded, it carries `compacted: false`.
- `unknown_media` counts media parts left out of `tokens_before` because no verified rule counts them. Both are present only when the meter had a count. With `meter: "input"` and no previous count they are absent rather than 0.
- `trigger: "custom"` appears when the profile decides with its own trigger function.
- With `timing: "after"` the event is on the turn that finished, and the next turn compacts.

### 4.9 E9: cancelled mid-stream

```
invoke_agent support                          UNSET  stop=cancelled
├─ chat … step 1        OK     input 5,120 output 36 cost 0.000402
├─ execute_tool lookup_order   OK
└─ chat … step 2        UNSET  stop=cancelled, after 1.140 s of text
     output.messages: the text received before the cancel (no finish_reason; response.status absent)
     usage: input 5,301 (theorem.usage.estimated ["input", "output"]), output 214 (estimated), no cost
```

Root: `theorem.usage.cost_usd` = 0.000402 and `theorem.usage.cost_partial` = true. `theorem.usage.estimated` = `["input", "output"]`.

### 4.10 E10: structured output repair

```
invoke_agent support.summary                  OK  theorem.attempts=2
│  events: theorem.attempt.retry { attempt: 2, reason: "validation" }
├─ chat … step 1  attempt 1   output.type=json   output text "#e10.a1" (invalid)
└─ chat … step 1  attempt 2   output.type=json   output text "#e10.a2" (valid ticket_summary)
```

The retry event says only why a new attempt started. What failed validation is attempt 1's output text (`#e10.a1`), so the reason is readable from the record without a second copy.

### 4.11 E11: provider failure

```
invoke_agent support                          ERROR unavailable  stop=provider_error  error.type=unavailable
│                                             theorem.error.public="#e11.public"
└─ chat … step 1                              ERROR unavailable  stop=provider_error  error.type=unavailable
   ├─ POST  ERROR 502   resend_count=0
   ├─ POST  ERROR 502   resend_count=1  backoff_ms=500
   └─ POST  ERROR 503   resend_count=2  backoff_ms=1000
   events: exception { exception.type: "TheoremError", exception.message: "#e11.internal" }
```

- **Public vs internal:** `error.type` is the builder's kind; `theorem.error.public` is what the caller received, the kind's wording from the profile's lexicon. The call's `exception.message` is the provider's own message. Both are stored by hash under the scrub.
- **Where the status lives:** each `POST` carries its own status and the provider's error body as a `theorem.upstream.row`. The call's `error.type` is the kind that status maps to (`503` → `unavailable`).
- **No usage:** the chat has no `gen_ai.usage.*` at all. Nothing was reported, and a failed call is not estimated (step 1 rule). The root has none either, so the turn's usage reads as unknown, not 0.

### 4.12 E12: Live voice session

A session writes each record as soon as it is complete, so a long session never holds its whole trace in memory. All records share the session's trace and clock.

```
record R1 (written at its turnComplete)                  parent = session span
generate_content gemini-3.1-flash-live-preview  step 1   [2.100 → 6.410]  OK  stop=generation_complete
│  output.type: speech
│  input.messages:  user: blob audio "#e12.in1"          (one part over the contiguous audio chunks sent)
│                   user: text "#e12.in1.heard"          (theorem.source: input_transcription)
│  output.messages: blob audio "#e12.out1"; text "#e12.out1.said" (theorem.source: output_transcription);
│                   tool_call lookup_order
│  theorem.output.delivered: the same parts, as the host received them after guardrails
│  usage: input 3,402 (audio 70, text 3,332) output 41 (audio 33, text 8)
│  events: theorem.wire.request per frame at its send time; theorem.upstream.row per server frame
│
└─ record T1 (written when the call settles)             parent = R1's span
   execute_tool lookup_order                             OK

record R2 (written at its turnComplete)                  parent = session span
generate_content …  step 2                               [6.380 → 9.870]  OK  stop=generation_complete
   input.messages:  tool: tool_call_response "#e12.t1.result"   (sent as R1 completed; R2 reads it)
   output.messages: blob audio "#e12.out2"; text "#e12.out2.said"
   events: theorem.wire.request { the toolResponse frame } at its send time

record R3 (written at its turnComplete)                  parent = session span
generate_content …  step 3                               UNSET  stop=interrupted
   output.messages: the audio and transcript produced before the barge-in; no finish_reason
   usage: as reported (Live reports per response); estimated sides listed when it did not report

record S (written at close)                              parent = the host's traceparent
invoke_agent support.voice                               [0.000 → 48.200]  OK  theorem.steps=3
   gen_ai.usage.* = sum of R1, R2 and R3
   events: theorem.wire.request { setup frame }; theorem.upstream.row { setupComplete }
           theorem.session { kind: "setup_complete" }
           theorem.session { kind: "voice_activity", activity, audio_offset }
           theorem.session { kind: "session_resumption", resumable: true, handle_issued: true }
           theorem.session { kind: "closed", code: 1000, reason: "", initiator: "host" }
```

- **Response boundaries:** a response record opens at its first response-scoped event and closes at the provider's `turnComplete`. Each `done` the host receives carries the response span's `traceparent`.
- **Input is new input only.** A response's `input.messages` holds what was sent since the previous response opened: realtime audio, text and tool responses. A tool response belongs to the response after the one that asked: Live completes the asking response as the result lands and answers in a new one. It is never the whole session: with sliding-window compression the provider drops earlier context, so what the model read of the session is unknowable.
- **Transcripts are labeled.** `theorem.source` says a text part is the provider's transcript, not something anyone typed. Speech heard after the model began answering is input for the next response.
- **What the host received.** `theorem.output.delivered` on each response is its output as the host received it, after guardrails, beside `output.messages` (what the model produced). A transcript of the user's speech is input, so it stays on `input.messages`.
- **Tool calls** each write their own record under the response that asked for them. A call the provider cancels is a `theorem.tool.cancel { gen_ai.tool.call.id, gen_ai.tool.name }` event on the response.
- **Session events** (`theorem.session`) cover `key_overflow { key_slot, to_key_slot, error.type, error }` (setup on the pinned key was refused for quota and the session opened on `paid`, which its responses then name as `theorem.key_slot`), `setup_complete`, `session_resumption`, `voice_activity`, `closing_soon` (with `time_left_ms` when the provider gives one), `waiting_for_input`, `working`, `idle` and `closed { code, reason, initiator }`. `initiator` is `host`, `provider` or `theorem`. A provider close carries `error.type` (what its code means as a failure) when the code is not 1000, and, after a `goAway`, `cause: go_away`, `time_left_ms` and `closed_after_ms`.
- **The resumption handle is a credential.** Frames are recorded without it, `theorem.request.live` records only `resumed`, and events record only that a handle was issued.
- **Status:** the session is `ERROR` when it threw or the provider closed it with a code other than 1000 (`error.type` is the kind: a reason naming a quota `rate_limit`, else 1006 `network`, 1007 / 1008 `unsupported`, others `unavailable`), `UNSET` with `theorem.stop.kind=cancelled` when the host aborted it, `UNSET` with `theorem.stop.kind=go_away` when the provider closed it after warning it would (any code; no verdict, so a planned end neither alarms nor passes as fine), and `OK` otherwise.
- If the Worker is evicted mid-session, R1, T1, R2 and R3 survive and record S is missing. A viewer shows a trace without its root, which is honest. Every response and tool record carries `gen_ai.agent.name` and `gen_ai.conversation.id` itself, so each one still says whose it is.

## 5. Questions the traces answer

| Question | Answered by |
|---|---|
| What exactly did the model see on call N of turn T? | that `chat` span's `system_instructions` + `tool.definitions` + `input.messages` → `content` |
| What exactly was sent on the wire? | `theorem.wire.request` on each `POST` (on the response for Live), interned body → `content` |
| What did the user see vs what the model produced? | `invoke_agent` `output.messages` (what the host received) vs each call's `output.messages` (what the model produced); guardrail events say which rule withheld or rewrote what, and where |
| Cost of a conversation / user / day | sum `theorem.usage.cost_usd` over `chat` spans filtered by `gen_ai.conversation.id` / `metadata` / time; `partial` and absent costs are counted separately |
| Tokens by model, provider, modality, cache hit rate | `chat` span `gen_ai.usage.*` grouped by `request.model` / `provider.name` |
| How much of the total is estimated? | `theorem.usage.estimated` per call |
| Latency: time to first chunk, p95 per tool, hook overhead, retry cost | `response.time_to_first_chunk`; `execute_tool` durations; `hook_ms` on `theorem.stage`; HTTP try spans and `backoff_ms` |
| Why did approving the refund take 13.5 s? | the trace waterfall: record A's 10 s tool timeout, then record B (E4) |
| Which tool results carried injections, and what did the model try next? | `theorem.guardrail` (stage `tool_result`) on `execute_tool` + the following call's output + `denied` spans with a `tool_call` guardrail |
| Which turns needed a repair, and why? | `theorem.attempts > 1` + `theorem.attempt.retry.reason` |
| What did a specialist cost the turn that called it? | the trace's `invoke_agent` subtrees, joined by `traceId` / `parentSpanId` |
| When was context compacted, what replaced it, and why? | `theorem.compaction` (the decision, every turn) + its `summary` hash |
| Which searches grounded an answer, and what did they cite? | `server_tool_call` parts + `theorem.grounding` (`sources`, `annotations`) |
| Did this answer follow a pause/approval? | root `links` (`resume`) + `theorem.tool.approved` on the resumed call |
| Error rate by provider / status code / kind | HTTP try spans `http.response.status_code`; `chat` and `execute_tool` `error.type` (the kind) |
| Was this recorded at all? | `theorem.record.include` / `scrub` on the root |
| What was the model asked to do beyond the prompt? | `theorem.request.*` (builtins, store, structured, image, speech, live) |
| Why did a Live session end? | `theorem.session { kind: "closed", code, reason, initiator }` |

## 6. Honest limits

- **Provider-run tools:** their timing is only arrival times (`theorem.observed_end` and the row events). Google does not report execution time.
- **Cloudflare Workers:** clocks advance only at I/O (`theorem.clock=io`).
- **Scrubbed text:** a hash covers the scrubbed text, so exact original bytes are unrecoverable when scrub is on (by policy). Offsets on guardrail events say where text changed.
- **Missing counts:** estimated counts are labeled per side, and media with no known rule is `unknown_media`, never a guess.
- **Evicted session:** a Live session whose worker is evicted has no root record.
- **Live response start:** a response opens at its first pending input frame, so its duration includes the time the model spent listening.
- **Live after close:** the session record is sealed when the host closes the session; frames that arrive after that are not recorded.
- **Live estimates under compression:** when Live reports no usage, the input estimate counts the context held since the session began. Under sliding-window compression the provider has dropped some of it, so that estimate is high. It is labeled `theorem.usage.estimated`, never presented as reported.

## 7. Choices made here (follow from the invariant; flag any you disagree with)

1. **One `POST` span per HTTP try, always.** Retries, backoff and key rotation are visible, and the shape is the same whether or not a retry happened.
2. **Wire body and upstream rows kept, interned.** Every string equal to a known content text becomes its hash, so the wire is exactly reconstructable without storing text twice. Stream deltas stay inline, because their arrival times are the latency data.
3. **Attempts are an attribute plus a retry event, not a span.** Viewers stay flat; nothing is lost.
4. **Provider-run tools are output parts, not `execute_tool` spans**, per semconv. Theorem did not run them, so it cannot time them.
5. **Agent usage covers its own calls only.** Totals across nested agents come from summing `chat` spans in the trace, so there is one owner per count and no double counting.
6. **Per-modality usage on a root appears only when every call reported it.** A partial sum would look precise and be wrong.
7. **v2's `title` (the first 80 characters of the input) is dropped.** It was a display cap; readers derive a title from `content`.
8. **Records are self-contained** (`content` holds every referenced hash); sinks deduplicate by hash.
9. **A reference names its kind** (`content_sha256` for text, `json_sha256` for JSON). Both are stored in `content`, so without the kind a reader could not tell a JSON document from text that happens to be JSON. Added 23/09/2026 with the OTLP export.
10. **OTLP export puts `metadata` on the record's top span as `theorem.metadata.<key>`.** OTLP has no record-level slot (the resource is the service's identity), and a viewer can filter on span attributes. Blob bytes are not exported; they were never stored.
11. **`theorem.tool.approved`** records that the host resumed a gated call with approval (`true`) or refusal (`false`). The approval itself belongs to the host; Theorem records only the answer the resumed call carried.
