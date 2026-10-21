# @theoremjs/react

[![npm](https://img.shields.io/npm/v/@theoremjs/react?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/@theoremjs/react)
[![CI](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml/badge.svg)](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/masudl-hub/theoremai/blob/main/LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/masudl-hub/theoremai)

Define an agent once. Get the server and the user interface from the same definition.

## The idea

In Theorem, you write an agent as a **profile** (see [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents)). The profile states:

- which models the agent can use
- what the agent accepts: text, images, files, or voice
- which tools the agent can call
- what the agent must return
- how the kernel guards each input and output

This package uses the same profile on both sides.

- **Server.** `createTheoremHandler` runs the profile. It enforces the guardrails and the tool gates, and it keeps the conversation.
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

When a profile records traces, the chat offers a floating trace toggle. Opening the trace uses the same toggle to close it, with a selected appearance. When the trace replaces the chat, its pane has equal padding on all sides.

The package has three parts:

- A ready-made chat, voice call, host console, and decision form. They are built on [Astryx](https://www.npmjs.com/package/@astryxdesign/core).
- Hooks and a transport, for your own UI.
- The server handler and the client of [`@theoremjs/web`](https://www.npmjs.com/package/@theoremjs/web), as `/server` and `/client`.

## Install

```bash
npm install @theoremjs/react @theoremjs/web @theoremjs/agents zod react react-dom
```

For the ready-made UI (`/ui` and `/live`), also install Astryx and StyleX:

```bash
npm install @astryxdesign/core @stylexjs/stylex
```

To build your own theme from the Theorem theme (`/ui/theme`), also install `@astryxdesign/theme-neutral`.

Use the versions that this package lists in `peerDependencies`. Install `@theoremjs/react`, `@theoremjs/web`, and `@theoremjs/agents` at the same version. The Astryx and StyleX peers are optional. The hooks work without them.

When a chat turn, a call, a host request, or a decision fails, the ready-made UI shows the error in a banner that screen readers announce at once. The end of a live call is announced when the reader is next idle.

Requirements:

- TypeScript 5.7 or later, for the type declarations.
- A bundler that handles CSS imports. Vite does. `/ui` and `/live` import their own stylesheets.
- For voice, a bundler that resolves `new URL('./worklets/mic-capture.js', import.meta.url)`. Vite does.

The package does not include the Figtree font. The theme uses Figtree, and falls back to the system font if Figtree is not loaded. To use Figtree, load the font in your app.

## Quick start

### 1. Register the provider and create the handler

Register the provider before you create the handler. The profile binds models through the registered provider's `.model()` helper.
The helper takes the protocol and the model ID. Pass credential values through the handler's vault.
Supply vault slots as own properties. The server ignores inherited credentials and resolvers.
Replacing the registration affects later runs. An active run keeps the registration that it started with.

```ts
import { defineProfile, geminiProvider, registerProvider } from '@theoremjs/agents';
import { createMemoryConversationStore, createTheoremHandler } from '@theoremjs/web/server';

const gemini = registerProvider(geminiProvider, { keySlot: 'main' });

const support = defineProfile({
  type: 'text',
  id: 'support.agent',
  identity: { handle: 'support', system: 'You help customers with their account.' },
  models: {
    fast: gemini.model('geminiInteractions', 'gemini-3.5-flash-lite'),
  },
  defaultModel: 'fast',
  tools: { allow: [] },
  inputs: { text: true },
});

export const theorem = createTheoremHandler({
  profile: support,
  provider: { vault: { main: process.env.GEMINI_API_KEY } },
  conversationStore: createMemoryConversationStore(),
});
```

The memory store keeps each conversation in process memory. For other stores, see [Keep the conversation](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#keep-the-conversation).

### 2. Mount the handler

`createTheoremHandler` returns a function: `(request: Request) => Promise<Response>`. It works in Workers, Deno, Bun, Hono, and Next route handlers. In Node, use an adapter.

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

The profile, the keys, and the system prompt stay on the server. The browser receives only the interface of the profile: the models, the inputs, the tool names, and the wording. The handler removes the system prompt from this description.

## Entry points

| Import | Content |
| --- | --- |
| `@theoremjs/react` | Hooks, transports, and client logic |
| `@theoremjs/react/ui` | `TheoremChat`, `TheoremHost`, `TheoremDecision`, `TheoremEmbedding`, and their parts |
| `@theoremjs/react/live` | `LiveRunner`, the voice and video call UI |
| `@theoremjs/react/server` | `@theoremjs/web/server`: the handlers and the stores they use |
| `@theoremjs/react/ui/theme` | `theoremTheme`, the base for your own Astryx theme |
| `@theoremjs/react/ui/icons` | The icon set of the theme |
| `@theoremjs/react/client` | `@theoremjs/web/client`: the client logic, without the hooks |

## Chat

`<TheoremChat />` accepts these props. All props are optional.

| Prop | Use |
| --- | --- |
| `endpoint` | The path where the handler is mounted. Default: `/api/theorem`. |
| `http` | Fetch options for the default transport, such as auth headers or a custom `fetch`. |
| `transport` | Your own transport, instead of `endpoint`. Use it for tests or for hosts that do not use HTTP. |
| `theme`, `mode` | An Astryx theme, and `'system'`, `'light'`, or `'dark'`. Without `theme`, the chat uses your theme or the Theorem theme. |
| `labels` | Replacement text for each locale. See [Wording](#wording). |
| `placeholder`, `emptyState` | The composer placeholder, and the content above the composer before the first message. |
| `density`, `maxWidth`, `className`, `style` | Layout. `maxWidth` is a CSS length. Default: half of the chat width, or the full width on a narrow screen. |
| `trace` | Shows the trace instead of the chat. Use it when your own control switches the view. The profile must record traces. |
| `conversation`, `conversationView`, `onConversationChange` | Resume a conversation that the server keeps, or open one you started. See below. |
| `initialText` | The text that the composer starts with. The user can send it or change it. The component reads it once, when it mounts. |
| `chatRef` | Sends a message from your code. See below. |
| `composer` | `false` leaves the composer out. The chat is the transcript alone, and your own control sends through `chatRef`. Default: `true`. |

### Resume a conversation

The server keeps the conversation in its `conversationStore`. The browser never sends the history. It holds only a ref that the store issued.

`onConversationChange` gives you each new ref. It runs:

- when the message reaches the server
- each time the server saves the reply, while the reply runs and when it ends

Keep the latest ref. To resume the conversation, pass it as `conversation`. The component reads this value once, when it mounts. It then draws the conversation as the server keeps it, including a reply that waits for a gate.

```tsx
<TheoremChat
  endpoint="/api/theorem"
  conversation={savedRef}
  onConversationChange={(ref) => saveRef(ref)}
/>
```

If the server does not save the message, the message leaves the transcript. It goes back in the composer with the error, and the user can send it again.
If the browser loses the response to a gate answer, the chat reads the conversation again from the server. The same answer sent again fails with `session.gate_expired`.
If the server can no longer open the ref, the message fails with `session.conversation_unknown`. The error's `errorCopy` carries that key. The chat then sends the message once more, with the transcript the page shows as `transcript`. `createTheoremHandler` ignores it, because the server owns the conversation, so the message fails. The studio's server owns no conversation of its own: it continues from the transcript under a new ref.

A profile whose `providerContinuation.history` is `'stateless'` keeps no conversation. The server stores nothing and issues no ref. The transcript is kept only in the page, and a reload clears it.

### Send a message from your code

`chatRef` gives you `send(text, files?)`. It sends the text and optional array of browser files as the user. Files use the same profile validation and encoding as composer attachments. When the reply is complete, it returns the blocks that the turn added. It returns `null` if the chat cannot accept a message now. This happens while a reply streams or waits for a gate.
`chatRef` also gives you `stop()`. It stops the reply that streams, as the composer's stop button does.

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

If the person sends a new message while a gate is open, the server cancels the open calls. The message names only the calls it cancels. The server reads each call from the reply it saved, not from the browser. The reply to the new message follows in the same stream. See [Composer, queue, and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md).

## Other profile types

Each profile type has a handler and a component. Mount the handler. Point the component at it.

### Host

A `host` profile does not run a model. The page calls the tools of the profile directly. Each call passes through the gates and the guardrails of the kernel.

```ts
import { createTheoremHostHandler } from '@theoremjs/web/server';

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

The console builds a form from the input schema. It shows the result as figures, charts, tables, images, audio, or Markdown, with the raw JSON beside it. If the data renderer fails, the view switches to JSON so the selected view matches what is shown. For your own UI, use `createHostTransport` and `useTheoremHost`.

#### Serve a host profile over MCP

`createTheoremMcpHandler` from `@theoremjs/web/server` serves the same profile to MCP clients, such as coding agents and chat apps. See [Serve a host profile over MCP](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#serve-a-host-profile-over-mcp).

### Decision

A `decision` profile has no conversation. You give it a JSON state and questions. It answers the questions about the state.

```ts
import { createTheoremDecisionHandler } from '@theoremjs/web/server';

export const decide = createTheoremDecisionHandler({ profile, questions, vault }); // mount at /api/decision
```

```tsx
import { TheoremDecision } from '@theoremjs/react/ui';

<TheoremDecision endpoint="/api/decision" />
```

- `questions` maps each question id to its definition.
- `images` is optional. It holds pictures every decision sends, by the reference the questions write, such as `<ghs02>` in "Which item matches <ghs02>?". The page sees them and refuses its own image under one of their names.
- `vault` holds the keys of the profile, by slot.
- `metadata` is optional. It adds data, such as the signed-in user, to the trace record of each decision.

When the profile sets `maxStateBytes` in its `inputs`, `TheoremDecision` shows the size of the state against that limit under it. Each text box is as tall as the lines of its text, within a limit.

In one column, the state sits in the middle of the page until you ask for a decision. It then eases up to the top, and the answers appear under it. With `columns`, the state moves to the left instead and the answers fill the right.

A profile whose model takes images (`images: true`, see the TypeSafe options in `docs/contracts/providers.md`) shows a drop area under the state when a question is a box. Each PNG or JPEG dropped there becomes a state field named after the file. The field holds the image's reference, its name in angle brackets: `pantry shelf.jpg` becomes `{ "pantry_shelf": "<pantry_shelf>" }`. The field shows the image, opens it full size in a lightbox when clicked, and can replace it. A question names the field in backticks, such as "Which jar in `pantry_shelf` is open?". TypeSafe reads a reference anywhere it appears as text. The brackets keep a reference from matching an ordinary word. A decision sends only the images its state still names, as `assets`, and the kernel refuses any that are not PNG or JPEG bytes before a request leaves. Pass `defaultImages`, with a `defaultState` that names them, to start with some.

A box answer is drawn as the part of the image it covers, with its edges beside it as shares of the image. The image is the one the question's `image` gives, a reference or a state field. Without one, it is the one at the field the instructions first name in backticks, such as `chart` in "Where on `chart` would the green apple in `photo` sit?". Without that, it is the first image the state names, or else the first held. Click the cut-out to open the whole image in a lightbox, with the box outlined in `--color-accent` and the rest shaded in `--color-overlay`.

Pass `onQuestion` to open a question where it is set up, such as in an editor. Each answer then has a button that calls it with the question's id.

Pass `questionText`, each question's text by its id, to show it under its answer's title, cut to two lines with the rest on hover. The page is never sent a question's instructions, so it shows only the text you give it.

For your own UI, use `useTheoremDecision`. Its `decide(state, assets)` takes the images by reference.

### Embedding

An `embedding` profile turns inputs into vectors. Each input is text, or an object with `parts`: text and files.

```ts
import { createTheoremEmbeddingHandler } from '@theoremjs/web/server';

export const embed = createTheoremEmbeddingHandler({ profile, vault }); // mount at /api/embedding
```

```tsx
import { TheoremEmbedding } from '@theoremjs/react/ui';

<TheoremEmbedding endpoint="/api/embedding" />
```

`TheoremEmbedding` is a search bench. Paste text and choose where it splits: not at all, at each line, at blank lines, at commas, or at a separator of your own. Or drop files: a text, Markdown, CSV, or JSON file splits the same way, and an image, audio, video, or PDF file is one document. **Index** embeds the documents with the `document` task, in as few requests as the profile's `inputs` and its model allow. The interface holds the profile's inputs to what its default model takes: the file types both accept, the files one input may hold, and the inputs one request may carry, read from the model's protocol. For a protocol of your own, pass it to `embeddingInterface(profile, [protocol])`. Type a query and press **Search**: it embeds the query with the `query` task and ranks the documents by cosine similarity. `defaultText` and `defaultQuery` fill the two cards.

Each request is held to the `inputs` of the profile before it is sent, and each shows as JSON and in the trace.

For your own UI, use `useTheoremEmbedding` for one request, and `embed(inputs, { task })` to set the task. Use `useEmbeddingIndex` to embed many documents in batches. `splitText`, `embeddingBatches`, and `rankMatches` from `@theoremjs/web/client` split, batch, and rank as the bench does.

**Index** also draws the documents as a space: each a dot in a ball, placed by the three directions their vectors differ most along, and joined to its nearest neighbour when that pair is far more alike than the typical pair. A query is a white dot joined to its matches. Drag to turn it; point at a dot to name its document. For your own UI, `EmbeddingSpaceView` from `@theoremjs/react/ui` draws a space from `layoutSpace(vectors)`, or from `layoutSpaceSoon(vectors, signal)`, which lays it out in slices so the page stays responsive, and places a query with `placeQuery(space, vector)`, all from `@theoremjs/web/client`. Where the browser cannot draw it, the view calls `onUnavailable`, and the bench lists the vectors instead.

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

`LiveRunner` also accepts `theme`, `mode`, `labels`, and `trace`. Tool gates in a call appear in a dialog over the call.

### The page's part in a call

Three more props give the call values from the page. The profile declares each one; the page only supplies the value.

| Prop | The profile declares | What the page gives |
| --- | --- | --- |
| `slots` | `inputs.slots` | The value chosen for each slot. It is read when the call starts. A value that changes during a call takes the call up again with it when the profile has resumption on; otherwise the next call has it. |
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
- `TheoremChat` and `useTheoremChat` take the same `pageTools`. When a chat agent calls a page tool, the reply waits for the page's answer and then goes on. The person is shown no prompt.
- The runner writes a console warning when the profile has a page tool with no function in `pageTools`, and when `pageTools` has a function for a tool that is not a page tool.

The live client checks a tool call with its relay before it invokes a page callback.
It waits for permission and sign-in decisions first. A claimed dispatch grant supplies the final checked arguments.
The callback runs only for that grant. It returns its result with the call ID, operation ID, and grant ID.
The server validates the result against the saved claim before the kernel checks the tool output.
A restored page gate does not run a callback. Cached terminal replay emits no dispatch grant.

To make the agent speak first, set `live.greeting` on the profile. The page sends nothing for it.

### A call that drops

Use `live.sessionResumption` to reconnect after a dropped connection or a provider time limit.
The client stores the native checkpoint beside portable history. It sends both when it opens the next session.

The runner shows `reconnecting`. It tries five times, after 0.5, 1, 2, 4, and 8 seconds.
If all attempts fail, it reports a `network` error.
The relay receives the absence duration. If the profile sets `live.resumed`, the agent announces its return after the configured `afterMs`.

The kernel validates native state before resumption. A protocol, provider, model, connection, key slot, or history mismatch rebuilds from portable history.
It emits `provider_warning`. The client then discards the incompatible checkpoint and retains the history.
A rebuilt session with history does not repeat the initial greeting.

A failed call does not reconnect. Without `live.sessionResumption`, a provider-ended call is complete.

### Your relay

The relay is server code. To authenticate the conversation and resume a call in your relay, see [Your relay](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#your-relay).

To build your own call view, use `useLiveRunnerModel(iface, connection, { slots, context, pageTools })` from `@theoremjs/react/ui`. It returns the state of the call, its captions, and its controls. `LiveCaptionsPanel` draws the captions.

### A custom browser transport

Use `withPageToolDispatch` when your screen reads turn events through a custom transport. See [A custom browser transport](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#a-custom-browser-transport).

## Server

The handlers, the stores, and the client come from [`@theoremjs/web`](https://www.npmjs.com/package/@theoremjs/web). This package re-exports them as `@theoremjs/react/server` and `@theoremjs/react/client`. In the `@theoremjs/web` README:

- [Server options](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#server-options): what `createTheoremHandler` takes.
- [Keep the conversation](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#keep-the-conversation): the conversation stores, and your own database.
- [Share session authority](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#share-session-authority): one session store for several server instances.
- [Build your own server](https://github.com/masudl-hub/theoremai/blob/main/web/README.md#build-your-own-server): the reply loop, for a server that is not a `fetch` handler.

## Build your own UI

The hooks give you the same state and actions that the ready-made components use. They draw nothing.

`useTheoremInterface` reads the interface of the profile from the server. `useTheoremChat` keeps the transcript, the streaming state, the drafts, the queue, and the gates.

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

`chat.phase` is `'idle'`, `'streaming'`, or `'gated'`. The actions are `handleSubmit`, `handleStop`, `handleSendNow`, and `handleToolDecision`.

To show the transcript and the composer, use `ChatTranscript` and `ChatComposerBar` from `/ui`. You can also draw your own from `chat.blocks`.

The hooks and the client write no English text. They return kinds, codes, and states. You write the words.

- A failure is a `ClientFailure`: `{ error, errorKind, errorInternal? }`. Show `error` to the user. It is the wording of the profile. `errorKind` and `errorInternal` are for your code.
- An attachment problem is an `AttachmentValidationIssue`. Use `attachmentIssueText(issue, iface.labels)` from `@theoremjs/agents` to get its text.
- A provider can end a live call after it gives a warning. This is not a failure. `LiveSessionClient` calls `onSessionEnded(session)`. `session.message` is the wording of the profile (`live.session_ended`). `session.ended` has the close code and the timing.
- The state of the UI is given as values, such as `liveState`, the work status, the drawer parts, and the hint ids. You choose the words for them.

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

`LiveRunner`, `TheoremHost`, `TheoremDecision`, and `TheoremEmbedding` accept the same prop.

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
- [Tool credentials](https://github.com/masudl-hub/theoremai/blob/main/react/docs/credentials.md): typed keys, OAuth, and token refresh, with a full callback route.
- [Composer, queue, and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md): the actions for stash, queue, steer, and send now.
- [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents): profiles, tools, guardrails, and providers.

License: MIT.

Set `--theorem-pane-background` on a containing element to change the fill of raised panes within it. The default is `--color-background-card`.
