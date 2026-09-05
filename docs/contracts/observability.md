# Observability (`theorum/observability`)

Trace sinks and record helpers. THEORUM does not own a database, does not read
trace-related environment variables for destinations, and never lets tracing
fail a turn. Hosts that need a signal when sinks die set `TraceSink.onError`.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/observability` / `jsr:@theorum/core/observability` |
| Module | `src/observability/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/observability/trace.ts` | Sink implementations + `writeTrace` |
| `src/observability/trace-record.ts` | `TraceRecord` shape |
| `src/observability/trace-usage.ts` | Token usage attachment |
| `src/observability/trace-attach.ts` | Attachment helpers |
| `src/observability/spans.ts` | Span redaction (`applySpans`) |

## Trace sinks

Pass a `TraceSink` as the optional third argument to `runTurn`:

```ts
for await (const event of runTurn(request, provider, jsonlSink(hostTraceDir))) {
  // …
}
```

| Sink | Behavior |
| --- | --- |
| `noopSink()` | Drop records (default when omitted) |
| `memorySink(into)` | Append `TraceRecord`s to a caller-owned array |
| `jsonlSink(dir)` | Daily rotating JSONL under a host-chosen directory |
| `sinkFromDir(dir)` | Resolve a directory sink helper |
| `resolveTraceDir(...)` | Path helper for hosts assembling a trace root |
| `TraceSink.onError` | Optional hook for build/write failures (never fails the turn) |

`jsonlSink` writes `turns-YYYY-MM-DD.jsonl`, rotates around 32 MiB, and prunes
files older than 14 days. Directory creation is recursive.

`writeTrace(sink, recordPromise)` awaits the record and writes it. Errors from
record construction or the sink are forwarded to optional `sink.onError` and
never abort the turn. Production hosts should set `onError` (log, metric, alert)
so dying disks/permissions are visible.

When building a record without a pre-sanitized request, `buildRecord` prefers
full request sanitize; if blob/policy checks throw, it still redacts text and
keeps attachments for hashing — it never invents empty `{ input: {} }`.

## Sensitive storage

Trace records are **host-confidential**, not end-user artifacts:

| Field | Stored as | Notes |
| --- | --- | --- |
| `upstreamLog` | Scrubbed HTTP/SSE rows | Auth headers redacted; image bytes hashed; canary omitted |
| `events[].evidence.raw` | Verbatim provider step JSON | Audit/debug — treat like server logs |
| `events[].errorInternal` | Redacted sensitive spans | Full upstream diagnostics |
| `events[].media` | SHA-256 only | Bytes not retained in trace |
| `wire` | Scrubbed outbound request | Same rules as `upstreamLog` |

Restrict trace directories to the host process. Do not expose JSONL files or
`memorySink` dumps to clients. Use `forClientEvents` before any user-visible
transport.

## Trace records

`TraceRecord` captures turn identity, timing, model selection, token usage, and
related fields for host analytics. Built by `buildRecord` in the runner path and
consumed by sinks.

When `sanitizedReq` is omitted, `buildRecord` uses `sanitizeTurnRequestForTrace`:
full request sanitize when possible; on blob/policy failure it still redacts text
and hashes attachments — it never invents empty `{ input: {} }`. A sanitize
fallback is recorded in `errorInternal` when no other internal error is set.

| Module | Role |
| --- | --- |
| `trace-record.ts` | Record type + builder inputs |
| `trace-usage.ts` | Attach provider token events |
| `trace-attach.ts` | Correlate attachments / metadata |

## Exported API

| Export | Kind |
| --- | --- |
| `TraceSink` | type |
| `TraceRecord` | type |
| `jsonlSink`, `memorySink`, `noopSink` | function |
| `resolveTraceDir`, `sinkFromDir` | function |
| `writeTrace` | function |

```theorum-evidence
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
    "Trace sinks": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace.test.ts" }
      ]
    },
    "Sensitive storage": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace-record.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace.test.ts" }
      ]
    },
    "Trace records": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace-record.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/observability/mod.ts" },
        { "kind": "contract_test", "path": "tests/observability/trace.test.ts" }
      ]
    }
  }
}
```
