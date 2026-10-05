# @theoremjs/react

React bindings for [Theorem](https://www.npmjs.com/package/@theoremjs/agents), the agent kernel with guardrails, tool gating and egress checks built into every turn.

- **A drop-in chat, voice call, host console and decision form**, built on [Astryx](https://www.npmjs.com/package/@astryxdesign/core) and themed for Theorem.
- **Headless hooks and a typed transport**, if you would rather draw the UI yourself.
- **A Web-standard server handler** (`Request` in, `Response` out) that serves a profile to the browser: streaming turns, tool gates, sign-in, steering and session state.

You describe the agent once as a profile in `@theoremjs/agents`; this package shows it to a person and carries their side of the conversation.

## Install

```bash
npm install @theoremjs/react @theoremjs/agents zod react react-dom
```

For the UI entry points (`/ui` and `/live`), add the Astryx packages and StyleX:

```bash
npm install @astryxdesign/core @stylexjs/stylex
# only to build your own theme from Theorem's (`/ui/theme`):
npm install @astryxdesign/theme-neutral
```

Use the versions this package lists under `peerDependencies`. The Astryx and StyleX peers are optional: the hooks, the client and the server handler run without them. `@theoremjs/agents` is a peer so the host and the UI share one kernel. The type declarations need TypeScript 5.7 or later.

`/ui` and `/live` import their own stylesheets, so a bundler that handles CSS imports (Vite does) needs no extra step. The theme is set in Figtree with a system-font fallback; the package does not ship the font, so load it yourself if you want it. The live UI loads its microphone worklet with `new URL('./worklets/mic-capture.js', import.meta.url)`, which Vite and any bundler that resolves that pattern ship without configuration.

## Quick start

Serve a profile from your server:

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

`createTheoremHandler` returns `(request: Request) => Promise<Response>`, so it mounts in anything that speaks Web `Request` and `Response`: Workers, Deno, Bun, Hono, Next route handlers, or Node behind an adapter. Send every request under one path to it, `/api/theorem` by default:

```ts
export default {
  fetch(request: Request) {
    return new URL(request.url).pathname.startsWith('/api/theorem')
      ? theorem(request)
      : new Response('Not found', { status: 404 });
  },
};
```

Then render the chat in your app:

```tsx
import { TheoremChat } from '@theoremjs/react/ui';

export function App() {
  return <TheoremChat endpoint="/api/theorem" />;
}
```

The browser asks the handler to describe the profile, and the chat draws what it accepts: the models and efforts it offers, attachments and voice notes, and its tool gates. The profile, its keys and its system prompt stay on the server; the handler strips the system prompt from what it describes.

## Entry points

| Import | What it is |
| --- | --- |
| `@theoremjs/react` | Headless hooks (`useTheoremChat`, `useTheoremInterface`, `useTheoremHost`, `useTheoremDecision`), the transports, and the client logic behind the UI |
| `@theoremjs/react/ui` | `TheoremChat`, `TheoremHost`, `TheoremDecision`, and the parts they are made of |
| `@theoremjs/react/live` | `LiveRunner`, the voice and video call UI |
| `@theoremjs/react/server` | `createTheoremHandler`, `createTheoremHostHandler`, `createTheoremDecisionHandler`, and the stores they use |
| `@theoremjs/react/ui/theme` | `theoremTheme`, to extend into your own Astryx theme |
| `@theoremjs/react/ui/icons` | The icon set the theme uses |
| `@theoremjs/react/client` | The same client logic as the root entry, without the hooks |

## The chat

`<TheoremChat />` takes these props. All are optional.

| Prop | What it does |
| --- | --- |
| `endpoint` | Where `createTheoremHandler` is mounted. Default `/api/theorem`. |
| `http` | Fetch options for the default transport: auth headers, a custom `fetch`. |
| `transport` | Your own transport, in place of `endpoint`: tests, non-HTTP hosts. |
| `theme`, `mode` | An Astryx theme (omit to inherit yours, or use Theorem's) and `'system'`, `'light'` or `'dark'`. |
| `labels` | Replacement wording by locale. See [Wording](#wording). |
| `placeholder`, `emptyState` | The composer's placeholder, and what shows above it before the first message. |
| `density`, `maxWidth`, `className`, `style` | Layout. `maxWidth` is a CSS length and defaults to half the chat, or full width on narrow screens. |
| `trace` | Show the trace in place of the chat from your own control. Needs a profile that records traces. |
| `initialChat`, `onChatChange` | Keep a conversation and resume it. See below. |
| `chatRef` | Send a message as the composer would. See below. |

### Keep and resume a chat

`onChatChange` reports the `{ blocks, session }` each time the conversation comes to rest: a turn finished, or a message was added or removed. It is never called while a reply streams or waits on a gate. Pass what it last reported as `initialChat` to resume. The snapshot's `session` carries what the next turn is sent with.

```tsx
<TheoremChat
  endpoint="/api/theorem"
  initialChat={saved}
  onChatChange={(snapshot) => save(snapshot)}
/>
```

### Send from your own code

`chatRef` exposes `send(text)`, which sends a message as the composer would and resolves with the blocks the turn added once its reply is done. It resolves `null` while a reply is streaming or waiting on a gate.

```tsx
const chat = useRef<TheoremChatHandle>(null);
// ...
const turn = await chat.current?.send('Summarize my open tickets');
<TheoremChat chatRef={chat} />
```

### Tool gates

When a tool needs a decision, the chat shows it in the transcript: an approval card for a permission or confirmation, and a sign-in card for a tool that needs a credential. The user answers, the handler settles the call, and the turn continues. A typed key is saved on the server and never held in the browser. See [Tool credentials](https://github.com/masudl-hub/theoremai/blob/main/react/docs/credentials.md) for OAuth and typed keys, and [The wire](https://github.com/masudl-hub/theoremai/blob/main/react/docs/wire.md) for what each answer sends.

A message sent while a reply waits on a gate walks away from it: the host settles the waiting calls as cancelled, and the new message's reply follows in the same stream. See [Composer, queue and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md).

## Other profile types

Each profile type has a handler and a component. They follow the same shape as the chat: mount the handler, point the component at it.

**Host.** A `host` profile runs no model: the page calls its tools directly, with every call going through the kernel's gates and guardrails.

```ts
import { createTheoremHostHandler } from '@theoremjs/react/server';
export const host = createTheoremHostHandler({ profile: opsConsole }); // mount at /api/host
```

```tsx
import { TheoremHost } from '@theoremjs/react/ui';
<TheoremHost endpoint="/api/host" />
```

A `GET` describes each allowed tool with its input and output JSON Schema, never its endpoint or credentials. `POST /call` with `{ name, input }` streams the call's events, and `POST /invoke` answers a gate the call paused on. The console draws a form from the input schema and lays the result out from its value: figures, charts, tables, images, audio and Markdown, with the raw JSON beside them. `createHostTransport` and `useTheoremHost` are there for a UI of your own.

**Decision.** A `decision` profile judges a piece of JSON state and answers questions you define about it, with no conversation.

```ts
import { createTheoremDecisionHandler } from '@theoremjs/react/server';
export const decide = createTheoremDecisionHandler({ profile, questions, vault }); // /api/decision
```

```tsx
import { TheoremDecision } from '@theoremjs/react/ui';
<TheoremDecision endpoint="/api/decision" />
```

`questions` maps each question id to its definition, `vault` carries the profile's keys by slot, and `metadata` can attach the signed-in user to each decision's trace record. `useTheoremDecision` is the headless hook.

**Live.** A `live` profile runs a voice or video call over a WebSocket relay that you host with `runSession` from `@theoremjs/agents`. `LiveRunner` takes the profile's interface, which `interfaceFromProfile` (`@theoremjs/agents/interface`) builds from the profile, and a function that says what to connect to:

```tsx
import { LiveRunner } from '@theoremjs/react/live';

<LiveRunner iface={iface} connection={() => ({ profile: 'support.voice' })} />
```

It opens `wss://<your host>/api/live/relay?profile=<id>`. Pass `{ openMessage }` in place of `{ profile }` to send the relay an open message of your own, and `createSocket` to supply the socket yourself. `LiveRunner` takes `theme`, `mode`, `labels` and `trace` like the chat. Live tool gates show in a dialog over the call.

## Server options

`createTheoremHandler` takes a profile and a provider, and everything else is optional:

| Option | What it does |
| --- | --- |
| `profile` | The profile to serve. Registered with the kernel when the handler is created. |
| `provider` | Provider settings, with the key vault by slot, or a function that builds a provider per request for hosts that pick keys per tenant. |
| `session` | Resolves the caller's session id, for example `${userId}:${conversationId}`. Return `undefined` to refuse with a 401. Default: an opaque id in an HttpOnly, SameSite=Lax cookie the handler issues on first contact. |
| `host` | Opaque app context for tool handlers (`ctx.host`), such as the signed-in user. |
| `sessionStore`, `steerInbox` | Where pending gates and queued steers live. Default: process memory, so pass a shared store when requests can reach different instances. |
| `credentialStore` | Tool credentials by session. Default: process memory. |
| `authorizationUrl` | The sign-in URL for an OAuth gate. Without it an OAuth gate carries no URL. |
| `gateTtlMs` | How long a gate waits for its answer. Default 30 minutes; a later answer is refused with `session.gate_expired`. |
| `clientEvents` | Forwarded to `forClient` when events are projected for the browser. |
| `onError` | Called with every error the handler catches, for reporting. Users read the profile's wording for the error's kind, never the error. |

The default stores keep state in memory, so they suit development and a single process. Use a shared store in production.

## Build your own UI

The hooks do what the components do, without drawing anything. `useTheoremChat` holds the transcript, streaming, drafts, the pending queue and the tool gates:

```tsx
import { createHttpTransport, useTheoremChat, useTheoremInterface } from '@theoremjs/react';

const transport = createHttpTransport({ endpoint: '/api/theorem' });

function MyChat() {
  const described = useTheoremInterface(transport);
  const chat = useTheoremChat({
    transport,
    iface: described.status === 'ready' && described.iface.type !== 'live' ? described.iface : null,
  });
  // chat.blocks, chat.streamBlocks, chat.phase, chat.draftText, chat.handleSubmit, ...
}
```

`phase` is `'idle'`, `'streaming'` or `'gated'`. `handleSubmit`, `handleStop`, `handleSendNow` and `handleToolDecision` are the actions the composer and the gate cards call. Render the transcript with `ChatTranscript` and `ChatComposerBar` from `/ui`, or draw your own from `blocks`.

The headless layer writes no English. It hands you kinds, codes and states:

- A failure is a `ClientFailure`: `{ error, errorKind, errorInternal? }`. `error` is the profile's own wording (resolved on the host) and is the text to show the user. `errorKind` and `errorInternal` are for you.
- An attachment problem is an `AttachmentValidationIssue`. Word it with `attachmentIssueText(issue, iface.lexicon)` from `@theoremjs/agents`.
- A live call the provider ended after warning it would is not a failure. `LiveSessionClient`'s `onSessionEnded(session)` gives `session.message`, the profile's `live.session_ended` wording, and `session.ended`, with the close code and timing.
- Chrome is semantic: `liveState`, work status, drawer parts and hint ids, for you to word.

## Wording

Every line the default UI shows is an Astryx i18n message: Theorem's under `@theorem.*` keys (`THEOREM_UI_CATALOG` lists each one with a description and the values it takes), and Astryx's own under `@astryx.*`. `labels` replaces any of them, per locale:

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

`LiveRunner`, `TheoremHost` and `TheoremDecision` take the same prop. The locale is your Astryx `InternationalizationProvider`'s locale, `en` without one, and your own Astryx `messages` and `overrides` apply too and win over the defaults. Labels are checked when the component mounts: an unknown `@theorem.*` key, a message that is not valid ICU, a value the line is not given, or a key outside `@theorem.*` and `@astryx.*` throws, naming the locale and key. Label values render as text, never HTML.

## More

- [The wire](https://github.com/masudl-hub/theoremai/blob/main/react/docs/wire.md): the request and event schemas between the browser and the host, and what each side checks.
- [Tool credentials](https://github.com/masudl-hub/theoremai/blob/main/react/docs/credentials.md): typed keys, OAuth and refresh, with a complete callback route.
- [Composer, queue and steer](https://github.com/masudl-hub/theoremai/blob/main/react/docs/composer.md): the action matrix for stash, queue, steer and send now.
- [`@theoremjs/agents`](https://www.npmjs.com/package/@theoremjs/agents): profiles, tools, guardrails and providers.

MIT licensed.
