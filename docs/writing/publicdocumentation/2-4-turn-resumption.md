# Turn Resumption & Steering

Not every agent turn runs from start to finish in a single uninterrupted pass. A model may exhaust its output token budget mid-sentence, a critical tool action may pause for human approval, or a user might need to redirect an agent while it is executing a multi-step research loop.

The `turnBehaviour` configuration governs how Theorem manages these pauses—enabling automated continuations, human approval gates, and mid-turn user steering.

---

## Turn Behavior Configuration

Base profile fields (`identity`, `models`, `tools`, `guardrails`, `observability`) apply across all modalities as documented in [Profiles](2-1-profiles.md). Text profiles declare a `turnBehaviour` block to configure continuation rules, steering affordances, and step limits:

```ts
import { defineProfile } from '@theoremjs/agents';

export const logisticsDesk = defineProfile({
  type: 'text',
  id: 'harbor.desk',
  // ... identity, models, tools

  turnBehaviour: {
    resumption: {
      allowContinue: ['length', 'stream_incomplete', 'provider_error'],
      autoContinue: ['stream_incomplete'], // Auto-retry dropped streams without prompting
      maxContinues: 3,
    },
    allowSteering: true, // Allow user mid-turn steering and stage message injection
    atStepLimit: 'answer',
  },

  // ... guardrails, observability, labels
});
```

* **`resumption`**: Governs how truncated or failed model completions are continued.
* **`allowSteering`**: Enables injecting user instructions into a running turn while tools are executing.
* **`atStepLimit`**: Defines terminal behavior when a tool loop reaches `profile.maxSteps`.

---

## Continuing Incomplete Replies

Completions can halt prematurely when reaching output token budgets or when network streams drop. Theorem standardizes continuation across three stop reasons (`ContinueStopKind`):

* **`'length'`**: The model reached its `maxOutputTokens` limit mid-completion.
* **`'stream_incomplete'`**: The transport connection dropped before the provider sent final tokens.
* **`'provider_error'`**: The provider returned a transient gateway error or timeout.

### Manual vs. Automated Continuations

The `resumption` block controls whether recoveries are automatic or require user confirmation:

* **`allowContinue`**: Lists stop kinds for which your frontend UI should display a "Continue" button. The kernel allows manual continuation calls after these stops.
* **`autoContinue`**: Lists stop kinds that Theorem resumes automatically without user intervention. When set, dropped connections retry immediately up to `maxContinues`.
* **`maxContinues`**: Maximum number of continuation attempts permitted for a single exchange (default: `1`).

### Executing a Continuation Turn

To continue a truncated text turn, call `runTurn()` with `continueFrom`, increment the 1-based `continuation` count, and place the partial text reply at the end of `input.history`:

```ts
import { runTurn } from '@theoremjs/agents';

const continuedEvents = runTurn({
  profile: 'harbor.desk',
  continueFrom: { stop: previousDoneEvent.stop },
  continuation: 1,
  input: {
    history: [
      ...previousMessages,
      { role: 'assistant', text: partialReplyText },
    ],
  },
});

for await (const event of continuedEvents) {
  if (event.type === 'text') {
    process.stdout.write(event.text);
  }
}
```

The model reads the partial assistant text from history and resumes generating directly from where it stopped.

---

## Tool Action Gates

When a tool requires human confirmation or session consent, Theorem halts the turn before tool execution begins with `stop: { kind: 'gate' }` and captures the pending call in `done.tools: TurnToolSnapshot`.

Unlike incomplete model replies, held tool calls are not resumed with `continueFrom`. Instead, your frontend application collects the user's approval and resumes or declines execution using `invokeTool()`.

For approval cards, argument modification, and gate resumption patterns, see [Tool Permissions & Gates](3-2-tool-gates.md).

---

## Mid-Turn Steering

When `turnBehaviour.allowSteering` is set to `true` (default for `text` profiles), users can guide or redirect an in-flight turn without cancelling the operation.

In long multi-step workflows, waiting for an agent to finish multiple research steps before correcting a misunderstanding wastes time and token quota. Steering allows the client application to inject corrective guidance while the agent is actively executing tools or preparing its next step.

### How Steering Works

1. **Stage Boundaries**: Theorem emits `stage` events (`'pre_turn'`, `'pre_tool'`, `'post_tool'`, `'before_end'`, `'post_turn'`). Steering messages are applied at the nearest stage boundary.
2. **Context Preservation**: Existing tool results and conversation history remain intact; the steering message is appended as a high-priority user instruction.
3. **Non-Destructive**: Unlike an abort signal (`signal.abort()`), steering does not tear down connection state or discard accumulated work.

---

## Stop Reason Reference

Every turn emits a terminal `done` event containing a `stop: TurnStop` object. The `stop.kind` property identifies why the turn concluded:

| Stop Kind | Category | Description | Resumption Method |
| :--- | :--- | :--- | :--- |
| **`'completed'`** | Normal | The model generated a natural completion token. | None; turn finished. |
| **`'length'`** | Resumeable | Output hit the model's `maxOutputTokens` budget. | `runTurn({ continueFrom })` |
| **`'stream_incomplete'`** | Resumeable | Connection dropped before the provider sent final tokens. | `runTurn({ continueFrom })` or `autoContinue` |
| **`'provider_error'`** | Resumeable | Provider returned a transient error or gateway timeout. | `runTurn({ continueFrom })` or `autoContinue` |
| **`'tool'`** | Tool Hold | Model requested tool calls returned in `done.tools`. | `invokeTool({ snapshot })` |
| **`'gate'`** | Tool Hold | Tool execution was held pending human approval. | `invokeTool({ snapshot, resume })` |
| **`'step_limit'`** | Budget | Tool loop exhausted `profile.maxSteps` with no answer. | None (prevent via `atStepLimit: 'answer'`) |
| **`'filtered'`** | Safety | Output blocked by boundary guardrails or provider filters. | Model rewrites if `guardrails.blockedReply` is configured |
| **`'cancelled'`** | Aborted | Turn was aborted by `signal.abort()` or stage abort. | None; state discarded. |

---

## Related Guides

* **[Profiles](2-1-profiles.md)**: Universal profile identity, model bindings, inputs, and registry lifecycle.
* **[Text Profiles](2-1-1-text-profiles.md)**: Conversational agents, output schemas, and `atStepLimit` policies.
* **[Defining Tools](3-1-tools.md)**: Declaring gates (`auto`, `session_consent`, `always_confirm`) on tool definitions.
* **[Lifecycle Hooks & Interception](2-5-lifecycle-hooks.md)**: Using `onStage` and `onAgentCall` to observe and modify running turns.
