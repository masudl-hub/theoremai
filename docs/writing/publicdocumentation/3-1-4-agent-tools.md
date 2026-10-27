# Agent Tools

An `agent` tool runs one complete turn of another registered agent profile and returns its reply to the caller. This enables specialized agents—such as a customs compliance advisor or an image generator—to act as modular capabilities within an orchestrator's workflow.

Unlike traditional tool definitions, an agent tool requires no custom handler code. Theorem automatically infers input and output schemas directly from the target profile's declared contract.

---

## Registering an Agent Tool

Register agent tools using `registerTool()` with `type: 'agent'`:

```ts
import { registerTool } from '@theoremjs/agents';

export const customsSubAgentTool = registerTool({
  type: 'agent',
  name: 'consult_customs_specialist',
  description: 'Consult the customs specialist on import tariffs and necessary cargo paperwork.',
  category: 'logistics',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',

  profile: 'harbor.customs',
  maxCallsPerTurn: 2, // Limit sub-agent invocations per caller turn
});
```

* **`profile`**: The registered profile ID of the sub-agent.
* **`maxCallsPerTurn`**: Maximum number of times the calling model may invoke this sub-agent in a single exchange.

---

## Automatic Schema Derivation

Because the sub-agent is already a declared profile, Theorem derives the tool's schemas automatically:

* **Input Schema**: The tool takes `text`, plus any additional channels the target profile declares in `inputs` (such as `attachments`, `voice`, `slots`, and `speech`).
* **Output Schema**: The tool returns the target agent's response payload—including its `text`, `structured` JSON output, citations (`sources`), and media parts.

---

## Architectural Delegation Rules

Every agent tool must follow four invariants enforced by the kernel:

1. **Registration Order**: The target profile must be registered before the agent tool is registered.
2. **Modality Support**: The target profile must be a `text`, `image`, or `speech` profile that accepts text input.
3. **Zero Gated Tools**: None of the target agent's own tools may stop for human confirmation or sign-in gates. Every tool available to the sub-agent must have `permission: 'auto'`.
4. **Context Isolation**: The caller's ambient host data (`ctx.host`) is not inherited by the sub-agent. The child agent runs with isolated host state unless explicitly provided by the caller's request hook.

---

## Channel & Field Governance

To govern how the calling model interacts with the sub-agent, configure field and channel rules directly on the agent tool definition:

### Reserving Channels (`hostOnly`)

If the target profile accepts channels that the calling model should not manipulate (such as private session slots or enterprise documents), designate them as `hostOnly`:

```ts
// ... inside agent tool definition
hostOnly: ['slots', 'attachments'],
```

The calling model sees only the `text` field. Only your host hook can supply the reserved channels.

### Host-Only Model Fields (`hostFields`)

Declare fields that the calling model fills, but only the host application reads:

```ts
import { z } from 'zod';

// ... inside agent tool definition
hostFields: {
  billingAccount: z.string().describe('Billing account code for this consultation'),
},
```

The kernel extracts `billingAccount` into `hostInput` for `onAgentCall` and strips it before the child agent runs.

## Host Interception (`onAgentCall`)

When an agent invokes an agent tool, Theorem invokes the request's `onAgentCall` hook before the child turn runs. The hook receives an `AgentCall` descriptor carrying the tool name, target profile, model arguments, and any `hostInput` values from `hostFields`.

The hook can approve execution as-is, return `{ refuse: string }` to report a tool error back to the caller model, or return an `AgentCallRequest` to reshape arguments, limit delegation depth, or inject isolated credentials into the child agent's `ctx.host`.

For complete `onAgentCall` interceptor patterns, see [Lifecycle Hooks & Interception](2-5-lifecycle-hooks.md).

---

## Related Guides

* **[Tools & Execution Pipeline](3-1-tools.md)**: Universal tool attributes, pipeline stages, and dynamic loading.
* **[Profiles](2-1-profiles.md)**: Declaring agent profiles and modality configurations.
* **[Lifecycle Hooks & Interception](2-5-lifecycle-hooks.md)**: Detailed `onAgentCall` hook specifications.
