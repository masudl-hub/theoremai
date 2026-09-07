# Tool system migration

Ground-up tool registry rebuild (2026). **No compatibility shims.** Hosts must
migrate once; after that the model is simpler and enforcement is consistent.

Spec: `tmp/specs/tool-system.md` (working design notes — not published docs)

---

## Breaking API removals

| Removed | Replacement |
| --- | --- |
| `TurnRequest.tools` (per-id gates) | `tools.allow` / `builtInTools` + `loadTier` |
| `TurnRequest.dynamicToolLoader` | `tools.t2Loader` function returning `{ loaded }` |
| `TurnRequest.toolInvoke` | `invokeTool({ profile, name, input, … })` |
| `executeTool(profile, name, args)` | Stream events via `runTurn` / `invokeTool` |
| `ToolEnvelope` (`status` / `finding` / `data`) | `TurnEvent.tool.phase` (`complete`, `pause`, `error`, …) |
| `askUser` catalog builtin | `ask_user` harness tool (`registerHarnessTools`) |
| Per-turn `loadTier` / `permissionTier` on declarations | `loadTier` / `permission` on each registered tool |
| Per-turn `dynamicToolLoader` (T2 schemas) | `tools.t2Loader` + `{ loaded }` |
| Per-turn T1 conditional wiring | `profile.tools.t1Policy` |
| `TurnRequest.toolLoader` | `profile.tools.t1Policy` |
| Hand-authored JSON Schema on turns | Zod `input` / `output` at registration |
| `CATALOG.tools` monolith | `registerTool`, `getTool`, `listTools` |

---

## Host migration checklist

### 1. Startup — register once

```ts
import { z } from 'zod';
import { registerTool, registerHarnessTools } from 'theorum';

registerHarnessTools(); // ask_user, etc.

registerTool({
  type: 'function',
  name: 'lookup_order',
  description: '…',
  category: 'operations',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'session_consent',
  input: z.object({ orderId: z.string() }),
  output: z.object({ finding: z.string() }),
  handler: async (input) => ({ finding: `…` }),
});
```

Add **`zod`** as a dependency (`^4.1.8` peer on npm). Tool wire schemas are derived at registration via Zod 4's native `z.toJSONSchema()` (`input` mode for parameters, `output` mode for result schemas).

### 2. Profile — allow customs; model lists builtins

```ts
tools: {
  allow: ['lookup_order', 'load_tools', 'deferred_lookup'],
  t2Loader: 'load_tools', // optional — function that returns { loaded }
}
// model.config.*.builtInTools: ['googleSearch']
```

Set **`loadTier`** on each registered tool (`T0` / `T1` / `T2`).

### 3. Turn — no per-tool gate

Eligibility is allow / `builtInTools`. Visibility is `loadTier` (+ `tools.t1Policy` for T1, `tools.t2Loader` for T2).

```ts
runTurn({
  profile: 'my.bot',
  sessionPermissions: ['lookup_order'], // session_consent tools
  path: 'web', // catalog path filter
  input: { text: '…' },
}, provider);
```

### 4. Pause resume — `invokeTool`

When `done.stop.kind === 'tool'`:

```ts
invokeTool({
  profile: 'my.bot',
  name: 'delete_resource',
  input: originalArgs,
  resume: { granted: true }, // always_confirm
  // resume: { value: userAnswer }, // ask_user / interactive
});
```

`resume` **skips** eligibility (`not_gated`) when `value` or `granted` is set. It does
**not** bypass T1/T2 load checks — ensure `tools.t1Policy` / `promoted` cover resume when needed.
T0 paused calls may resume without rebuilding the snapshot. Direct invoke requires the
tool on `tools.allow`.

### 5. Turn continue — `continueFrom` (not tool pause)

For `length`, `stream_incomplete`, `provider_error`:

```ts
runTurn({
  profile: 'my.bot',
  continueFrom: { stop: previousDone.stop, partialText: '…' },
  input: { text: '…' },
}, provider);
```

Do **not** use `continueFrom` for tool pauses — use `invokeTool`.

---

## Behavior changes (not bugs)

- **`always_confirm`** ignores `sessionPermissions`; only `resume.granted === true` bypasses.
- **`canExecute` returning a pause envelope** — use `preflight` returning a `ToolPause` instead.
- **T2 promotion** — only the designated `tools.t2Loader` function may promote **pre-registered** ids in `allow`.
- **Tool descriptions** — no per-turn `sanitizeDynamicTools`; sanitize at registration if needed.

---

## Event mapping (old → new)

| Old `ToolEnvelope` | New stream |
| --- | --- |
| `status: 'ok'` | `tool.phase: 'complete'` |
| `status: 'pause'` | `tool.phase: 'pause'` (+ `pause.kind`) |
| `status: 'error'` | `tool.phase: 'error'` (+ `failure.code`) |

Model-facing results use `formatToolResult` internally; hosts
consume `TurnEvent`s and traces, not envelopes.

---

## Deferred (not in v1)

- `registerExternalToolProvider` (MCP / external dynamic tools)
