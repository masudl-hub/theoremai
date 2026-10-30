# Theorem Studio Overview

Developing and debugging AI agents requires continuous iteration across system prompts, tool schemas, model parameters, and safety rules. Switching back and forth between code editors, terminal test scripts, and external playground web apps creates friction and hides errors until runtime.

Theorem Studio is an interactive visual workbench for authoring, testing, and debugging Theorem agents. It gives builders a unified environment that links profile forms, TypeScript source code, live chat execution, visual architecture mapping, and offline trace replay.

---

## What Studio Gives You

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                               THEOREM STUDIO                                │
├──────────────────────────────┬──────────────────────────────┬───────────────┤
│ FORM & MONACO EDITOR         │ WORKSPACE MAP                │ RUN BENCH &   │
│                              │                              │ TRACE REPLAY  │
│ • Dual form & code editing   │ • Visual agent topology      │ • Live chat   │
│ • Real-time type checking    │ • Provider & model links     │ • Tool gating │
│ • Pre-flight compilation     │ • Sub-agent delegation       │ • Replay file │
│ • Direct project file save   │ • Shared tool libraries      │ • Diff compare│
└──────────────────────────────┴──────────────────────────────┴───────────────┘
```

Studio equips builders with five core capabilities:

1. **Dual Form & Code Editing**: Edit agent profiles through structured forms (model parameters, prompt templates, tool allowlists, guardrail thresholds) or write TypeScript directly in an embedded Monaco editor. Changes in either pane instantly synchronize with the other.
2. **Pre-flight Compilation & Diagnostic Testing**: Studio continuously compiles the profile draft in the background using the Theorem compiler. It type-checks schemas, validates tool input/output contracts, checks each model's provider, and flags issues directly on the offending form field or code line before you run a single turn.
3. **Interactive Workspace Map**: View a live topological diagram of your entire project. The map visualizes how providers connect to models, how models bind to agents, which tools each profile can invoke, and how sub-agents delegate work or write compaction summaries.
4. **Live Run Bench & Tool Approvals**: Test agents in an interactive chat interface that renders real-time token streaming, formatted tool arguments, and human-in-the-loop approval cards when gated tools request confirmation.
5. **Trace Replay & Regression Testing**: Import production or test `.trace.json` files to inspect historical turns step-by-step. Replay recorded user turns against your modified agent profile offline without spending API tokens, compare recorded vs. replayed behavior side-by-side, and switch to "Continue live" to test past the point of divergence.

---

## The Studio Workbench

### 1. Dual Form & Monaco Code Editor

Every agent profile can be viewed and edited as either high-level form fields or standard TypeScript code:

* **Visual Forms**: Adjust model temperature, effort levels, thinking budgets, and context limits with sliders and select pickers. Toggle tool access with checkboxes and set up boundary guardrails with input filters.
* **Code Editor**: Edit the raw TypeScript declaration (`defineProfile({...})`). The editor provides full auto-completion, hover documentation, and TypeScript compiler diagnostics against `@theoremjs/agents`.
* **Instant Round-Trip**: Switching between form controls and code is lossless. Editing code updates the visual controls; tweaking visual sliders updates the TypeScript code immediately.

### 2. Pre-Flight Compilation Testing

Studio runs pre-flight validation as you type. Rather than waiting for a turn to fail at runtime with an invalid parameter or missing key:

* **Model Route Checks**: Checks that each model's provider exists in the workspace and serves the agent's type on the model's protocol. The compile does not read your key vault: the studio command checks each provider's key once when the project opens, and a run whose key slot is empty fails with an `auth` error.
* **Schema Validation**: Validates tool input schemas against Zod definitions and ensures structured output definitions match target JSON Schemas.
* **Boundary Checks**: Verifies that custom guardrails, regex patterns, and egress domain allowlists are well-formed.
* **Node-Level Issues**: When an error occurs, Studio points directly to the specific node in the agent tree and opens the relevant line in the code editor.

### 3. Visual Workspace Map

Complex multi-agent architectures often obscure which agent has access to which database or model. The Workspace Map visualizes your project topology as a connected graph:

```text
[ Providers ] ──serves──> [ Models ] ──runs──> [ Agent Profiles ] ──allows──> [ Tools ]
                                                      │
                                                    asks
                                                      ▼
                                              [ Sub-Agents ]
```

* **Providers & Models**: Visualizes the workspace's model providers and which models they serve. Studio registers Gemini, OpenRouter, Local (a server such as Ollama, llama.cpp, vLLM, or LM Studio), and TypeSafe. A project can register its own.
* **Profile Connections**: Shows which models power each profile, and whether profiles share base prompts or compaction summarizers.
* **Tool Allowances**: Displays tool assignments across agents, distinguishing between local function tools, MCP servers, and HTTP endpoints.
* **Sub-Agent Delegation**: Visualizes agent tool (`type: 'agent'`) relationships where one profile delegates tasks to another (e.g., `harbor.desk` delegating berth allocations to `harbor.berth_planner`).

### 4. Interactive Run Bench

The run bench sits beside the editor, allowing you to test modifications immediately:

* **Streaming Execution**: Watch thoughts, tokens, and tool calls stream live.
* **Human-in-the-Loop Gating**: Sensitive tools trigger interactive confirmation cards. You can inspect the pending arguments, approve the call, or reject it with an optional explanatory note.
* **Personas & Acting As**: Test your agents under different roles or permissions (e.g., dock worker vs. port administrator) using simulated personas defined in your setup.

### 5. Trace Replay & Regression Debugging

When debugging a production incident or verifying a prompt tweak, you do not need to re-type conversations or spend model tokens:

1. **Importing Traces**: Click **Replay exchange** and drop in a `TraceRecord` JSON file (`<agent>-<timestamp>.trace.json`) or a JSONL file with one record on each line. Studio renders the complete historical exchange, including user turns, tool inputs/outputs, and guardrail events.
2. **Offline Replay**: Click **Replay** to run the historical user turns back through the current profile definition. Model responses and tool results are fed from the recording, allowing you to verify how new guardrails or system prompts behave without network calls or API costs.
3. **Compare View**: Toggle between **Recorded** and **Replayed** in the trace card heading to view exact differences in responses, tool invocations, and guardrail actions.
4. **Divergence & Continue Live**: If your updated prompt alters the conversation flow (for instance, asking a clarifying question instead of making a premature tool call), the replay detects divergence and halts. You can inspect the divergence point and click **Continue live** to resume interactive chat with the live model from that exact turn.

---

## Two Ways to Run Studio

Studio operates in two environments:

| Approach | How You Run It | Environment | Persistence & Access |
| :--- | :--- | :--- | :--- |
| **Local Project Mode** | `npx theorem-studio` | Local terminal / browser | Reads local files, runs on local API keys, saves edits directly to project files |
| **Embedded App Mode** | `<StudioScreen />` | Web application component | Runs on server-controlled quotas, sandboxed execution, session state kept in the browser tab |

### Local Project Mode

Run the CLI command in your project directory:

```bash
npx theorem-studio
```

Studio loads your project configuration ([`studio.setup.ts`](8-1-1-studio-setup-and-workspace.md)), spins up a local server, and launches the web interface. In this mode:

* **Direct Disk Persistence**: Clicking **Save** writes production-ready TypeScript code directly to your project files on disk.
* **Local Keys**: Model calls sign with the keys in your entry's `theorem.provider.vault`, read from your environment (`process.env` or `Deno.env`). Studio never writes keys to disk.
* **Editor Integration**: Studio integrates with your local desktop editor (VS Code, Cursor, Zed, WebStorm). Clicking an issue or file reference opens the exact file and line in your editor.

### Embedded App Mode

You can also embed the complete Studio workbench directly into your own web applications—for internal enterprise developer portals, customer playgrounds, or partner integration consoles.

```tsx
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { theoremStudioTheme } from '@theoremjs/studio/ui/built/theorem-studio.ts';
import { openStudio } from '@theoremjs/studio/ui/lib/studio-open.ts';
import { StudioScreen } from '@theoremjs/studio/ui/studio-screen.tsx';

// In the browser, before the first render: it reads this tab's kept workspace.
const opened = await openStudio();

export function AgentPlayground() {
  return (
    <Theme theme={theoremStudioTheme} mode="dark">
      <LayerProvider>
        <StudioScreen opened={opened} host={{ kernelVersion: '0.3.3' }} />
      </LayerProvider>
    </Theme>
  );
}
```

In embedded mode:

* **Lent Keys & Quotas**: Control which models visitors can use and enforce strict spending quotas to prevent credit exhaustion.
* **Sandboxed Execution**: Visitors cannot write files to your server or access internal infrastructure.
* **Tab State**: Drafts and test conversations are kept in the browser's IndexedDB, under the tab. A reload keeps them. After the tab closes, a studio tab opened later clears them. Keys are never kept.

---

## Group VIII Structure

* **[Project Setup & Workspaces](8-1-1-studio-setup-and-workspace.md)**: Configuring `studio.setup.ts`, multi-agent project topology, test personas, and desktop editor integration (`--editor`).
* **[Draft Compiler & Code Synchronization](8-1-2-draft-compiler-and-code-export.md)**: How Studio validates profiles, compiles schemas, and synchronizes edits between visual forms and TypeScript files.
* **[Embedded Studio Screen & Lent Keys](8-1-3-embedded-studio-screen.md)**: Embedding `<StudioScreen />` into React applications, configuring lent API keys, and setting usage quotas.