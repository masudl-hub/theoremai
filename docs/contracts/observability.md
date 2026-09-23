# Observability (`@theoremai/agents/observability`)

Trace sinks, destination registry, and profile observability policy. THEOREM
does not own a database, does not read trace-related environment variables for
destinations, and never lets tracing fail a turn. Hosts that need a signal when
sinks die set `TraceSink.onError` or `observability.onWriteError`.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremai/agents/observability` / `jsr:@theoremai/agents/observability` |
| Module | `src/observability/mod.ts` |
| Viewer attributes | `@theoremai/agents/observability/openinference` → `src/observability/openinference.ts` (optional) |

## Ownership

| Path | Role |
| --- | --- |
| `src/observability/types.ts` | `ProfileObservabilitySpec` + resolved policy shapes |
| `src/observability/resolve-policy.ts` | `resolveObservabilityPolicy` (pure defaults; no sinks) |
| `src/observability/policy.ts` | `resolveTraceWriter` (writer precedence, per-trace sampling) |
| `src/observability/destinations.ts` | Named destination registry |
| `src/observability/trace-sink.ts` | `TraceSink` contract (type-only; safe for non-Deno host type graphs) |
| `src/observability/trace.ts` | Sink implementations + `writeTrace` |
| `src/observability/trace-span.ts` | Span builder (`startTrace`), content markers, `traceparent` helpers |
| `src/observability/trace-record.ts` | `TraceRecord` shape, `buildRecord` (scrub + include), `contentOf`, `inlineContent` |
| `src/observability/otlp.ts` | `toOtlpJson` (records → OTLP/JSON request) |
| `src/observability/openinference.ts` | `withOpenInference` (opt-in viewer attributes; its own export) |
| `src/observability/spans.ts` | Redaction spans shared with guardrails (`applySpans`, `spansFromPatterns`) |

## Profile observability

Declare policy on the profile. Prefer a host-registered destination id; pass a
`TraceSink` only for tests or custom exporters.

```ts
registerTraceDestination('prod', jsonlDestination('/var/log/theorem'));

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
| `scrub.*` | Scrubbing of **stored** text — independent of `profile.guardrails` |
| `retainForDays` | Days to keep each record. Handed to every destination with the record (`TraceWriteContext`), including an explicit sink. `<= 0` keeps records forever. Default 14 |
| `rotateAfterMiB` | JSONL file size before rotating, when `writeTo` resolves to a jsonl destination. Default 32 |
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

`scrub` defaults stay on even when turn-path `guardrails.redactSensitive` is
false: a host-confidential store must not accidentally inherit a debug-off
switch.

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
| `registerTraceDestination(id, dest)` | Register a `TraceSink` or `{ kind: 'jsonl', dir }` |
| `jsonlDestination(dir)` | Build a JSONL destination descriptor |
| `getTraceDestination` / `requireTraceDestination` | Lookup (throws `TheoremError` if unregistered) |
| `listTraceDestinationIds` / `clearTraceDestinations` | Introspection / tests |

## Trace sinks

Pass a `TraceSink` as the optional last argument to `runTurn`, `invokeTool` or
`runSession`,
or resolve one from profile policy:

```ts
for await (const event of runTurn(request, provider, jsonlSink(hostTraceDir))) {
  // …
}
```

| Sink | Behavior |
| --- | --- |
| `noopSink()` | Drop records (default when omitted and no profile writeTo) |
| `memorySink(into)` | Append `TraceRecord`s to a caller-owned array |
| `jsonlSink(dir, options?)` | Daily rotating JSONL under a host-chosen directory |
| `TraceSink.onError` | Optional hook for build/write failures (never fails the turn) |

`TraceSink.write(record, context)` receives the record and its
`TraceWriteContext` — `{ retainForDays }` from the observability policy of the
profile that wrote it. Retention has one owner: a host store computes its own
expiry from `context.retainForDays` (for example `retain_until`, null when
`<= 0`), and the JSONL writer prunes by the same value.

`jsonlSink(dir, { rotateAfterMiB?, now? })` writes one record per line to
`turns-YYYY-MM-DD.jsonl`, rotates around `rotateAfterMiB` (default 32), and on
each write removes day files older than the record's `retainForDays`
(`<= 0` removes nothing). Directory creation is recursive.

`writeTrace(sink, recordPromise, policy)` awaits the record and writes it with
the policy's write context. Errors from
record construction or the sink are forwarded to optional `sink.onError` and
never abort the turn. Production hosts should set `onError` / `onWriteError`
(log, metric, alert) so dying disks/permissions are visible.

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
- With `scrub.canary`, every canary bound in the record (the turn's and any
  nested turn's) is removed from stored text.
- A hash identifies the text *after* scrub, so original bytes are unrecoverable
  when scrub is on.
- The root records the policy it was written under:
  `theorem.record.include` and `theorem.record.scrub` list the enabled flags,
  so a missing field reads as "not recorded", never as "did not happen".

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

`buildRecord({ spans, policy, canaries?, metadata? })` seals the spans a
`TraceTree` collected. Hosts record their own spans with `startTrace` (content
through `traceContent`, `traceBytes`, `traceJson`).

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

## OTLP export

`toOtlpJson(records)` reshapes trace records into one OTLP/JSON
`ExportTraceServiceRequest` — the body of `POST /v1/traces` — with no encoder
dependency:

- One `resourceSpans` entry per record (its `resource`), one scope named
  `@theoremai/agents`, carrying the record's `schemaUrl`.
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

Phoenix maps the GenAI semconv spans itself but reads reasoning tokens and
cost only under [OpenInference names](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md).
`withOpenInference(records)`, imported from
`@theoremai/agents/observability/openinference`, returns copies whose
model-call spans (`chat`, `generate_content`) also carry:

| OpenInference | From |
| --- | --- |
| `llm.token_count.completion_details.reasoning` | `gen_ai.usage.reasoning.output_tokens` |
| `llm.cost.total` | `theorem.usage.cost_usd`, unless `theorem.usage.cost_partial` |

- Only model calls: a viewer sums them across a trace, and an agent span's
  usage is already the sum of its calls.
- A partial cost keeps only its `theorem.*` name, so it never reads as a total.
- Absent inputs stay absent.

Export with `toOtlpJson(withOpenInference(records))`. The kernel and
`toOtlpJson` stay viewer-neutral; hosts that don't use such a viewer never load
the module.

## Exported API

| Export | Kind |
| --- | --- |
| `TraceSink`, `TraceWriteContext`, `JsonlSinkOptions` | type |
| `TraceRecord` | type |
| `TraceSpan`, `TraceSpanEvent`, `TraceSpanKind`, `TraceSpanLink`, `TraceSpanStatus` | type |
| `TraceAttributes`, `TraceAttributeValue`, `TraceContent`, `TraceBytes`, `TraceJson` | type |
| `TraceTree`, `SpanHandle`, `SpanOptions`, `SpanLinkInput`, `TraceClock` | type |
| `TraceDestination`, `JsonlTraceDestination` | type |
| `ProfileObservabilitySpec`, `TraceIncludeSpec`, `TraceScrubSpec` | type |
| `ResolvedObservabilityPolicy`, `ResolvedTraceInclude`, `ResolvedTraceScrub` | type |
| `jsonlSink`, `memorySink`, `noopSink` | function |
| `writeTrace` | function |
| `buildRecord`, `contentOf`, `inlineContent` | function |
| `toOtlpJson` | function |
| `withOpenInference` (from `@theoremai/agents/observability/openinference`) | function |
| `OtlpTraceRequest`, `OtlpSpan`, `OtlpKeyValue`, `OtlpAnyValue` | type |
| `startTrace`, `traceContent`, `traceBytes`, `traceJson` | function |
| `registerTraceDestination`, `jsonlDestination`, `requireTraceDestination`, `getTraceDestination` | function |
| `listTraceDestinationIds`, `clearTraceDestinations` | function |
| `isJsonlTraceDestination`, `isTraceSink` | function |
| `resolveObservabilityPolicy`, `resolveTraceWriter` | function |

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
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/observability/mod.ts" },
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
      ]
    }
  }
}
```
