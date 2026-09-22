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

## Ownership

| Path | Role |
| --- | --- |
| `src/observability/types.ts` | `ProfileObservabilitySpec` + resolved policy shapes |
| `src/observability/resolve-policy.ts` | `resolveObservabilityPolicy` (pure defaults; no sinks) |
| `src/observability/policy.ts` | `resolveTraceWriter` |
| `src/observability/destinations.ts` | Named destination registry |
| `src/observability/trace-sink.ts` | `TraceSink` contract (type-only; safe for non-Deno host type graphs) |
| `src/observability/trace.ts` | Sink implementations + `writeTrace` |
| `src/observability/trace-record.ts` | `TraceRecord` shape + `buildRecord` |
| `src/observability/trace-usage.ts` | Token usage attachment |
| `src/observability/trace-attach.ts` | Attachment helpers |
| `src/observability/spans.ts` | Span redaction (`applySpans`) |

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
    include: {
      upstreamLog: true,
      outboundWire: false,
      evidenceRaw: false,
      usage: true,
      guardrailDecisions: true,
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
| `sampleRate` | Fraction of turns to record (0–1). Default 1. Ignored when `runTurn` passes an explicit sink |
| `include.*` | Which TraceRecord payloads to keep. Authored blocks default `outboundWire` / `evidenceRaw` off; omitting the whole `observability` block preserves historical buildRecord inclusion |
| `scrub.*` | Scrubbing of **stored** records — independent of `profile.guardrails` |
| `retainForDays` / `rotateAfterMiB` | JSONL retention when `writeTo` resolves to a jsonl destination |
| `onWriteError` | Host hook on build/write failure (never fails the turn) |

Omit the whole `observability` block → noop (same as today). `resolveObservabilityPolicy` maps author-provided values to fully resolved settings.

`scrub` defaults stay on even when turn-path `guardrails.redactSensitive` is
false: a host-confidential store must not accidentally inherit a debug-off
switch. `include.guardrailDecisions` keeps `{ type: 'guardrail' }` rows in the
TraceRecord (default true). `include.guardrailMatchPreview` keeps
`GuardrailHit.match` on the live stream and TraceRecord (default **false**).

### Resolution order

1. Explicit `runTurn(request, provider, sink)` — sink wins (deterministic capture).
2. Else `profile.observability.writeTo` via `resolveTraceWriter`.
3. Else noop.

```ts
for await (const event of runTurn(request, provider)) {
  // uses profile.observability
}
```

## Trace destinations

The current observability refresh keeps the destination registry and sink selection behavior aligned with the live source files in this branch.

| API | Role |
| --- | --- |
| `registerTraceDestination(id, dest)` | Register a `TraceSink` or `{ kind: 'jsonl', dir }` |
| `jsonlDestination(dir)` | Build a JSONL destination descriptor |
| `getTraceDestination` / `requireTraceDestination` | Lookup (throws `TheoremError` if unregistered) |
| `listTraceDestinationIds` / `clearTraceDestinations` | Introspection / tests |

## Trace sinks

The branch-level trace updates keep the sink implementations and write path synchronized with the runtime event handling and destination behavior.

Pass a `TraceSink` as the optional third argument to `runTurn`, or resolve one
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
| `jsonlSink(dir, options?)` | Daily rotating JSONL under a host-chosen directory |
| `sinkFromDir(dir)` | Resolve a directory sink helper |
| `resolveTraceDir(...)` | Path helper for hosts assembling a trace root |
| `TraceSink.onError` | Optional hook for build/write failures (never fails the turn) |

`jsonlSink` writes `turns-YYYY-MM-DD.jsonl`, rotates around `rotateAfterMiB`
(default 32), and prunes files older than `retainForDays` (default 14).
Directory creation is recursive.

`writeTrace(sink, recordPromise)` awaits the record and writes it. Errors from
record construction or the sink are forwarded to optional `sink.onError` and
never abort the turn. Production hosts should set `onError` / `onWriteError`
(log, metric, alert) so dying disks/permissions are visible.

When building a record without a pre-sanitized request, `buildRecord` prefers
full request sanitize; if blob/policy checks throw, it still redacts text and
keeps attachments for hashing — it never invents empty `{ input: {} }`.

## Sensitive storage

Trace records are **host-confidential**, not end-user artifacts.
`buildRecord` applies `observability.scrub` (defaults on) independently of
turn-path `profile.guardrails`, then honors `observability.include` for which
sections exist at all:

| Field | Stored as | Notes |
| --- | --- | --- |
| `upstreamLog` | Scrubbed HTTP/SSE rows | Auth headers redacted; image bytes hashed; canary omitted when `scrub.canary`. Gated by `include.upstreamLog` |
| `events[].evidence.raw` | Verbatim provider step JSON | Audit/debug — treat like server logs. Gated by `include.evidenceRaw` (off by default when observability is authored) |
| `events[].errorInternal` / text | Scrubbed per `scrub.sensitive` / `scrub.injection` | Full upstream diagnostics after scrub |
| `events[].media` | SHA-256 only | Bytes not retained in trace |
| `wire` | Scrubbed outbound request | Same rules as `upstreamLog`. Gated by `include.outboundWire` |
| `{ type: 'guardrail' }` events | Decision identity (+ optional `hit.match`) | Gated by `include.guardrailDecisions`; match text gated by `include.guardrailMatchPreview` (off by default) |

Restrict trace directories to the host process. Do not expose JSONL files or
`memorySink` dumps to clients. Use `forClientEvents` before any user-visible
transport.

## Trace records

`TraceRecord` captures turn identity, timing, requested model id (`modelSelect`),
effort level (`effort`), resolved model (`model.id` / `model.apiId`), optional
`keySlot` (vault key slot), token usage, and related fields for host analytics.
Built by `buildRecord` in the runner path and consumed by sinks.

| Field | Source |
| --- | --- |
| `modelSelect` | `TurnRequest.model` when set |
| `effort` | `TurnRequest.effort` when set |
| `model` | Resolved binding id + wire `apiId` |
| `keySlot` | Vault slot chosen for the turn |
| `generation` | Resolved generation knobs (`thinking`, `temperature`, tools, …) |

`buildRecord` accepts optional `observability` (`ProfileObservabilitySpec` or
already-resolved policy). The runner passes the policy from
`resolveTraceWriter`. When omitted, include defaults match historical behavior
(`outboundWire` / `evidenceRaw` on); when a profile authors `observability`,
those two default off.

`TraceEvent.guardrail` persists `{ type: 'guardrail' }` decisions (stage, trust,
action, hits) when `include.guardrailDecisions` is true. `hit.match` is kept only
when `include.guardrailMatchPreview` is true; otherwise `snapshotEvent` strips it.
Empty shells are not written: `snapshotEvent` copies `event.guardrail` when present.

When `sanitizedReq` is omitted, `buildRecord` uses `sanitizeTurnRequestForTrace`:
full request sanitize when possible; on blob/policy failure it still redacts text
and hashes attachments — it never invents empty `{ input: {} }`. A sanitize
fallback is recorded in `errorInternal` when no other internal error is set.
Stored request/event text is then passed through `scrub` again so trace scrubbing
does not silently inherit a turn-path `redactSensitive: false`.

| Module | Role |
| --- | --- |
| `trace-record.ts` | Record type + builder inputs (`observability`, scrub, include) |
| `trace-usage.ts` | Attach provider token events |
| `trace-attach.ts` | Copy request fields + correlate attachments / metadata (include-gated) |

## Exported API

| Export | Kind |
| --- | --- |
| `TraceSink`, `JsonlSinkOptions` | type |
| `TraceRecord` | type |
| `TraceDestination`, `JsonlTraceDestination` | type |
| `ProfileObservabilitySpec`, `TraceIncludeSpec`, `TraceScrubSpec` | type |
| `ResolvedObservabilityPolicy`, `ResolvedTraceInclude`, `ResolvedTraceScrub` | type |
| `jsonlSink`, `memorySink`, `noopSink` | function |
| `resolveTraceDir`, `sinkFromDir` | function |
| `writeTrace` | function |
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
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
      ]
    },
    "Trace records": {
      "supports": [
        { "kind": "source", "path": "src/observability/trace-record.ts" },
        { "kind": "contract_test", "path": "tests/observability/policy.test.ts" }
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
