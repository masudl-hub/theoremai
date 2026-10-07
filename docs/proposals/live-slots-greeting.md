# Context, slots in prompts, a greeting and page tools on the profile

Status: decided, not built. Section 8 is the build order.

## 1. The problem

Things every agent on a page needs are host code today. The profile does not
show them, so the playground cannot show, edit or test them.

| Need | Today |
| --- | --- |
| The agent speaks first on a call | The page sends a text turn such as `(call connected)` when the call starts listening |
| The agent knows what the page shows | On a call, the page sends free text with `sendContext(text)`. It is read at `live_user`, as if the person said it. A chat agent has no way |
| The agent says it is back after a dropout | The package's call view does not reconnect. A drop ends the call |
| The page answers a tool call | A function tool with `clientAnsweredHandler(name)` on the server, and a function in React. The two are paired by name only. A wrong name is a 20 second timeout |

The rule: the profile declares it, the kernel does it, and the frontend only
supplies values.

## 2. The shape

```ts
inputs: {
  slots:   { language: ['en', 'fr'] },
  context: { from: ['client', 'server'], maxChars: 4000 },
},
identity: { system: 'Reply in {language}.' },
live: {
  greeting: 'Greet the visitor in {language}.',
  resumed:  { prompt: 'Tell the visitor you are back.', afterMs: 3000 },
},
tools: [{ name: 'highlight', type: 'function', answeredBy: 'page', input: …, output: … }],
```

`inputs.slots` and `inputs.context` are on every profile type that takes turns,
`live` included. `live.greeting` and `live.resumed` are on `live` only.

## 3. Slots

- A slot keeps its shape: a name and its allowed values.
- `{name}` in `identity.system`, `live.greeting` and `live.resumed.prompt` is
  replaced with the value the turn or call chose.
- A `{name}` that is not a declared slot stays as written: a prompt may use
  braces for other things.
- A prompt that uses a slot the caller did not fill is a request error.
- This is safe because every value is one the builder listed. Free-form data
  never goes into a prompt; it goes through context.

## 4. Context

Context is one package: any JSON the page or the server wants the agent to
know. The builder does not declare a field for each value.

| Field | Meaning |
| --- | --- |
| `from` | Who can send context: `client` (the browser), `server` (the host's handler), or both |
| `maxChars` | The longest package, as serialized JSON, from each sender |

- Chat: the package goes with each turn.
- Call: the package goes at call start. The page sends it again when it
  changes. It does not start a reply.
- A new package replaces the old one. The model keeps what it was sent earlier
  in the call; the kernel cannot remove it.

### The boundary

Context crosses a new inbound boundary, `context`. It is not `user` or
`live_user`: the page said it, not the person.

| Sender | Trust | Read at |
| --- | --- | --- |
| The browser | `untrusted` | `context` |
| The host's handler | `assembled` | `context` |

- The profile's detectors and actions apply at `context`, with their own row in
  the editor.
- The kernel gives each package to the model in a marked block that names the
  sender. It is never joined to the system instruction.
- Context from a sender the profile does not list is refused.
- A package over `maxChars` is refused.

An address in context counts as given, as one in the user's message or in a local
tool's result does: the page is the host's own code.

A value a tool returns is not context. It crosses `tool_result_<kind>`, as now.

## 5. Greeting and resume

- `live.greeting` is a prompt. The kernel sends it when a call opens with no
  resumption handle, and the model replies in speech.
- `live.resumed.prompt` is a prompt. The kernel sends it when a call opens with
  a resumption handle and the caller was away for `afterMs` or longer.
- The caller sends the time away with the session request. The kernel keeps no
  state between sessions. A false number can only make the agent say, or not
  say, that it is back.
- Neither prompt is shown as a message, and neither is stored as something the
  visitor said.
- With no `live.greeting` the agent waits for the visitor. With no
  `live.resumed` a resumed call is silent.

The package's call view reconnects after a drop: it keeps the resumption handle,
shows that it is reconnecting, retries with backoff, and sends the time away.

## 6. Page tools

`answeredBy: 'page'` on a function tool:

- The kernel supplies the handler. The host does not write
  `clientAnsweredHandler`.
- The interface lists the page tools. The React runner warns at start when a
  page tool has no handler.
- The output schema checks the page's answer, as now.

## 7. What the frontend does

```tsx
<LiveRunner
  slots={{ language: 'fr' }}
  context={{ page: 'Checkout', cart }}
  pageTools={{ highlight: (args) => ({ output: highlight(args) }) }}
/>
```

```ts
createTheoremHandler({ profile, context: (request) => ({ tier: tierOf(request) }) });
```

Removed, with no alias:

- `sendContext` on the live session, the live client and `useLiveRunnerModel`.
- The `context` client message with free text.
- The `onConnected` prop and the single `pageTool` function prop (neither was
  committed).

## 8. Build order

1. Kernel: `inputs.context`, the `context` boundary, slots in prompts,
   `inputs` on `live`.
2. Kernel: `live.greeting`, `live.resumed`, `answeredBy`.
3. React: handler and transports carry context; `LiveRunner` takes `slots`,
   `context` and `pageTools`, and reconnects.
4. Playground: the editor shows context, the greeting, the resume prompt and
   page tools.
5. Frontend: the Th30 dock moves onto the package's call view.
