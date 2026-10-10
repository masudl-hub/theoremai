# Observability (`@theoremjs/agents/observability`)

Trace sinks, destination registry, and profile observability policy. THEOREM
does not own a database, does not read trace-related environment variables for
destinations, and never lets tracing fail a turn. Hosts that need a signal when
sinks die set `TraceSink.onError` or `observability.onWriteError`.

Registered model turns use the normalized `chat` operation; live responses use
`generate_content`. The provider name is the registered provider instance ID.
Native finish values on turns use `gen_ai.response.finish_reasons` rather than a
vendor-specific status attribute. Credential values resolved by an adapter are removed
at the upstream tap boundary before the existing trace scrub and content-hash policy.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/observability` / `jsr:@theoremjs/agents/observability` |
| Module | `src/observability/mod.ts` |
| File sink | `@theoremjs/agents/observability/jsonl` → `src/observability/jsonl.ts` (Node, Deno and Bun; keeps the filesystem out of browser and Worker bundles) |
| Viewer attributes | `@theoremjs/agents/observability/openinference` → `src/observability/openinference.ts` (optional) |
| Viewer annotations | `@theoremjs/agents/observability/phoenix` → `src/observability/phoenix.ts` (optional) |

## Ownership

| Path | Role |
| --- | --- |
| `src/observability/types.ts` | `ProfileObservabilitySpec` + resolved policy shapes |
| `src/observability/resolve-policy.ts` | `resolveObservabilityPolicy` (pure defaults; no sinks) |
| `src/observability/policy.ts` | `resolveTraceWriter` (writer precedence, per-trace sampling) |
| `src/observability/destinations.ts` | Named destination registry |
| `src/observability/trace-sink.ts` | `TraceSink` contract (type-only) |
| `src/observability/trace.ts` | `memorySink`, `noopSink`, `writeTrace` |
| `src/observability/jsonl.ts` | `jsonlSink` (daily rotating JSONL files; its own export) |
| `src/observability/trace-span.ts` | Span builder (`startTrace`), content markers, `traceparent` helpers |
| `src/observability/trace-record.ts` | `TraceRecord` shape, `buildRecord` (scrub + include), `contentOf`, `inlineContent` |
| `src/observability/otlp.ts` | `toOtlpJson` (records → OTLP/JSON request) |
| `src/observability/openinference.ts` | `withOpenInference` (opt-in viewer attributes; its own export) |
| `src/observability/phoenix.ts` | `phoenixAnnotations` (eval results as Phoenix span annotations; its own export) |
| `src/observability/spans.ts` | Redaction spans shared with guardrails (`applySpans`, `spansFromPatterns`) |

## Profile observability

Declare policy on the profile. Prefer a host-registered destination id; pass a
`TraceSink` only for tests or custom exporters.

```ts
registerTraceDestination('prod', jsonlSink('/var/log/theorem'));

defineProfile({
  // …
  observability: {
    writeTo: 'prod',
    sampleRate: 1,
    resource: { 'service.name': 'harbor-support' },
    include: {
      upstreamLog: true,
      outboundWire: false,
      evidenceRaw: false,
      usage: true,
      guardrailDecisions: true,
      guardrailMatchPreview: false,
    },
    scrub: {
      sensitive: true,
      injection: true,
      canary: true,
    },
    retainForDays: 14,
    rotateAfterMiB: 32,
    onWriteError: (err) => hostLog.warn('trace write failed', err),
  },
});
```

| Field | Meaning |
| --- | --- |
| `writeTo` | `false` = off; `string` = registered id; `TraceSink` = inline writer |
| `sampleRate` | Fraction of traces to record (0–1). Default 1. Decided by trace id, so every record of one trace is kept or dropped together. Ignored when a writer receives an explicit sink |
| `resource` | Process attributes stamped on every record (`TraceRecord.resource`). Default `{}` |
| `include.*` | Which attribute and event families land in a record (table below) |
| `scrub.*` | Scrubbing of **stored** text, with the detectors `guardrails.detect` declares and whatever action they take ([Scrub](#scrub)) |
| `retainForDays` | Days to keep each record. Handed to every destination with the record (`TraceWriteContext`), including an explicit sink. `<= 0` keeps records forever. Default 14 |
| `rotateAfterMiB` | File size before a file-based destination starts a new file. Handed to every destination with the record (`TraceWriteContext`). Default 32 |
| `onWriteError` | Host hook on build/write failure (never fails the turn) |

| Include flag | Default | Governs |
| --- | --- | --- |
| `upstreamLog` | on | `theorem.upstream.row` events (scrubbed provider rows and frames) |
| `outboundWire` | off when authored | `theorem.wire.request` events (scrubbed outbound request bodies) |
| `evidenceRaw` | off when authored | `raw` on `theorem.grounding` events; normalized sources stay |
| `usage` | on | `gen_ai.usage.*` and `theorem.usage.*` attributes |
| `guardrailDecisions` | on | `theorem.guardrail` events |
| `guardrailMatchPreview` | off | `match` on guardrail hits, in the trace and the live stream |

Omit the whole `observability` block → no recording (noop). The only way a turn
without an authored block records is an explicit sink (tests, one-off capture);
that capture keeps `outboundWire` and `evidenceRaw`. `resolveObservabilityPolicy`
maps author-provided values to fully resolved settings; every writer resolves
through it.

Sampling reads the low 32 bits of the root span's trace id (OpenTelemetry
`TraceIdRatioBased`). A turn, its specialists, a Live session's response and
tool records, an `invokeTool` record and a host cutout that share one trace are
therefore kept or dropped whole, in any process.

### Scrub

`scrub` cleans stored text with the same detectors the turn reads with
(`guardrails.detect`): a match is replaced by the placeholder `redact` leaves.
It ignores their actions, so a detector set to `ignore` in the turn still
cleans the trace: a host-confidential store must not accidentally inherit a
debug-off switch.

| Switch | Cleans with |
| --- | --- |
| `sensitive` | `ids`, `financial`, `network`, `credentials` and every detector of the host's own |
| `injection` | `injection` and `tool_instructions` |
| `canary` | The canaries bound in the record |

Each switch is a `ScrubSwitch` and says whose patterns clean the trace, apart
from the turn. The patterns are written once, on the detector.

| Value | The stored trace is cleaned with |
| --- | --- |
| `true` (default) | What each detector reads the turn with: Theorem's patterns, the host's or both |
| `{ theorem: false }` | The host's patterns and detectors only |
| `{ host: false }` | Theorem's patterns only |
| `{ theorem: true, host: true }` | Both, whatever the turn reads with |
| `false` | Nothing |

A side left out of the object is on. The canary is Theorem's alone, so
`canary: { theorem: false }` keeps it. A host detector's `find` reads stored
text too, with no `boundary`; a text it throws on is stored as `[omitted]`.
`buildRecord` reads the host's patterns from `policy.detect`, which
`resolveTraceWriter` fills from the profile; without it Theorem's patterns
clean the record alone.

### Resolution order

1. Explicit sink (`runTurn(request, provider, sink)`, `invokeTool(request, sink)`,
   `runSession(request, options, sink)`) — sink wins, no sampling (deterministic capture).
2. Else `profile.observability.writeTo` via `resolveTraceWriter`, sampled by trace id.
3. Else noop.

```ts
for await (const event of runTurn(request, provider)) {
  // uses profile.observability
}
```

## Trace destinations

| API | Role |
| --- | --- |
| `registerTraceDestination(id, sink)` | Register a `TraceSink` under a non-empty id; anything without a `write` function throws `config` |
| `getTraceDestination` / `requireTraceDestination` | Lookup (throws `TheoremError` if unregistered) |
| `listTraceDestinationIds` / `clearTraceDestinations` | Introspection / tests |

## Trace sinks

Pass a `TraceSink` as the optional last argument to `runTurn`, `invokeTool` or
`runSession` (or as `RunDecisionOptions.sink` to `runDecision`), or resolve one
from profile policy:

```ts
for await (const event of runTurn(request, provider, jsonlSink(hostTraceDir))) {
  // …
}
```

| Sink | Behavior |
| --- | --- |
| `noopSink()` | Drop records (default when omitted and no profile writeTo) |
| `memorySink(into)` | Append `TraceRecord`s to a caller-owned array |
| `jsonlSink(dir, options?)` | Daily rotating JSONL under a host-chosen directory ([JSONL sink](#jsonl-sink)) |
| `TraceSink.onError` | Optional hook for build/write failures (never fails the turn) |

`TraceSink.write(record, context)` receives the record and its
`TraceWriteContext` — `{ retainForDays, rotateAfterMiB }` from the
observability policy of the profile that wrote it. Storage policy has one
owner: a host store computes its own expiry from `context.retainForDays` (for
example a host-defined expiry timestamp, null when `<= 0`), and the JSONL writer prunes and
rotates by the same values.

`writeTrace(sink, recordPromise, policy)` awaits the record and writes it with
the policy's write context. Errors from
record construction or the sink are forwarded to optional `sink.onError` and
never abort the turn. `writeSpans(sink, spans, policy, metadata?)` (internal)
builds a finished trace's record under the policy and writes it the same way;
tool calls and decisions write through it. Production hosts should set `onError` / `onWriteError`
(log, metric, alert) so dying disks/permissions are visible.

## JSONL sink

`jsonlSink` is its own entry point, `@theoremjs/agents/observability/jsonl`,
because it writes files through Node's `node:fs` (Node, Deno and Bun all
provide it). Browser and Worker bundles import `@theoremjs/agents` and
`@theoremjs/agents/observability` without pulling in the filesystem.

```ts
import { jsonlSink } from '@theoremjs/agents/observability/jsonl';

registerTraceDestination('prod', jsonlSink('/var/log/theorem'));
```

`jsonlSink(dir, { now? })` writes one record per line to
`turns-YYYY-MM-DD.jsonl`. On each write it:

- creates `dir` if needed, readable by the host's user only (`0700`, files `0600`);
- removes day files older than the record's `retainForDays` (`<= 0` removes nothing);
- starts `turns-YYYY-MM-DD-<ms>.jsonl` once the day file reaches the record's
  `rotateAfterMiB`.

`dir` must be absolute and outside the working directory; anything else throws
`config` when the sink is built, before any filesystem access.

## Sensitive storage

Trace records are **host-confidential**, not end-user artifacts. Spans never
carry text inline: `buildRecord` resolves every content marker once, under
`observability.scrub` (defaults on, independent of turn-path
`profile.guardrails`), then `observability.include` drops whole families.

| Marker | Stored as |
| --- | --- |
| `$content` (messages, instructions, tool arguments and results, reasoning, exception text) | Scrubbed text in `content`, referenced as `{ content_sha256 }` |
| `$bytes` (media) | `content_sha256` over the raw bytes and `bytes` length; bytes never stored. Text that is not base64 is hashed as text and marked `invalid_base64` |
| `$json` (upstream rows, wire bodies) | Media hashed, canaries removed, text scrubbed, every string equal to a recorded text replaced by `{ content_sha256 }`; the result stored in `content`, referenced as `{ json_sha256 }` |

- Credential headers are recorded as `[redacted]`; every other header is kept.
- With `scrub.canary` on for Theorem's side, every canary bound in the record
  (the turn's and any nested turn's) is removed from stored text.
- A hash identifies the text *after* scrub, so original bytes are unrecoverable
  when scrub is on.
- The root records the policy it was written under:
  `theorem.record.include` and `theorem.record.scrub` list the enabled flags,
  so a missing field reads as "not recorded", never as "did not happen".
- A record states its format as `v` (`TRACE_VERSION`, now 3);
  `traceRecordSchema` refuses any other version rather than guessing at its fields.

Restrict trace directories to the host process. Do not expose JSONL files or
`memorySink` dumps to clients. Use `forClientEvents` before any user-visible
transport.

## Trace records

A `TraceRecord` (v3) is a list of spans shaped like OTLP/JSON plus the content
they reference. Attribute names follow the OpenTelemetry GenAI semantic
conventions pinned by `schemaUrl`; names under `theorem.*` cover what semconv
has no name for.

```ts
interface TraceRecord {
  v: 3;
  schemaUrl: string;                    // pinned semconv-genai commit
  resource: TraceAttributes;            // observability.resource
  metadata?: Record<string, unknown>;   // the request's host metadata, untouched
  spans: TraceSpan[];                   // root first, then in start order
  content: Record<string, string>;      // sha256 hex → exact scrubbed text
}
```

The shape is declared once, as `traceRecordSchema` (and one schema per span
part) in `src/observability/trace-schema.ts`; the types are their inferred
types, and `trace-span.ts` and `trace-record.ts` import them. A record that
arrives over a wire (the live relay's `trace` envelope) is parsed with
`traceRecordSchema` before it is read.

| Writer | Record root | Parent of the root |
| --- | --- | --- |
| `runTurn` | `invoke_agent {profile}` — one record per turn | The request's `traceparent`, or none |
| Specialist run by a tool | Its own `invoke_agent` record | The calling `execute_tool` span |
| `invokeTool` | `execute_tool {name}` — one record per invoke | The request's `traceparent` |
| Live session | One record per model response (`{operation} {model}`), one per tool call, and the session root at close | Responses under the session root; a tool under the response that asked for it |
| `flushMintTrace` (host) | One `cutout` span | The held turn's root |

Every record of one conversation step shares a trace id, so a reader joins them
by `traceId` / `parentSpanId`; resume and continuation edges are span links. A
record is self-contained (`content` holds every hash its spans reference);
sinks may deduplicate across records by hash.

A tool call a service refused for access outside its declared scopes carries a
`theorem.auth.scope_refused` event on its `execute_tool` span: the credential
slot, the scopes the service asked for and the scopes the tool declares.

`buildRecord({ spans, policy, canaries?, metadata? })` seals the spans a
`TraceTree` collected. Hosts record their own spans with `startTrace` (content
through `traceContent`, `traceBytes`, `traceJson`). `readTraceparent(value)`
returns the trace and span ids of a `traceparent` a turn accepts, or
`undefined`, so a host checks a value from a request before handing it on.

A reference says how to read it:

| Key | Names | In `content` |
| --- | --- | --- |
| `content_sha256` on a text reference | Scrubbed text | Yes |
| `json_sha256` | Scrubbed JSON, its own strings interned as text references | Yes, as JSON text |
| `content_sha256` on a blob (beside `bytes`) | The raw bytes | No — bytes are never stored |

`contentOf(record, value)` returns the stored string behind either key.
`inlineContent(record, value)` rebuilds any value: a lone text reference
becomes its string, and beside other keys becomes `content` (the semconv part
field); a lone JSON reference becomes the parsed JSON, inlined recursively,
and beside other keys a parsed object merges under them; a blob keeps its hash.

The full span catalogue — every attribute, event, status rule and stop kind,
drawn in twelve worked traces including a Live voice session — is
[the worked example](../proposals/otel-turn-traces-example.md).

## Trace catalog

What a record holds is named and described once, in code
(`src/observability/trace-catalog.ts`), so a viewer never invents wording for
it. The studio's trace panel reads it; a host's own tooling can too.

| Lookup | Returns |
| --- | --- |
| `traceSpanMeta(span)` | `{ type, label, doc, subject? }`: what the span is (`Turn`, `Live session`, `Model call`, `Live response`, `Tool call`, `HTTP try`, `Cutout`, `Decision`, else `Host span`), decided from what it recorded, plus its subject: the agent, model, tool or path |
| `traceAttributeMeta(key)` | `{ label, doc, format, group, options?, open?, fields? }` for a span attribute, including the modality-usage and recorded-header families; `undefined` for a key Theorem does not write |
| `traceEventMeta(name)` | `{ label, doc, attributes }` for a span event |
| `traceEventAttributeMeta(event, key)` | The event's own entry for the key, else the span attribute of that key |
| `TRACE_ATTRIBUTE_GROUPS`, `TRACE_STATUS`, `TRACE_FIELDS`, `TRACE_SPAN_TYPES` | Labels for attribute groups, the three status codes, a record's and span's own fields, and the span types (`TraceSpanType`) `traceSpanMeta` returns |

`format` says how a value reads (`tokens`, `usd`, `milliseconds`, `content`,
`messages`, …). `options` describes a closed set's values and is keyed by the
kernel's own enum types, so a new stop kind, error kind, tool outcome, key
slot, guardrail stage or session kind fails the type check until it is
described; `open: true` marks a set whose other values are real and show as
is (provider names, HTTP error types). `fields` describes the keys inside an
object value (Live settings, guardrail hits, sign-in details, including the
`service` a gate names). A key with no
entry is still a real attribute: viewers show it under its raw name.

Two gates keep the catalog whole: a test scans every kernel and host source
for quoted attribute keys and event names, and the traced test suites write
through a sink that fails the file on any recorded key, event, value or
nested key the catalog cannot describe.

## OTLP export

`toOtlpJson(records)` reshapes trace records into one OTLP/JSON
`ExportTraceServiceRequest` — the body of `POST /v1/traces` — with no encoder
dependency:

- One `resourceSpans` entry per record (its `resource`), one scope named
  `@theoremjs/agents`, carrying the record's `schemaUrl`.
- Span kinds and status codes become their OTLP enum numbers; ids stay hex;
  integers become decimal-string `intValue`; objects and arrays become
  `kvlistValue` / `arrayValue`; `null` attributes are left out.
- Every reference is inlined with `inlineContent`, so a viewer reads standard
  semconv messages.

- The record's `metadata` has no record-level slot in OTLP (the resource is
  the service's identity), so each key lands on the record's top span — the
  one whose parent is outside the record — as `theorem.metadata.<key>`, where
  a viewer can filter on it.

Not exported: blob bytes (never stored; the blob keeps its hash).

A sink that exports is host code:

```ts
const otlpSink: TraceSink = {
  write: async (record) => {
    await fetch('http://127.0.0.1:4318/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpJson([record])),
    });
  },
};
```

For a backend that takes only OTLP protobuf, the host runs an OpenTelemetry
Collector that accepts OTLP/JSON over HTTP and forwards protobuf:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
exporters:
  otlp:
    endpoint: traces.example.internal:4317
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp]
```

## OpenInference attributes

Phoenix maps the GenAI semconv span kinds, models and token counts itself, but
its message views (the chat bubbles, Replay, the Input and Output columns of
the trace list), reasoning tokens and cost read only [OpenInference names](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md).
`withOpenInference(records)`, imported from
`@theoremjs/agents/observability/openinference`, returns copies whose spans
also carry:

| Span | OpenInference | From |
| --- | --- | --- |
| model call (`chat`, `generate_content`) | `llm.token_count.completion_details.reasoning` | `gen_ai.usage.reasoning.output_tokens` |
| model call | `llm.cost.total` | `theorem.usage.cost_usd`, unless `theorem.usage.cost_partial` |
| model call | `llm.input_messages.{i}.message.role` / `.content` / `.tool_calls.{k}.tool_call.*` / `.tool_call_id` | `gen_ai.system_instructions` as a `system` message first, then `gen_ai.input.messages` |
| model call | `llm.output_messages.{i}.message.*` | `gen_ai.output.messages`, else Live's `theorem.output.delivered` |
| model call and `invoke_agent` | `input.value`, `input.mime_type`, `output.value`, `output.mime_type` | The messages above (system instructions left out): one message with text is written as `text/plain`, anything else as JSON `[{role, content}]` |
| decision (`decide`) | `openinference.span.kind: LLM`, `llm.model_name`, `llm.provider`, `llm.token_count.{prompt, completion, total}` | `gen_ai.response.model` (else the requested model), `gen_ai.provider.name`, and `gen_ai.usage.*`: Phoenix derives no kind for an operation semconv does not name |
| decision | `llm.cost.total` | `theorem.usage.cost_usd` when reported by OpenRouter or priced for direct TypeSafe Jev |
| decision | `input.value` / `output.value` as `application/json` | `theorem.decision.state` and `theorem.decision.answers`, inlined; a decision has no messages, so Phoenix cannot replay it |
| `theorem.eval.trial` / `theorem.eval.run` | `openinference.span.kind: EVALUATOR` / `CHAIN` | The span name: a trial grades one turn, a run strings trials together; without a kind Phoenix lists them as `unknown` |

- A message's content is its text parts, a structured part's JSON and each
  media part named by modality (`[image]`), one per line; stored references
  are inlined. A text part that is the structured part's JSON as the model
  typed it is shown once, as the JSON. Tool calls and tool results keep their
  ids, names and arguments.
- Only model calls and decisions carry usage: a viewer sums them across a
  trace, and an agent span's usage is already the sum of its calls.
- A model call with no reported cost (Google reports none) gets no
  `llm.cost.total`; Phoenix then prices it from its own model table, for
  display only.
- A partial cost keeps only its `theorem.*` name, so it never reads as a total.
- Absent inputs stay absent; a tool span is left alone.

Export with `toOtlpJson(withOpenInference(records))`. The kernel and
`toOtlpJson` stay viewer-neutral; hosts that don't use such a viewer never load
the module.

## Phoenix annotations

Eval results travel as `gen_ai.evaluation.result` events on a
`theorem.eval.trial` span (see the evals contract). Phoenix shows them as span
events, but its Annotations column, filters and experiment views read span
annotations, which it takes over REST (`POST /v1/span_annotations`), not
OTLP. `phoenixAnnotations(records)`, imported from
`@theoremjs/agents/observability/phoenix`, builds that request's `data`: one
annotation per result, on the judged root (the trial span's parent).

| Annotation field | From |
| --- | --- |
| `span_id` | the trial span's `parentSpanId` |
| `name` | `gen_ai.evaluation.name` |
| `annotator_kind` | `LLM` when `theorem.evaluation.source` is `model`, else `CODE` |
| `result.label`, `result.score` | `gen_ai.evaluation.score.label`, `.score.value` |
| `result.explanation` | `gen_ai.evaluation.explanation`, inlined; absent when the policy did not keep it |
| `metadata` | `suite`, `case`, `trial` from the trial span; `passed`, `error_type`, `grader_version` from the event |

Records without trial spans add nothing. Phoenix keeps one annotation per span
and name, so grading a record again replaces its annotations. The module is
pure: the host posts `{ data: phoenixAnnotations(records) }` beside the
records it exports, after Phoenix has stored the spans (it refuses
annotations on spans it lacks with 404). `scripts/evals-example.ts --phoenix`
is a host doing both against `deno task phoenix:up` (`scripts/phoenix/`),
which also enters Jev's price in Phoenix's model table: Phoenix shows a cost
from that table, not from a span's `llm.cost.total`.

## Exported API

| Export | Kind |
| --- | --- |
| `TraceSink`, `TraceWriteContext` | type |
| `TraceRecord` | type |
| `TraceSpan`, `TraceSpanEvent`, `TraceSpanKind`, `TraceSpanLink`, `TraceSpanStatus` | type |
| `TraceAttributes`, `TraceAttributeValue`, `TraceContent`, `TraceBytes`, `TraceJson` | type |
| `TraceTree`, `SpanHandle`, `SpanOptions`, `SpanLinkInput`, `TraceClock` | type |
| `ProfileObservabilitySpec`, `TraceIncludeSpec`, `TraceScrubSpec`, `ScrubSwitch` | type |
| `ResolvedObservabilityPolicy`, `ResolvedTraceInclude`, `ResolvedTraceScrub`, `ResolvedScrubSwitch` | type |
| `memorySink`, `noopSink` | function |
| `jsonlSink` (from `@theoremjs/agents/observability/jsonl`) | function |
| `JsonlSinkOptions` (from `@theoremjs/agents/observability/jsonl`) | type |
| `writeTrace` | function |
| `buildRecord`, `contentOf`, `inlineContent` | function |
| `toOtlpJson` | function |
| `withOpenInference` (from `@theoremjs/agents/observability/openinference`) | function |
| `phoenixAnnotations` (from `@theoremjs/agents/observability/phoenix`) | function |
| `PhoenixSpanAnnotation` (from `@theoremjs/agents/observability/phoenix`) | type |
| `OtlpTraceRequest`, `OtlpSpan`, `OtlpKeyValue`, `OtlpAnyValue` | type |
| `startTrace`, `traceContent`, `traceBytes`, `traceJson`, `readTraceparent` | function |
| `registerTraceDestination`, `requireTraceDestination`, `getTraceDestination` | function |
| `listTraceDestinationIds`, `clearTraceDestinations` | function |
| `isTraceSink` | function |
| `resolveObservabilityPolicy`, `resolveTraceWriter` | function |
| `traceSpanMeta`, `traceAttributeMeta`, `traceEventMeta`, `traceEventAttributeMeta` | function |
| `TRACE_ATTRIBUTE_GROUPS`, `TRACE_STATUS`, `TRACE_FIELDS`, `TRACE_SPAN_TYPES` | const |
| `TraceSpanMeta`, `TraceSpanType`, `TraceAttributeMeta`, `TraceEventMeta`, `TraceOptionMeta`, `TraceAttributeGroup`, `TraceValueFormat` | type |

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/observability/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/observability/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Profile observability": {
      "supports": [
        { "kind": "source", "path": "src/observability/types.ts" },
        { "kind": "source", "path": "src/observability/resolve-policy.ts" },
        { "kind": "source", "path": "src/observability/policy.ts" },
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
      ]
    },
    "Trace destinations": {
      "supports": [
        { "kind": "source", "path": "src/observability/destinations.ts" },
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
      ]
    },
    "Trace sinks": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace.ts" },
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
      ]
    },
    "JSONL sink": {
      "supports": [
        { "kind": "source", "path": "src/observability/jsonl.ts" },
        { "kind": "contract_test", "path": "tests/observability/jsonl.test.ts" }
      ]
    },
    "Sensitive storage": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace-record.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace-record.test.ts" }
      ]
    },
    "Trace records": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace-record.ts" },
        { "kind": "source", "path": "src/observability/trace-span.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace-record.test.ts" },
        { "kind": "contract_test", "path": "tests/observability/live-trace.test.ts" },
        { "kind": "contract_test", "path": "tests/observability/tool-trace.test.ts" }
      ]
    },
    "Trace catalog": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace-catalog.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace-catalog.test.ts" },
        { "kind": "contract_test", "path": "tests/observability/live-trace.test.ts" }
      ]
    },
    "OTLP export": {
      "supports": [
        { "kind": "source", "path": "src/observability/otlp.ts" },
        { "kind": "contract_test", "path": "tests/observability/otlp.test.ts" }
      ]
    },
    "OpenInference attributes": {
      "supports": [
        { "kind": "source", "path": "src/observability/openinference.ts" },
        { "kind": "contract_test", "path": "tests/observability/openinference.test.ts" }
      ]
    },
    "Phoenix annotations": {
      "supports": [
        { "kind": "source", "path": "src/observability/phoenix.ts" },
        { "kind": "contract_test", "path": "tests/observability/phoenix.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/observability/mod.ts" },
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
      ]
    }
  }
}
```
