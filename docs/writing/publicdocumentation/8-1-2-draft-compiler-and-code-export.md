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
│ Model: gemini-3.5-flash-lite │ export const harborDesk =    │
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

### 1. Model Route Checks
Checks that each model's provider exists in the workspace and serves the agent's type on the model's protocol. Otherwise the editor shows an issue such as "No provider is defined as openai."

The compile does not read your key vault. When a project opens, the studio command asks each provider about its key once and prints one line for each, such as `key for gemini (gemini) works`, `refused`, or `is empty`. The `--offline` flag skips this check. A run whose key slot is empty fails with an `auth` error.

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

When running locally (`npx theorem-studio`), Studio writes your edits back to your project files on disk when you save. Click **Save** in the editor's toolbar to review the diff, then save.

Before it changes any file, Studio opens a review dialog titled **Save to** and your project's name.

```text
┌─────────────────────────────────────────────────────────────┐
│ Save to harbor                                              │
│ Save writes all of these lines or none. It then             │
│ type-checks and loads the project, and puts your files      │
│ back unless it runs as what you tested.                     │
├─────────────────────────────────────────────────────────────┤
│ src/agents/harbor-desk.ts:14 · +1 −1                        │
│                                                             │
│    tools: {                                                 │
│      allow: [                                               │
│        'vesselLookup',                                      │
│ -      'oldBerthCheck',                                     │
│ +      'berthAssignment',                                   │
│      ],                                                     │
│    },                                                       │
├─────────────────────────────────────────────────────────────┤
│ [Discard all]                              [Cancel] [Save]  │
└─────────────────────────────────────────────────────────────┘
```

### Unified Diff Previews
The review modal displays exact unified diff hunks (`+` added lines, `-` removed lines) for every file affected:
* **By File or All Changes**: Toggle between inspecting one file at a time or scrolling through all project changes at once.
* **Targeted Updates**: Studio updates only the specific profile or tool object you modified. Surrounding imports, comments, helper functions, and custom application code in the file remain untouched.

### The Atomic Save Guarantee
Save writes every change or none. It then type-checks and loads the project. If the project does not type-check, does not start, or does not load as what you tested, Save puts your files back and says why. Your disk files then hold exactly what you tested in the run bench, or what they held before.

### Conflict Prevention
Studio checks the state of your project files before writing:
* **External Edits**: If a file changed in your desktop editor after Studio opened it, Save does not write that change. The review names the file and says it "changed after the studio opened it. Reload the studio." If your files change after the review was made, Save writes nothing and says: "Your files changed after this review was made. Close it and review again."
* **Locked Values**: If your code sets a value in a way Studio cannot rewrite, the review names the file and line that set it and says: "Change it there." Edit that value in your desktop editor.

### Undo Save
After a save, a message names the files Studio wrote, with an **Undo** button for 15 seconds. **Undo** puts the files back as they were before the save. Your edits stay in Studio, unsaved again.

### Discard All
**Discard all**, in the review dialog, puts the project back to its files and drops every unsaved edit. Studio asks first: "Discard every unsaved edit?" **Undo** in the next message brings the edits back.

---

## Related Guides

* **[Theorem Studio Overview](8-1-theorem-studio.md)**: Architecture, visual workbench capabilities, and execution modes.
* **[Project Setup & Workspaces](8-1-1-studio-setup-and-workspace.md)**: Configuring `studio.setup.ts`, local key vaults, and multi-agent workspaces.
* **[Embedded Studio Screen](8-1-3-embedded-studio-screen.md)**: Embedding `<StudioScreen />` into React applications with lent keys and quota limits.
* **[Profiles & State Management](2-1-profiles.md)**: Complete schema specification for Theorem agent profiles.