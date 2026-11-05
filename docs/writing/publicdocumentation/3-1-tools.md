# Tools & Execution Pipeline

A tool is code or an external capability that a model can request Theorem to execute. You register tools once in your application scope, then name them in each profile that is permitted to invoke them.

Theorem routes all tool calls through a checked execution pipeline that validates inputs, inspects security boundaries, enforces human approval gates, and verifies output shapes before results reach model context.

---

## Tool Execution Pipeline

When a model requests a tool, Theorem runs the call through five deterministic verification stages:

```mermaid
flowchart LR
    Step1["1. Model Request<br/>(name, arguments)"] --> Step2["2. Validation & Gates<br/>(tools.allow, Zod input, human gate)"]
    Step2 --> Step3["3. Tool Runner<br/>(function, http, mcp, agent)"]
    Step3 --> Step4["4. Result Validation<br/>(Zod output, guardrail check)"]
    Step4 --> Step5["5. Model Context<br/>(verified result in history)"]
```

1. **Step Completion**: The provider stream must conclude without truncation or network drops before pending tool calls are authorized.
2. **Profile Authorization**: The active profile must explicitly list the tool in `profile.tools.allow`.
3. **Input Validation**: Arguments are validated against the tool's `input` Zod schema. Malformed arguments reject the call before any handler executes.
4. **Boundary Inspection & Gates**: Egress guardrails inspect arguments for sensitive data. If `permission` requires human approval, execution pauses with `stop: { kind: 'gate' }`.
5. **Output Verification**: The result returned by the runner is validated against the tool's `output` Zod schema and inspected by ingress guardrails before entering model history.

---

## Tool Types Taxonomy

Theorem categorizes tools into five distinct execution types:

```mermaid
flowchart TD
    subgraph Provider ["Upstream Provider Infrastructure"]
        Builtin["builtin<br/>(Google Search, Code Execution)"]
    end

    subgraph Host ["Host Application & Kernel"]
        Function["function<br/>(Local Handler or UI Page)"]
        HTTP["http<br/>(Declarative REST Endpoint)"]
        MCP["mcp<br/>(Remote Model Context Protocol Server)"]
        Agent["agent<br/>(Sub-Agent Profile Delegation)"]
    end

    Call["Model Tool Request"] --> Router{"Tool Type"}
    Router -->|Provider-native| Builtin
    Router -->|Custom code| Function
    Router -->|Direct API| HTTP
    Router -->|External MCP| MCP
    Router -->|Sub-agent| Agent
```

| Type | Execution Host | Typical Use Case | Guide |
| :--- | :--- | :--- | :--- |
| **`builtin`** | Provider | Native capabilities like Google Search or code execution. Declared in model `builtInTools`. | [Model Bindings](2-2-model-bindings.md) |
| **`function`** | Host Process or Browser | Custom TypeScript/JavaScript logic (`handler`) or browser UI DOM tools (`answeredBy: 'page'`). | [Function Tools](3-1-1-function-tools.md) |
| **`http`** | Kernel HTTP Client | Direct REST API calls with URL parameter mapping, rate limiting, and size caps. | [HTTP Tools](3-1-2-http-tools.md) |
| **`mcp`** | Remote MCP Server | Tools on external servers conforming to the Model Context Protocol, with automatic session pooling. | [MCP Tools](3-1-3-mcp-tools.md) |
| **`agent`** | Kernel Runner | Delegating a task to another registered agent profile (`text`, `image`, or `speech`). | [Agent Tools](3-1-4-agent-tools.md) |

---

## Core Tool Attributes

Every custom tool registered with `registerTool` declares metadata that governs how the kernel classifies, routes, and protects the capability:

* **`access`**: `'read-only'`, `'read-write'`, or `'destructive'`:
  * `'read-only'`: Idempotent queries. The kernel may automatically retry these when upstream services are busy or fail transiently.
  * `'read-write'`: Mutates external state. Never retried automatically.
  * `'destructive'`: Deletes data, executes financial transactions, or performs irreversible actions. Guardrails can restrict or require confirmation for these calls after reading untrusted data.
* **`permission`**: `'auto'`, `'session_consent'`, or `'always_confirm'`:
  * `'auto'`: Executes without human intervention.
  * `'session_consent'`: Requests approval on first use, then runs freely for the duration of the session.
  * `'always_confirm'`: Demands explicit human approval before every execution (see [Tool Permissions & Gates](3-2-tool-gates.md)).
* **`loadTier`**: `'T0'` or `'T2'`:
  * `'T0'`: Core tools loaded into model prompt context at the start of every turn.
  * `'T2'`: On-demand tools loaded selectively at turn start via `tools.t1Policy` or mid-turn via a `tools.t2Loader` tool.
* **`paths`**: String array restricting tool availability to specific turn paths (e.g., `['claims']`). Use `['*']` to make the tool available on all paths. When a turn specifies `runTurn({ path: 'claims' })`, only tools whose `paths` include `'claims'` or `'*'` are offered to the model.
* **`category`**: Custom classification label for host-side organization.

---

## Direct Tool Execution (`runTool` vs `invokeTool`)

Theorem exposes two programmatic entry points for executing registered tools outside an active model turn:

* **`invokeTool(request)`**: Returns an async generator (`AsyncGenerator<TurnEvent>`) yielding incremental lifecycle events (start, progress, completion, citations) as the tool executes. Ideal for streaming progress to user interfaces or resuming held tool gates.
* **`runTool(request)`**: A Promise-based alternative returning `Promise<ToolCallResult>` that settles only when the tool finishes, delivering its final validated output and status directly. Ideal for backend batch operations and headless integrations.

---

## Dynamic Tool Loading & Profile Binding

A registered tool belongs to no profile until allowed. Profiles declare allowed tools and configure on-demand loading policies in `profile.tools`:

```ts
import { defineProfile } from '@theoremjs/agents';

export const logisticsAgent = defineProfile({
  type: 'text',
  id: 'harbor.logistics',
  // ... identity, models

  tools: {
    allow: ['check_hold_status', 'lookup_vessel', 'load_tools', 'issue_refund'],
    
    // Evaluate at turn start: load claims tools only on claims path
    t1Policy: ({ path }) => (path === 'claims' ? ['issue_refund'] : []),

    // Tool the model can call mid-turn to load additional T2 tools on demand
    t2Loader: 'load_tools',
  },

  // ... guardrails, observability
});
```

* **`allow`**: The complete list of tool IDs permitted for this profile. For zero tools, write `{ allow: [] }`.
* **`t1Policy`**: A host function called at the start of every turn. It receives `ToolLoadContext` (`path`, `input`, `host`) and returns an array of `T2` tool names to load for this exchange. You can import your own routing logic here—such as rule-based heuristics, keyword matching, or embedding similarity search.
* **`t2Loader`**: Names a function tool the model can call mid-turn when its current toolset is insufficient. The loader tool executes host search logic and returns `{ loaded: [...] }` with the newly loaded tool names.

Live and host profiles ignore `loadTier` and load all allowed tools at turn start.

---

## Tool Types In Detail

* **[Function Tools](3-1-1-function-tools.md)**: Local JavaScript/TypeScript handlers, streaming generators, browser UI tools (`answeredBy: 'page'`), `ToolContext`, grounding citations (`sources`), and `uncheckedOutput`.
* **[HTTP Tools](3-1-2-http-tools.md)**: Declarative REST endpoints, URL mapping (`pathParams`, `queryParams`, `bodyParam`), rate limits, timeout controls, and multimodal image extraction (`images`).
* **[MCP Tools](3-1-3-mcp-tools.md)**: Model Context Protocol integration, server endpoints, and native MCP session pooling (`session.idleMs`, `session.max`, LRU eviction, parallel open deduplication).
* **[Agent Tools](3-1-4-agent-tools.md)**: Delegating to registered agent profiles, input/output schema derivation, `maxCallsPerTurn`, isolation, and `onAgentCall` interception.

---

## Related Guides

* **[Tool Permissions & Gates](3-2-tool-gates.md)**: Configuring `session_consent`, `always_confirm`, and approval lifecycles.
* **[Auth & Credentials](3-3-auth-credentials.md)**: Authenticating tools via OAuth, API keys, and `signedInFetch`.
* **[Liquid Tool Labels](3-4-liquid-labels.md)**: Dynamic transcript activity labels with conditional formatting.
