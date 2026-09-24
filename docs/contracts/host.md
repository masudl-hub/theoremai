# Host (`@theoremai/agents/host`)

Optional helpers for host applications. **Not** part of the turn kernel —
import when you want shared reply/status glue, cutout-trace flushing, or live
structured-output preview without reimplementing it per route.

Host-driven tool execution (MCP servers, web UIs, schedulers) does not live
here: register a `type: 'host'` profile (`HostProfileDefinition` — `tools.allow`
ceiling, optional `observability`, optional `guardrails` narrowed to
`HostGuardrailsSpec` — `sanitizeInput`, `redactSensitive`, `network`, `taint`;
quota / canary / egress are refused because they guard a model turn — no models)
and call
`invokeTool({ profile, name, input, host })` from `@theoremai/agents/kernel`. The `host`
slot carries opaque application context to `handler` / `preTool`
(and turn stages — see `docs/contracts/stages.md`) and is never traced or sent
to a provider. Application context that belongs in the trace goes in
`metadata`, which the invoke's trace record stores untouched. See `docs/contracts/kernel.md` (“Host profile” and “Host context
slot”).

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremai/agents/host` / `jsr:@theoremai/agents/host` |
| Module | `src/host/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/host/reply.ts` | JSON responses + HTTP status constants |
| `src/host/client-turn.ts` | Strip `errorInternal` (error and guardrail events) / `evidence.raw` before client transports |
| `src/host/mint-trace.ts` | Cutout mint trace flush helpers |
| `src/host/readStreamingJsonStringField.ts` | Incomplete JSON string preview |
| `src/host/mod.ts` | Public barrel |

## HTTP replies

| Export | Role |
| --- | --- |
| `json(status, body, cors)` | JSON `Response` with merged CORS headers |
| `caughtStatus(err)` | The status of the error's kind (below); an unrecognised throw is `internal` → `500` |
| `HTTP_OK` | `200` |
| `HTTP_BUSY` | `429` |
| `HTTP_NOT_FOUND` | `404` |
| `HTTP_METHOD` | `405` |

`caughtStatus` by kind:

| Kind | Status | Kind | Status |
| --- | --- | --- | --- |
| `config` | 500 | `bad_response` | 502 |
| `request` | 400 | `network` | 502 |
| `input` | 422 | `timeout` | 504 |
| `action` | 403 | `safety` | 422 |
| `auth` | 401 | `blocked` | 403 |
| `rate_limit` | 429 | `declined` | 409 |
| `unsupported` | 422 | `failed` | 502 |
| `unavailable` | 503 | `cancelled` | 499 (client closed request) |
| | | `internal` | 500 |

`auth` is 401 whichever key was refused. When the refused key is the host's own
provider key rather than one the caller supplied, the host may prefer to reply
500 itself.

Example:

```ts
import { caughtStatus, HTTP_BUSY, json } from "@theoremai/agents/host";

try {
  return json(200, { ok: true }, cors);
} catch (err) {
  // Pass the profile's lexicon so its wording wins over the defaults.
  return json(caughtStatus(err), { error: publicError(err, profile.lexicon) }, cors);
}
```

Quota busy responses typically use `HTTP_BUSY` after `takeSlot` returns `busy`;
when it returns `quota`, reply with `quotaExhausted(profile)` as above (`429`,
the lexicon's `quota.exhausted`).

## Client-safe turn events

Before forwarding `TurnEvent`s to browsers, SSE, or mobile clients, strip
host-only diagnostics:

```ts
import { forClientEvents } from "@theoremai/agents/host";
import { runSession } from "@theoremai/agents";

const live = await runSession({ profile: "site.live" }, { gemini: { vault } });
for await (const event of live.events()) {
  ws.send(JSON.stringify({ type: "events", events: forClientEvents([event]) }));
}
```

Outbound canary/egress for live is applied inside `runSession`. Hosts that
build a custom relay still may call `processLiveOutboundBatch` /
`finalizeLiveOutboundTurn` directly — prefer `runSession` when possible.

| Export | Role |
| --- | --- |
| `forClient(event, options?)` | Copy one event without `errorInternal` on error and guardrail events (`errorKind` and the user's `error` stay); strips `evidence.raw` unless `includeEvidenceRaw: true`; always strips `GuardrailHit.match` |
| `forClientEvents(events, options?)` | Batch helper for Live relays and HTTP stream flush |
| `ClientTurnOptions` | `{ includeEvidenceRaw?: boolean }` |

HTTP error responses should still use `publicError(err, profile.lexicon)` —
`forClient` applies only to turn event payloads.

## Cutout mint trace

| Export | Role |
| --- | --- |
| `flushMintTrace` | Write a held turn record, then one `cutout` record in the same trace |
| `CutoutTape` | What the host observed: `ok`, `ms`, `url`, input/output hashes, the upstream exchange, error text |
| `TraceSink` (imported) | From `src/observability/trace-sink.ts`, the type-only sink contract |

For a side effect the host makes after a turn (for example an image cutout)
that belongs in that turn's trace. Run the turn into a `memorySink`, make the
call, then pass the held record, the tape, the host's `app` metadata and the
real sink to `flushMintTrace`:

- The turn record is written unchanged.
- The second record holds one `cutout` span (CLIENT) whose parent is the turn's
  root, timed to end now and to have lasted `ms`. It carries `server.address` /
  `url.path`, `theorem.cutout.input.sha256` / `theorem.cutout.output.sha256`,
  the exchange as a `theorem.upstream.row` event, and any error text as an
  `exception` event stored by hash. Status is `OK` or `ERROR` from `ok`.
- It is built under the observability policy of the profile the turn ran on and
  carries the turn's metadata plus `app`.

## Structured JSON preview

`readStreamingJsonStringField(jsonText, key)` reads one string field from
**incomplete** JSON while structured output streams as text deltas. Hosts use
it for live UI previews; it is not a JSON validator and never throws on truncated
input.

```ts
import { readStreamingJsonStringField } from "@theoremai/agents/host";

const preview = readStreamingJsonStringField(buffer, "mermaid");
// returns decoded prefix even before closing quote
```

| Behavior | Detail |
| --- | --- |
| Locator | `"key": "` pattern |
| Escapes | `\n`, `\t`, `\uXXXX`, … |
| Incomplete buffer | Returns prefix for live UI preview |
| Missing key | `null` |

Does not validate full JSON documents.

## Exported API

Live list: `src/host/mod.ts` (`json`, status constants, `caughtStatus`,
`flushMintTrace`, `CutoutTape`, `readStreamingJsonStringField`, `forClient`,
`forClientEvents`, `ClientTurnOptions`).

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/host/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/host/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "HTTP replies": {
      "supports": [
        { "kind": "source", "path": "src/host/reply.ts" },
        { "kind": "contract_test", "path": "tests/host/host.test.ts" }
      ]
    },
    "Client-safe turn events": {
      "supports": [
        { "kind": "source", "path": "src/host/client-turn.ts" },
        { "kind": "contract_test", "path": "tests/host/client-turn.test.ts" }
      ]
    },
    "Cutout mint trace": {
      "supports": [
        { "kind": "source", "path": "src/host/mint-trace.ts" },
        { "kind": "contract_test", "path": "tests/host/host.test.ts" }
      ]
    },
    "Structured JSON preview": {
      "supports": [
        { "kind": "source", "path": "src/host/readStreamingJsonStringField.ts" },
        { "kind": "contract_test", "path": "tests/host/readStreamingJsonStringField.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/host/mod.ts" },
        { "kind": "contract_test", "path": "tests/host/host.test.ts" }
      ]
    }
  }
}
```
