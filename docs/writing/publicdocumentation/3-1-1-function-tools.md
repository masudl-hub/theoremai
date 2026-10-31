# Function Tools

Function tools execute custom TypeScript or JavaScript code in response to a model tool call. They run in your backend process via an async `handler` or directly in the user's browser through `answeredBy: 'page'`.

The kernel enforces [Zod](https://zod.dev) validation on both inputs (before your handler executes) and outputs (before results reach model context).

---

## Registering a Function Tool

Register function tools using `registerTool()` with `type: 'function'`:

```ts
import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';

export const holdStatusTool = registerTool({
  type: 'function',
  name: 'check_hold_status',
  description: 'Look up why a freight shipment is currently on hold.',
  category: 'logistics',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',

  input: z.object({
    shipmentId: z.string().describe('The alphanumeric shipment identifier'),
  }),

  output: z.object({
    status: z.enum(['hold', 'cleared', 'in_transit']),
    reason: z.string(),
  }),

  handler: async (input, ctx) => {
    const record = await fetchShipment(input.shipmentId, { signal: ctx.signal });
    return {
      status: record.status,
      reason: record.holdReason ?? 'No hold applied',
    };
  },
});
```

* `name`: Identifier used by the model to call the tool.
* `description`: Explains to the model what the tool does and when to call it.
* `input`: Zod schema compiled to provider JSON Schema and checked before `handler` runs.
* `output`: Zod schema validating the value returned by `handler`. If validation fails, Theorem refuses the output.

---

## Handler Execution Models

Function tools support two execution models: direct async functions and streaming generators.

### Direct Async Handlers (Default)

The standard handler takes typed `input` and a `ToolContext`, returning the typed `output`:

```ts
handler: async (input, ctx) => {
  const result = await db.query(input.query);
  return { rows: result.rows };
}
```

### Streaming Generator Handlers

For long-running tasks, declare an `async function*` handler to emit real-time progress, draft snippets, or trace steps to the client UI without polluting model prompt context:

```ts
handler: async function* (input, ctx) {
  yield { kind: 'progress', data: { percent: 30, stage: 'Connecting to telemetry' } };
  const trajectory = await computeTrajectory(input.routeId, { signal: ctx.signal });

  yield { kind: 'progress', data: { percent: 100, stage: 'Calculation complete' } };
  yield { kind: 'complete', output: trajectory };
}
```

The client receives real-time progress events, while the model sees only the final `complete` output.

### Browser Tools (`answeredBy: 'page'`)

When an action executes directly in the user's browser (such as querying the DOM, inspecting canvas state, reading `localStorage`/`IndexedDB`, or executing Theorem Surface tools like `look` and `act`), omit the server-side `handler` and declare `answeredBy: 'page'`:

```ts
import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';

export const readViewportSelectionTool = registerTool({
  type: 'function',
  name: 'read_viewport_selection',
  description: 'Read the currently selected elements in the user canvas.',
  category: 'workspace',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',

  answeredBy: 'page', // Omit handler; execution target is the client web page

  input: z.object({}),
  output: z.object({
    selectedIds: z.array(z.string()),
  }),
});
```

#### Contract & Schema Verification

Under the TypeScript `FunctionToolInput` contract, `handler` is required for server functions but omitted when `answeredBy: 'page'`:

```ts
type FunctionToolInput<TIn, TOut> = ... & (
  | { handler: ToolHandler<TIn, NoInfer<TOut>>; answeredBy?: 'page' }
  | { answeredBy: 'page'; handler?: undefined }
);
```

Even though the tool body executes in the browser, the host retains strict schema boundaries. When the browser submits its answer, the kernel unpacks the output and validates it against the tool's Zod `output` schema. If the browser returns malformed data, schema validation fails before the payload reaches the model context.

#### Runtime Dispatch Modes

* **Turn-Based Pausing (`kind: 'page'` gate)**: In standard turn execution without an active coordinator, the turn halts and yields a `ToolGate` with `kind: 'page'`. The frontend executes the DOM query and resumes the turn by passing `page: PageAnswer`.
* **Live Streaming Dispatch (`pageExecution`)**: When a live execution coordinator is mounted on `ToolContext`, execution does not halt at a gate. The kernel emits a `{ phase: 'dispatch', grantId, arguments }` turn event to the client over the stream and awaits `dispatch.result`.

#### Failure States

If the browser cannot complete the call, the client submits a failure variant in `PageAnswer`:
* **`{ timedOut: true }`**: Emits a `tool.page_timed_out` failure to the model.
* **`{ unanswered: true }`**: Emits a `tool.page_no_answer` failure to the model when the browser runtime lacks a registered handler for that tool.

---

## Tool Execution Context (`ToolContext`)

Handlers receive a `ToolContext` carrying host state and runtime affordances:

* **`ctx.signal`**: An `AbortSignal` tied to turn cancellation or client aborts. Pass to database queries or outbound network calls.
* **`ctx.host`**: Opaque host data passed from `runTurn({ host: myContext })`, such as tenant credentials or database pools.
* **`ctx.callId`**: Unique identifier for this specific tool execution.
* **`ctx.traceparent`**: W3C distributed trace header string for parenting downstream telemetry spans.
* **`ctx.signedInFetch`**: Guarded fetch client for authenticated tools (see [Auth & Credentials](3-3-auth-credentials.md)).

---

## Tool Utilities & Output Hooks

### Grounding Sources (`sources`)

When a tool fetches external articles, documentation, or records, attach verified citations using the `sources` hook:

```ts
// ... inside registerTool definition
sources: (output) => [
  {
    title: output.vesselName,
    uri: `https://maritime.registry/vessels/${output.imoNumber}`,
    type: 'record',
  },
],
```

The kernel extracts these sources, emits formal `citation` events to subscribers, and tracks them in the transcript without requiring prompt engineering.

### Unchecked Outputs (`uncheckedOutput`)

When a handler returns dynamic JSON from a remote client or database that TypeScript cannot statically infer against your Zod output schema, TypeScript will refuse to compile the handler return. Use `uncheckedOutput()` to defer type checking to runtime:

```ts
import { uncheckedOutput } from '@theoremjs/agents';

// ... inside handler
const rawPayload: unknown = await remoteClient.fetchBlob();
return uncheckedOutput(rawPayload);
```

The kernel runs your Zod `output` validator against the raw payload before serializing it for the model.

---

## Related Guides

* **[Tools & Execution Pipeline](3-1-tools.md)**: Universal tool attributes, pipeline stages, and dynamic loading.
* **[HTTP Tools](3-1-2-http-tools.md)**: Declarative REST endpoint tools.
* **[Tool Permissions & Gates](3-2-tool-gates.md)**: Human approval gates and `invokeTool()` resumption.
* **[Auth & Credentials](3-3-auth-credentials.md)**: Authenticating function tools with `ctx.signedInFetch`.
