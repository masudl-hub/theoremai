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
- `tools/call` runs the tool through the gates, the guardrails, and the trace of the kernel. The client receives the text a model would read, not the raw output.
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
- `open.host` is the `openMessage` that the page's `connection` returned.
- Read later messages with `parseLiveClientMessage`. Give context messages to `session.sendContext({ client: message.context })`.

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
- `update(options)` gives the controller your latest options, such as a new `context`, `slots`, or `pageTools`. Each turn reads the options as they are when it is sent. `conversation`, `conversationView`, `initialText`, `initialFiles`, `initialVoice`, and `initialPending` are read only when the controller is created.
- Each method is bound to the controller. Pass it as a callback as it is.

`state.phase` is `'idle'`, `'streaming'`, or `'gated'`. The methods for the composer depend on it:

| Method | What it does |
| --- | --- |
| `submit()` | At `idle`, sends the draft. Otherwise, queues it. |
| `enqueue('steer')` | Sends the draft to the running turn with `transport.steer`. The steer leaves `pendingMessages` when the turn's `stage` event names it in `injected`, and joins the transcript there, between the reply before it and the reply after. A steer the turn never takes waits at the front of the queue. |
| `enqueue('queue')` | Keeps the draft to send after the reply. When the reply ends without a failure and no gate waits, the first queued message is sent. |
| `enqueue('stash')` | Keeps the draft without sending it. `queuePending(id)` moves it to the queue. |
| `sendNow(message?)` | Sends a pending message, or the draft, at once. A streaming reply is stopped first, as `stop()` stops it. A reply that waits on gates is left. |
| `movePending(id, direction)` | Moves a pending message one place `'up'` or `'down'` among the messages of its kind. `composerPendingMoves(messages, id)` from `@theoremjs/agents/interface` says which ways it can go, so a control that can do nothing is not drawn. |
| `restorePending(id)` | Puts a pending message back in the composer. The draft that was there is stashed first, so the user loses nothing. |
| `stop()` | Stops the streaming reply with `transport.stop`. What the reply said before the stop stays in the transcript and the history, closed as cancelled. A queued message stays queued. When the host refuses the stop, the controller drops the stream instead, and a host that keeps the conversation keeps the stopped reply where the page can't read it. |
| `decide(action)`, `authenticate(secret?)` | Answer the gate that the reply waits on. |
| `branch(index)` | Cuts the conversation after transcript block `index`. |
| `sendText(text, files?)` | Sends a message from your code. It resolves with the blocks the turn added, or `null` when the chat cannot take a message now. |

The controller uses these methods of the transport: `turn`, `invoke` (to answer a gate), `steer`, `stop`, `conversation`, and `rewind`. `conversation` and `rewind` are called only for a profile whose host keeps the conversation. `pageResult` is called when the reply hands a tool to the page.

The controller writes no English text. The helpers below give the composer's controls as values, and you choose the words:

| Helper | What it gives |
| --- | --- |
| `composerActionState(args)` | The primary button (`send`, `queue`, `stop`, or `none`), the send menu, and whether the button is off. |
| `composerDrawerSummary(args)` | The count of waiting messages by kind, for a collapsed drawer. |
| `resolveComposerHint(args)` | The stash hint, when the whole draft is selected. |
| `isStashShortcut(event)` | Whether a key press is the stash shortcut, `STASH_SHORTCUT`. |

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
| `host` | App data for the tool handlers (`ctx.host`), such as the signed-in user. |
| `prepare` | Your app's own turn, from the one the handler builds (`TurnWiring.prepare` from `@theoremjs/agents`). Set what your app sets per turn, such as `system`, `credentials`, `onStage` and `onAgentCall`; read your app data as `turn.host`. The handler keeps its profile, its tool execution and its abort. Your `onStage` runs before the handler's steering, and your `credentials` are read before the session's. |
| `pageToolBroker` | Delivers results to active page dispatches. Default: bounded process memory. |
| `conversationStore` | Where the conversation is kept. Required, except for a stateless profile, which must not have one. See [Keep the conversation](#keep-the-conversation). |
| `sessionStore`, `steerInbox` | Where open gates are kept, and where steers and stops reach a running turn. Default: process memory, which reaches only turns this process runs. On more than one instance, give a shared `SteerInbox`. |
| `credentialStore` | Where tool credentials are kept, by session. Default: process memory. |
| `authorizationUrl` | Returns the sign-in URL for an OAuth gate. Without it, an OAuth gate has no URL. |
| `gateTtlMs` | How long a gate waits for an answer. Default: 30 minutes. A later answer fails with `session.gate_expired`. |
| `clientEvents` | Options for `forClient` and `clientError`, which prepare each event and each caught failure for the browser. `reader: 'builder'` sends the raw reason in place of the wording of the profile. Use it only in a development tool on your own machine. |
| `onError` | Receives each error that the handler catches. A visitor sees the wording of the profile for that kind of error, never the error. |

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
| `createMemoryConversationStore()` | Process memory, for one server instance. A conversation that is not saved for 24 hours expires. At most 10,000 conversations are kept; the one saved longest ago goes first. Set `ttlMs` and `maxSessions` to change these limits. |
| `createSealedConversationStore({ keys, keyVersion })` | Nowhere on the server. The ref is the conversation itself, encrypted and signed with your key, and bound to the session. The browser cannot read it or change it. |
| Your own `TheoremConversationStore` | Your database. |

A ref that the store cannot open fails with `session.conversation_unknown`, kind `not_found` (HTTP 404). This includes a ref from another session. A route or method the handler does not serve also answers 404 with kind `not_found`.

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
} from '@theoremjs/web/server';

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
The handler retains settled operations for 24 hours from settlement by default. Set `operationRetentionMs` to change this window.
Each saved outcome records its absolute retention deadline. Changing a handler's policy does not shorten that deadline.
Each issued gate records its absolute expiry. Changing `gateTtlMs` does not extend an issued gate.
Ready, running, and uncertain operations do not expire.

A session store declares its `capacity`: what it holds for one session, in bytes of UTF-8 JSON.

| Field | What it bounds | Memory store default |
| --- | --- | --- |
| `maxStateBytes` | One session's saved state | 16 MiB |
| `maxOutcomeBytes` | One tool result | 1 MiB (`DEFAULT_MAX_OUTCOME_BYTES`) |

Pass `capacity` to `createMemorySessionStore` to change them. A store you write declares the capacity of its own storage.

Set `maxRequestBytes` to bound browser JSON before parsing. Its default is 16 MiB.
The handler rejects oversized requests before provider access or tool preparation.
Provider host options also accept `limits` for deadlines and upstream output.
The handler keeps room for one `maxOutcomeBytes` result for each gate and each call that has not settled.
When a session is full, the handler drops its oldest settled results, then its oldest provider checkpoints.
It never drops gates, permissions, or calls that have not settled. When those alone do not fit, the new call is refused before it runs, and the user reads `session.full`.
A result larger than `maxOutcomeBytes` settles as the call's `result_too_large` failure. The call is never left unresolved because of its size.
The handler fits each state to the store's capacity before `compareAndSwap`.

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

`createTheoremHandler` runs each chat reply through a small loop that `@theoremjs/web/server` exports. Use the loop when your server is not a `fetch` handler, or when your routes differ from the handler's. The conversation store, the guardrails, and the wire stay the same, so `TheoremChat` and the hooks work with your server unchanged.

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
