# Draft Compiler & Code Synchronization

When authoring AI agents, you often have to choose between visual low-code interfaces that hide the underlying code, and raw code files that lack interactive parameter tuning.

Theorem Studio provides a unified authoring experience: visual form controls and a TypeScript Monaco editor side-by-side, backed by real-time compiler diagnostics and atomic file saving with unified diff reviews.

---

## Dual-Pane Authoring

Every agent profile can be edited either visually or directly in code. The two panes represent the exact same profile definition and stay continuously synchronized:

```text
┌──────────────────────────────┬──────────────────────────────┐
│ VISUAL FORM CONTROLS         │ MONACO TYPESCRIPT EDITOR     │
├──────────────────────────────┼──────────────────────────────┤
│ Model: gpt-4o-mini           │ export const harborDesk =    │
│ Effort: [Minimal ▾]          │   defineProfile({            │
│                              │     id: 'harbor.desk',       │
│ Tools:                       │     type: 'text',            │
│   ☑ vesselLookup             │     // ...                   │
│   ☑ berthAssignment          │     tools: {                 │
│                              │       allow: [               │
│ Guardrails:                  │         'vesselLookup',      │
│   Egress: api.harbor.local   │         'berthAssignment',   │
│                              │       ],                     │
│                              │     },                       │
│                              │   });                        │
└──────────────────────────────┴──────────────────────────────┘
```

* **Visual Form Controls**: Sliders for temperature and thinking budgets, dropdowns for effort levels, checkboxes for tool allowlists, and structured forms for guardrail boundaries.
* **Monaco Editor**: A full-featured code editor with syntax highlighting, auto-completion, parameter hints, and type hovers powered by TypeScript definitions from `@theoremjs/agents`.
* **Instant Two-Way Synchronization**: Moving a visual slider immediately updates the TypeScript code; typing new tool names or adjusting prompt strings in the editor updates the visual form controls in real time.

---

## Real-Time Compiler Diagnostics

In traditional agent development, configuration errors—like referencing an unconfigured API key slot, mistyping a tool name, or providing an invalid schema—are only discovered when an agent crashes mid-turn.

Studio runs background validation on every keystroke, catching configuration errors before you run a single test turn:

### 1. Key Slot Verification
Ensures that every model binding references a valid key slot defined in your local environment. If an agent requests a model on a slot that has no API key in your vault, Studio flags it immediately rather than letting the model call fail at runtime.

### 2. Tool & Schema Validation
Checks that all tool IDs in your agent's allowlist exist in your project's tool library. When using structured outputs, Studio validates that your reply definition satisfies the target JSON Schema contract.

### 3. Guardrail Rule Checking
Verifies that custom regular expressions, detector rules, and domain egress allowlists are syntactically valid and non-blocking for benign inputs.

### Pinpointing Issues
When an error is detected:
* Studio displays an issue badge in the toolbar indicating the number of active issues.
* Clicking an issue takes you directly to the offending field in the visual form.
* The Monaco editor highlights the exact line with an inline red squiggle and diagnostic hover tooltip.

---

## Saving Changes with Diff Reviews

When running locally (`npx theorem-studio`), Studio writes your edits directly back to your project files on disk when you save (`Cmd+S` or clicking **Save**).

To ensure you maintain total control over your codebase, Studio presents an interactive **Save Review Dialog** before modifying any file.

```text
┌─────────────────────────────────────────────────────────────┐
│ Save Changes to Project                                     │
├─────────────────────────────────────────────────────────────┤
│ src/agents/harbor-desk.ts:14 · +2 −1                        │
│                                                             │
│    tools: {                                                 │
│      allow: [                                               │
│        'vesselLookup',                                      │
│ -      'oldBerthCheck',                                     │
│ +      'berthAssignment',                                   │
│      ],                                                     │
│    },                                                       │
├─────────────────────────────────────────────────────────────┤
│ [Cancel]                                       [Write Files]│
└─────────────────────────────────────────────────────────────┘
```

### Unified Diff Previews
The review modal displays exact unified diff hunks (`+` added lines, `-` removed lines) for every file affected:
* **By File or All Changes**: Toggle between inspecting one file at a time or scrolling through all project changes at once.
* **Targeted Updates**: Studio updates only the specific profile or tool object you modified. Surrounding imports, comments, helper functions, and custom application code in the file remain untouched.

### The Atomic Save Guarantee
Studio enforces an atomic save model: it writes all approved changes or none. This guarantees that your disk files always match the exact configuration you tested in the run bench, preventing partial updates from leaving your codebase in a broken state.

### Conflict Prevention
Studio checks the state of your project files before writing:
* **External Edits**: If a file was modified in your desktop editor after Studio opened it, Studio warns you of the conflict and asks you to reload rather than overwriting your external changes.
* **Locked Values**: If a setting in your code is computed by a dynamic function or imports an external constant, Studio notifies you that the value is managed in code and should be edited in your desktop editor.

### Undo Save
If you make a save and decide you want to revert it, Studio provides an immediate **Undo Save** option that restores your files to their state prior to the write.

---

## Related Guides

* **[Theorem Studio Overview](8-1-theorem-studio.md)**: Architecture, visual workbench capabilities, and execution modes.
* **[Project Setup & Workspaces](8-1-1-studio-setup-and-workspace.md)**: Configuring `studio.setup.ts`, local key vaults, and multi-agent workspaces.
* **[Embedded Studio Screen](8-1-3-embedded-studio-screen.md)**: Embedding `<StudioScreen />` into React applications with lent keys and quota limits.
* **[Profiles & State Management](2-1-profiles.md)**: Complete schema specification for Theorem agent profiles.