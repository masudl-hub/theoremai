# Project Setup & Multi-Agent Workspaces

When you run Theorem Studio on a project, it reads one **setup file**: `studio.setup.ts`.

The setup file names your app's entry point. Studio runs your agents the way your app runs them: with the same registration, the same keys, and the same turn preparation.

---

## The Setup File

Create a `studio.setup.ts` file in your project. Export `entry`: the path of your app's entry point, relative to the setup file.

```ts
import type { StudioActingAs, StudioPeople } from '@theoremjs/studio/people';

// 1. Name your app's entry point
export const entry = './server/theorem.ts';

// 2. Define simulated personas for test runs
export const people: StudioPeople = {
  places: [{ id: 'stage', label: 'Harbor Stage' }],
  existing: () => [
    { id: 'dock-inspector', label: 'Dock Inspector (Read-Only)' },
    { id: 'harbor-master', label: 'Harbor Master (Admin)' },
  ],
};

// 3. Build execution context from the active persona
export function host(_request: Request, actingAs: StudioActingAs | undefined): unknown {
  return actingAs ? { userId: actingAs.person.id, role: actingAs.person.id } : undefined;
}
```

Your app's entry exports `theorem`, a `TurnWiring`. Your app's own server uses the same object, so a Studio turn is the turn your app runs:

```ts
// server/theorem.ts
import type { TurnWiring } from '@theoremjs/agents';
import { registerHarborSystem } from './harbor/register.ts';

export const theorem: TurnWiring = {
  register: () => registerHarborSystem(),
  provider: {
    vault: {
      gemini: Deno.env.get('GEMINI_API_KEY') ?? '',
    },
  },
};
```

Studio reads only these exports from the setup file. `entry` is required. The others are optional:

| Export | What It Configures |
| :--- | :--- |
| `entry` | The path of your app's entry point, relative to the setup file. Studio loads its `theorem` export, a `TurnWiring`. |
| `people` | Declares test environments and simulated personas that appear in Studio's user picker. |
| `host` | Builds the runtime context object passed to your tools (`ctx.host`) based on the active persona selected in Studio. Can be `async`. |
| `questions` | Defines criteria and options for decision profiles (`{ [profileId]: { [questionId]: DecisionQuestion } }`). |
| `images` | Supplies reference images that decision profiles can inspect during evaluation. |

Studio reads three fields of `theorem`:

| Field | What It Configures |
| :--- | :--- |
| `register()` | Called once as Studio loads the project, before anything runs. Register your profiles (`registerProfile`) and tools here. Can be `async`. |
| `provider` | The keys, network, and limits each model call runs on (`ProviderHostOptions`). |
| `prepare(turn)` | Receives each text, image, and speech turn. Studio runs the turn it returns. |

A setup file that exports `default` or `provider` does not open. Studio stops with a message that names the move to the entry. A setup file with no `entry` does not open either.

---

## Managing API Keys Locally

A profile's model names a *key slot* rather than a key (for example, `keySlot: 'gemini'`). In your entry, `theorem.provider.vault` maps each slot to a key, so a Studio run signs with the key the same profile uses in your app:

```ts
export const theorem: TurnWiring = {
  provider: {
    vault: {
      gemini: Deno.env.get('GEMINI_API_KEY') ?? '',
      openrouter: () => fetchSecretFromVault('openrouter-prod-slot'),
    },
  },
};
```

* **Dynamic Resolution**: Key slots can contain plain string values or asynchronous resolver functions that fetch credentials from local vaults on demand.
* **Keys From Your Environment**: Studio loads your entry in the environment you start it in. If the entry reads its keys as it loads, set them on the command that starts Studio, as you do for your app: `GEMINI_API_KEY=… npx theorem-studio`. Studio never writes keys to disk, to the browser tab's storage, or into profile files.
* **Explicit Slot Failure**: If a model's key slot is missing or empty in your vault, that run fails with an `auth` error that names the slot, for example: "The vault has no credential in slot 'gemini'". Studio does not try another key in its place.

---

## Simulating Roles with Personas

Real-world agents frequently call tools that enforce permission checks. A maritime harbor agent might allow a dock inspector to view berth assignments, while restricting vessel rerouting to the harbor master.

Studio allows you to simulate these personas during interactive test runs using `people` and `host`:

```ts
import type { StudioActingAs, StudioPeople } from '@theoremjs/studio/people';

export const people: StudioPeople = {
  places: [
    { id: 'eu-terminal', label: 'Rotterdam Terminal' },
    { id: 'us-terminal', label: 'New York Harbor' },
  ],
  existing: () => [
    { id: 'user-guest', label: 'Public Observer' },
    { id: 'user-operator', label: 'Berth Operator' },
    { id: 'user-admin', label: 'Port Master' },
  ],
};

export function host(_request: Request, actingAs: StudioActingAs | undefined) {
  if (!actingAs) return { permissions: ['read'] };
  return {
    userId: actingAs.person.id,
    terminal: actingAs.place,
    permissions: actingAs.person.id === 'user-admin' ? ['read', 'write', 'admin'] : ['read'],
  };
}
```

In the Studio interface:
1. Open **Settings** $\rightarrow$ **People**.
2. Select your test place (e.g., `Rotterdam Terminal`) and test user (e.g., `Berth Operator`).
3. Each run in the chat bench executes with the context generated by `host()`.
4. Switch personas between turns to verify that tool gates and authorization policies behave as expected without modifying any agent code.

---

## Multiple Environments

Projects often maintain separate configurations for mock testing and staging integrations. Name your files using the `<name>.studio.setup.ts` convention:

* `studio.setup.ts` (Default development)
* `mock.studio.setup.ts` (Offline scripted models)
* `stage.studio.setup.ts` (Staging database integrations)

If multiple setup files exist, Studio asks which one to open when launched with `npx theorem-studio`. A `studio.setup.ts` file takes the name of the folder it is in. In this example, the project folder is `harbor`:

```text
Which setup?
› harbor  studio.setup.ts
  mock    mock.studio.setup.ts
  stage   stage.studio.setup.ts
↑ ↓ to move, enter to open
```

You can select a setup file directly by passing its name:

```bash
npx theorem-studio mock
```

---

## Desktop Editor Integration

When Studio detects validation warnings or type mismatches in a profile, you can jump directly to the offending file and line in your desktop code editor.

Configure your editor using the `--editor` flag:

```bash
npx theorem-studio --editor cursor
```

Studio supports popular editors out of the box:

| Editor | CLI Command | How Studio Opens Files |
| :--- | :--- | :--- |
| **VS Code** | `--editor code` | `code -g file:line` |
| **Cursor** | `--editor cursor` | `cursor -g file:line` |
| **Zed** | `--editor zed` | `zed file:line` |
| **Windsurf** | `--editor windsurf` | `windsurf -g file:line` |
| **WebStorm** | `--editor webstorm` | `webstorm --line n file` |

If `--editor` is omitted, Studio uses `$VISUAL` or `$EDITOR` when that editor opens a window, and `code` otherwise. If that editor does not start, your machine's default editor opens the file.

In **Settings** → **Files**, **Open files in** offers **Automatic**, **VS Code**, and **Cursor**. **Automatic** opens the editor the studio command was started with.

---

## Multi-Agent Workspaces

When multiple agents run in the same project, Studio organizes them into a unified workspace:

* **Shared Tool Library**: All tools registered by your application join a project-wide catalog. Agents do not duplicate tool definitions; each profile declares an allowlist selecting from the catalog.
* **Decoupled Editing & Testing**: You can select one agent in the editor to tweak its system prompt or model parameters, while selecting a different agent in the chat bench (`chatWith`) to run tests.
* **Agent-to-Agent Delegation**: When an agent invokes another profile through an agent tool (`type: 'agent'`; for example, `harbor.desk` delegating berth optimization to `harbor.berth_planner`), Studio traces the delegation in the run bench, allowing you to inspect parent and child spans in real time.

---

## Related Guides

* **[Theorem Studio Overview](8-1-theorem-studio.md)**: Mental model, visual workbench capabilities, and execution environments.
* **[Draft Compiler & Code Synchronization](8-1-2-draft-compiler-and-code-export.md)**: Real-time background compilation, schema type checking, and two-way file saving.
* **[Embedded Studio Screen](8-1-3-embedded-studio-screen.md)**: Embedding `<StudioScreen />` into React applications with lent keys and quota limits.
* **[Tools & Capabilities Overview](3-1-tools.md)**: Defining custom local function tools, MCP tools, and HTTP integrations.