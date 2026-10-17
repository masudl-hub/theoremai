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

When a chat turn, a call, a host request or a decision fails, the ready-made UI shows the error in a banner that screen readers announce at once. The end of a live call is announced when the reader is next idle.

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
import { createMemoryConversationStore, createTheoremHandler } from '@theoremjs/react/server';

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

The memory store keeps each conversation in process memory. For other stores, see [Keep the conversation](#keep-the-conversation).

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

`chatRef` gives you `send(text)`. It sends the text as the user. When the reply is complete, it returns the blocks that the turn added. It returns `null` if the chat cannot accept a message now. This happens while a reply streams or waits for a gate.
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

If the person sends a new message while a gate is open, the server cancels the open calls. The message names only the calls it cancels. The server reads each call from the reply it saved, not from the browser. The reply to the new message follows in the same stream. See [Composer, queue and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md).

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

Under the state, `TheoremDecision` shows the shortcut that asks for a decision, ⌘↵. When the profile sets `maxStateBytes` in its `inputs`, it shows the size of the state against that limit instead. Each text box is as tall as the lines of its text, within a limit.

In one column, the state sits in the middle of the page until you ask for a decision. It then eases up to the top, and the answers appear under it. With `columns`, the state moves to the left instead and the answers fill the right.

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

The kernel validates native state before resumption. A protocol, provider, model, connection, key slot or history mismatch rebuilds from portable history.
It emits `provider_warning`. The client then discards the incompatible checkpoint and retains the history.
A rebuilt session with history does not repeat the initial greeting.

A failed call does not reconnect. Without `live.sessionResumption`, a provider-ended call is complete.

### Your relay

Use a session boundary to authenticate the conversation before you open the upstream session.
Use the same authenticated session resolver and atomic session store for chat and live requests.
The boundary rejects native state that this conversation did not save.
Saved ownership also covers the operation state. An older live checkpoint cannot revive a completed action.

```ts
import { runSession } from '@theoremjs/agents';
import {
  createTheoremSessionBoundary,
  parseLiveOpenMessage,
} from '@theoremjs/react/server';

const boundary = await createTheoremSessionBoundary({
  request,
  session: authenticatedConversation,
  sessionStore: sharedSessionStore,
});
const open = parseLiveOpenMessage(firstFrame);
const session = await runSession(
  { profile, ...await boundary.prepareLiveOpen(open, hostContext) },
  { vault: hostKeyVault, execution: boundary.toolExecution, pageExecution: boundary.pageExecution },
);
for await (const event of session.events()) {
  if ((event.type === 'done' || event.type === 'provider_checkpoint') && event.providerState) {
    await boundary.recordCheckpoint(event.providerState);
  }
  sendToBrowser(event);
}
```

- `prepareLiveOpen` returns validated history, slots, context, native state, and absence duration. It removes system-role history.
- Its second argument supplies server context. Browser context stays under `client`.
- Save checkpoint ownership before you send the event. If storage fails, close the session without advertising that checkpoint.
- The boundary refuses native resumption while a saved operation is ready, running, or uncertain. It does not repeat the operation.
- Without a session resolver, the boundary uses an anonymous cookie. Forward its `setCookie` value in the upgrade response.
- `open.host` is the `openMessage` that your `connection` returned.
- Read later messages with `parseLiveClientMessage`. Give context messages to `session.sendContext({ client: message.context })`.

To build your own call view, use `useLiveRunnerModel(iface, connection, { slots, context, pageTools })` from `@theoremjs/react/ui`. It returns the state of the call, its captions and its controls. `LiveCaptionsPanel` draws the captions.

### A custom browser transport

Use `withPageToolDispatch` when your screen consumes turn events through a custom transport.
The helper runs callbacks only for dispatch grants received on the active stream.
It never reads a saved transcript to authorize callback execution.
Implement the transport's `pageResult` method to return the result to your authenticated server.
`createHttpTransport` and `createHostTransport` post that result to `/page-result`.
The built-in chat and host console apply this helper for their `pageTools`.
For a custom host view, pass callbacks as the second argument to `useTheoremHost`.

```ts
import { createHttpTransport, withPageToolDispatch } from '@theoremjs/react';

const transport = withPageToolDispatch(
  createHttpTransport({ endpoint: '/api/theorem' }),
  { highlight: async argumentsFromServer => ({ output: { shown: argumentsFromServer.id } }) },
);
```

## Server options

`createTheoremHandler` requires `profile` and `provider`. All other options are optional.

| Option | Use |
| --- | --- |
| `profile` | The profile to serve. The kernel registers it when you create the handler. |
| `provider` | Host options, including the credential vault. A function can return these options per request, for example for tenant-specific credentials. |
| `session` | Returns the session id of the caller, for example `${userId}:${conversationId}`. Return `undefined` to refuse the request with a 401. Default: a random id in an HttpOnly, SameSite=Lax cookie that lasts 30 days. |
| `host` | App data for the tool handlers (`ctx.host`), such as the signed-in user. |
| `pageToolBroker` | Delivers results to active page dispatches. Default: bounded process memory. |
| `conversationStore` | Where the conversation is kept. Required, except for a stateless profile, which must not have one. See [Keep the conversation](#keep-the-conversation). |
| `sessionStore`, `steerInbox` | Where open gates and queued steers are kept. Default: process memory. |
| `credentialStore` | Where tool credentials are kept, by session. Default: process memory. |
| `authorizationUrl` | Returns the sign-in URL for an OAuth gate. Without it, an OAuth gate has no URL. |
| `gateTtlMs` | How long a gate waits for an answer. Default: 30 minutes. A later answer fails with `session.gate_expired`. |
| `clientEvents` | Options for `forClient` and `clientError`, which prepare each event and each caught failure for the browser. `reader: 'builder'` sends the raw reason in place of the wording of the profile. Use it only in a development tool on your own machine. |
| `onError` | Receives each error that the handler catches. A visitor sees the wording of the profile for that kind of error, never the error. |

### Start a conversation with content

`startConversation` stores a conversation that opens on blocks you wrote, and returns its ref and its view. The model reads the blocks as history, so the user's next message is a follow-up.

```ts
import { startConversation, theoremSession } from '@theoremjs/react/server';

const session = theoremSession(request);
const { ref } = await startConversation({ sessionId: session.id, store: conversationStore }, profile, [
  { id: 'ask', kind: 'user-text', text: 'Two days in Lisbon. Where should I stay?' },
  { id: 'reply', kind: 'text', text: 'Stay in Chiado.' },
  { id: 'done', kind: 'turn-done' },
]);
// Send session.setCookie as Set-Cookie when it is set, and give the page the ref and view.
```

Pass the ref as `conversation` and the view as `conversationView`. The chat draws the view at once, and does not read the conversation from the server again.

```tsx
<TheoremChat endpoint="/api/theorem" conversation={ref} conversationView={view} />
```

- The store is the one you pass to the handler as `conversationStore`, and the session is the one the chat's requests carry. `theoremSession(request)` is the handler's cookie session: its `id`, and a `setCookie` header when the request had none. With your own `session` resolver, pass the id it returns.
- The profile's guardrails read the history first, at the `history` boundary, as they read every turn's history. A detector set to `redact` changes what the model reads; the transcript keeps your text. A detector set to `block` throws `detect.blocked`, and nothing is stored.
- The result's `events` are the guardrail events for what matched.

### Keep the conversation

The conversation store keeps the transcript, the history that the model reads, the provider's native state, and a reply that waits for a gate.
The session store keeps gates, permissions and operations. The two stores are separate.

| Store | Where the conversation is kept |
| --- | --- |
| `createMemoryConversationStore()` | Process memory, for one server instance. A conversation that is not saved for 24 hours expires. At most 10,000 conversations are kept; the one saved longest ago goes first. Set `ttlMs` and `maxSessions` to change these limits. |
| `createSealedConversationStore({ keys, keyVersion })` | Nowhere on the server. The ref is the conversation itself, encrypted and signed with your key, and bound to the session. The browser cannot read it or change it. |
| Your own `TheoremConversationStore` | Your database. |

A ref that the store cannot open fails with `session.conversation_unknown`. This includes a ref from another session.

The sealed store:

- Each key is at least 32 bytes. Keep the keys on the server.
- `keyVersion` names the key that seals new writes. Keep an older key in `keys` while its refs must still open.
- Each save issues a new ref. An older ref of the same conversation still opens, as a rewind does.
- If the user stops a reply, or the browser leaves while a reply runs, the server saves the result under a new ref that the browser never receives. The browser keeps the ref from when its message reached the server. The reply, and any tool call it settled, is lost to the browser. With the memory store or your own store, the ref does not change, and the chat shows what the server saved.
- The ref holds the whole conversation, including the bytes of each attachment. Every request sends it, so the conversation must stay under `maxRequestBytes`.

To keep conversations in your own database, implement these two methods:

```ts
import type {
  ConversationSnapshot,
  ConversationWriteResult,
  StoredConversation,
} from '@theoremjs/react/server';

interface ConversationDatabase {
  read(sessionId: string, ref: string): Promise<ConversationSnapshot | undefined>;
  write(
    sessionId: string,
    ref: string | null,
    expectedRevision: string | null,
    next: StoredConversation,
  ): Promise<ConversationWriteResult>;
}
```

- Every read and write names the session. For a ref that this session did not write, `read` returns `undefined` and `write` returns `{ written: false }`.
- A null `ref` creates a conversation. Return a new opaque `ref` and `revision`.
- Otherwise, write only while the stored revision is still `expectedRevision`, as one atomic operation. Return `{ written: false }` on a conflict.
- Check what you read back with `storedConversationSchema`.

### Share session authority

Use one shared `TheoremSessionStore` when requests can reach several server instances.
New execution claims retain accepted request data and final prepared input under `operation.invocation`.
Use this data in `authorizeToolReplay` to check current access to the affected resource.
Older records can lack this evidence. Refuse disclosure if your access check needs it.
It holds approvals and provider checkpoint ownership. Tool credentials use the separate `credentialStore`.

```ts
import type {
  SessionSnapshot,
  SessionWriteResult,
  TheoremSessionState,
} from '@theoremjs/react/server';

interface SharedSessionStore {
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  compareAndSwap(
    sessionId: string,
    expectedRevision: string | null,
    next: TheoremSessionState,
  ): Promise<SessionWriteResult>;
}
```

Implement `compareAndSwap` as one atomic database operation. A separate read followed by a write is unsafe.
A null revision creates an absent session. A matching revision replaces the current state.
Return `{ written: false }` on a conflict. On success, return `{ written: true, revision }` with a new opaque revision.
Never reuse a revision, including after expiration. Return detached state from `load`.
Return write success only after the store meets its promised durability.

Each tool action has a kernel-issued `operationId`. The provider's `callId` identifies the upstream call.
An approval must carry both values. A new action receives a new operation ID even if its provider reuses a call ID.
A settled replay can omit input. If it supplies input, that input must match the accepted invocation.
The built-in clients copy this reference from the gate event. Custom clients must preserve it.
Historical events can omit operation IDs for display. They cannot authorize a new action.

The handler validates versioned state and retries a conflicting transition at most eight times.
It does not run tools inside this retry loop. Invalid state fails; it does not become an empty session.
The previous session `load`/`save` contract is not supported. Existing unversioned state and versions 1 or 2 require an explicit host migration.
An older pending gate does not prove that its body never ran. Verify the destination before restoring execution authority.
The current session state uses version 3. Gates and operation records use operation IDs as keys.
Each operation record contains its retained outcome. There is no separate outcome cache.
A gate belongs to the profile that issued it. Another profile cannot consume it through shared session storage.
The handler saves an accepted answer as ready before it invokes the kernel.
A retry before dispatch must repeat that accepted answer. It cannot change the input or decision.
Immediately before the tool body, an atomic claim changes ready to running.
The kernel saves the terminal outcome before it sends completion to the client.
A later answer receives that outcome without executing the tool or preparation hooks again.
The handler checks current tool registration and profile allowlisting before disclosing the outcome.
The handler checks current output rules before replay. Required redaction or refusal withholds the saved result.
Supply `authorizeToolReplay` for current role or resource access checks. This read-only callback can withhold a result without reopening the action.
If execution ends without a saved outcome, the claim remains running or becomes uncertain.
The handler never restores that operation as an approval. The host must check the destination before any new action.
Saved outcomes include guarded model read-back, media, provenance, and suspicious content signals.
The handler retains settled operations for 24 hours from settlement by default. Set `operationRetentionMs` to change this window.
Each saved outcome records its absolute retention deadline. Changing a handler's policy does not shorten that deadline.
Each issued gate records its absolute expiry. Changing `gateTtlMs` does not extend an issued gate.
Ready, running, and uncertain operations do not expire.

Use `sessionLimits` when your storage budget requires different finite limits. The defaults are:

| Limit | Default |
| --- | --- |
| `maxGates` | 32 |
| `maxOperations` | 128 |
| `maxCheckpoints` | 256 |
| `maxPermissions` | 2,048 |
| `maxStateBytes` | 32 MiB |
| `maxInvocationBytes` | 256 KiB |
| `maxOutcomeBytes` | 256 KiB |

Set `maxRequestBytes` to bound browser JSON before parsing. Its default is 16 MiB.
The handler rejects oversized requests before provider access or tool preparation.
Provider host options also accept `limits` for deadlines and upstream output.
Byte limits measure UTF-8 JSON. The handler reserves one maximum outcome for each gate and unresolved operation.
A new claim fails before dispatch when it cannot reserve that space.
An oversized result after dispatch leaves an uncertain claim. It does not restore an approval.
Limits never remove unresolved authority or shorten retained settlements. The host must reconcile and archive unresolved actions.
The memory store accepts the same `sessionLimits` options. Shared stores receive checked states through the handler.

The default memory store coordinates handlers that share the same store object.
It retains unexpired gates, unresolved operations, and unexpired outcomes during idle and capacity eviction.
It refuses a new session when every stored session has protected authority.
Separate memory stores and process restarts do not retain shared authority.
Atomic updates prevent two workers from dispatching the same operation. A process crash leaves its running claim protected.
These claims do not provide exactly-once effects at the destination. Use the operation ID with destination idempotency when available.
Concurrent pending attempts can reach preparation before one claims the body.
Permission checks and pre-body hooks must be read-only or independently idempotent. The kernel cannot prove hook purity.
A live session does not restore a dispatched call after an unexpected failure. It retains an uncertain call on that connection.
To retain execution claims across connections, supply a durable coordinator through `RunSessionOptions.execution`.
Browser dispatch uses a host-owned `PageToolExecution` service beside the execution coordinator.
`createTheoremHandler` supplies both services. Live relays pass the session boundary's `pageExecution` and `toolExecution` to `runSession`.
Forward live page results to `answerPageResult`. Preserve checkpoint ownership through `beforeEvent` when using the Studio bridge.
The default `PageToolBroker` keeps active result waiters in process memory. Several workers need a shared broker or request affinity.
Use `pageToolBroker` to supply that broker. It carries results; the atomic session store retains execution authority.
Lost result delivery does not permit another dispatch. The operation retains its claim or an uncertain outcome.
The default result deadline is 20 seconds. An expired or interrupted result cannot reopen approval.

## Build your own server

`createTheoremHandler` runs each chat reply through a small loop that `@theoremjs/react/server` exports. Use the loop when your server is not a `fetch` handler, or when your routes differ from the handler's. The conversation store, the guardrails and the wire stay the same, so `TheoremChat` and the hooks work with your server unchanged.

| Function | Use |
| --- | --- |
| `readerConversationHost({ sessionId, store, profile, clientEvents })` | The conversation of one session, and how its events reach the browser (`forClient`). |
| `openConversation(host, ref, use)` | Reads the conversation under `ref`, or starts one when `ref` is `undefined`. It refuses a request that `use` does not allow, before anything runs. |
| `postedMessage(iface, input, context?)` | Checks the person's message against the profile's inputs. `iface` is `interfaceFromProfile(profile, defaultKernelScope.tools)` from `@theoremjs/agents/interface`. |
| `messageReply({ host, opened, message, walkAway?, runner })` | Posts the message, runs the reply and writes it back. Returns the lines to stream. |
| `answerReply({ host, opened, call, settling, runner })` | Continues a reply after one of its calls was answered. `settling` is the call's events from the kernel's `invokeTool`. |
| `rewindConversation({ host, opened, at, walkAway? })` | Cuts the conversation after transcript block `at`. `-1` empties it. |
| `conversationView(host, conversation)` | The conversation as the chat draws it. |
| `waitingCalls(conversation)` | The calls a paused reply waits on. A message or a rewind walks away from exactly these. |

`use` says what the request opens the conversation for: `{ kind: 'read' }`, `{ kind: 'message', abandon? }`, `{ kind: 'answer', call }` or `{ kind: 'rewind', at }`.

The runner is how your server runs the model for a reply. This server answers a message for `support`, the profile from the [Quick start](#quick-start):

```ts
import { compactHistory, defaultKernelScope, runTurn } from '@theoremjs/agents';
import { interfaceFromProfile } from '@theoremjs/agents/interface';
import {
  createMemoryConversationStore,
  messageReply,
  openConversation,
  postedMessage,
  type ReplyRunner,
  readerConversationHost,
  theoremTurnRequestSchema,
} from '@theoremjs/react/server';

const provider = { vault: { main: process.env.GEMINI_API_KEY } };
const conversations = createMemoryConversationStore();

async function* send(sessionId: string, body: unknown, signal: AbortSignal) {
  const request = theoremTurnRequestSchema.parse(body);
  const host = readerConversationHost({ sessionId, store: conversations, profile: support, clientEvents: undefined });
  const runner: ReplyRunner = {
    run: (turn) => runTurn({ profile: support.id, ...turn, signal }, provider),
    async compact(history, tokens, model) {
      const compacted = await compactHistory({ profile: support.id, history, tokens, signal, ...(model ? { model } : {}) }, provider);
      return compacted?.history;
    },
    signal,
  };
  const message = postedMessage(interfaceFromProfile(support, defaultKernelScope.tools), request.input);
  const opened = await openConversation(host, request.conversation, { kind: 'message' });
  yield* messageReply({ host, opened, message, runner });
}
```

Write each line as one JSON line of an `application/x-ndjson` response. The reply's events come first, then a `conversation` line with the ref the store issued. When the run fails, its error line comes last.

What the loop leaves to you:

- The session. Every read and write names it, and the store refuses a ref from another session.
- Gates. A profile whose tools wait for approval needs a session store that issues each gate and checks its answer. `createTheoremHandler` keeps one. With your own server, check the answer, run the call with `invokeTool`, and pass its events to `answerReply`.
- Walking away. A message to a reply that waits on gates must name exactly `waitingCalls(conversation)` as `abandon`, and pass each call's cancelled run as `walkAway`.

On the browser side, `@theoremjs/react/client` reads what your server sends:

| Export | Use |
| --- | --- |
| `CHAT_LINES` | The schemas of a reply's lines: each turn event, and the `conversation` line. |
| `ChatLine`, `ChatLineSink` | A checked line, and the callback that receives each one. |
| `fetchConversation(url, body, options?)` | POSTs a conversation read, and checks the view your server answers. |
| `fetchRewound(url, body, options?)` | POSTs a rewind, and checks the rewound conversation. |
| `failedDecisionTraces(err)` | The trace records that a failed decision left, for the trace inspector. |

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
- An attachment problem is an `AttachmentValidationIssue`. Use `attachmentIssueText(issue, iface.labels)` from `@theoremjs/agents` to get its text.
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
