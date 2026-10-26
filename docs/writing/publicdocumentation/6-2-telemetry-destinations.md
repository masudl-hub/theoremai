# Telemetry Sinks & Exporters

Theorem maintains no proprietary telemetry database or persistent background daemon. Instead, the kernel produces standardized trace records and hands them to **trace sinks**—pluggable writers that buffer, transform, or export records to external observability platforms.

Hosts configure telemetry declaratively on agent profiles (`observability`), register named global destinations at startup (`registerTraceDestination`), or inject per-call trace sinks directly into `runTurn`.

---

## Observability Policy (`ProfileObservabilitySpec`)

Agents declare their tracing behavior under the profile's [`observability`](file:///Users/masudlewis/Development/theoremai/src/observability/types.ts#L48-L70) block:

```ts
import { registerProfile } from '@theoremjs/agents';

registerProfile({
  id: 'harbor.desk',
  type: 'text',
  // ... identity, models, tools, inputs, outputs, providerContinuation, guardrails
  observability: {
    writeTo: 'production-collector', // Destination ID, TraceSink instance, or false
    sampleRate: 0.25,                 // TraceIdRatioBased sampling (25% of traces)
    resource: {
      'service.name': 'harbor-service',
      'deployment.environment': 'production',
    },
    include: {
      usage: true,                   // Include token counts and USD costs (default: true)
      guardrailDecisions: true,      // Record boundary check outcomes (default: true)
      upstreamLog: false,            // Exclude raw provider streaming frames (default: true)
      outboundWire: false,           // Exclude outbound HTTP bodies (default: false)
    },
    scrub: {
      sensitive: true,               // Redact SSNs, credit cards, IP addresses, and API keys
      canary: true,                  // Redact ephemeral canary tokens
      injection: true,               // Redact prompt injection attempts
    },
  },
  // ... labels
});
```

### Destination Resolution (`writeTo`)
* `false` *(Default when omitted)*: Telemetry disabled. Internal spans execute with zero export overhead ([`noopSink`](file:///Users/masudlewis/Development/theoremai/src/observability/trace.ts#L22)).
* `string`: Resolves a globally registered destination ID via [`registerTraceDestination`](file:///Users/masudlewis/Development/theoremai/src/observability/destinations.ts#L18-L29).
* `TraceSink`: Directly supplies an inline writer object implementing the `write(record, context)` interface.

### Deterministic Sampling (`sampleRate`)
Sampling rates range from `0.0` (drop all) to `1.0` (keep all). Sampling uses OpenTelemetry's `TraceIdRatioBased` algorithm, hashing the lowest 32 bits of the trace ID. Because the decision is computed from the trace ID rather than individual spans, all spans across a turn, its sub-agent calls, and compaction steps are retained or dropped together.

---

## Global Destination Registry

Hosts register reusable trace destinations once during application bootstrap:

```ts
import { registerTraceDestination, jsonlSink } from '@theoremjs/agents';

// Register a local JSONL sink
registerTraceDestination('audit-jsonl', jsonlSink('./var/traces', {
  filename: 'turns.jsonl',
}));

// Register a custom OTLP exporter
registerTraceDestination('production-collector', {
  async write(record, context) {
    const otlpPayload = toOtlpJson(record);
    await fetch('https://otel-collector.internal:4318/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(otlpPayload),
      signal: context.signal,
    });
  },
  onError(err) {
    console.error('Failed to export trace:', err);
  },
});
```

Profiles across the application reference registered destinations by ID (`writeTo: 'audit-jsonl'`). If a profile references an unregistered destination ID, profile execution throws a `config` error (`TheoremError('config', "Trace destination '<id>' is not registered")`).

---

## Trace Exporters & Sinks

Theorem provides three primary sink patterns:

### 1. OTLP HTTP / JSON Collector (`toOtlpJson`)
For export to OpenTelemetry collectors, Datadog, Honeycomb, or Grafana Tempo, [`toOtlpJson`](file:///Users/masudlewis/Development/theoremai/src/observability/otlp.ts#L17) serializes a [`TraceRecord`](file:///Users/masudlewis/Development/theoremai/src/observability/trace-schema.ts#L106-L117) into a valid OpenTelemetry `ExportTraceServiceRequest` JSON payload (`POST /v1/traces`).

```ts
import { toOtlpJson, type TraceSink } from '@theoremjs/agents';

export function otlpHttpSink(endpoint: string): TraceSink {
  return {
    async write(record, context) {
      const body = JSON.stringify(toOtlpJson(record));
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: context.signal,
      });
    },
  };
}
```

### 2. Local File Logging (`jsonlSink`)
For on-disk auditing or headless worker logging without network dependencies, [`jsonlSink`](file:///Users/masudlewis/Development/theoremai/src/observability/jsonl.ts#L72) streams NDJSON trace records directly to local disk:

```ts
import { jsonlSink } from '@theoremjs/agents';

const diskSink = jsonlSink('/var/log/theorem', {
  filename: 'traces.jsonl',
  rotateDaily: true,
});
```

### 3. In-Memory Sinks for Testing (`memorySink`)
For integration tests and CI assertion pipelines, [`memorySink`](file:///Users/masudlewis/Development/theoremai/src/observability/trace.ts#L21) buffers records in memory without file or network I/O:

```ts
import { memorySink, runTurn } from '@theoremjs/agents';

const sink = memorySink();

await runTurn({
  profile: 'harbor.desk',
  sink, // Overrides profile writeTo for this execution
  input: { text: 'Manifest verification' },
});

console.assert(sink.records.length === 1);
console.assert(sink.records[0].spans[0].name === 'invoke_agent harbor.desk');
```

---

## Data Scrubbing & Sanitization

Observability pipelines must never exfiltrate API credentials, PII, or internal canary markers to external telemetry providers.

Theorem applies sanitization filters before records are handed to trace sinks:

1. **Deterministic Scrubbing (`scrub.sensitive`)**: Scans prompt text, completions, and tool arguments against credential patterns and sensitive data rules, replacing matched spans with `[omitted - sensitive]` or `[omitted - credentials]`.
2. **Canary Scrubbing (`scrub.canary`)**: Strips generated ephemeral canary tokens, replacing them with `[omitted - canary]`.
3. **Payload Scrubbing (`include.upstreamLog`)**: When raw wire logging is enabled for debugging, inbound credentials and authorization headers are masked before storage.

---

## Related Guides

* **[Trace Spans & Semantic Conventions](6-1-trace-spans-catalog.md)**: OpenTelemetry GenAI attributes, span topology, and content interning.
* **[Evaluations & Benchmarks](6-3-evals-and-benchmarks.md)**: Grader suites and automated evaluation against trace records.
* **[Network Safety & Secret Masking](4-4-network-safety.md)**: Boundary detectors and sanitization rules for outbound requests.
* **[Kernel Labels & Errors](2-6-kernel-labels.md)**: Overriding error strings and telemetry diagnostic copy.
