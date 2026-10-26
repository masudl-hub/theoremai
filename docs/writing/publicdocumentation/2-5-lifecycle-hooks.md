# Lifecycle Hooks & Interception

Large language models predict next tokens and generate tool calls, but they operate without awareness of host process boundaries, enterprise security policies, or out-of-band audit requirements. Placing security and telemetry checks inside model system prompts is fragile and consumes valuable token budget.

Theorem provides two deterministic interception hooks that execute in the host environment outside the model's token context:
* **`onStage`**: Observes turn milestones and applies host directives (denying tools, mutating inputs, requiring confirmation, or injecting messages).
* **`onAgentCall`**: Intercepts, shapes, or refuses delegations when an agent invokes a nested sub-agent tool.

---

## Stage Interception (`onStage`)

Pass an `onStage` callback to `runTurn()` or `runSession()` to intercept execution at defined lifecycle milestones:

```ts
import { runTurn, type StageContext, type StageResult } from '@theoremjs/agents';

const events = runTurn({
  profile: 'harbor.desk',
  input: { text: 'Audit container CONT-9941' },
  onStage: async (ctx: StageContext): Promise<StageResult | undefined> => {
    if (ctx.stage === 'pre_tool' && ctx.tool === 'delete_record') {
      return { deny: { code: 'FORBIDDEN', message: 'Destructive actions are prohibited.' } };
    }
  },
});
```

### Lifecycle Stages & Affordances

A turn moves through up to five lifecycle stages in sequence. The handler receives a `StageContext` and can return a `StageResult` containing permitted affordances for that milestone:

| Stage | Trigger & Context | Permitted Affordances (`StageResult`) |
| :--- | :--- | :--- |
| **`'pre_turn'`** | Fires before dispatching input to the provider. `ctx.history` contains existing messages. | `inject`, `abort` |
| **`'pre_tool'`** | Fires after the model requests tools, before handlers execute. `ctx.stepCalls` lists all calls in the step. | `abort`, `deny`, `confirm`, `mutate`, `waitFor` |
| **`'post_tool'`** | Fires after a tool settles or fails. `ctx.outputRaw`, `ctx.outputModel`, and `ctx.failure` are populated. | `inject`, `abort`, `deny`, `mutate`, `labelFailed` |
| **`'before_end'`** | Fires after final reply generation, before guardrail verdict and history commit. `ctx.reply` contains the draft answer. | `inject`, `abort` |
| **`'post_turn'`** | Fires after all generation, tool loops, and cleanup finish, right before `done`. | *(None — read-only telemetry)* |

### Tool Gate Escalation (`confirm`)

At `pre_tool`, a stage handler can dynamically escalate an un-gated tool call to require human approval:

```ts
// ... inside onStage
if (ctx.stage === 'pre_tool' && ctx.tool === 'transfer_funds') {
  const amount = Number((ctx.input as { amount?: number })?.amount ?? 0);
  if (amount > 10000) {
    return {
      confirm: { summary: `Authorize wire transfer of $${amount}?` },
    };
  }
}
```

When returned, Theorem halts execution immediately with `stop: { kind: 'gate' }` and preserves the pending action in `done.tools` for later resumption via `invokeTool()`.

### Parallel Tool Coordination (`waitFor`)

When a model requests multiple tools in a single step, they execute concurrently by default. To enforce dependency order without failing the turn, return `waitFor` with the IDs of prerequisite calls:

```ts
// ... inside onStage
if (ctx.stage === 'pre_tool' && ctx.tool === 'generate_report') {
  const queryCalls = ctx.stepCalls?.filter((c) => c.tool === 'run_query').map((c) => c.callId);
  if (queryCalls && queryCalls.length > 0) {
    return { waitFor: queryCalls };
  }
}
```

The kernel holds `generate_report` until all identified query calls complete.

---

## Sub-Agent Interception (`onAgentCall`)

An agent tool (`type: 'agent'`) delegates a subtask to another registered profile. When an agent's model requests an agent tool, Theorem invokes `onAgentCall` before dispatching the child turn.

The host hook receives an `AgentCall` descriptor:
* **`tool`**: Name of the agent tool being invoked.
* **`profile`**: Target profile ID configured to run the sub-agent.
* **`caller`**: Profile ID of the agent making the request.
* **`depth`**: Nesting depth (starts at `1` for direct child agents).
* **`input`**: Model-generated arguments destined for the sub-agent.
* **`hostInput`**: Model-generated values for tool `hostFields`. These fields are consumed only by `onAgentCall` and are stripped before child agent dispatch.

### Refusing or Reshaping Child Turns

The hook returns one of three outcomes:
1. **`undefined`**: Executes the child agent turn with the caller's arguments as-is.
2. **`{ refuse: string }`**: Rejects the delegation. Theorem returns the refusal message to the calling model as a tool error.
3. **`AgentCallRequest`**: Reshapes the child invocation—overriding inputs, swapping models, attaching isolated stage handlers, or passing credentials via `host`.

```ts
import { runTurn, type AgentCall, type AgentCallRequest } from '@theoremjs/agents';

const events = runTurn({
  profile: 'research.orchestrator',
  input: { text: 'Investigate vessel manifests.' },
  onAgentCall: async (call: AgentCall): Promise<AgentCallRequest | { refuse: string } | undefined> => {
    // Prevent unbounded sub-agent recursion
    if (call.depth > 2) {
      return { refuse: 'Sub-agent recursion depth exceeded.' };
    }

    // Isolate tenant credentials into the child turn's host context
    return {
      host: { tenantId: 'tenant-cargo-01' },
      metadata: { parentCallId: call.callId },
    };
  },
});
```

---

## Related Guides

* **[Turn Resumption & Steering](2-4-turn-resumption.md)**: Handling tool gates, `continueFrom` executions, and `allowSteering` settings.
* **[Defining Tools](3-1-tools.md)**: Declaring function, MCP, HTTP, and agent tools.
* **[Host Profiles](2-1-7-host-profiles.md)**: Executing model-less tools directly using `invokeTool()`.
* **[Guardrails & Sanitize](4-1-the-four-boundaries.md)**: Declarative boundary filters applied before and after generation.
