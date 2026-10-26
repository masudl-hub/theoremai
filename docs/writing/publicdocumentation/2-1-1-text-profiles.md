# Text Profiles & runTurn()

Text profiles (`type: 'text'`) configure conversational agents that reason across multi-step tool loops, stream incremental text, and optionally enforce structured JSON schemas. They are invoked through `runTurn()`, which dispatches the request to the bound model, executes permitted tools, validates output contracts, and yields real-time execution events.

---

## Text Profile Configuration

Base profile fields (`identity`, `models`, `tools`, `guardrails`, `observability`) apply across all modalities as documented in [Profiles](2-1-profiles.md). By default, text profiles generate conversational markdown and text streams. Text profiles can optionally configure structured output contracts (`outputs.structured`) and tool-loop step limits (`turnBehaviour.atStepLimit`):

```ts
import { defineProfile } from '@theoremjs/agents';

export const customsAuditor = defineProfile({
  type: 'text',
  id: 'harbor.customs_auditor',
  // ... identity, models, tools, inputs

  // Optional: Enforce a validated JSON shape instead of freeform text
  outputs: {
    structured: 'customs_declaration_v1',
    validation: {
      fields: {
        'declaration.trackingNumber': async (candidate) => {
          const isValid = /^TRK-[A-Z0-9]{8}$/.test(String(candidate));
          return isValid
            ? { isValid: true }
            : { isValid: false, error: 'Tracking number must match TRK-XXXXXXXX' };
        },
      },
      items: {
        'declaration.manifestItems': {
          check: async (item, turn) => {
            // Corroborate item against data returned by tools earlier in this turn
            const code = (item as { hsCode?: string }).hsCode;
            const knownCodes = turn.toolResults.flatMap((r) =>
              Array.isArray((r.output as { validCodes?: string[] })?.validCodes)
                ? (r.output as { validCodes: string[] }).validCodes
                : [],
            );
            return knownCodes.includes(code ?? '')
              ? { isValid: true }
              : { isValid: false, error: `Unverified HS code: ${code}` };
          },
          onFail: 'fix', // 'fix' asks the model to rewrite refused items; 'drop' removes them
        },
      },
      maxRetries: 2,
    },
  },

  turnBehaviour: {
    // Action taken when tool steps reach profile.maxSteps
    atStepLimit: 'answer', // 'answer' strips tools on the final step to force a summary; 'stop' halts immediately
  },

  // ... guardrails, observability, labels
});
```

---

## Structured Output Contracts

By default, text agents return conversational prose. When an application requires guaranteed data shapes, declare `outputs.structured`.

Theorem enforces structured outputs across two distinct boundaries: upstream model decoding and host-side business validation.

```mermaid
flowchart TD
    Model["Model Completion"] --> Gram["Layer 1: Upstream Schema Enforcement<br/><i>registerStructured</i>"]
    Gram -- Syntax or type invalid --> RetryGram["Provider Rejection"]
    Gram -- Valid JSON shape --> Host["Layer 2: Host Domain Validation<br/><i>outputs.validation</i>"]
    Host -- Corroborates toolResults & format --> Pass["Emit { type: 'structured' }"]
    Host -- Business rule failed --> Policy{"onFail Policy"}
    Policy -- onFail: 'fix' --> Rewrite["Re-prompt model for invalid items only (up to maxRetries)"]
    Policy -- onFail: 'drop' --> Strip["Remove invalid items from array & emit remainder"]
```

### Schema Registration

Structured outputs reference registered JSON schemas. Define and register the schema in the kernel registry before binding it to a profile:

```ts
import { registerStructured } from '@theoremjs/agents';

registerStructured('customs_declaration_v1', {
  jsonSchema: {
    type: 'object',
    properties: {
      declaration: {
        type: 'object',
        properties: {
          trackingNumber: { type: 'string' },
          manifestItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                hsCode: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['hsCode', 'description'],
            },
          },
        },
        required: ['trackingNumber', 'manifestItems'],
      },
    },
    required: ['declaration'],
  },
});
```

### Upstream Schema Enforcement

When `outputs.structured` specifies a registered schema ID, Theorem instructs the upstream provider to constrain token generation to matching JSON (via OpenAI `response_format`, Gemini `responseSchema`, or tool-calling fallback).

This guarantees **grammar and types**: `trackingNumber` will always be a string, and `manifestItems` will always be an array. However, the model provider cannot execute application code, inspect external databases, or cross-reference facts against tool responses. A model can return syntactically valid JSON containing invented tracking numbers or fictitious manifest items.

### Host Validation & Targeted Repair

The `validation` block provides deterministic enforcement in your application process after the JSON is produced:

* **`fields` (Format & Domain Constraints)**: Dotted paths to specific scalar properties. Use this to verify checksums, test regex formats, or query databases.
* **`items` (Tool Corroboration)**: Dotted paths to array properties. The validator receives the individual array item and the `turn` context, including `turn.toolResults`. Use this to verify that items listed in the model's structured answer match the data returned by tools executed earlier in the turn.
* **`onFail` (Surgical Remediation)**: When a list item fails its check:
  * `'fix'`: Theorem asks the model to rewrite *only the defective items*, preserving all valid items and avoiding full completion regenerations.
  * `'drop'`: Theorem strips invalid items from the array and continues.
* **`maxRetries`**: Limits the number of repair round-trips before the turn emits whatever valid elements settled.

### Dynamic Schema Selection by Turn Slot

For profiles handling multiple document types, `structured` accepts a slot-mapped dictionary:

```ts
outputs: {
  structured: {
    by: 'declarationType',
    map: {
      freight: 'freight_declaration_v1',
      passenger: 'passenger_declaration_v1',
    },
    fallback: 'general_declaration_v1',
  },
}
```

When slot mapping is declared, Theorem reads `TurnRequest.input.slots[by]` to select the schema. If the slot matches a key in `map`, that schema is applied; otherwise, it defaults to `fallback`.

---

## Step Limit Handling

When an agent calls tools, each round of model generation and tool execution consumes one step against `profile.maxSteps`. The `turnBehaviour.atStepLimit` setting determines the terminal policy when `maxSteps` is reached:

| Mode | Behavior | Use Case |
| :--- | :--- | :--- |
| **`'stop'`** *(default)* | Halts execution immediately. The turn terminates with `stop: 'step_limit'` and returns the current state. | Strict execution budgets or automated pipelines requiring deterministic step ceilings. |
| **`'answer'`** | On the final permitted step, Theorem suppresses all tool definitions from the model prompt. The model cannot call additional tools and must write a textual response synthesizing accumulated evidence. | User-facing assistants that must deliver a partial answer rather than a blank halt when research takes too many steps. |

When using `atStepLimit: 'answer'`, `profile.maxSteps` must be set to `2` or higher during registration to allow at least one step for tool calling before the answer step.

---

## Invoking Text Profiles: `runTurn()`

Text profiles are executed using `runTurn()`. The runner returns an async generator yielding incremental `TurnEvent` objects as execution progresses.

### Basic Invocation

You only need to handle the events your application requires. For example, streaming text to the terminal and reading the final structured output:

```ts
import { runTurn } from '@theoremjs/agents';

const events = runTurn({
  profile: 'harbor.customs_auditor',
  input: {
    text: 'Audit declaration #TRK-88294100 against manifest rules.',
    slots: { declarationType: 'freight' },
  },
  system: 'Treat declaration flags with high scrutiny for port authority compliance.', // One-off instruction for this turn
  path: 'customs', // Offer only tools whose paths include 'customs' or '*'
});

for await (const event of events) {
  if (event.type === 'text') {
    process.stdout.write(event.text);
  }
  if (event.type === 'structured') {
    console.log('\nValidated Declaration:', event.structured);
  }
}
```

* **`system`**: Appends dynamic, one-off instructions to this turn alone without mutating the profile's permanent `identity.system`.
* **`path`**: Selects the execution channel, exposing only registered tools declaring this path or wildcard (`paths: ['*']`).

Because `runTurn()` returns an async generator, execution begins when the caller pulls the first event.

---

### Turn Event Catalog

For full-featured conversational interfaces, `runTurn()` emits granular lifecycle events throughout the turn:

| Event Type | Key Payload | Description |
| :--- | :--- | :--- |
| **`text`** | `text: string` | Incremental completion text token delta. |
| **`thought`** | `text: string` | Incremental internal reasoning token delta (when `streaming.streamThoughts` is enabled). |
| **`tool`** | `tool: ToolCallEvent` | Tool execution updates: emitted when a tool call starts (`input`) and when it finishes (`output`). |
| **`structured`** | `structured: unknown` | Verified JSON object matching the registered schema and passing all host checks. |
| **`stage`** | `stage: TurnStage` | Lifecycle transitions: `'pre_turn'`, `'pre_tool'`, `'post_tool'`, `'before_end'`, `'post_turn'`. |
| **`done`** | `stop: TurnStop`, `tokens?: TurnTokens` | Terminal event emitted when the turn concludes, reporting stop reasons and token counts. |
| **`error`** | `errorKind: ErrorKind`, `error?: string` | Emitted if an unhandled boundary violation or execution error halts the turn. |

---

## Related Guides

* **[Profiles](2-1-profiles.md)**: Universal profile identity, model bindings, inputs, and registry lifecycle.
* **[Defining Tools](3-1-tools.md)**: Declaring parameter schemas, credentials, and execution handlers for tools.
* **[Turn Resumption & Steering](2-4-turn-resumption.md)**: Resuming turns from tool gates, continue tokens, and mid-turn user steering.
