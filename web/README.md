# @theoremjs/web

[![npm](https://img.shields.io/npm/v/@theoremjs/web?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/@theoremjs/web)
[![CI](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml/badge.svg)](https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/masudl-hub/theoremai/blob/main/LICENSE)

Serve a Theorem profile over HTTP, and talk to it from a browser, with no UI framework.

## The idea

In Theorem, you write an agent as a **profile** (see [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents)). This package puts the profile on the web.

- **Server.** `createTheoremHandler` takes a Web `Request` and returns a `Response`. It runs the profile, enforces the guardrails and the tool gates, and keeps the conversation. Each other profile type has its own handler.
- **Browser.** The transports call the handlers. The client checks each line the server sends, and folds the lines into state that any UI can draw.

The package imports no UI framework. [`@theoremjs/react`](https://www.npmjs.com/package/@theoremjs/react) builds its hooks and its ready-made UI on it, and re-exports it as `@theoremjs/react/server` and `@theoremjs/react/client`.

## Install

```bash
npm install @theoremjs/web @theoremjs/agents zod
```

Install `@theoremjs/web` and `@theoremjs/agents` at the same version.

Requirements:

- TypeScript 5.7 or later, for the type declarations.
- For voice, a bundler that resolves `new URL('./worklets/mic-capture.js', import.meta.url)`. Vite does.

## Entry points

| Import | Content |
| --- | --- |
| `@theoremjs/web/server` | The handlers and the stores they use |
| `@theoremjs/web/client` | The transports, the wire schemas, and the client logic |

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
  operationRetentionMs: 24 * 60 * 60 * 1000, // a day: how long a finished call's result is kept
});
```

The memory store keeps each conversation in process memory. For other stores, see [Keep the conversation](#keep-the-conversation).

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

The profile, the keys, and the system prompt stay on the server. The browser receives only the interface of the profile: the models, the inputs, the tool names, and the wording. The handler removes the system prompt from this description.

To show a chat on this handler, use `TheoremChat` from [`@theoremjs/react`](https://www.npmjs.com/package/@theoremjs/react).

## Serve a host profile over MCP

`createTheoremMcpHandler` serves the same profile to MCP clients, such as coding agents and chat apps, at one endpoint. It answers MCP clients of the current revision and clients that still open with `initialize`, and it keeps no session between requests.

```ts
import { createTheoremMcpHandler } from '@theoremjs/web/server';

export const mcp = createTheoremMcpHandler({ profile: docsTools, version: '1.0.0' }); // mount at /mcp
```

- `tools/list` gives each allowed tool with its input schema. A tool's `access` becomes the read-only and destructive hints of MCP.
- Clients of the current revision may cache the tool list for 5 minutes and the discovery result for an hour. Neither holds anything about the caller, so a shared cache may keep them.
- `tools/call` runs the tool through the gates, the guardrails, and the trace of the kernel. The client receives the text and media a model would read, not the raw output. A reference a tool returned, which no model reads, is left out. So is all the media of a hidden tool (`exposeToModel: false`), whose model reads only that the call completed.
- A tool that fails returns a result marked `isError`, so the model can read it and try again.
- No one can approve a call over MCP. The handler refuses a profile when an allowed tool has a permission other than `auto`.
- A browser page on another origin is refused unless `origins` lists it.

## Your relay

A `live` profile runs a voice or video call through a WebSocket relay that you host.

Use a session boundary to authenticate the conversation before you open the upstream session.
Use the same authenticated session resolver and atomic session store for chat and live requests.
The boundary rejects native state that this conversation did not save.
Saved ownership also covers the operation state. An older live checkpoint cannot revive a completed action.

```ts
import { runSession } from '@theoremjs/agents';
import {
  createTheoremSessionBoundary,
  parseLiveOpenMessage,
} from '@theoremjs/web/server';

const boundary = await createTheoremSessionBoundary({
  request,
  session: authenticatedConversation,
  sessionStore: sharedSessionStore,
  operationRetentionMs: 24 * 60 * 60 * 1000,
});
const open = parseLiveOpenMessage(firstFrame);
const session = await runSession(
  {
    profile,
    ...await boundary.prepareLiveOpen(open, profile, hostContext),
    execution: boundary.toolExecution,
    pageExecution: boundary.pageExecution,
  },
  { vault: hostKeyVault },
);
for await (const event of session.events()) {
  if ((event.type === 'done' || event.type === 'provider_checkpoint') && event.providerState) {
    await boundary.recordCheckpoint(event.providerState);
  }
  sendToBrowser(event);
}
```

- `prepareLiveOpen` returns validated history, options, context, native state, and absence duration. It removes system-role history.
- Its second argument is the profile the call opens on. A model or effort the page picks is refused unless that profile sets `allowModelSelect` (or the binding's `allowEffortSelect`).
- Its third argument supplies server context. Browser context stays under `client`.
- Save checkpoint ownership before you send the event. If storage fails, close the session without advertising that checkpoint.
- The boundary refuses native resumption while a saved operation is ready, running, or uncertain. It does not repeat the operation.
- Without a session resolver, the boundary uses an anonymous cookie. Forward its `setCookie` value in the upgrade response.
- `open.host` is the `openMessage` that the page's `connection` returned.
- Read later messages with `parseLiveClientMessage`. Give context messages to `session.sendContext({ client: message.context })`.

### The live client

`LiveSessionClient` opens the call from the page. It runs each call the model makes on the relay:

```ts
import { LiveSessionClient } from '@theoremjs/web/client';

const client = new LiveSessionClient({
  profile: 'guide',
  pageTools: {
    highlight: (args) => ({ output: { highlighted: String(args.target) } }),
  },
});
await client.connect();
```

- A call dispatched to the page runs the `pageTools` function of the same name. Its `output` goes to the model.
- A page tool with no function, or a function that throws, answers with no answer. The console names a page tool that has no function. The call does not wait.
- `onGate` answers every other gate: ask the user, then return what `continueGatedToolInvocation` makes of the answer. Without `onGate`, the client refuses every gate.
- When the connection closes, the calls still open fail, and the relay closes the session.

## A chat with no framework

Use `createChatController` when you draw the chat yourself, in any framework or none. It holds all of the chat's logic, and it draws nothing:

- the transcript, and the reply as it streams;
- the composer's draft, files, and voice note;
- the pending messages: steer, queue, and stash;
- the gates, branching, and resuming a conversation.

`useTheoremChat` from `@theoremjs/react` is this controller, bound to React.

```ts
import { createChatController, createHttpTransport } from '@theoremjs/web/client';

const transport = createHttpTransport({ endpoint: '/api/theorem' });
const iface = await transport.describe();
if (iface.type === 'live') throw new Error('Use LiveSessionClient for a live profile.');

const chat = createChatController({ transport, iface });
chat.subscribe(() => draw(chat.getState()));

chat.setDraftText('What is in my cart?');
await chat.submit();
```

- `getState()` returns a `ChatState`. It is a new object after each change, and the same object between changes. So you can compare it by reference, as React's `useSyncExternalStore` does.
- `subscribe(listener)` calls the listener once for each group of changes, after the code that made them has run. It returns the function that unsubscribes. Until the first subscribe or send, the chat asks nothing of the host. Then it reads a resumed conversation that came without its `conversationView`, and answers a restored page gate as unanswered.
- `update(options)` gives the controller your latest options, such as a new `context`, `options`, or `pageTools`. Each turn reads the options as they are when it is sent. `conversation`, `conversationView`, `initialText`, `initialFiles`, `initialVoice`, and `initialPending` are read only when the controller is created.
- A live call takes `stated` in its options, and `setStated(stated)` changes it during the call. As with `setOptions`, the call is taken up again with the prompt lines the new value chooses.
- Each method is bound to the controller. Pass it as a callback as it is.
- `state.delivery` says how far the latest message has got: `sending` while it posts, `sent` once the server has it, `delivered` once the model works on it, and `read` once the reply starts. The server's own events (`stage`, `guardrail`, `late_results`, `session`, `hook_failed`, `error`, `done`) leave it at `sent`, because they say nothing of the model. It is `null` before the first message and after its turn fails.

`state.phase` is `'idle'`, `'streaming'`, or `'gated'`. At `'gated'`, the reply waits on a tool gate. `state.waitingGate` is that gate when the person must answer it: a confirmation, a permission or a sign-in. It is `null` at other times, and for a page gate, which the page answers.

The methods for the composer depend on the phase:

| Method | What it does |
| --- | --- |
| `submit()` | At `idle`, sends the draft. Otherwise, queues it. |
| `enqueue('steer')` | Sends the draft to the running turn with `transport.steer`. The steer leaves `pendingMessages` when the turn's `stage` event names it in `injected`, and joins the transcript there, between the reply before it and the reply after. A steer the turn never takes waits at the front of the queue. When the host saves the steer itself (`intake`), the steer stays in `pendingMessages` with `saved` set, and the page does not send it again. See [Messages the host saved](#messages-the-host-saved). |
| `enqueue('queue')` | Keeps the draft to send after the reply. When the reply ends without a failure and no gate waits, the first queued message is sent. |
| `enqueue('stash')` | Keeps the draft without sending it. `queuePending(id)` moves it to the queue. |
| `pend(message)` | Steers, queues, or stashes a message you made with `createComposerPendingMessage`, as `enqueue` does the draft. A message queued on an idle chat sends at once. A composer shared by several chats gives each the same message, so its id names it in all of them. |
| `sendNow(message?)` | Sends a pending message, or the draft, at once. A streaming reply is stopped first, as `stop()` stops it. A reply that waits on gates is left. |
| `movePending(id, direction)` | Moves a pending message one place `'up'` or `'down'` among the messages of its kind. `composerPendingMoves(messages, id)` from `@theoremjs/agents/interface` says which ways it can go, so a control that can do nothing is not drawn. |
| `restorePending(id)` | Puts a pending message back in the composer. The draft that was there is stashed first, so the user loses nothing. |
| `stop()` | Stops the streaming reply with `transport.stop`. What the reply said before the stop stays in the transcript and the history, closed as cancelled. A queued message stays queued. When the host refuses the stop, the controller drops the stream instead, and a host that keeps the conversation keeps the stopped reply where the page can't read it. |
| `decide(action)`, `authenticate(secret?)` | Answer the gate that the reply waits on. |
| `branch(index)` | Cuts the conversation after transcript block `index`. |
| `sendText(text, options?)` | Sends a message from your code. `options` can add `files`, `voice`, a `model` and its `effort`. The model becomes the chat's pick, as if chosen in the composer. An `effort` without a `model` applies to the chat's current model. A model the profile does not have is refused by the turn, not replaced by the default. It resolves with the blocks the turn added, or `null` when the chat cannot take a message now. |

### Name your app's objects in a message

Use refs when a message points at something your app holds, such as a saved document, and your server must know which one without reading the words. A message's `parts` are its words and refs in order: `{ type: 'text', text }` and `{ type: 'ref', kind, id }`. `kind` and `id` are your own strings.

```ts
const chat = createChatController({ transport, iface, refText: (ref) => `[${ref.id}]` });

chat.setDraftText('Compare [doc-7] with the last one');
chat.setDraftParts([
  { type: 'text', text: 'Compare ' },
  { type: 'ref', kind: 'document', id: 'doc-7' },
  { type: 'text', text: ' with the last one' },
]);
await chat.submit();
```

- Call `setDraftParts` after `setDraftText`: `setDraftText` clears the parts. The React composer does both.
- `refText` writes a ref into the message's text. Without it, a ref is written as its id. Give `createTheoremHandler` or `createTheoremConversationCore` the same `refText`.
- The server writes the text from the parts. It does not read the text the page sent.
- Your `prepare` reads `turn.input.parts`. The page can send any `kind` and `id`, so check that this person may use what they name.
- The model reads the text, not the parts. Earlier messages reach the model as text.
- A queued, stashed, steered, or restored message keeps its parts, and so does the saved transcript.
- With your own `intake`, call `personMessageOf(steer, refText)` to build the message.

### Messages the host saved

A host with `intake` saves each message before a reply runs. When another reply holds the conversation, the host saves the message and runs nothing. The controller then keeps the message in `pendingMessages`, as kind `steer`, with `saved: { landsAs }`. `landsAs` is the ids a reply names the message by when it reads it.

- The page cannot edit, move, send, or remove a saved message. The host has it.
- The message leaves `pendingMessages` when a reply reads it, and joins the transcript before that reply.
- The message also leaves when a conversation read shows one of its blocks.
- `saveComposerPendingMessage` and `takeSavedComposerPending` from `@theoremjs/agents/interface` make these two changes for a controller of your own.

With `intake`, each `/turn` and each `/steer` carries an `id`: the pending message's id, or a new one. The host saves a message one time for each `id`, so a request sent twice saves one message.

After a wake that fails, that the person stops, or that runs nothing, the page does not wake again by itself. The next conversation read can ask for a wake.

The controller uses these methods of the transport: `turn`, `invoke` (to answer a gate), `steer`, `stop`, `conversation`, and `rewind`. `conversation` and `rewind` are called only for a profile whose host keeps the conversation. `pageResult` is called when the reply hands a tool to the page.

The controller writes no English text. The helpers below give the composer's controls as values, and you choose the words:

| Helper | What it gives |
| --- | --- |
| `composerActionState(args)` | The primary button (`send`, `queue`, `stop`, or `none`), the send menu, and whether the button is off. |
| `composerDrawerSummary(args)` | The count of waiting messages by kind, for a collapsed drawer. |
| `resolveComposerHint(args)` | The stash hint, when the whole draft is selected. |
| `composerShortcut(event)` | The send-menu action a key press asks for: ⌘↵ steers, ⌘⇧↵ sends now, ⌘⇧S stashes; `null` otherwise. `COMPOSER_SHORTCUTS` has each action's key for `Kbd`. |

## A custom browser transport

Use `withPageToolDispatch` when your screen consumes turn events through a custom transport.
The helper runs callbacks only for dispatch grants received on the active stream.
It never reads a saved transcript to authorize callback execution.
Implement the transport's `pageResult` method to return the result to your authenticated server.
`createHttpTransport` and `createHostTransport` post that result to `/page-result`.
The ready-made chat and host console of `@theoremjs/react` apply this helper for their `pageTools`.
In a React host view of your own, pass the callbacks as the second argument to `useTheoremHost`.

```ts
import { createHttpTransport, withPageToolDispatch } from '@theoremjs/web/client';

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
| `host` | App data for the tool handlers (`ctx.host`), such as the signed-in user. The handler asks it one time for each run, when the run first reads it. |
| `refText` | Writes each ref of a message into its text. Default: the ref's id. See [Name your app's objects in a message](#name-your-apps-objects-in-a-message). |
| `prepare` | Your app's own turn, from the one the handler builds (`TurnWiring.prepare` from `@theoremjs/agents`). Set what your app sets per turn, such as `system`, `credentials`, `onStage`, `onEvent` and `onAgentCall`; read your app data as `turn.host`. The handler keeps its profile and its abort. Your `onStage` runs before the handler's steering, and your `credentials` are read before the session's. An `execution` you return decides each call, and the session still records the same call; a `background` you return takes the place of the `background` option. A call held at a gate runs on, once answered, with the `host`, `onStage`, `credentials`, `execution` and `background` you give for that call's turn; that turn has `answersHeldCall`, and its `onEvent` is not called, because no new turn runs. |
| `core` | A `ConversationCore` your app built (`createTheoremConversationCore`). The handler runs each chat call on it, `/notify` and `/follow` too, and takes no `prepare`, `inbox`, `onStage`, `beforeSave`, `afterSave`, `compact`, `lateResultsDecider`, `background`, `notifier`, `replyFeed`, `notifyRetryMs`, `authorizeToolReplay` or `authorizationUrl` beside it: the core has them. It does take `intake` and `onContinue`. |
| `inbox`, `beforeSave`, `afterSave`, `compact` | Your app's own inbox and your steps around each save, as [the conversation core](#run-replies-with-no-page-request) takes them. Each is given the request's context: its `host` is what `host` returned for the request, so `await at.host`. With `inbox`, every reply the page starts runs under a hold of your conversation, and a wake tells the items that wait in it. A steer needs `intake`: it saves the message into your inbox. Without `intake`, the handler refuses the steer with a `config` error. Do not set `inbox` with `lateResultsDecider`. |
| `onStage` | The server's own stage handler, on every call the handler runs, a host profile's included: after your app's (`prepare`), before steering. For a rule the server adds to whatever the app says, such as a question before each tool that writes. |
| `pageToolBroker` | Delivers results to active page dispatches. Default: bounded process memory. |
| `pageStatesTurn` | Let the page say which prompt lines a turn gets, through `stated` on a turn or a live call. Set it only for a page you trust as yourself, such as a builder's own tool. Without it, a request with `stated` is refused. |
| `conversationStore` | Where the conversation is kept. Required, except for a stateless profile, which must not have one. See [Keep the conversation](#keep-the-conversation). |
| `sessionStore` | Where open gates are kept. Default: process memory. A steer and a stop need no store of their own: see [Steer and stop without your own inbox](#steer-and-stop-without-your-own-inbox). |
| `lateResultsDecider` | Who tells the model that a background call ended: `TurnWiring.lateResultsDecider`. Set it on your `TurnWiring`, and the studio uses it too. Unset, no page wakes the chat and no reply reads a late result. `tellEveryResult` tells each result to the first reply that runs, and gives up a result two replies read without telling. See [the background section](#share-session-authority). |
| `conversationLeaseMs` | How long a reply keeps its chat after it last renewed, in milliseconds. A running reply renews every third of it. A wake that finds another reply running tries again once this runs out. Default: `60000`. |
| `onContinue` | Who runs the next reply when a reply ends with items that wait and may be told now. Return `'here'`, and the handler runs it in the same response. Return `'taken'`, and your app runs it with the conversation core's `followUp`. Unset, the handler lets the chat go, and the page wakes it. |
| `intake` | Your app's own save of each message the page sends, on `/turn` and `/steer`. Set it when a message must be in your database before any reply runs. Needs `inbox`. See [Save a page's message in your own write](#save-a-pages-message-in-your-own-write). |
| `notifier`, `notifyRetryMs` | Tell an open page that a background call ended, and how long the page waits to reopen a cut stream. Unset, the page reads the end on its next turn or reload. With `core`, give them to the core. See [the background section](#share-session-authority). |
| `replyFeed` | Lets every page open on a conversation draw a running reply's lines live, whoever started it. Needs `notifier`. Unset, a page that did not start the reply reads it once it ends. With `core`, give it to the core. See [Follow a running reply](#follow-a-running-reply). |
| `credentialStore` | Where tool credentials are kept, by session. Default: process memory. |
| `authorizationUrl` | Returns the sign-in URL for an OAuth gate. Without it, an OAuth gate has no URL. |
| `gateTtlMs` | How long a gate waits for an answer. A later answer fails with `session.gate_expired`, and the next message or the next wake cancels the call. Unset, a gate waits until it is answered. |
| `maxRequestBytes` | The largest browser request body, in bytes. Unset, a body of any size is read. |
| `pageToolTimeoutMs` | How long the page has to answer a tool call it runs. A call it has not answered by then settles as timed out. Unset, the call waits until the page answers or the turn stops. The browser clients answer every call they get, so only a page function that never returns holds a turn. |
| `operationRetentionMs` | Required. How long the session keeps a finished tool call's result, in milliseconds from when it finished. While it is kept, the same call asked for again gets that result and does not run again. Your app decides it: the handler has no default. |
| `clientEvents` | Options for `forClient` and `clientError`, which prepare each event and each caught failure for the browser. `reader: 'builder'` sends the raw reason in place of the wording of the profile. Use it only in a development tool on your own machine. |
| `onError` | Receives each error that the handler catches. A visitor sees the wording of the profile for that kind of error, never the error. |

### Defaults

A limit that stops a turn or refuses a request is unset unless you set it: `gateTtlMs`, `maxRequestBytes`, `pageToolTimeoutMs`, and a session store's `capacity`. `operationRetentionMs` has no default, so every handler sets it. The memory stores expire and evict nothing unless you set `ttlMs` and `maxSessions`, so they grow until the process ends. Set both on a public server. These have a default:

| What | Default | Set it with |
| --- | --- | --- |
| The session cookie | Lasts 30 days | `session` |

A model profile that leaves out `maxSteps` makes at most 20 model calls a turn.

### Start a conversation with content

`startConversation` stores a conversation that opens on blocks you wrote, and returns its ref and its view. The model reads the blocks as history, so the user's next message is a follow-up.

```ts
import { startConversation, theoremSession } from '@theoremjs/web/server';

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
The session store keeps gates, permissions, and operations. The two stores are separate.

| Store | Where the conversation is kept |
| --- | --- |
| `createMemoryConversationStore()` | Process memory, for one server instance. It keeps every conversation until the process ends. Set `ttlMs` to expire a conversation that is not saved for that long, and `maxSessions` to cap the count; the one saved longest ago goes first. |
| `createSealedConversationStore({ keys, keyVersion })` | Nowhere on the server. The ref is the conversation itself, encrypted and signed with your key, and bound to the session. The browser cannot read it or change it. |
| Your own `TheoremConversationStore` | Your database. |

A ref that the store cannot open fails with `session.conversation_unknown`, kind `not_found` (HTTP 404). This includes a ref from another session. A route or method the handler does not serve also answers 404 with kind `not_found`.

The sealed store:

- Each key is at least 32 bytes. Keep the keys on the server.
- `keyVersion` names the key that seals new writes. Keep an older key in `keys` while its refs must still open.
- Each save issues a new ref. An older ref of the same conversation still opens, as a rewind does.
- If the user stops a reply, or the browser leaves while a reply runs, the server saves the result under a new ref that the browser never receives. The browser keeps the ref from when its message reached the server. The reply, and any tool call it settled, is lost to the browser. With the memory store or your own store, the ref does not change, and the chat shows what the server saved.
- The ref holds the whole conversation, including the bytes of each attachment. Every request sends it, so the conversation must stay under `maxRequestBytes`.

To keep conversations in your own database, implement these three methods:

```ts
import type {
  ConversationSnapshot,
  ConversationWriteResult,
  DetachedEnding,
  StoredConversation,
} from '@theoremjs/web/server';

interface ConversationDatabase {
  read(sessionId: string, ref: string): Promise<ConversationSnapshot | undefined>;
  write(
    sessionId: string,
    ref: string | null,
    expectedRevision: string | null,
    next: StoredConversation,
  ): Promise<ConversationWriteResult>;
  end(sessionId: string, ending: DetachedEnding): Promise<void>;
}
```

- Every read and write names the session. For a ref that this session did not write, `read` returns `undefined` and `write` returns `{ written: false }`.
- A null `ref` creates a conversation. Return a new opaque `ref` and `revision`.
- Otherwise, write only while the stored revision is still `expectedRevision`, as one atomic operation. Return `{ written: false }` on a conflict.
- Check what you read back with `storedConversationSchema`.
- A store that keeps each block in its own place (a row, a column) checks one block with `transcriptBlockSchema`.
- Keep `id` as the handler gives it. It names the conversation in each turn's trace as `gen_ai.conversation.id`, and stays the same through every save and rewind.
- Set `running` on the snapshot while a reply runs on the conversation under a hold you keep. See [Show a reply that runs elsewhere](#show-a-reply-that-runs-elsewhere).
- `end` saves how a background call ended on the step of the reply that started it. The handler calls it when the call ends, and again after each save of a reply, for a call that ended before its reply was saved. Find the tool block whose `tool.operationId` is `ending.operationId`, in any of the session's conversations, and replace it with `endedBlock(block, ending)`. Change no revision, so a reply that runs meanwhile still saves. Keep the ended block when a later `write` still holds the block as it detached. With no such block, change nothing. A call whose end is saved shows its end and its done label after the session has dropped its record. A store that keeps nothing, such as the sealed store, does nothing in `end`: the conversation read shows the end from the session's record while the session keeps it. With `authorizeToolReplay`, the handler does not call `end`, because every request reads a saved end and that check runs on each read.

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
} from '@theoremjs/web/server';

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
The handler retains settled operations for `operationRetentionMs` from settlement.
Each saved outcome records its absolute retention deadline. Changing a handler's policy does not shorten that deadline.
Each issued gate records its absolute expiry. Changing `gateTtlMs` does not extend an issued gate.
Ready, running, background, and uncertain operations do not expire.

A session store with a real limit declares its `capacity`: what it holds for one session, in bytes of UTF-8 JSON.

| Field | What it bounds |
| --- | --- |
| `maxStateBytes` | One session's saved state |
| `maxOutcomeBytes` | One tool result |

A store that declares no `capacity` holds any size. `createMemorySessionStore` declares none unless you pass `capacity`, with both fields. A store you write declares the capacity of its own storage, if it has one.

Set `maxRequestBytes` to bound browser JSON before parsing. Unset, a body of any size is read. A relay passes the same number to `parseLiveOpenMessage` and `parseLiveClientMessage`.
The handler rejects oversized requests before provider access or tool preparation.
Provider host options also accept `limits` for deadlines and upstream output.
When the store declares a capacity, the handler keeps room for one `maxOutcomeBytes` result for each gate and each call that has not settled.
When a session is full, the handler drops its oldest settled results, then its oldest provider checkpoints.
It never drops gates, permissions, or calls that have not settled. When those alone do not fit, the new call is refused before it runs, and the user reads `session.full`.
A result larger than `maxOutcomeBytes` settles as the call's `result_too_large` failure. The call is never left unresolved because of its size.
The handler fits each state to the store's capacity, when it has one, before `compareAndSwap`.

The default memory store coordinates handlers that share the same store object.
It retains unexpired gates, unresolved operations, and unexpired outcomes during idle and capacity eviction.
It refuses a new session when every stored session has protected authority.
Separate memory stores and process restarts do not retain shared authority.
Atomic updates prevent two workers from dispatching the same operation. A process crash leaves its running claim protected.
These claims do not provide exactly-once effects at the destination. Use the operation ID with destination idempotency when available.
Concurrent pending attempts can reach preparation before one claims the body.
Permission checks and pre-body hooks must be read-only or independently idempotent. The kernel cannot prove hook purity.
A live session does not restore a dispatched call after an unexpected failure. It retains an uncertain call on that connection.
To retain execution claims across connections, supply a durable coordinator as `execution` on `SessionRequest`.
Browser dispatch uses a host-owned `PageToolExecution` service beside the execution coordinator.
`createTheoremHandler` supplies both services. Live relays put the session boundary's `pageExecution` and `toolExecution` on `SessionRequest`.

A tool with a `background` setting runs inline until you pass the `background` option to `createTheoremHandler`, or return `background` from `prepare`, with an `execution` of your own that has `detach`, when the same turns run elsewhere in your app too. The option takes `{ request, sessionId }` and returns a `ToolBackgroundService`, which receives each detached call and its late events. The session keeps the call as `background` until it settles, and a late settlement does not invalidate a checkpoint. A conversation read shows the call as it stands: running, then its result, or an error for a marked call. An open page reads it on its next turn or reload, unless you set `notifier`. When the session has dropped a settled operation, the block reads an error with the code `outcome_not_retained`. On a durable store, a worker that dies leaves the operation as `background`, so your sweep marks it `uncertain` with `worker_lost` through `compareAndSwap`. Keep the service's values valid after the request ends. A live relay passes its service to `runSession`.
To show an open page that a background call ended, with no turn or reload, pass `notifier: createMemoryNotifier()` to `createTheoremHandler`. While a call runs, the conversation read tells the page to open `POST <base>/notify`. The handler sends one `changed` line when the stream opens, and one when each background call in the session ends. The line carries no content, so the page calls the same conversation read as before. The page closes the stream when no call runs. With `inbox`, the read always tells the page to listen, because your app saves replies the page did not start: call `notifier.publish(sessionId)` after each one. The model reads the result only as your decider says.

Set `lateResultsDecider` on your `TurnWiring` and pass it to `createTheoremHandler`. Unset, nothing tells the model a background call ended: the conversation read never says `wake: true`, `<base>/wake` runs nothing, and the next message reads no late result. A result waits for the model when its call ended and no saved reply told it. When the session holds no end for the call (it dropped the settled operation, or marked the call `uncertain`), the result waits as an error with the code `outcome_not_retained` or the uncertainty's reason, and the model reads that the action is unresolved. `ended` hears that end too. A call `authorizeToolReplay` withholds from the request does not wait.

The handler runs each reply under a hold of the chat, with `runConversation` from `@theoremjs/agents/conversation`. One reply at a time reads the chat's results. A result is told only when the reply that read it is saved. A reply that fails gives its results back, and a later reply reads them.

- `policy(items, moment)` picks, by `id` (the call's `operationId`), the results the model reads now. Each item has the call's `outcome`, and `handovers`: the earlier replies it was given to that ended unsaved. The handler asks it as a reply opens (`stage: 'pre_turn'`), after each step whose calls settled (`'post_tool'`), and once the model has answered (`'before_end'`). `moment.host` is the request's `host`, as `ended` gets it, so a policy can keep one person's quiet hours. `moment.opening` is `'message'` for the person's message, `'wake'` for a reply to no message, and `'follow_up'` as a reply ends, for results that ended while it ran. The handler also asks it at `opening: 'wake'` on each conversation read, to say whether the page wakes the chat. It must change nothing. A result it leaves out waits for a later reply. A result it puts in `giveUp` is never read, and is reported once to `onError` with the code `late_results_given_up`.
- `ended({ host, result, wake, notify })` hears each background call end. `wake(conversation)` runs a reply to no message from the server, as a page's wake does, so a chat answers with no page open. `notify()` tells the session's open pages to read again.

`tellEveryResult` is the decider for an app with no server of its own: every reply reads every result that waits, and the open page wakes the chat. A result that two replies read and did not tell (the model failed, or the reply lost the chat) is given up and reported once as `late_results_given_up`, so a model that keeps failing does not reply again and again. Write your own to keep a count, such as a cap or quiet hours, or to reply from the server.

When the policy tells a result at `opening: 'wake'`, the conversation read says `wake: true`, and the page posts `<base>/wake` once it is idle. The handler runs a reply with no message, under a hold of the chat, so two pages that post at once run one reply. No wake runs while a reply waits on a gate that the person can still answer: the reply that goes on after the answer reads what waits. With `gateTtlMs` set, a wake that finds every gate of the reply past its limit cancels those calls as expired, and then runs. The model reads `sign_in.expired` for a sign-in and `session.gate_lapsed` for any other gate. A wake that fails gives its results back, so the chat wakes again. A message the person sends during a wake takes the chat: the wake writes nothing, and its stream ends with no error. When the wake was already saving its reply as the message read the chat, the message posts after that reply. When that reply stopped on an approval, the message fails with `session.gate_pending`, and the approval waits.

When a result ends while a reply runs, that reply reads it at its next moment. If it ends as the reply saves, the policy is asked once more before the reply lets the chat go. A reply from the server then runs a follow-up under the same hold. A page's reply lets the chat go, and the conversation read tells the page to wake. A server wake that finds another reply running tries again once that reply's lease runs out (`conversationLeaseMs`).

The decider is the one way a result reaches the model. If your `background` service told the model a result some other way, such as with your own `onStage`, remove that, or the model reads it twice.

To wake from the server, call `wake` with the conversation's current reference. Your `conversationStore` must keep that reference across writes: the reference of `createSealedConversationStore` is the sealed conversation itself, so each write gives a new one, which only the page holds. The reply runs with the headers of the request that started the call and no signal, because that request has ended.

`createMemoryNotifier` reaches only pages connected to the process that ran the call. On more than one instance, give a shared `TheoremNotifier`. Your sweep calls `publish` with the session id after it marks a call `worker_lost`, because that write does not pass through the handler. Hosting platforms cut long responses. Set `notifyRetryMs` so that the page reopens the stream after that wait. Unset, the page does not reopen it, and reads the end on its next turn or reload.

To reach a closed tab, send a Web Push from your `background` service, when the handle's `done` resolves. Theorem does not hold push subscriptions or VAPID keys. If your service worker then reaches an open page, call `refresh()` on the `ChatController`. It runs the same read.

Forward live page results to `answerPageResult`. Preserve checkpoint ownership through `beforeEvent` when using the Studio bridge.
The default `PageToolBroker` keeps active result waiters in process memory. Several workers need a shared broker or request affinity.
Use `pageToolBroker` to supply that broker. It carries results; the atomic session store retains execution authority.
Lost result delivery does not permit another dispatch. The operation retains its claim or an uncertain outcome.
Set `pageToolTimeoutMs` to give the page a deadline for a result. Unset, a dispatch waits until the page answers or the turn stops. The browser clients answer every dispatch they get, with no answer when the page has no function for the tool, so only a page function that never returns holds a turn. An expired or interrupted result cannot reopen approval.

## Run replies with no page request

Use `createTheoremConversationCore` when a message reaches your server with no `Request` from a page: a messaging channel, a voice channel, or a timer. The core runs the replies that `createTheoremHandler` runs, on the same stores. A page that uses the handler reads the same conversation.

Each call takes a **run context** where the handler takes the `Request`: `{ sessionId, signal, host? }`. `sessionId` names the session, `signal` aborts the run, and `host` is your context for tool handlers.

```ts
import { createMemoryConversationStore, createTheoremConversationCore } from '@theoremjs/web/server';

const core = createTheoremConversationCore({
  profile: support,
  provider: { vault: { main: process.env.GEMINI_API_KEY } },
  conversationStore: createMemoryConversationStore(),
});

async function received(sessionId: string, text: string, ref: string | undefined, signal: AbortSignal) {
  const reply = await core.message({ sessionId, signal }, { ...(ref ? { ref } : {}), input: { text } });
  for (;;) {
    const next = await reply.next();
    if (next.done) return next.value;
    deliver(next.value);
  }
}
```

`deliver` is your function: it sends one line to the channel. A run yields the lines that the handler streams. The `conversation` line carries the ref: keep it, and pass it with the next message. The run then returns how it ended:

| `outcome` | Meaning |
| --- | --- |
| `released` | The run ended, and no run holds the conversation. |
| `continue` | Items wait that a reply may be told now. The run's `hold` still has the conversation under `ref`. See [Run the follow-up](#run-the-follow-up). |
| `held` | Another run holds the conversation until `leasedUntil`. This run ran nothing. |
| `lost` | Another run took the conversation from this run. |

| Method | Use |
| --- | --- |
| `message(at, { ref?, input, context?, generation?, abandon?, saved? })` | Posts the person's message and runs the reply. |
| `checkMessage(at, { ref?, input, context?, abandon? })` | Throws what `message` throws before it runs anything, and changes nothing. Call it before your app saves a message itself. |
| `answer(at, body)` | Answers a call that a paused reply waits on. |
| `wake(at, { ref })` | Runs a reply to no message, for items that arrived since the model last ran. |
| `followUp(at, { ref, hold })` | Runs the next reply to no message, under the hold of a run that ended `continue`. |
| `release(at, { ref, hold })` | Lets the conversation go under that hold, with no follow-up. |
| `read(at, { ref })` | Returns the conversation as a page draws it. |
| `rewind(at, { ref, at })` | Cuts the conversation after transcript block `at`. |
| `steer(at, { ref, id, input } \| { turnId, id, input })` | Puts `input` into the inbox of the running reply: the one that holds the conversation `ref` names, or the run `turnId` names. Returns `false` when no reply runs there. Throws `session.reply_unreachable` when the store says a reply runs that this process does not hold, and what `message` throws for an `input` the profile does not take, such as text over `inputs.maxTextChars`. Throws a `config` error when you set `inbox`: use `intake`, which saves the message in your inbox. |
| `stop(at, { turnId } \| { conversation })` | Stops a running reply: the turn `turnId` names, or the reply that holds `conversation`. Returns `false` when it is not running. When your `inbox` has a `stop`, it stops the reply that holds the conversation, and reads neither. Without one, Theorem's own stop reaches a reply that this process runs. For a reply the store says runs elsewhere, `{ conversation }` throws `session.reply_unreachable`. |
| `follow(at, { ref })` | Returns the lines of the reply that runs on the conversation now, whoever started it, from its first line until it ends. Throws `not_found` without `replyFeed`. |
| `subscribe(at, changed)` | Calls `changed` for each `notifier.publish` under `at.sessionId`, and returns the function that stops it. The handler's `/notify` listens here, so a core that keeps its chats under another session than the page's still reaches the page. Throws `not_found` without `notifier`. |

The core takes these options from [Server options](#server-options), with the same meaning: `profile`, `onStage`, `sessionStore`, `conversationStore`, `credentialStore`, `gateTtlMs`, `operationRetentionMs`, `pageToolBroker`, `pageToolTimeoutMs`, `notifier`, `notifyRetryMs`, `replyFeed`, `lateResultsDecider`, `conversationLeaseMs`, and `clientEvents`. These options take the run context in place of the `Request`:

| Option | Use |
| --- | --- |
| `provider` | Required. The host options for registered providers, or `(at, model?)` that returns them. |
| `prepare(turn, run?)` | Your `TurnWiring.prepare`. With `inbox`, `run` is the reply's hold of your inbox. |
| `background(at)` | The service for tools with a `background` setting. |
| `authorizeToolReplay(at, operation)` | Checks access before the core discloses a saved tool result. |
| `authorizationUrl(challenge, at)` | The sign-in URL for an OAuth gate. |
| `onError(err, at)` | Receives each error that a run reports and does not throw. |
| `wake(at, ref)` | Required with `lateResultsDecider`. Start a reply to no message for the conversation under `ref`, for example with a queued call to `core.wake`. |
| `inbox(at)` | Your own inbox for the conversation. See below. |
| `beforeSave(at, reply)`, `afterSave(at, saved)`, `compact(at, signal)` | Your steps around the save that ends a reply. See [Shape the save that ends a reply](#shape-the-save-that-ends-a-reply). |

### Hold the conversation in your own inbox

Use `inbox` when messages and events arrive from more than one place, and one reply at a time must run for a conversation. An **inbox** is a `ConversationInbox` from `@theoremjs/agents/conversation`: it holds the items that wait for a reply, and it gives one run at a time a hold of the conversation, on a lease.

`inbox(at)` returns `{ inbox, conversation, policy, leaseMs }`:

| Field | Use |
| --- | --- |
| `inbox` | Your `ConversationInbox`. `createMemoryInbox` is one for tests. |
| `conversation` | The name of the conversation in your inbox. |
| `policy` | Your `InboxPolicy`: which waiting items a reply is told, and which are given up. |
| `leaseMs` | How long a hold keeps the conversation after it last renewed, in milliseconds. |
| `stop` | Optional. Your `HoldStop`: a stop for the reply that holds the conversation. See [Stop a reply from any server](#stop-a-reply-from-any-server). |

Each run then holds `conversation` in your inbox while it runs. Your `prepare` receives that hold as `run`, a `ReplyRun`. `run.opened` is the items the reply reads as it opens. `run.take` returns the items that arrive while the reply runs. To tell the model an item, add it to the turn that `prepare` returns, or inject it from that turn's `onStage`.

A run that finds the conversation held returns `held` and runs nothing. A wake on a reply that waits on a gate also returns `held`, and `leasedUntil` is when the last gate lapses. When a gate has no time limit, the wake returns `released` and runs nothing. `read` answers `wake: true` when your policy tells a waiting item to a reply to no message.

### Save the person's message in your own write

Use `saved` when your app saves each message when it arrives, before any reply runs. In that write, your app also takes the conversation in your inbox under a hold. Pass both to `message`:

```ts
await core.message(at, { ref, input, saved: { hold, blocks } });
```

`hold` is the hold your write took. `blocks` is the message as your app saved it, as transcript blocks. The core then posts nothing. The reply runs under `hold`, and the save that ends the reply writes `blocks` with the reply. When another run holds the conversation, the run returns `held` and writes nothing. `saved` needs `inbox`.

### Save a page's message in your own write

Use `intake` on `createTheoremHandler` when the page's messages must be in your database before any reply runs. Then a message that arrives during a reply is not lost when the reply fails, and a message from the page waits in the same inbox as a message from any other channel.

```ts
createTheoremHandler({
  profile,
  provider,
  conversationStore,
  operationRetentionMs,
  inbox,
  intake: async (at, sent) => {
    const saved = await saveMessage(at.sessionId, sent.id, sent.ref, sent.message);
    return saved.hold === undefined
      ? { outcome: 'saved', ref: saved.ref, landsAs: saved.ids }
      : { outcome: 'opened', ref: saved.ref, landsAs: saved.ids, hold: saved.hold, blocks: saved.blocks };
  },
});
```

The save that `intake` calls in this example is your function. In one write, it does three things:

1. It saves the message under `sent.id`. A second call with the same `sent.id` saves nothing new.
2. It puts the message in your inbox as an item.
3. It takes the conversation under a hold, when no reply holds it.

`intake` returns a `MessageIntake`:

| Field | Use |
| --- | --- |
| `outcome` | `'opened'` when your write took the conversation. `'saved'` when another reply holds it, or when the message was saved before. |
| `ref` | The conversation that holds the message. Your `conversationStore` must be able to read it. |
| `landsAs` | Each id a reply names the message by: the id of its inbox item, of its inject on a `stage` line, and of each of its blocks. |
| `hold`, `blocks` | With `opened`: the hold your write took, and the message as transcript blocks. The handler passes them to `message` as `saved`. |

The handler checks the message before it calls `intake`, with the core's `checkMessage`. A message with no `id`, with content the profile does not take, or to a conversation the session cannot read is refused, and `intake` is not called.

To refuse a message yourself, throw from `intake`. Name the reason, and give its words in the profile's `labels`:

```ts
throw new TheoremError('request', 'ref names a document this person cannot use', {
  copy: { key: 'reason.not_allowed', params: { name: 'Q3' } },
});

labels: { 'reason.not_allowed': 'You cannot use {name}.' }
```

The page reads those words, on `/turn` and on `/steer`. A reason with no words reads as `request.refused`. The second argument of `TheoremError` is for your logs; the person never reads it.

On `/turn`, the stream opens with a `conversation` line that has `posted` and `landsAs`. With `opened`, the reply follows on the same stream. With `saved`, the stream ends there.

On `/steer`, the handler does not put the message into the running turn. The reply that holds the conversation reads the message from your inbox: in the same reply when your `prepare` takes it with `run.take`, or in a follow-up. The response is `{ ok: true, saved: { conversation, landsAs } }`. When the steer's save took the conversation, no reply was running. The handler then asks `onContinue`. For `'taken'`, your app runs the reply with `followUp`. Otherwise the handler lets the conversation go, and the page's wake runs the reply. Your `policy` must tell the message to a reply at `opening: 'wake'`.

A reply that opens with items from your inbox sends a `conversation` line with `opened`, the ids of those items. The page uses it to move a saved message from the pending list into the transcript.

Your store marks the items in `told` in its `write`. If an item in `told` that the reply was handed still waits when the run ends `continue`, the run lets the conversation go and fails with a `config` error, because each follow-up would tell that item again. `onError` receives the error.

### Steer and stop without your own inbox

Use this when you set no `inbox`, and a person sends a message into a reply that is running, or stops it. Theorem keeps its own conversation inbox for the reply. A steer is a message in that inbox, beside the ended background calls. A reply that holds the conversation takes one message at each `pre_turn`, `post_tool` and `before_end`, and the `stage` event names it in `injected`. A save of the reply that took it tells it once. A stop reaches the reply that holds the conversation.

The inbox is named as follows:

| Chat | Named by | Kept in |
| --- | --- | --- |
| A stored chat | The conversation id, and the session. | Process memory, and the session store for the ended calls. |
| A chat that keeps no conversation (`providerContinuation.history: 'stateless'`) | The run: the `turnId` the page sent, and the session. | Process memory, for as long as the run lasts. |

A page that has a conversation steers and stops by `{ conversation }`. The page's own turn also answers to its `turnId` while it runs, so a steer or stop that names only the turn reaches the same inbox. Both inboxes live in process memory, so a steer must reach the process that runs the reply. A message that waits when a stateless run ends is lost with the run, and the page sends it again. A steer with no reply running is refused with `session.turn_ended`.

### Stop a reply from any server

Without `stop` in your `inbox`, Theorem's own stop reaches the replies that this process runs, by conversation or by `turnId`. Set `stop` to keep the stop in your own store. A stop then reaches the reply that holds the conversation, on any server, and from any channel or wake.

```ts
const stop: HoldStop = {
  ask: async (conversation) => false,
  stopped: async (conversation, hold, over) => false,
  clear: async (conversation, hold) => {},
};
```

- `ask` records a stop for the hold that has `conversation` now. Return `false` when no hold has it. `<base>/stop` and the core's `stop` call it, and `turnId` is not read. Read the hold and write the stop in one statement, or a stop can name a hold that no longer runs.
- `stopped` settles `true` when a stop is asked for `hold`. It settles `false` when `over` aborts, which is the end of the model run. Each model run of a reply under a hold calls it.
- `clear` removes a stop asked for `hold`. The core calls it as each model run ends.

A stop is for the reply that holds the conversation when the stop arrives. The follow-up keeps the hold. Because the core clears the stop as the reply ends, a stop that came too late for the reply does not stop the follow-up.

### Show a reply that runs elsewhere

A page that opens while a reply runs, after a reload, in another tab, or while another channel's reply runs, did not start that reply. Only your records know that it runs. Your store's `read` tells the page with `running` on the snapshot:

```ts
const snapshot: ConversationSnapshot = {
  revision,
  conversation,
  running: { since, prompt, heldUntil },
};
```

- `since`: when the reply started, in epoch milliseconds. The working pill counts from it.
- `prompt`: what the person said that the transcript does not hold yet, as transcript blocks. These are the messages the reply answers, and steers that are saved but not read yet. The page shows them under the transcript.
- `heldUntil`: when the hold lapses unless it is renewed. A page that has heard nothing by then reads the conversation again, so a reply whose server died does not show as working forever.
- Set `running` only while the hold is live. Leave it unset when no reply runs.

The view the page reads has the same `running`. While it is set, the chat's phase is `streaming` and `runningElsewhere` holds it, so the page acts as it does for its own reply:

- The stop button sends `/stop` with `{ conversation }`. Your `inbox`'s `stop` stops the reply. Without one, a reply that another process runs is refused with `session.reply_unreachable`, the page shows that error, and the reply still shows as working.
- A steer sends `/steer` with `{ conversation }` and no `turnId`. `intake` saves it. Without `intake`, the steer is refused with `session.reply_unreachable` while the store says a reply runs that this process does not hold.
- A message sent while it works waits in the queue. Send now stops the reply, then sends the message. When the stop is refused, the message stays in the composer.

The page reads again at `heldUntil` once for each `heldUntil`. When your server's clock and the browser's differ, a hold can look lapsed to the page while your store still returns it. The page then waits for your `notifier.publish`, or for a read that returns a new `heldUntil`.

Call `notifier.publish` after each save that ends the reply. The page reads the conversation again. When `running` is gone, the queue sends its next message, unless the person stopped the reply.

### Follow a running reply

A page open on a conversation draws a reply that another page started, or that your app runs with no page request, as it happens: the steps, the pill and the words. Pass `replyFeed` with `notifier` to `createTheoremHandler` or `createTheoremConversationCore`. Without `notifier`, the setup fails with a `config` error.

```ts
import { createMemoryNotifier, createMemoryReplyFeed } from '@theoremjs/web/server';

createTheoremHandler({
  // ...
  notifier: createMemoryNotifier(),
  replyFeed: createMemoryReplyFeed(),
});
```

Every reply that runs under a hold writes each of its lines to the feed, and calls `notifier.publish(sessionId)` when it starts and when it ends. This covers a message, an answer, a wake and a follow-up, from a page or from the core. The conversation read says `follow: true`, and a page that sees `running` and has no reply of its own posts `POST <base>/follow` with `{ conversation }`. The stream is the line stream of `/turn`, with the same `tools.showData` filter. It starts from the first line of the reply, so a page that joins late draws the whole reply, and ends with the reply. The page then reads the conversation as before. Stop and steer by conversation work as they do for any reply the page did not start. The chat draws the followed reply with the same `streaming` state as its own, so no host switch is added.

`TheoremReplyFeed` is yours to implement:

- `start(conversation, reply)` opens a reply. It replaces the earlier reply of that conversation, and ends that reply's followers.
- `append(conversation, reply, line)` adds a line.
- `end(conversation, reply)` closes it and ends its followers.
- `follow(conversation, listener)` calls `listener.line` with every line so far, then each new line, then `listener.end`. With no reply open, it calls `end` at once. It returns the function that stops the listening.

`conversation` is the conversation's id, which stays the same across writes, where the reference changes. Theorem sets no size, retention or timing. `createMemoryReplyFeed` keeps every line of the current reply of each conversation in the process, with no cap, and reaches only the pages of that process. On more than one instance, give a shared `TheoremReplyFeed`. A feed that throws never changes the reply: the error goes to `onError`. `running` is the store's, as in [the section on a running reply](#share-session-authority): the feed does not set it. Without `running`, the page does not follow.

### Shape the save that ends a reply

Use `beforeSave` when your app keeps each block as its own record, and must decide what a reply writes. The core calls it once for each save that ends a reply, before the store's `write`.

```ts
const core = createTheoremConversationCore({
  // ...
  beforeSave: async (at, reply) => ({ blocks: reply.blocks, told: [], host: {} }),
  afterSave: async (at, { ended, told }) => {},
});
```

`reply` has these fields:

| Field | Meaning |
| --- | --- |
| `ended` | How the reply ended: `committed`, `failed`, `stopped`, `paused`, `lost`, or `refused`. |
| `blocks` | The blocks this save adds to what the store last wrote. They include a message that you passed in `saved`, and the blocks of a paused reply that this message walked away from. |
| `failure` | The error event, when the reply failed. With `ended: 'paused'`, an answer or a walk-away did not settle, and the reply still waits. |
| `landed` | The ids of the named injects and the steers that the model read in this reply. |
| `held` | With `inbox`, the reply's hold of your inbox, as `prepare` receives it. |

Return `{ blocks, told, host? }`:

- `blocks` replaces `reply.blocks` in the transcript. Add, remove, or reword blocks here. Set `host` on a block, a JSON object, to keep your own values with it, such as the id of its record. The core never reads a block's `host`.
- `told` is the ids of the inbox items that this save marks as told.
- `host` is a value of your own for the store.

The store's `write` then receives a fifth argument, a `WriteContext`: `{ hold?, reply?, host?, ended, told, appended }`. `appended` is the blocks that you returned. A store on your database can write the reply, mark the items in `told`, and check that `hold` still holds the conversation, in one statement. A write with no context saves no reply: a new conversation, a posted message, a rewind, or the core's own compaction.

These rules apply:

- A reply that paused keeps its own blocks with the paused reply, and they are not in `blocks`. They arrive in the save that ends the reply after the person answers.
- With `beforeSave`, the core adds no error block to a reply that failed. Word the failure from `reply.failure`.
- When `beforeSave` throws on a reply that failed or stopped, the core reports the error to `onError`, saves nothing, and the run ends with the reply's own failure. On any other reply, the throw fails the reply.
- `afterSave` runs after the store wrote the reply, while the run still holds the conversation. Use it to send the reply to a channel. When it throws, the core reports the error to `onError`, and the save stands.
- With no `beforeSave`, `told` is empty and the blocks are saved as they are.

### Refuse a reply

To answer with a line of your own and run no model, return `{ refuse: { text, host? } }` from `prepare` in place of the turn. Use it for a limit that your app keeps, such as a daily limit or a paused plan.

```ts
const core = createTheoremConversationCore({
  // ...
  prepare: async (turn) =>
    (await overLimit(turn.host)) ? { refuse: { text: 'You reached the limit for today.' } } : turn,
});
```

- The run yields the line as the reply's text. The reply saves with `ended: 'refused'`, and has no error block and no usage.
- `host` goes on the block of the line, as a `host` that `beforeSave` sets does.
- `beforeSave` and `afterSave` run as for any reply. The items in `told` are marked as told. The items that the reply read and did not tell go back to the inbox.
- A reply that goes on after an answered call, a wake, and a follow-up can be refused in the same way.
- Do not refuse a turn that has `answersHeldCall`. An answered call has no reply to refuse, so the call fails with a `config` error and does not run.
- While your app would refuse, its `policy` must tell only the items that the refusal answers, and `beforeSave` must mark each of them as told. An item that is told and not marked makes the run end `continue`, and each follow-up saves the line again.
- To make a wake say nothing, do not refuse it. While your app would refuse, return an empty `tell` from `policy` at each `opening` for the items that have no reply to a refusal, such as a reminder. A wake then runs no reply and saves nothing, the conversation read does not say `wake: true`, and the items wait.
- `createTheoremHandler` takes the same `prepare`. The page shows the line as the reply.

A reply to a message can lose its hold while it runs: a newer message took the conversation over. The core then calls `beforeSave` with `ended: 'lost'`, and calls `write` with `ended: 'lost'` and an empty `told`. Your store keeps the blocks that the person saw and marks no item as told. `afterSave` does not run. The memory store and the sealed store refuse this write, because they keep no holds. A store that refuses it keeps nothing, and the core reports nothing. With no `beforeSave`, or for a reply to no message, a lost reply writes nothing.

Set `compact` when your app compacts the history in its own run. After a reply's save, the core calls `compact(at, { history, tokens })` in place of its own compaction, and writes nothing more. When it throws, the core reports the error to `onError`.

A block's `host` goes to the page with the block: in the conversation that the page reads, and on the `stage` line of an inject. Put nothing in it that the person must not read.

A page cannot set `host` on a block. The core drops `host` from the blocks of a transcript that a page restores, and `theoremStartRequestSchema` drops it from the blocks of a start request. An app with no server keeps no `host`: its page restores the transcript on each message.

### Run the follow-up

A run ends `continue` when items arrived that a reply may be told now. For example, a person sent a second message while the reply ran. The run still holds the conversation, so no other run can start. Your server does one of two things with `ref` and `hold`:

- Call `followUp` to run the next reply. It can end `continue` again.
- Call `release` to let the conversation go. The next run that opens the conversation reads what waits.

A run that ends `continue` can carry `failure`, which is what the run threw. Throw it after the follow-up or the release.

A follow-up answers in the chat that `ref` names, and `at` must be able to read that chat. With `inbox`, one conversation can have a chat in more than one session. Pass the `at` and the `ref` of the session that the follow-up answers in. A follow-up that cannot open its chat throws, and lets the conversation go. With `inbox`, `release` reads no chat.

`followedUp` does this for you. Pass it the run and a function that returns `'here'`, `'taken'`, or `'let_go'` for each `continue`:

```ts
import { followedUp } from '@theoremjs/web/server';

const reply = await core.message(at, { ref, input });
const lines = followedUp(core, at, reply, () => 'here');
```

| Choice | What `followedUp` does |
| --- | --- |
| `here` | Runs the follow-up, and yields its lines after the run's lines. |
| `taken` | Does nothing, and returns the `continue`. Your app calls `followUp` from another place, such as a queue. |
| `let_go` | Calls `release`, and returns `released`. |

Read each run to its end, because the end is where a `continue` arrives. A run goes on to its end and saves its reply even when your server stops reading its lines. A `continue` that nothing follows up or releases keeps the conversation until its lease runs out.

You cannot pass `inbox` together with `lateResultsDecider`. The core fails at setup with a `config` error.

## Build your own server

`createTheoremHandler` runs each chat reply through a small loop that `@theoremjs/web/server` exports. Use the loop when your server is not a `fetch` handler, or when your routes differ from the handler's. For a server that only has no page request, [the conversation core](#run-replies-with-no-page-request) is less work. The conversation store, the guardrails, and the wire stay the same, so `TheoremChat` and the hooks work with your server unchanged.

| Function | Use |
| --- | --- |
| `readerConversationHost({ sessionId, store, profile, clientEvents })` | The conversation of one session, and how its events reach the browser (`forClient`). |
| `openConversation(host, ref, use)` | Reads the conversation under `ref`, or starts one when `ref` is `undefined`. It refuses a request that `use` does not allow, before anything runs. |
| `postedMessage(iface, input, context?)` | Checks the person's message against the profile's inputs. `iface` is `interfaceFromProfile(profile, defaultKernelScope.tools)` from `@theoremjs/agents/interface`. |
| `messageReply({ host, opened, message, walkAway?, runner })` | Posts the message, runs the reply and writes it back. Returns the lines to stream. |
| `answerReply({ host, opened, call, settling, runner })` | Continues a reply after one of its calls was answered. `settling` is the call's events from the kernel's `invokeTool`. |
| `rewindConversation({ host, opened, at, walkAway? })` | Cuts the conversation after transcript block `at`. `-1` empties it. A save that only added after `at` as the rewind read the chat is cut away too. When that save stopped on an approval, the rewind fails with `session.gate_pending`. |
| `conversationView(host, conversation)` | The conversation as the chat draws it. |
| `waitingCalls(conversation)` | The calls a paused reply waits on. A message or a rewind walks away from exactly these. |

`use` says what the request opens the conversation for: `{ kind: 'read' }`, `{ kind: 'message', abandon? }`, `{ kind: 'answer', call }`, or `{ kind: 'rewind', at }`.

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
} from '@theoremjs/web/server';

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
- Tool data. When `profileShowsToolData(profile)` is `false`, give the page each line through `eventWithoutToolData` and each block of a view through `blockWithoutToolData`. All three come from `@theoremjs/agents/interface`. Drop a line or a block that either one returns as `undefined`. Do not apply them to what you save: the model's history is rebuilt from the saved transcript.

On the browser side, `@theoremjs/web/client` reads what your server sends:

| Export | Use |
| --- | --- |
| `CHAT_LINES` | The schemas of a reply's lines: each turn event, and the `conversation` line. |
| `ChatLine`, `ChatLineSink` | A checked line, and the callback that receives each one. |
| `fetchConversation(url, body, options?)` | POSTs a conversation read, and checks the view your server answers. |
| `fetchRewound(url, body, options?)` | POSTs a rewind, and checks the rewound conversation. |
| `fetchStarted(url, body, options?)` | POSTs blocks to start a conversation on, and checks the started conversation. |
| `failedTraces(err)` | The trace records that a failed decision left, for the trace inspector. |

## More documentation

- [The wire](https://github.com/masudl-hub/theoremai/blob/main/react/docs/wire.md): the requests and events between the browser and the server, and the checks on each side.
- [Tool credentials](https://github.com/masudl-hub/theoremai/blob/main/react/docs/credentials.md): typed keys, OAuth, and token refresh, with a full callback route.
- [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents): profiles, tools, guardrails, and providers.

License: MIT.
