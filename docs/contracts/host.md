# Host (`theorum/host`)

Optional helpers for host applications. **Not** part of the turn kernel —
import when you want shared reply/status glue, cutout-trace flushing, or live
structured-output preview without reimplementing it per route.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/host` / `jsr:@theorum/core/host` |
| Module | `src/host/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/host/reply.ts` | JSON responses + HTTP status constants |
| `src/host/client-turn.ts` | Strip `errorInternal` / `evidence.raw` before client transports |
| `src/host/mint-trace.ts` | Cutout mint trace flush helpers |
| `src/host/readStreamingJsonStringField.ts` | Incomplete JSON string preview |
| `src/host/mod.ts` | Public barrel |

## HTTP replies

| Export | Role |
| --- | --- |
| `json(status, body, cors)` | JSON `Response` with merged CORS headers |
| `caughtStatus(err)` | `400` for `TheorumError`, else `500` |
| `HTTP_OK` | `200` |
| `HTTP_BUSY` | `429` |
| `HTTP_NOT_FOUND` | `404` |
| `HTTP_METHOD` | `405` |

Example:

```ts
import { caughtStatus, HTTP_BUSY, json } from "theorum/host";

try {
  return json(200, { ok: true }, cors);
} catch (err) {
  return json(caughtStatus(err), { error: publicError(err) }, cors);
}
```

Quota busy responses typically use `HTTP_BUSY` after `takeSlot` returns `busy`.

## Client-safe turn events

Before forwarding `TurnEvent`s to browsers, SSE, or mobile clients, strip
host-only diagnostics:

```ts
import { forClientEvents } from "theorum/host";
import { runSession } from "theorum";

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
| `forClient(event, options?)` | Copy one event without `errorInternal`; strips `evidence.raw` unless `includeEvidenceRaw: true`; always strips `GuardrailHit.match` |
| `forClientEvents(events, options?)` | Batch helper for Live relays and HTTP stream flush |
| `ClientTurnOptions` | `{ includeEvidenceRaw?: boolean }` |

HTTP error responses should still use `publicError(err)` — `forClient` applies
only to turn event payloads.

## Cutout mint trace

| Export | Role |
| --- | --- |
| `flushMintTrace` | Flush pending cutout mint records after a turn |
| `CutoutTape` | Tape type for mint/cutout correlation |

Use when your Deno HTTP host records mint/cutout telemetry alongside THEORUM
turns. Skip entirely for non-HTTP or non-Deno hosts.

## Structured JSON preview

`readStreamingJsonStringField(jsonText, key)` reads one string field from
**incomplete** JSON while structured output streams as text deltas. Hosts use
it for live UI previews; it is not a JSON validator and never throws on truncated
input.

```ts
import { readStreamingJsonStringField } from "theorum/host";

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

```theorum-evidence
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
