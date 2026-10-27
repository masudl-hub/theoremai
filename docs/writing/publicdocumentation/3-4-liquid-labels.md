# Liquid Tool Labels

Model tool calls execute on structured JSON payloads, but end users and UI transcripts need human-readable status text. Showing raw function names and JSON objects creates cluttered interfaces and confusing approval cards.

Theorem tools declare dynamic, typed label templates directly in their definitions. Templates extract arguments, format numbers and dates, evaluate conditional rules, and join compound statements—all verified against your Zod schemas at startup.

---

## Label Slots

A tool's `labels` block provides templates for four distinct lifecycle states:

```ts
import { registerTool } from '@theoremjs/agents';
import { z } from 'zod';

export const holdStatusTool = registerTool({
  type: 'function',
  name: 'check_hold_status',
  // ... access, loadTier, permission, handler

  labels: {
    activity: 'checking status of shipment {shipmentId}',
    activityPast: 'found {status} record for {shipmentId}',
    activityFailed: 'could not check shipment {shipmentId}',
    request: 'check status of shipment {shipmentId}',
  },

  input: z.object({ shipmentId: z.string() }),
  output: z.object({ status: z.string(), destination: z.string() }),
});
```

| Slot | Display Trigger | Available Variables |
| :--- | :--- | :--- |
| **`activity`** | Displayed while the tool is executing (spinner line). | `input` |
| **`activityPast`** | Displayed once the tool completes successfully in the transcript. | `input` and `output` |
| **`activityFailed`** | Displayed when the tool throws an unhandled error or fails. | `input` |
| **`request`** | Displayed on human confirmation cards when the tool hits an approval gate. | `input` |

If a label is omitted, Theorem falls back to formatting the tool's name in natural words (e.g., `check_hold_status` becomes `"check hold status"`).

---

## Value Placeholders & Formatting

Wrap field names in curly braces `{path}` to insert values from the call:

* **Object Paths**: `{shipmentId}`, `{recipient.address.city}`
* **Array Indexing**: `{items.0.title}`, `{containers.-1.id}`
* **Automatic Formatting**:
  * Numbers are formatted with locale separators (`14500` $\rightarrow$ `"14,500"`).
  * ISO timestamps are formatted into readable dates (`"2026-10-25T14:00:00Z"` $\rightarrow$ `"Oct 25, 2026, 2:00 PM"`).
  * Control and unprintable characters are sanitized.

### Fallback Values

If an argument is optional, provide a fallback using the pipe syntax `{path|fallback}`:

```ts
activity: 'dispatching to {destinationPort|regional hub}',
```

If a placeholder has no value and no fallback is specified, that template line does not fit and is discarded.

---

## Conditional Rules (`when`)

Prefix lines with `when <field> is <value>:` to display specialized copy based on arguments:

```ts
labels: {
  activity: [
    'when priority is urgent: expediting urgent release for {shipmentId}',
    'when priority is standard: releasing container {shipmentId}',
    'processing shipment {shipmentId}', // Fallback line
  ],
}
```

### Supported Condition Syntax

* **Equality**: `when status is archived: ...`
* **Negation**: `when status is not archived: ...`
* **Null Checks**: `when holdReason is null: ...`
* **Compound Logic**: Join multiple checks with `and`:
  `when priority is urgent and coldChain is true: expediting refrigerated container {containerId}`

---

## Multi-Line Evaluation Order

When an array of template lines is provided, Theorem evaluates them from top to bottom and renders the first line where:
1. Every `when` condition evaluates to true.
2. Every `{path}` placeholder resolves to a defined value (or has a fallback).

> [!IMPORTANT]
> The final line of a multi-line list must always fit—it should have no conditional `when` prefix and use fallbacks on any optional placeholders.

---

## Compound Joined Lines (`+ `)

To assemble sentences from multiple independent flags without writing every combination, prefix lines with `+ `:

```ts
labels: {
  activity: [
    '+ when expedited is true: expedited transport',
    '+ when temperatureControlled is true: cold-chain monitoring',
    '+ delivering container {containerId}',
  ],
}
```

Theorem evaluates all matching `+ ` lines in sequence and joins them naturally in words:
* If both flags are true: `"expedited transport, cold-chain monitoring, and delivering container CONT-9941"`
* If only expedited is true: `"expedited transport and delivering container CONT-9941"`

---

## Build-Time Schema Validation

Theorem validates label templates at registration time against your Zod `input` and `output` schemas:

* A placeholder referencing `{destination}` will throw a `TheoremError('config')` at startup if `destination` is not declared in the Zod schema.
* Output variables (e.g. `{output.status}`) are allowed only in `activityPast`. Referencing output variables in `activity` or `request` throws a build-time configuration error.

---

## Related Guides

* **[Tools & Execution Pipeline](3-1-tools.md)**: Declaring tools and execution pipelines.
* **[Tool Permissions & Gates](3-2-tool-gates.md)**: Using `labels.request` in human approval cards.
* **[Kernel Labels & Errors](2-6-kernel-labels.md)**: Customizing system error copy and localization.
