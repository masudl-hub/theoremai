# @theoremjs/studio

[![npm](https://img.shields.io/npm/v/@theoremjs/studio?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/@theoremjs/studio)
[![CI](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml/badge.svg)](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/masudl-hub/theoremai/blob/main/LICENSE)

Edit, run and test Theorem agents in a studio: on your own project with one command, or as a screen in your own app.

## The idea

The **studio** is a screen for one agent **profile** (see [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents)) at a time. You edit the profile as a form or as code, run it in a chat beside the editor, and probe its guardrails.

The screen keeps the profile it edits in the browser, as a **draft**. It sends the draft with every request to a server under `/api/studio`. You choose which server answers:

```text
                    ┌──────────────────────────────┐
                    │ BROWSER                      │
                    │ <StudioScreen />             │
                    │ edits the draft · runs it    │
                    └──────────────┬───────────────┘
                                   │ POST /api/studio/*
                                   │ (the draft rides along)
                 ┌─────────────────┴──────────────────┐
                 ▼                                    ▼
┌────────────────────────────────┐  ┌────────────────────────────────┐
│ THE COMMAND                    │  │ YOUR APP                       │
│ npx theorem-studio             │  │ createStudioDraftHandler()     │
│                                │  │                                │
│ your project, on this machine  │  │ any visitor, on your server    │
│ saves edits to your files      │  │ saves nothing                  │
└────────────────────────────────┘  └────────────────────────────────┘
```

- **The command** opens your project's agents. It runs them with your project's tools and keys, and writes your edits back to your files.
- **The screen in your app** shows the same studio to your users. Your server answers with one handler. It runs drafts only on keys you choose to lend.

## Install

```bash
npm install -D @theoremjs/studio @theoremjs/agents @theoremjs/react
```

The command needs [Deno](https://deno.com). The installed `@theoremjs/studio`, `@theoremjs/agents` and `@theoremjs/react` versions must match exactly.

To show the screen in your app, also install the peers at the versions this package lists in `peerDependencies`:

```bash
npm install react react-dom zod @astryxdesign/core@0.7.0 @astryxdesign/theme-neutral@0.7.0 @stylexjs/stylex@0.19.0
```

## Open your project

```bash
npx theorem-studio
```

The command starts two servers that only this machine reaches: your project's server, under Deno, and the studio's page. It opens the project's **setup file**: `studio.setup.ts` or `<name>.studio.setup.ts`. When the project has several, it asks which one.

Add `"studio": "theorem-studio"` to your scripts to run it as `npm run studio`.

```text
theorem-studio [setup] [--editor <command>] [--deno-config <file>] [--no-watch]
```

| Option | What it does |
| --- | --- |
| `setup` | The setup file to open, by its file or its name. |
| `--editor <command>` | The editor the studio opens a line of your files in. Default: `$VISUAL` or `$EDITOR` when it opens a window, else `code`. |
| `--deno-config <file>` | The Deno config your project loads with. Default: the `deno.json` or `deno.jsonc` in the folder you ran the command in, else the studio's. |
| `--no-watch` | Do not watch the files the setup reads. The studio reads them again when you come back to it. |

### What a setup file exports

Every export is optional. The studio reads only these:

| Export | What the studio does with it |
|---|---|
| `default()` | Calls it once as it loads the project, before anything runs: register the project's profiles and tools here. It may be `async`. |
| `provider` | The keys, network and limits every model call runs on (`ProviderHostOptions` from `@theoremjs/agents/kernel`). Without it, a run's model call fails for want of a key. |
| `people`, `host` | Who a run's tools act for (below). |
| `questions` | What each decision profile asks, by the profile's id: `{ [profileId]: { [questionId]: DecisionQuestion } }`. |

### Keys a run uses

A profile's model names a key slot. `provider.vault` holds a key for each slot, so a studio run signs with the key the same profile uses in your app. Load the keys however your start script does, and read them when the setup file loads; the studio never writes them down:

```ts
export const provider = {
  vault: { openai: Deno.env.get('OPENAI_API_KEY') ?? '' },
};
```

For a key that comes from a secret store, a slot can hold a function instead. The studio calls it with the provider and slot when a call needs the key. A slot left out or empty fails that run with the slot's name, not a guess at another key.

### Who a run acts as

A setup file can export `people` and `host` to let the builder pick who the project's tools act for:

```ts
import type { StudioActingAs, StudioPeople } from '@theoremjs/studio/people';

export const people: StudioPeople = {
  places: [{ id: 'stage', label: 'Stage' }],
  existing: (place) => [{ id: 'user-1', label: 'Test keeper' }], // optional
  fresh: (place) => makeTestUser(place), // optional; removing it later is yours
  start: undefined, // optional pick the studio opens on; without it, no one
};
export function host(request: Request, actingAs: StudioActingAs | undefined): unknown {
  return actingAs ? buildContextFor(actingAs.person.id) : undefined;
}
```

The builder picks a place and a person in Settings, under People. Each run carries the pick, and `host` builds the tools' context from it. `host` may be `async`; the run waits for it. Each person keeps their own chat and session. Without `people`, every run acts as no one.

## Show the studio in your app

Use this when your users should edit and run agents on your site: a playground, or an internal tool. You need a Vite build, the screen, and one server route.

### 1. Add the Vite plugin

`studioVite` resolves the screen's packages to your install, so your page has one copy of React and Astryx. It also serves the code editor's icons and the type declarations it checks a profile's code against.

```ts
// vite.config.ts
import { studioVite } from '@theoremjs/studio/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), studioVite({ hostRoot: import.meta.dirname })],
});
```

`hostRoot` is the folder of the app that shows the screen.

### 2. Show the screen

```tsx
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { theoremStudioTheme } from '@theoremjs/studio/ui/built/theorem-studio.ts';
import { openStudio } from '@theoremjs/studio/ui/lib/studio-open.ts';
import { StudioScreen } from '@theoremjs/studio/ui/studio-screen.tsx';
import '@theoremjs/studio/ui/figtree.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@theoremjs/studio/ui/built/theme.css';
import '@theoremjs/studio/ui/motion.css';

export function Studio() {
  return (
    <Theme theme={theoremStudioTheme} mode="dark">
      <LayerProvider>
        <StudioScreen opened={openStudio()} host={{ kernelVersion: '0.3.1' }} />
      </LayerProvider>
    </Theme>
  );
}
```

Render it in the browser only. `openStudio()` reads the tab's kept workspace, so it does not run on a server.

`host` tells the screen about your page:

| Field | What it does |
| --- | --- |
| `kernelVersion` | The `@theoremjs/agents` version, shown under the studio's title. Required. |
| `lentKeys` | Keys your page lends to whoever opens the studio. See [Lend your keys](#lend-your-keys). |
| `toolHandlers` | Handlers for your page's own function tools, by name. A tool with none answers with its sample reply or a stub. |
| `hasSettings` | True when your page has a door to Settings. Keys then show in Settings, not in the editor's header. |
| `mountSurface` | Mounts the screen's surface while the screen is open, and returns the unmount. |
| `onReport` | Called as what is on screen changes, and with `null` when the screen closes. |

### 3. Answer at `/api/studio`

The screen sends every request under `/api/studio`. Mount one handler there:

```ts
import { createStudioDraftHandler, STUDIO_BASE } from '@theoremjs/studio/server';

const studio = createStudioDraftHandler();

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname.startsWith(`${STUDIO_BASE}/`)) return studio(request);
    return new Response('Not found', { status: 404 });
  },
};
```

The handler takes a Web `Request` and returns a `Response`. It serves no project: each request carries its draft.

Without lent keys, the handler answers three requests:

- the guardrail probe, on a scripted model, so no model is called;
- the key test, for a key the builder types;
- the tool connection test, which reaches public hosts only.

Drafts then run in the browser, on the builder's own keys.

To call `onProbePassed` after the reply on a Worker, pass `ctx.waitUntil` as the second argument: `studio(request, (work) => ctx.waitUntil(work))`.

## Lend your keys

Use this when visitors without a key should still run drafts: a public playground on your free-tier keys. The drafts then run on your server, so you decide what they may use.

You describe the keys once, as a `LentKeys`. It says which models the keys run and which built-in tools each model may use. It also says how large a decision may be, and what runs on the keys keep to. Give the same `LentKeys` to the screen and to the handler:

```ts
import type { LentKeys } from '@theoremjs/studio';
import { createStudioDraftHandler } from '@theoremjs/studio/server';

declare const keys: LentKeys;
declare const env: { GEMINI_KEY: string };

const studio = createStudioDraftHandler({
  lent: {
    mode: 'demo',
    keys,
    // Fill each key slot the draft's models name.
    hostOptions: (profile) => ({
      vault: Object.fromEntries(
        'models' in profile
          ? Object.values(profile.models).flatMap((model) => (model.keySlot ? [[model.keySlot, env.GEMINI_KEY]] : []))
          : [],
      ),
    }),
  },
  spend: (kind, request) => {
    // Count `kind` for whoever sent `request`. Throw a TheoremError to refuse it.
  },
});
```

```tsx
<StudioScreen opened={openStudio()} host={{ kernelVersion: '0.3.1', lentKeys: keys }} />
```

`hostOptions` gets each draft's profile. The draft names its own key slots, so fill the slots its models name. A decision or embedding whose vault holds no key is refused with `auth`.

With `lent`, the handler also runs chats, calls, decisions and embeddings. A draft that names a model the keys do not run is refused with the reason `LentKeys.violation` gives.

| Option | What it does |
| --- | --- |
| `lent` | `{ mode: 'demo', keys }`, with `hostOptions` filling each profile's key slots, and your tool handlers. Without it, no draft runs on the server. |
| `spend` | Spends one `decision`, `call` or `agent` turn for whoever sent the request, before it runs. Throw a `TheoremError` to refuse it; the screen shows its wording. Default: nothing is counted. |
| `resolveHost` | Resolves the names the connection test calls, so the network guard refuses one that answers a private address. Workers have no DNS lookup: pass `dnsOverHttpsResolver(...)`. Default: `lent.resolveHost`. |
| `onProbePassed` | Gets each probed text that some guardrail boundary let through, after the reply. |
| `sessionStore`, `pageToolBroker`, `steer` | Where visitor sessions, page tool results and a running chat's steers are kept. Default: in memory. A host on several isolates needs stores they all reach. |
| `conversationKey` | The key chat conversations are sealed with. Default: a new one for this handler's lifetime. A restart, or another isolate, then cannot open a chat, and the chat continues from the page's transcript. Pass one key to every isolate to keep each conversation on the server. |
| `draftNetwork` | True only when the handler serves the builder alone, on their own machine, as the command's does. A connection test then keeps to the draft's network guardrail. Otherwise it reaches public hosts only. |

Live calls on lent keys open a WebSocket to `/api/live/relay`, not `/api/studio`. This package does not ship that relay. Build it on your server with `attachStudioLiveSession` from `@theoremjs/studio/browser`, and see the relay section of [`@theoremjs/react`](https://www.npmjs.com/package/@theoremjs/react).

## Entry points

| Import | What it holds |
| --- | --- |
| `theorem-studio` | The command. |
| `@theoremjs/studio/server` | `createStudioDraftHandler`, `STUDIO_BASE` and their types. |
| `@theoremjs/studio/ui/*` | The screen: `ui/studio-screen.tsx`, `ui/lib/studio-open.ts`, the theme in `ui/built/`, and the stylesheets. |
| `@theoremjs/studio/vite` | `studioVite`. |
| `@theoremjs/studio/people` | `StudioPeople` and `StudioActingAs`, for a setup file. |
| `@theoremjs/studio/browser` | Runs a draft in the browser on the builder's keys, and `attachStudioLiveSession` for a live relay. |
| `@theoremjs/studio/runtime` | `studioScope` and the run functions the handler is built on, for a server of your own. |
| `@theoremjs/studio/surface` | `studioSurface`: the draft as nodes an agent can read and set. |
| `@theoremjs/studio` | The draft and its tools (below). |

## The `@theoremjs/studio` entry

Use these when you build on the studio's draft yourself: compile it, export it as source, or probe its guardrails.

| Export | Purpose |
| --- | --- |
| `StudioDraft`, `createBlankDraft()`, `createExampleDraft()` | Editable profile draft; blank, or the travel concierge |
| `createLiveExampleDraft()`, `createNarratorExampleDraft()`, `createConsoleExampleDraft()`, `createArchitectWorkspace()` | The other examples: the concierge as a live agent, a speech narrator, a host tool console, and a code architect that calls the narrator through an agent tool |
| `setProfileType()`, `includeFacet()`, `excludeFacet()`, `newModelBinding()`, `newToolSpec()` | Draft edits that keep it consistent with `PROFILE_GRAPH` |
| `studioTree()`, `studioNodeRef()`, `modelBindingNodeId()`, `toolSpecNodeId()` | The draft as a tree; node ids that issues point at |
| `compileStudio()` | Draft → profile definition, custom tools, structured schema; or issues keyed by node |
| `studioSource()` | Compiled draft as a TypeScript module (`registerTool`, `defineProfile`, `registerProfile`) |
| `LentKeys`, `LentHolds`, `StudioRunsOn`, `ON_OWN_KEYS`, `modelBindingViolation()` | What a studio runs on: a page's lent keys (which models, built-ins and decision sizes they allow, and what runs on them keep to whatever a profile says), or the builder's own keys or machine, where a profile runs as written |
| `zodFromJsonSchema()`, `parseJsonSchema()` | Authored JSON Schema → Zod for registration |
| run-payload helpers, `studioRunDefines()`, `clearStaleStudioRuns()` | Handoff of a compiled draft to the run tab, whether a kept run still defines on this package, and clearing the ones that do not |
| `createStudioTransport()`, `studioInterface()` | The run tab's transport for a compiled draft; its `traces` feed receives the records each run writes |
| `runGuardrailProbes()`, `runGuardrailProbe()`, `probeDraft()`, `PROBE_BOUNDARIES`, `PROBE_BOUNDARY_NOTES`, `PROBE_STATUSES` | Test a draft's guardrails: send one text across every boundary, or across one, on a scripted model. Each boundary answers with a status (passed, flagged, redacted or blocked), whether its turn was tainted by a remote read, the guardrail events, what went on past the boundary, and the turn's trace records. No model or host is called. Each boundary's note says what crosses it, when the kernel reads it and what the kernel does there |
| `PROBE_BATTERY` | Hard texts to probe with: disguised attacks and harmless texts that look like attacks, each with the boundary it crosses and whether a guardrail should act on it |
| `createStudioTraceRouter()`, `STUDIO_RUN_METADATA_KEY`, `StudioTraceLine` | Trace delivery: the server registers the router's sink for `STUDIO_TRACE_DESTINATION`; each run opens a route and passes its metadata, and gets back `{ type: 'trace', record }` lines (after a text run's events, or on the Live socket as each record is written) |
| `demoToolSpecs()`, `demoInputsSpec()` | Every example tool seed, and the inputs facet seed |
| `DEMO_CONCIERGE_SYSTEM`, `DEMO_ALLOWED_HOSTS` | Demo system prompt and egress allowlist |
| `DEMO_HTTP_SAMPLE_INPUT`, `demoHttpSampleInput()` | Connection-test payloads for demo HTTP tools |
| `registerStudioTools()`, `StudioToolHandlers` | Register a draft's tools; a function tool answers with its sample reply, else the handler the host gives for its name, else a stub from its output schema |
| `stubOutputFromSchema()` | Generic stub object from a JSON Schema |
| `StudioInputsSpec`, `StudioToolSeed`, `StudioToolSpecSeed` | Serializable seed shapes |
