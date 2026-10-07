# Surfaces (`@theoremjs/agents/surface`)

One protocol for an agent to see and work in a person's screen. A page mounts a
**surface**: nodes with fields and actions. The agent has two tools, `look` and
`act`, for every surface any page mounts, so a new page adds nodes, not tools.
The runtime answers both tools in the client and projects every answer, so a
secret reaches the agent only as a card.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/surface` / `jsr:@theoremjs/agents/surface` |
| Module | `src/surface/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/surface/types.ts` | `Surface`, `SurfaceNode`, `SurfaceField`, `SurfaceAction`, `defineAction` |
| `src/surface/formats.ts` | Field formats: secret cards, URL and header masking, scrubbing |
| `src/surface/runtime.ts` | `createSurfaceRuntime`: answers `look` and `act`, ledger, notes, state line |
| `src/surface/tools.ts` | `surfaceTools()`, `SURFACE_PROMPT` |

## Protocol

A surface has an `id`, a `revision` that rises with every change, a one-line
`summary`, and `nodes()`, read fresh on every call. The first node is the root,
with id `''`; the agent addresses it by the surface id alone and any other node
as `surface/node`. A node may have `fields()`, `set`, `point` and `actions`.

`look` with no `at` lists every mounted surface (revision, summary, up to 80
nodes, issue counts) and any declared surface that isn't open. `look` at a node
returns its projected fields, what each means (`type`, `doc`, `options`,
`format`, `readOnly`), its issues, its actions with their JSON Schema input,
and its children. Looking at, or acting on, a declared surface that isn't
mounted calls `open(id)` and waits up to `mountWaitMs` (5 s) for it to mount.

`act` runs one action. A node with `set` and `fields` gets the built-in `set`
(input `{ changes }`); one with `point` gets `point` (input `{ field? }`).

| Effect | Means | Needs |
| --- | --- | --- |
| `read` | Changes nothing | — |
| `run` | Does something outside the surface (tests, sends, exports) | — |
| `write` | Changes the surface | `basedOn`, the revision of the agent's last look |

| `status` | When |
| --- | --- |
| `applied` | A write changed the revision; `changed` lists the nodes |
| `unchanged` | A write changed nothing (every change rejected, or no-op) |
| `done` | A `read` or `run` action finished; its `result` rides along |
| `stale` | `basedOn` is not the current revision; nothing ran; `changed` says what moved |
| `refused` | No such node or action, bad input (`rejected`), or a write without `basedOn` |
| `failed` | The action threw; `why` is its message, scrubbed |

A repeated `callId` replays the recorded answer (the ledger keeps 100). A write
action marked `intent: true` replays when the same `intent` reaches the same
node within 60 s, so "start over" applies once. `set` rejects, field by field,
unknown fields, read-only ones (with their reason) and every secret.

`subscribe` lets the runtime note the person's changes (`by: 'person'` in
`changesSince`) through `onNote`; the agent's own are not noted. `settled(callId,
'cancelled' | 'undelivered')` notes once that an applied call's answer was lost.
`stateLine()` is `(state)` plus each surface's revision and summary and the last
five calls.

## Secrets

| Format | What the agent sees |
| --- | --- |
| `secret` | A card: `set`, `looksLike` (from the prefix), `problems` (spaces, line breaks, quotes, placeholder, short), `sameAs` (other secrets with the same value), `usedBy` |
| `url` | The URL with `user:pass@` and credential-named query parameters masked |
| `headers` | The JSON object with credential-named values masked; text that isn't JSON is told only by its length |
| `text` | As is, then scrubbed |

Every answer, state line and note is scrubbed: each secret field's value and
each value from `surface.secrets()` is replaced by `[secret name]`, then the
kernel's sensitive patterns (`sensitiveSpans`) are masked. Strings are capped
at 2,000 characters and long `data` strings are told as `(bytes)`. The agent
can never `set` a secret: it `point`s the person at it and they enter it.

## Exported API

| Export | Role |
| --- | --- |
| `createSurfaceRuntime(options?)` | `{ mount, declare, isSurfaceTool, answer, settled, stateLine }`; options `now`, `open`, `mountWaitMs`, `onNote`, `ledger` |
| `surfaceTools(options?)` | The `look` and `act` function tool definitions, answered by the page (`answeredBy: 'page'`) |
| `SURFACE_PROMPT` | How an agent uses `look` and `act` |
| `SURFACE_TOOL_NAMES` | `['look', 'act']` |
| `defineAction(action)` | Types an action's input, for `SurfaceNode.actions` |
| `secretCard`, `maskUrl`, `maskHeaders`, `scrubText`, `scrubDeep`, `knownSecrets` | The projections, for pages that store or show values themselves |
| Types | `Surface`, `SurfaceNode`, `SurfaceField`, `SurfaceFieldFormat`, `SurfaceAction`, `SurfaceActionContext`, `SurfaceActionOutcome`, `SurfaceAuthor`, `SurfaceChange`, `SurfaceEffect`, `SurfaceIssue`, `SurfaceRejection`, `SecretCard`, `SurfaceRuntime`, `SurfaceRuntimeOptions`, `SurfaceLedgerEntry`, `SurfaceToolsOptions` |

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/surface/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/surface/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Protocol": {
      "supports": [
        { "kind": "source", "path": "src/surface/runtime.ts" },
        { "kind": "contract_test", "path": "tests/surface/runtime.test.ts" }
      ]
    },
    "Secrets": {
      "supports": [
        { "kind": "source", "path": "src/surface/formats.ts" },
        { "kind": "contract_test", "path": "tests/surface/runtime.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/surface/tools.ts" },
        { "kind": "contract_test", "path": "tests/surface/runtime.test.ts" }
      ]
    }
  }
}
```
