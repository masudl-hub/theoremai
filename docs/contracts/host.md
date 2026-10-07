# Host (`@theoremjs/agents/host`)

Optional helpers for host applications. **Not** part of the turn kernel —
import when you want shared reply/status glue, cutout-trace flushing, or live
structured-output preview without reimplementing it per route.

Host-driven tool execution (MCP servers, web UIs, schedulers) does not live
here: register a `type: 'host'` profile (`HostProfileDefinition` — `tools.allow`
ceiling, optional `observability`, optional `guardrails` narrowed to
`HostGuardrailsSpec` — `detect`, `network`;
quota / canary / egress / taint are refused because they guard a model turn — no models)
and call
`invokeTool({ profile, name, input, host })` from `@theoremjs/agents/kernel`. The `host`
slot carries opaque application context to `handler` / `preTool`
(and turn stages — see `docs/contracts/stages.md`) and is never traced or sent
to a provider. Application context that belongs in the trace goes in
`metadata`, which the invoke's trace record stores untouched. See `docs/contracts/kernel.md` (“Host profile” and “Host context
slot”).

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/host` / `jsr:@theoremjs/agents/host` |
| Module | `src/host/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/host/reply.ts` | JSON responses + HTTP status constants |
| `src/host/client-turn.ts` | Strip `errorInternal` (any event, and guardrail decisions) / `evidence.raw` before client transports |
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

`auth` is 401 whichever key was refused. A key the host's vault lacks (a model's
slot left empty: `the vault has no key in slot '<slot>'`) is `auth` too; keys
come only from the `vault` the host passes, through the slot the profile names.
When the refused key is the host's own provider key rather than one the caller
supplied, the host may prefer to reply 500 itself.

Example:

```ts
import { caughtStatus, HTTP_BUSY, json } from "@theoremjs/agents/host";

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
import { forClientEvents } from "@theoremjs/agents/host";
import { runSession } from "@theoremjs/agents";

const live = await runSession({ profile: "site.live" }, { vault });
for await (const event of live.events()) {
  ws.send(JSON.stringify({ type: "events", events: forClientEvents([event]) }));
}
```

Outbound canary/egress for live is applied inside `runSession`. Hosts that
build a custom relay still may call `processLiveOutboundBatch` /
`finalizeLiveOutboundTurn` directly — prefer `runSession` when possible.

A relay reads each text frame from the live client with `parseLiveClientMessage`
(`@theoremjs/react/server`): JSON that passes the live client's schema, else a
`request` error the relay sends back as an `error` envelope,
`{ type: 'error', error, errorKind }`. The live client reads every envelope
against its own schema: a kind it does not know reaches `onTurnEvent` as
`unsupported`, and one that fails its check (an envelope, or one event in an
`events` envelope) as `malformed`, left out as `bad_response`: the session
goes on, and an `events` envelope's other events stand.

The live client's first message is the open message (`parseLiveOpenMessage`): the call's `slots`, the page's `context`, a `resume` handle with the time away when the client takes a dropped call up again, and the host's own `openMessage` as `host`. A relay reads it before it opens the session; `liveSessionOpen(open, server?)` gives the `slots`, `context`, `sessionResumptionHandle` and `awayMs` for `runSession`. It is not a `LiveClientMessage`: one sent later is a `request` error.

The live client's `context` message carries the page's whole package, replacing the last. It goes to `session.sendContext` as the `client` sender's package: background the model reads without replying, such as the page the visitor is on. The profile's `inputs.context` decides whether the browser may send it and how long it may be.

The live client takes a dropped call up again when the provider gave a resumption handle (`live.sessionResumption`): status `reconnecting`, a try after 0.5, 1, 2, 4 and 8 seconds, then a `network` failure. The session's `ended` event (the provider's time limit) is taken up the same way when there is a handle; without one it is the end of the call. A close after an `error` envelope is the end of the call, not a drop.

A relay only forwards the live client's tool messages. The session holds the
model's calls and gates (see [`stages.md`](stages.md), "`LiveSession.executeTool`"),
so the relay passes the browser's `executeTool` message, less its `type`, to
`session.executeTool` and answers with one `executeToolResult` per message:

| `status` | When | Carries |
| --- | --- | --- |
| `settled` | The call ran and the model has its answer | `callId` |
| `gated` | The call waits on a gate | `callId`, `gate` |
| `refused` | `executeTool` threw | `callId`, `body`: `{ error: publicError(err, profile.lexicon), errorKind }` |

A tool the browser answers (a `function` tool whose result lives in the page) is
settled by the same message: `executeToolOnRelay({ callId, output })` sends the
browser's `output`, and the relay passes it to `session.executeTool` as
`page: { output }`. The tool is registered with `answeredBy: 'page'` and no handler: the kernel
returns what the page sent, so the tool's `output` schema checks it
and a mismatch reaches the model as an ordinary tool failure. With no
`page` the call fails to the model, naming the tool.

In a chat, the same tool pauses the turn at a `page` gate. The page answers it on `/invoke` with
`{ gateId, decision: 'approve', page: { output } }`, or `page: { unanswered: true }` when it has no
function for the tool. `useTheoremChat` does this from its `pageTools` option, and shows no prompt.

The kernel never times out an ungated held call, so the relay does:
`attachPlaygroundLiveSession` starts a timer when the model makes a call
(`clientCallTimeoutMs` in its options, default 20 s) and clears it when the
browser's `executeTool` for that call arrives or the call settles or is
cancelled. When it fires the relay calls `session.executeTool` with
`page: { timedOut: true }`, and the kernel fails the call with
`tool.page_timed_out` ("The page didn't answer"). The browser's
late answer is then refused like any `executeTool` for a settled call.

| Export | Role |
| --- | --- |
| `forClient(event, options?)` | Copy one event without `errorInternal` (it rides error events, an ended Live session, a tool call's failure such as a refused OAuth refresh, and guardrail decisions; `errorKind` and the user's `error` stay); strips `evidence.raw` unless `includeEvidenceRaw: true`; always strips `GuardrailHit.match` |
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
call, then pass the profile the turn ran on, the held record, the tape, the
host's `app` metadata and the real sink to `flushMintTrace`. It throws when the
held turn ran on a different profile:

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
import { readStreamingJsonStringField } from "@theoremjs/agents/host";

const preview = readStreamingJsonStringField(buffer, "mermaid");
// returns decoded prefix even before closing quote
```

| Behavior | Detail |
| --- | --- |
| Locator | `"key"`, then `:` and an opening quote (whitespace allowed); an earlier `"key"` not followed by a string value is skipped |
| Escapes | `\n`, `\t`, `\uXXXX`, … |
| Incomplete buffer | Returns prefix for live UI preview |
| Missing key, or a value that is not a string | `null` |

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
