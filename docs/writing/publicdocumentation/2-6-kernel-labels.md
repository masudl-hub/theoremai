# Kernel Labels & Errors

Theorem provides overridable, human-safe notices and error messages by default. Every emit-site—from tool activity indicators to terminal failure notices—resolves its copy through a central labels dictionary.

Use this to customize phrasing, localize strings into other languages, or match organizational tone without modifying kernel internals.

---

## Label Resolution Hierarchy

When the kernel needs a user-facing string or prompt note, it resolves the text across three layers:

1. **`profile.labels`**: Profile-specific overrides. Wins over all other definitions for that agent.
2. **`overrideLabels()`**: Process-wide overrides applied across all profiles in the application.
3. **Built-in Defaults**: Fallback strings shipped directly with the kernel.

Templates use `{param}` placeholders replaced at runtime:

```ts
import { defineProfile } from '@theoremjs/agents';

export const freightAssistant = defineProfile({
  type: 'text',
  id: 'freight.assistant',
  // ... identity, models, tools

  labels: {
    'error.timeout': 'The logistics database took too long to answer. Try again in a moment.',
    'error.rate_limit': 'Too many tracking requests. Pausing queries.',
  },

  // ... guardrails, observability
});
```

To replace wording process-wide across all profiles, invoke `overrideLabels()` during application bootstrap:

```ts
import { overrideLabels } from '@theoremjs/agents';

overrideLabels({
  'error.auth': 'Please re-authenticate your terminal session.',
  'error.safety': 'This instruction violates organizational transport safety policies.',
});
```

---

## Error Handling (`TheoremError`)

All kernel exceptions surface as `TheoremError`. This class extends native `Error` and provides structured error categorization:

* **`kind`**: An `ErrorKind` identifying why the operation failed.
* **`message`**: Formatted error message resolved from the labels dictionary.
* **`copy`**: Optional detailed error breakdown for multi-issue failures.

```ts
import { runTurn, TheoremError } from '@theoremjs/agents';

try {
  const events = runTurn({ profile: 'freight.assistant', input: { text: 'Dispatch' } });
  for await (const event of events) { /* ... */ }
} catch (err) {
  if (err instanceof TheoremError) {
    console.error(`Operation failed: [${err.kind}] ${err.message}`);
  }
}
```

---

## Error Kind Reference

The kernel categorizes all failures into 18 stable `ErrorKind` values. HTTP servers derive response status codes directly from these kinds:

| Error Kind | HTTP | Trigger | Default Behavior |
| :--- | :--- | :--- | :--- |
| **`'config'`** | `500` | Profile, tool, or schema setup error. | Thrown during validation or registration. |
| **`'request'`** | `400` | Host invoked the kernel with invalid parameters. | Rejects call immediately. |
| **`'input'`** | `422` | User input violated profile channel constraints. | Rejects turn before model dispatch. |
| **`'action'`** | `403` | User requested an action disallowed by profile. | Refuses action at stage boundary. |
| **`'auth'`** | `401` | Missing, expired, or rejected credentials. | Halts provider dispatch. |
| **`'rate_limit'`** | `429` | Upstream provider or tool quota exceeded. | Emits retryable failure. |
| **`'busy'`** | `503` | Provider is operational but capacity-constrained. | Retryable with exponential backoff. |
| **`'unsupported'`** | `422` | Selected model cannot fulfill requested modality/features. | Rejects provider binding. |
| **`'unavailable'`** | `503` | Upstream provider outage. | Fails turn. |
| **`'bad_response'`** | `502` | Provider returned malformed or unparseable payload. | Emits failure or triggers retry. |
| **`'network'`** | `502` | Network transport dropped before reaching provider. | Resumable if configured in `turnBehaviour`. |
| **`'timeout'`** | `504` | Model or tool took longer than configured limit. | Terminates operation. |
| **`'safety'`** | `422` | Provider safety filter or kernel guardrail blocked content. | Model rewrites if `blockedReply` is configured. |
| **`'blocked'`** | `403` | Host guardrail or policy check stopped an agent step. | Step aborted. |
| **`'declined'`** | `409` | User declined a gated tool action. | Emits tool refusal to model. |
| **`'failed'`** | `502` | Tool executed and threw an unhandled exception. | Formats tool failure into conversation history. |
| **`'cancelled'`** | `499` | Turn was aborted via `AbortSignal` or host hook. | Discards turn execution. |
| **`'internal'`** | `500` | Kernel invariant violation. | Fatal exception. |

---

## Related Guides

* **[Profiles](2-1-profiles.md)**: Declaring profile-level `labels` blocks.
* **[Turn Resumption & Steering](2-4-turn-resumption.md)**: Handling retryable stop reasons like `'provider_error'` and `'stream_incomplete'`.
* **[Lifecycle Hooks & Interception](2-5-lifecycle-hooks.md)**: Handling tool denials and gate triggers in `onStage`.
* **[Guardrails & Sanitize](4-1-the-four-boundaries.md)**: Configured boundary filters and canary leak protection.
