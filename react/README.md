# @theoremjs/react

[![npm](https://img.shields.io/npm/v/@theoremjs/react?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/@theoremjs/react)
[![CI](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml/badge.svg)](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/masudl-hub/theoremai/blob/main/LICENSE)

Define an agent once. Get the server and the user interface from the same definition.

## The idea

In Theorem, you write an agent as a **profile** (see [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents)). The profile states:

- which models the agent can use
- what the agent accepts: text, images, files or voice
- which tools the agent can call
- what the agent must return
- how the kernel guards each input and output

This package uses the same profile on both sides.

- **Server.** `createTheoremHandler` runs the profile. It enforces the guardrails and the tool gates.
- **Browser.** The UI asks the server to describe the profile. It then shows what the profile allows. It shows no attachment button if the profile does not accept files. It shows a model picker if the profile lets the user choose the model.

```text
                  ┌─────────────────────────────┐
                  │        agent profile        │
                  │   models · inputs · tools   │
                  │     output · guardrails     │
                  └──────────────┬──────────────┘
                                 │
                ┌────────────────┴────────────────┐
                ▼                                 ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ SERVER                        │ │ BROWSER                       │
│ createTheoremHandler          │ │ <TheoremChat />               │
│                               │ │ useTheoremInterface()         │
│ runs the profile              │ │ shows only what the           │
│ enforces guardrails and gates │ │ profile allows                │
└───────────────┬───────────────┘ └───────────────┬───────────────┘
                └─ HTTP: describe · turn · steer ─┘
```

Edit the profile, and both sides change. You do not write the UI code again.

The package has three parts:

- A ready-made chat, voice call, host console and decision form. They are built on [Astryx](https://www.npmjs.com/package/@astryxdesign/core).
- Hooks and a transport, for your own UI.
- A server handler. It takes a Web `Request` and returns a `Response`.

## Install

```bash
npm install @theoremjs/react @theoremjs/agents zod react react-dom
```

For the ready-made UI (`/ui` and `/live`), also install Astryx and StyleX:

```bash
npm install @astryxdesign/core @stylexjs/stylex
```

To build your own theme from the Theorem theme (`/ui/theme`), also install `@astryxdesign/theme-neutral`.

Use the versions that this package lists in `peerDependencies`. The Astryx and StyleX peers are optional. The hooks, the client and the server handler work without them.

Requirements:

- TypeScript 5.7 or later, for the type declarations.
- A bundler that handles CSS imports. Vite does. `/ui` and `/live` import their own stylesheets.
- For voice, a bundler that resolves `new URL('./worklets/mic-capture.js', import.meta.url)`. Vite does.

The package does not include the Figtree font. The theme uses Figtree, and falls back to the system font if Figtree is not loaded. To use Figtree, load the font in your app.

## Quick start

### 1. Define the profile and start the handler

```ts
import { defineProfile } from '@theoremjs/agents';
import { createTheoremHandler } from '@theoremjs/react/server';

const support = defineProfile({
  type: 'text',
  id: 'support.agent',
  identity: { handle: 'support', system: 'You help customers with their account.' },
  models: {
    fast: {
      protocol: 'geminiInteractions',
      provider: 'google',
      apiId: 'gemini-3.5-flash-lite',
      persistViaInteractionId: false,
    },
  },
  defaultModel: 'fast',
  key: 'main',
  tools: { allow: [] },
  inputs: { text: true },
});

export const theorem = createTheoremHandler({
  profile: support,
  provider: { vault: { main: process.env.GEMINI_API_KEY } },
});
```

### 2. Mount the handler

`createTheoremHandler` returns a function: `(request: Request) => Promise<Response>`. It works in Workers, Deno, Bun, Hono and Next route handlers. In Node, use an adapter.

Send all requests under one path to the handler. The default path is `/api/theorem`.

```ts
export default {
  fetch(request: Request) {
    return new URL(request.url).pathname.startsWith('/api/theorem')
      ? theorem(request)
      : new Response('Not found', { status: 404 });
  },
};
```

### 3. Show the chat

```tsx
import { TheoremChat } from '@theoremjs/react/ui';

export function App() {
  return <TheoremChat endpoint="/api/theorem" />;
}
```

The profile, the keys and the system prompt stay on the server. The browser receives only the interface of the profile: the models, the inputs, the tool names and the wording. The handler removes the system prompt from this description.

## Entry points

| Import | Content |
| --- | --- |
| `@theoremjs/react` | Hooks, transports and client logic |
| `@theoremjs/react/ui` | `TheoremChat`, `TheoremHost`, `TheoremDecision` and their parts |
| `@theoremjs/react/live` | `LiveRunner`, the voice and video call UI |
| `@theoremjs/react/server` | The handlers and the stores they use |
| `@theoremjs/react/ui/theme` | `theoremTheme`, the base for your own Astryx theme |
| `@theoremjs/react/ui/icons` | The icon set of the theme |
| `@theoremjs/react/client` | The client logic, without the hooks |

## Chat

`<TheoremChat />` accepts these props. All props are optional.

| Prop | Use |
| --- | --- |
| `endpoint` | The path where the handler is mounted. Default: `/api/theorem`. |
| `http` | Fetch options for the default transport, such as auth headers or a custom `fetch`. |
| `transport` | Your own transport, instead of `endpoint`. Use it for tests or for hosts that do not use HTTP. |
| `theme`, `mode` | An Astryx theme, and `'system'`, `'light'` or `'dark'`. Without `theme`, the chat uses your theme or the Theorem theme. |
| `labels` | Replacement text for each locale. See [Wording](#wording). |
| `placeholder`, `emptyState` | The composer placeholder, and the content above the composer before the first message. |
| `density`, `maxWidth`, `className`, `style` | Layout. `maxWidth` is a CSS length. Default: half of the chat width, or the full width on a narrow screen. |
| `trace` | Shows the trace instead of the chat. Use it when your own control switches the view. The profile must record traces. |
| `initialChat`, `onChatChange` | Save and restore a conversation. See below. |
| `initialText` | The text that the composer starts with. The user can send it or change it. The component reads it once, when it mounts. |
| `chatRef` | Sends a message from your code. See below. |

### Save and restore a conversation

`onChatChange` gives you the conversation as `{ blocks, session }`. It runs when the conversation is at rest:

- a turn ended
- a message was added
- a message was removed

It does not run while a reply streams or waits for a gate.

To restore the conversation, pass the saved value as `initialChat`. The component reads `initialChat` once, when it mounts.

```tsx
<TheoremChat
  endpoint="/api/theorem"
  initialChat={saved}
  onChatChange={(snapshot) => save(snapshot)}
/>
```

### Send a message from your code

`chatRef` gives you `send(text)`. It sends the text as the user. When the reply is complete, it returns the blocks that the turn added. It returns `null` if the chat cannot accept a message now. This happens while a reply streams or waits for a gate.

```tsx
const chat = useRef<TheoremChatHandle>(null);

const turn = await chat.current?.send('Summarize my open tickets');

<TheoremChat chatRef={chat} />
```

### Gates

A **gate** is a point where a tool call stops and waits for a person. There are two kinds:

- An approval gate asks the person to allow the call.
- A sign-in gate asks the person for a credential.

The chat shows each gate as a card in the transcript. When the person answers, the server settles the call and the turn continues.

The server saves a typed key. The browser does not keep it. For OAuth and typed keys, see [Tool credentials](https://github.com/masudl-hub/theoremai/blob/main/react/docs/credentials.md). For the data that each answer sends, see [The wire](https://github.com/masudl-hub/theoremai/blob/main/react/docs/wire.md).

If the person sends a new message while a gate is open, the server cancels the open calls. The reply to the new message follows in the same stream. See [Composer, queue and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md).

## Other profile types

Each profile type has a handler and a component. Mount the handler. Point the component at it.

### Host

A `host` profile does not run a model. The page calls the tools of the profile directly. Each call passes through the gates and the guardrails of the kernel.

```ts
import { createTheoremHostHandler } from '@theoremjs/react/server';

export const host = createTheoremHostHandler({ profile: opsConsole }); // mount at /api/host
```

```tsx
import { TheoremHost } from '@theoremjs/react/ui';

<TheoremHost endpoint="/api/host" />
```

The handler accepts these requests:

- `GET` describes each allowed tool with its input and output JSON Schema. It never shows the endpoint or the credentials of a tool.
- `POST /call` with `{ name, input }` streams the events of the call.
- `POST /invoke` answers a gate that paused a call.

The console builds a form from the input schema. It shows the result as figures, charts, tables, images, audio or Markdown, with the raw JSON beside it. For your own UI, use `createHostTransport` and `useTheoremHost`.

### Decision

A `decision` profile has no conversation. You give it a JSON state and questions. It answers the questions about the state.

```ts
import { createTheoremDecisionHandler } from '@theoremjs/react/server';

export const decide = createTheoremDecisionHandler({ profile, questions, vault }); // mount at /api/decision
```

```tsx
import { TheoremDecision } from '@theoremjs/react/ui';

<TheoremDecision endpoint="/api/decision" />
```

- `questions` maps each question id to its definition.
- `vault` holds the keys of the profile, by slot.
- `metadata` is optional. It adds data, such as the signed-in user, to the trace record of each decision.

For your own UI, use `useTheoremDecision`.

### Live

A `live` profile runs a voice or video call. The call goes through a WebSocket relay that you host with `runSession` from `@theoremjs/agents`.

`LiveRunner` needs two props:

- `iface`: the interface of the profile. `interfaceFromProfile` (from `@theoremjs/agents/interface`) builds it.
- `connection`: a function that tells the runner what to connect to.

```tsx
import { LiveRunner } from '@theoremjs/react/live';

<LiveRunner iface={iface} connection={() => ({ profile: 'support.voice' })} />
```

This code opens `wss://<your host>/api/live/relay?profile=<id>`. To send your own message to the relay, add `openMessage`. To use your own socket, add `createSocket`.

`LiveRunner` also accepts `theme`, `mode`, `labels` and `trace`. Tool gates in a call appear in a dialog over the call.

### The page's part in a call

Three more props give the call values from the page. The profile declares each one; the page only supplies the value.

| Prop | The profile declares | What the page gives |
| --- | --- | --- |
| `slots` | `inputs.slots` | The value chosen for each slot. It is read when the call starts. |
| `context` | `inputs.context` with `from: ['client']` | Any JSON the agent should know, such as the page the person is on. |
| `pageTools` | A function tool with `answeredBy: 'page'` | A function for each page tool, by name. It returns `{ output }`. |

```tsx
<LiveRunner
  iface={iface}
  connection={() => ({ profile: 'support.voice' })}
  slots={{ language: 'fr' }}
  context={{ page: '/pricing', cart }}
  pageTools={{
    highlight: (args) => ({ output: { success: highlight(String(args.target)) } }),
  }}
/>
```

- `context` goes with the start of the call. When its value changes, the runner sends it again. The agent reads it as background and does not reply to it.
- A page tool's output schema checks what the page returned. Every other tool runs on the relay, with its gates.
- The runner writes a console warning when the profile has a page tool with no function in `pageTools`, and when `pageTools` has a function for a tool that is not a page tool.

To make the agent speak first, set `live.greeting` on the profile. The page sends nothing for it.

### A call that drops

When the profile sets `live.sessionResumption` and the connection drops, the runner takes the call up again. It shows `reconnecting` and tries 5 times, after 0.5, 1, 2, 4 and 8 seconds. If no try connects, the call fails with a `network` error. The runner tells the relay how long the person was away. If the profile sets `live.resumed`, the agent says that it is back after an absence of `afterMs` or longer.

A call that the provider ends, or that fails, is not taken up again.

### Your relay

The live client's first message is the open message. Read it before you open the session:

```ts
import { liveSessionOpen, parseLiveOpenMessage } from '@theoremjs/react/server';

const open = parseLiveOpenMessage(firstFrame);
const session = await runSession({ profile, ...liveSessionOpen(open, hostContext) });
```

- `liveSessionOpen` returns the session's `slots`, `context`, `sessionResumptionHandle` and `awayMs`. Its second argument is your server's own context. Pass it only if the profile lists `server` in `inputs.context.from`.
- `open.host` is the `openMessage` that your `connection` returned.
- Read each later message with `parseLiveClientMessage`. Give a `context` message to `session.sendContext({ client: message.context })`.

To build your own call view, use `useLiveRunnerModel(iface, connection, { slots, context, pageTools })` from `@theoremjs/react/ui`. It returns the state of the call, its captions and its controls. `LiveCaptionsPanel` draws the captions.

## Server options

`createTheoremHandler` requires `profile` and `provider`. All other options are optional.

| Option | Use |
| --- | --- |
| `profile` | The profile to serve. The kernel registers it when you create the handler. |
| `provider` | The provider settings, with the key vault by slot. Or a function that builds a provider for each request. Use the function if each tenant has its own keys. |
| `session` | Returns the session id of the caller, for example `${userId}:${conversationId}`. Return `undefined` to refuse the request with a 401. Default: a random id in an HttpOnly, SameSite=Lax cookie. |
| `host` | App data for the tool handlers (`ctx.host`), such as the signed-in user. |
| `sessionStore`, `steerInbox` | Where open gates and queued steers are kept. Default: process memory. |
| `credentialStore` | Where tool credentials are kept, by session. Default: process memory. |
| `authorizationUrl` | Returns the sign-in URL for an OAuth gate. Without it, an OAuth gate has no URL. |
| `gateTtlMs` | How long a gate waits for an answer. Default: 30 minutes. A later answer fails with `session.gate_expired`. |
| `clientEvents` | Options for `forClient`, which prepares each event for the browser. |
| `onError` | Receives each error that the handler catches. The user sees the wording of the profile for that kind of error, never the error. |

**Note:** Process memory is correct for development and for one process. In production, use a store that all instances share.

## Build your own UI

The hooks give you the same state and actions that the ready-made components use. They draw nothing.

`useTheoremInterface` reads the interface of the profile from the server. `useTheoremChat` keeps the transcript, the streaming state, the drafts, the queue and the gates.

```tsx
import { createHttpTransport, useTheoremChat, useTheoremInterface } from '@theoremjs/react';

const transport = createHttpTransport({ endpoint: '/api/theorem' });

function MyChat() {
  const described = useTheoremInterface(transport);
  const chat = useTheoremChat({
    transport,
    iface: described.status === 'ready' && described.iface.type !== 'live' ? described.iface : null,
  });
  // chat.blocks, chat.streamBlocks, chat.phase, chat.draftText, chat.handleSubmit
}
```

`chat.phase` is `'idle'`, `'streaming'` or `'gated'`. The actions are `handleSubmit`, `handleStop`, `handleSendNow` and `handleToolDecision`.

To show the transcript and the composer, use `ChatTranscript` and `ChatComposerBar` from `/ui`. You can also draw your own from `chat.blocks`.

The hooks and the client write no English text. They return kinds, codes and states. You write the words.

- A failure is a `ClientFailure`: `{ error, errorKind, errorInternal? }`. Show `error` to the user. It is the wording of the profile. `errorKind` and `errorInternal` are for your code.
- An attachment problem is an `AttachmentValidationIssue`. Use `attachmentIssueText(issue, iface.lexicon)` from `@theoremjs/agents` to get its text.
- A provider can end a live call after it gives a warning. This is not a failure. `LiveSessionClient` calls `onSessionEnded(session)`. `session.message` is the wording of the profile (`live.session_ended`). `session.ended` has the close code and the timing.
- The state of the UI is given as values, such as `liveState`, the work status, the drawer parts and the hint ids. You choose the words for them.

## Wording

Each line of text in the ready-made UI is an Astryx i18n message. Theorem messages use `@theorem.*` keys. `THEOREM_UI_CATALOG` lists them, with a description and the values that each one takes. Astryx messages use `@astryx.*` keys.

Use `labels` to replace any message, for each locale:

```tsx
<TheoremChat
  labels={{
    en: {
      '@theorem.chat.greeting': 'What shall we plan?',
      '@theorem.composer.placeholder': 'Write to @{handle}',
      '@astryx.chatSendButton.send': 'Go',
    },
    de: { '@theorem.chat.greeting': 'Woran arbeiten wir?' },
  }}
/>
```

`LiveRunner`, `TheoremHost` and `TheoremDecision` accept the same prop.

- The locale is the locale of your Astryx `InternationalizationProvider`. Without a provider, it is `en`.
- Your own Astryx `messages` and `overrides` also apply. They replace the defaults.
- The component checks the labels when it mounts. It throws an error that names the locale and the key if:
  - a `@theorem.*` key is unknown
  - a message is not valid ICU
  - a message does not use a value that its line is given
  - a key is not in `@theorem.*` or `@astryx.*`
- Labels are shown as text. They are never shown as HTML.

## More documentation

- [The wire](https://github.com/masudl-hub/theoremai/blob/main/react/docs/wire.md): the requests and events between the browser and the server, and the checks on each side.
- [Tool credentials](https://github.com/masudl-hub/theoremai/blob/main/react/docs/credentials.md): typed keys, OAuth and token refresh, with a full callback route.
- [Composer, queue and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md): the actions for stash, queue, steer and send now.
- [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents): profiles, tools, guardrails and providers.

License: MIT.
