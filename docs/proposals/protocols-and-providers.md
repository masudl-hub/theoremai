# Protocols, providers, and models: the shape before publish

Status: proposal, 16 Oct 2026. Nothing here is built. It replaces the provider layer the audit
(`theoremai-frontend/tmp/providers-audit.md`) and the code sweep of 16 Oct found:

- two provider contracts;
- three ways to say what a model supports;
- four lists of provider names;
- the Chat Completions stream loop written twice, behaving seven ways differently;
- the fallback-key retry written three times;
- OpenRouter's extras inside the "generic" OpenAI code;
- options that do nothing.

The question it answers: **how does someone plug any protocol, provider, or model into Theorem, and have it
just work?** The rule throughout: **each concept has one owner, and everything else reads it.**

## Invariants

1. **Three layers.** Every model binding names a `protocol`, a `provider`, and an `apiId`.
2. **A protocol owns everything on the wire.** Framing, decoding, typed errors, options, extras,
   reasoning, tool-call ids, and the path for each profile type. A service whose wire differs gets its
   own protocol, extended from a base one. A protocol never sees a key, a slot, or a base URL.
3. **A provider is where and who, nothing more.** Where a service is, how to sign in, its headers,
   key slots and prices, and which protocols it serves. It is data plus one sign-in function; it
   can't change a request or read a reply.
4. **A model is its `apiId` and the settings on its binding.** Theorem keeps no facts about what a
   model supports; the upstream's refusals come back as typed errors. The one exception is a price
   where the API reports no cost (Jev, Gemini).
5. **A binding is checked once, at registration, and only for fit.** The provider serves the
   protocol, the protocol has a path for the profile type, the options parse strictly against the
   protocol, the slots differ, and the sign-in works on this runtime. It comes back parsed; nothing is
   changed in place.
6. **The conversation has one record.** It is Theorem's transcript, or the host's under
   `history: 'provider'`. Server state is a shortcut, used only when everything that gives it
   meaning matches.
7. **Switching provider or model is never an error in itself.** A mismatch rebuilds from the record.
8. **Every extra is typed and owned by one protocol.** Options, part extras, reasoning parts and
   custom parts each have a schema declared by the protocol that writes them, are checked when
   written and read, and are keyed by that protocol's id, written by the kernel. They go back to that
   protocol and the protocols extended from it.
9. **Only the kernel retries:** transient failures, one fallback key, and one sign-in refresh, all
   before the first event.
10. **Theorem owns ids.** The kernel mints tool-call ids; protocols translate them.
11. **One owner per concept.** Lists of names are read from what's registered, never written twice.
    Protocol ids are unique in a scope.

## 1. The words

The stack is **protocol → provider → model**, as in the original build.

| Word | One sentence | Example |
| --- | --- | --- |
| **Protocol** | One API shape: how a request is framed, how its reply streams back, and which path each profile type uses. | `geminiInteractions`, `openAi`, `systemOne` |
| **Provider** | One service that serves one or more protocols: where it is and how it is signed in to. | `gemini`, `openrouter`, `typesafe`, `local` |
| **Model binding** | One entry under a profile's `models`: which protocol, which provider, which model, and its settings. | `models.default` |
| **Model name** | The key a binding sits under in `models`. The profile and its turns use it. | `'default'`, `'fast'` |
| **`apiId`** | The id the provider knows the model by. | `'gemini-3.8-flash'` |
| **Connection** | What a builder sets on a provider when registering it. | `{ baseUrl }` for `local` |
| **Options** | What one binding tells its protocol beyond the shared settings. | `{ cacheControl: true }` |
| **Key slot** | A name the host fills with a key in its vault. Profiles name slots; they never hold keys. | `'company'` |

There is no word for "what a model supports". Builders choose models and write profiles to what a
model can do; Theorem does not keep a second copy of that. When the upstream refuses something, the
refusal comes back as a typed error.

**Why the protocol is on the binding.** One provider serves several shapes on the same profile type.
Vertex serves Gemini (`generateContent` / Interactions), Claude (Anthropic Messages, through
`:rawPredict`) and open models (Chat Completions) all as text. OpenRouter serves Chat Completions,
Responses, Anthropic Messages, its own `/images`, and System One. Without a model catalog, only the
binding can say which shape a model is spoken in.

## 2. The door: a profile's `models`

This is the only thing most builders write. Every field describes itself, and the studio and docs
read those descriptions.

```ts
const modelBindingSchema = z.strictObject({
  protocol: z.string().min(1)
    .describe('The API shape this model is spoken to in.'),
  provider: z.string().min(1)
    .describe('The service that runs the model or routes requests to one, such as Gemini or OpenRouter. Its registration supplies the endpoint and authentication.'),
  apiId: z.string().min(1)
    .describe('The id the provider knows the model by.'),

  // Shared settings: every protocol takes them, or refuses them by name.
  maxOutputTokens: z.number().int().positive().optional()
    .describe('The most tokens the model may write in one step.'),
  temperature: z.number().finite().nonnegative().optional()
    .describe('How varied the model\'s answers are.'),
  efforts: z.record(z.string(), thinkingLevel).optional()
    .describe('Effort names a turn may pick, each mapped to a thinking level.'),
  defaultEffort: z.string().optional()
    .describe('The effort used when a turn picks none.'),
  allowEffortSelect: z.boolean().optional()
    .describe('Whether a turn may pick an effort.'),
  summaries: z.boolean().optional()
    .describe('Whether the model sends summaries of its thinking.'),
  builtInTools: z.array(z.string()).optional()
    .describe('Tools the provider runs itself, by the ids it knows them by.'),
  compaction: compactionSpec.optional()
    .describe('How the conversation is shortened when it grows too long.'),

  // Keys: override the provider's slots for this model only.
  keySlot: keySlotSchema.optional()
    .describe('The slot this model\'s key is read from, in place of the provider\'s.'),
  fallbackKeySlot: keySlotSchema.optional()
    .describe('The slot tried once when the first key is out of quota.'),

  options: jsonObjectSchema.optional()
    .describe('What this model\'s protocol takes beyond the shared settings.'),
});

const decisionModelBindingSchema = modelBindingSchema
  .pick({ protocol: true, provider: true, apiId: true, keySlot: true, fallbackKeySlot: true, options: true })
  .extend({ timeoutMs: z.number().positive().optional()
    .describe('How long a decision may take before it fails.') });
```

What changes for the builder:

- `protocol` comes back, required.
- `providerOptions` becomes **`options`**. It belongs to the binding. Its schema is the protocol's
  options, and only the protocol's (section 4).
- `builtInTools` stays where it is, the one place a model's built-in tools are named. No protocol
  declares a list of them.
- The kernel's catalog no longer lists `models.*.providerOptions.store`, `.persistViaInteractionId`,
  `.server` or `.cache.*`. The options schemas describe their own fields, and the studio draws their
  rows from them. A third-party protocol's options get rows the same way.
- `server` is deleted. It changed nothing (audit B11).
- Each field's description is the `.describe()` above. The kernel catalog's `models.*` rows are
  derived from this schema, not written beside it.
- `apiId` keeps its name: `model` would clash with the model name.
- `protocol` and `provider` stay string ids, because a profile is plain data: the studio edits it,
  and a project writes it to a file.

## 3. What `defineProfile` does, and when

There are three checks. Each happens once, at the earliest point that has what it needs.

| When | Function | Checks | Why there |
| --- | --- | --- | --- |
| Writing the binding | `provider.model(protocol, apiId, settings)` | Options against the protocol's schema, with types in the editor. | It is the only point with the types. It is optional: a binding is plain data. |
| Defining the profile | `defineProfile(input)` | Shape only, against `modelBindingSchema`. | It has no registry, so it cannot know the provider. |
| Registering the profile | `scope.profiles.register(profile)` | Each binding against its registered provider: `checkBinding(provider, binding, profileType)`. | It is the first point where the provider is known. A missing provider fails here, with the provider and model named. |

`checkBinding` is the one place a binding meets its provider. It refuses, naming the field, when:

- the provider does not serve the binding's protocol;
- the protocol has no endpoint for the profile's type;
- the options don't parse against the protocol's schema;
- the two key slots are the same;
- the provider's sign-in needs WebSocket headers on a runtime that can't send them.

That is all. It does not check the model, its built-in tools, or its efforts against any list.

It returns the parsed binding and changes nothing in place. Today `validateProviderModel` writes
`binding.providerOptions` back.

Removed from `defineProfile`: the loop that refuses `key`, `fallbackKey`, `protocol`, and `provider`
at the top level, and the `Omit<…>` in `ProviderModelSettings`. Both exist only to catch an old
shape.

## 4. `defineProtocol`

A protocol is the code that speaks one API shape, and it owns everything on the wire. The kernel
ships the first-party ones; anyone can add one.

```ts
interface ProtocolDefinition<O, S> {
  id: string;                          // 'openAi'; what bindings write
  name: string;                        // 'OpenAI Chat Completions'; what people read
  description: string;                 // one sentence; what the studio shows

  /** Option c: the path each profile type uses. A type with no entry is not served. */
  endpoints: Partial<Record<ProfileType, string>>;
  options: z.ZodType<O>;               // every field a binding may set, each .describe()d
  continuation?: { version: number; schema: z.ZodType<S>; keyOptions?: string[] };
  reasoning?: z.ZodType<JsonValue>;    // the `data` of the reasoning parts it writes (section 7)
  extras?: z.ZodObject;                // what it attaches to transcript parts
  custom?: Record<string, z.ZodObject>; // content it emits that has no common shape, by kind

  /** Turns the reply's framing into rows. SSE when absent (Bedrock's binary event stream needs one). */
  framing?(response: Response): AsyncIterable<JsonObject>;
  /** Rewrites Theorem's tool-call ids for a wire with its own rules (Mistral's 9 characters). */
  callId?: { out(id: string): string; in(wireId: string): string };

  create(context: ProtocolContext<O, S>): ProtocolOperations<S>;
}

function defineProtocol<O, S>(definition: ProtocolDefinition<O, S>): Protocol<O, S>;
```

**A service whose wire differs is its own protocol, extended from a base.**

```ts
const openRouter = extendProtocol(openAi, {
  id: 'openRouter',
  name: 'OpenRouter Chat Completions',
  description: 'Chat Completions with OpenRouter\'s caching, routing, web search, cost, and reasoning.',
  options: z.strictObject({ cacheControl, sessionId, requireParameters }),  // added to openAi's
  reasoning: reasoningDetails,
  custom: { citations },
  body(body, at) { … },                // what it adds to the base's request; reports tools it wrote
  read(at) { return { row(row) { … }, finish() { … } }; },  // what it reads before the base
});
```

- The result is a protocol like any other, with its own id. "What does `openRouter` send?" has one
  answer: its definition. Nothing patches `openAi` from outside.
- Its options are the base's plus its own. A field the base already has is refused when the protocol
  is extended. The cost: a base adding a field an extension already uses is a breaking change for
  that extension. First-party protocols ship together, so our own tests catch it before release.
- Its endpoints, `framing`, and `callId` are the base's unless it gives its own.
- `read` sees every reply row before the base: it may emit events (citations, cost, its own error
  rows, the reasoning it adds up) and may take a row so the base never parses it.
- It is how a builder tries a new upstream field: a few typed lines, under a new id.

The first-party endpoint table:

| Protocol | text | image | speech | live | decision |
| --- | --- | --- | --- | --- | --- |
| `geminiInteractions` | `/interactions` | `/interactions` | `/interactions` | | |
| `geminiLive` | | | | `BidiGenerateContent` (WebSocket) | |
| `openAi` | `/chat/completions` | | `/audio/speech` | | |
| `openRouter` (extends `openAi`) | `/chat/completions` | | `/audio/speech` | | |
| `openRouterImages` | | `/images` | | | |
| `systemOne` | | | | | `/systemone` |

- Gemini Interactions uses one path for text, image, and speech; only the body differs. The OpenAI
  shape uses a path per type. The table holds both.
- `openRouterImages` is its own protocol: OpenRouter's `/images` body (`aspect_ratio`,
  `input_references`, `resolution`) is not OpenAI's images API. When an image profile also wants
  text, it posts `/chat/completions` with OpenRouter's image tool, as today. That borrows the
  `openRouter` path; it is kept as today, and noted.
- `systemOne` uses `/systemone` for both servers. OpenRouter's own spec lists
  `/api/v1/systemone` as compatible with TypeSafe; today we post OpenRouter's alpha `/decisions`.
  One live call confirms it before the switch.
- The table says whether a profile type is served and its default path. A provider may still
  place the URL itself (`url`), as Vertex `:streamRawPredict` and Bedrock do: that is location, not
  shape.
- The kernel passes the profile type in. Protocol code stops choosing its endpoint from `req.speech`,
  `req.image`, `apiId.includes('live')`, or `apiId.startsWith('openai/')`.

**What the kernel hands a protocol, and what it hands back.**

```ts
interface ProtocolContext<O, S> {
  profileType: ProfileType;
  apiId: string;
  options: O;                          // parsed
  limits: ProviderLimits;
  signal?: AbortSignal;

  /** Posts to this profile type's endpoint on the provider and yields the reply's rows, decoded by
   *  the protocol's `framing`. The provider's URL, headers, and sign-in are applied on the way out. */
  send(body: JsonObject, init: { stream: boolean; path?: string; headers?: Record<string, string> }):
    AsyncIterable<JsonObject>;
  /** Opens this profile type's WebSocket on the provider, signed in the same way. */
  connect(setup: JsonObject): Promise<ProtocolSocket>;
  tapUpstream(row: JsonObject): void;  // scrubbed wire rows for traces
}

interface ProtocolOperations<S> {
  complete?(request: TurnRequest<S>): AsyncIterable<TurnEvent<S>>;
  openSession?(request: TurnRequest<S>): Promise<LiveSession<S>>;
  decide?(request: DecisionRequest): Promise<DecisionResult>;
}
```

- A protocol never sees a key, a slot name, or a base URL. `send` and `connect` carry them.
- **Built-in tools have one writer.** The protocol writes the `builtInTools` ids its shape defines
  (Interactions puts `googleSearch` in `tools`; Live puts it in the setup frame; `openRouter` writes
  `webSearch` as `web_search_options`). It reports the ids it wrote, so no list is declared anywhere;
  an id it didn't write is refused by name when the call is made, and an id the upstream doesn't know
  comes back as the upstream's error.
- **A protocol can send any conversation from Theorem's own parts.** It never depends on what a
  server stored. Server state (an interaction id, a resumption handle) is a shortcut it may use, never
  the record. Signed reasoning is part of the record (section 7). Tool-call ids are Theorem's: each
  protocol translates them to and from the wire's format, so a tool call made under one provider is
  answered under another. Files are Theorem's copy; a file id one provider issued is never sent to
  another.
- Errors are typed: a protocol maps its error envelope to `TheoremError` kinds (`quota`, `auth`,
  `transient`, …). It does not retry.
- `TurnRequest`, `LiveSession`, and `TurnEvent` are today's `ProviderTurnRequest`,
  `ProviderLiveConnection` and `ProviderModelEvent`, renamed. The request loses its vendor fields
  (`previousInteractionId`, `store`, `continuation`, `sessionId`): those are options or continuation.
- A call's cost: the protocol reads it from the reply when the upstream reports one (`openRouter`
  does). Otherwise the kernel applies the provider's `prices` (section 5).

## 5. `defineProvider`

A provider is where a service is and how to sign in to it. It is data plus one sign-in function; it
can't change a request or read a reply.

```ts
interface ProviderDefinition<C, K> {
  id: string;                          // default id; a registration may rename it
  name: string;                        // 'OpenRouter'
  description: string;
  traceName?: string;                  // OpenTelemetry gen_ai.provider.name; else the id

  connection?: z.ZodType<C>;           // what a builder sets when registering it, each .describe()d
  key?: z.ZodType<K>;                  // absent: no key; .optional(): optional; an object for e.g.
                                       // a service account or AWS credentials
  authorize?: Authorize<K>;            // how the key is put on a request (below)
  prices?: PriceTable;                 // only where the API reports no cost (section 11)

  serves(connection: C): Serve[];      // one entry per protocol it serves
}

interface Serve {
  protocol: Protocol;
  baseUrl: string;
  /** Places the URL when the protocol's path isn't enough, e.g. the model in the path. */
  url?(at: { path: string; apiId: string; stream: boolean }): string;
  authorize?: Authorize;               // overrides the provider's, for this protocol only
  headers?: Record<string, string>;
}

/** Signs outgoing calls for one registration. Made once per registration and key, so a minted
 *  token (Vertex, AWS) is reused until it expires; `invalidate` drops it after an `auth` refusal. */
type Authorize<K = unknown> = (key: K) => {
  sign(outgoing: Outgoing): void | Promise<void>;
  invalidate?(): void;
};

interface Outgoing {
  transport: 'http' | 'ws';
  url: URL;
  headers: Headers;
  protocols: string[];                 // WebSocket subprotocols, where some APIs sign in
  body?: string;                       // final, so AWS signing can hash it; read-only
}

// Built in:
bearer()                         // Authorization: Bearer <key>
header('x-goog-api-key')         // or 'api-key' for Azure
query('key')                     // e.g. Gemini Live's WebSocket
```

Registering, with the builder's connection and keys:

```ts
scope.providers.register(openrouter, { keySlot: 'company', fallbackKeySlot: 'company-backup' });
scope.providers.register(local, { id: 'ollama', connection: { baseUrl: 'http://localhost:11434/v1' } });

const fast = scope.providers.get('openrouter').model('openRouter', 'google/gemini-3.8-flash', { … });
```

- A WebSocket opener takes `(url, { headers, protocols })`. A sign-in that needs headers on a
  runtime that can't send them on a WebSocket (a browser) is refused by name when the binding is
  checked, not ignored.
- `.decisionModel()` is separate from `.model()`. Today, passing `timeoutMs` to `.model()` quietly
  switches it to a decision binding.
- `RegisteredProvider` and `DefinedProvider` become one type, `Provider`.

**The first-party providers:**

| Provider | Serves | Sign-in | Also |
| --- | --- | --- | --- |
| `gemini` (renamed from `google`) | `geminiInteractions`, `geminiLive` | `x-goog-api-key`; the `key` query for Live | its price table |
| `openrouter` | `openRouter`, `openRouterImages`, `systemOne` | bearer | `HTTP-Referer` / `X-Title` headers |
| `typesafe` | `systemOne` | bearer | the Jev price |
| `local` | `openAi` | optional bearer | `baseUrl` is a required connection field |

`gemini` is named for the API it reaches. Vertex, when it comes, is its own provider, `vertex`, with
other hosts and Google Cloud sign-in.

**How "just works" holds up:**

| Plugging in | What it takes |
| --- | --- |
| A new model on a provider we have | Its `apiId` in a binding. |
| Groq, Together, DeepSeek | `defineProvider` with `serves: () => [{ protocol: openAi, baseUrl }]` and `bearer()`. No code. |
| Azure OpenAI v1 | The same, with `header('api-key')`. |
| Vertex open models | A `vertex` provider serving `openAi` at `…/endpoints/openapi`, with a token-minting `authorize`. |
| Anthropic Messages | One new protocol, `anthropicMessages`; Anthropic and OpenRouter `/messages` are providers serving it. Vertex Claude (`anthropic_version` in the body, no model) and Bedrock (its binary event stream) differ on the wire, so each is a protocol extended from it, served by `vertex` (`url` for `:streamRawPredict`) and a `bedrock` provider (AWS signing in `authorize`). |
| OpenAI Responses | One new protocol, `openAiResponses`; its encrypted reasoning items are reasoning parts. |
| A service with one odd field | `extendProtocol` from the protocol it nearly speaks, plus a provider that serves it. |

## 6. What the kernel owns

- **The fallback key.** When a call fails with `TheoremError('quota')` before its first event, the
  kernel retries once on the fallback slot, signed by an authorizer made for that key, and records
  which slot it used, by name. A quota error after output has streamed, or inside an open live
  session, is the turn's error. This replaces three copies (`shared/vault.ts`, `google/keys.ts`,
  `live/session.ts`) and fixes trace bug B10.
- **Transient retries**, with backoff, in `send`. No protocol or provider retries on its own.
- **One sign-in retry.** On an `auth` refusal before the first event, the kernel calls the
  authorizer's `invalidate` and retries once, so an expired minted token is refreshed, not fatal.
- **Tool-call ids.** The kernel mints short opaque ids (`[A-Za-z0-9]{24}`), the same for every
  provider. The transcript keeps the wire id beside Theorem's; a protocol with stricter rules
  rewrites them with `callId`.
- **Prices.** When the reply carries no cost and the provider has `prices`, the kernel works the cost
  out from the usage and marks it as Theorem's estimate.
- **The upstream tape and the trace.** `gen_ai.provider.name` is the provider's `traceName`, else
  its id; `gen_ai.operation.name` follows the profile type, so an Interactions turn is no longer
  traced as `chat`.
- **Continuation checkpoints.** A checkpoint holds the protocol's continuation. It is keyed by
  protocol + provider registration + its connection + `apiId` + the key slot actually used + the
  options the protocol lists in `keyOptions`. It is used only when the next call matches all of them.
- **The fallback key starts clean.** A retry on the fallback slot may be another account, so it
  rebuilds from the transcript instead of sending the first key's continuation; under
  `history: 'provider'` it is refused with `history_needed`.
- **Switching provider or model mid-conversation just works.** When the next call goes somewhere
  else, the kernel drops the old checkpoint and the protocol sends the conversation from Theorem's
  own transcript. A switch itself is never an error: `onMismatch` is deleted, and a mismatch always
  rebuilds.
  - With `history: 'provider'`, the host keeps the conversation itself and Theorem holds no
    transcript. A turn that changes provider or model then takes the conversation from the host,
    on the turn request, and is refused by name (`history_needed`) when the host sends none. How the
    host carries the conversation from provider to provider is the host's.
  - The one limit: if the conversation holds something the new model can't take (images, for a
    text-only model), the new provider's refusal comes back as a typed error. Theorem keeps no
    model facts to foresee it.
- **Protocol ids are unique in a scope.** Registering a provider that brings a different protocol
  under an id already registered is refused, so `protocol: 'anthropicMessages'` means one thing.

**No `apiVersion`.** The package version is the contract's version. A field that only ever says `1`
is a second truth.

## 7. Extras: typed, and kept with what they belong to

Services and models send and take things no common shape has: signed reasoning, citations, cache
counts, grounding results. Theorem handles them without knowing all of them, and without a
free-for-all. Every one is declared by the protocol that writes it.

**Signed reasoning is part of the record.** Anthropic thinking blocks, Gemini thought signatures and
OpenAI encrypted reasoning must go back word for word, and both Anthropic and Google say to keep
sending them when switching models (the API drops what the new model can't read). So an assistant
message can hold:

```ts
{ type: 'reasoning', text?: string, origin: { protocol, provider, apiId }, data: JsonValue }
```

`data` is checked against the `reasoning` schema of the protocol that wrote it. `origin.provider` is
the registration, for traces; it doesn't decide where the part goes.

- It is emitted as an event, so a host keeping its own history (`history: 'provider'`) has it too.
- It goes back to the protocol that wrote it, and to any protocol extended from that one, whatever the
  provider or model. Anthropic thinking goes to `anthropicMessages` and the Vertex and Bedrock
  extensions; OpenRouter's `reasoning_details` go only to `openRouter`, so Groq on plain `openAi`
  never receives them.
- Everything else is skipped; its visible text stays.
- Gemini's per-part thought signature moves here from `tool_calls[].thoughtSignature`.

**Extras ride on the part they belong to.** Any transcript part may carry extras keyed by the
protocol that wrote them:

```ts
extras?: { [protocol: string]: JsonObject }
```

- The kernel writes the key, never the builder, so it can't be misspelled.
- Each is checked against that protocol's `extras` schema, when written and when read back. They go
  back by the same rule as reasoning.

**Content with no common shape** is a custom part, `{ type: 'custom', kind: 'openRouter.citations',
data }`, its `data` checked against the schema the protocol declares under that kind. Hosts and the
studio can render it by kind or show it as data.

**Options are strict.** A binding's `options` are parsed against its protocol's schema; an unknown
field is an error, not ignored.

**Raw rows for looking around.** The upstream tape records every row already; a builder can opt in
to seeing them in the stream as `{ type: 'raw', row }`.

This is the AI SDK's model (`providerOptions` in, `providerMetadata` out, custom parts by `kind`, raw
chunks), with its loose ends tied: one owner per extra, the key written by the kernel, and every
extra with a schema.

## 8. The single owners

| Concept | Owner | Read by |
| --- | --- | --- |
| A binding's shape and field descriptions | `modelBindingSchema`; the catalog's `models.*` rows derive from it | `defineProfile`, studio rows, docs |
| Everything on the wire: framing, body, reply, errors, ids | The protocol | `send`, `connect`, the kernel |
| Which path a profile type uses | The protocol's `endpoints` | `checkBinding`, `send`, the studio's protocol picker |
| What options a binding takes | The protocol's `options` | `checkBinding`, studio rows, docs |
| Which protocols a provider serves, and where | The provider's `serves` | `checkBinding`, the studio's provider page |
| A model's built-in tools | The binding's `builtInTools` | The protocol, which writes them |
| How a key is put on a request | The provider's `authorize` | `send`, `connect` |
| Whether a key is needed, and its shape | The provider's `key` | Registration, the studio's key row |
| The fallback-key retry, transient retries | The kernel | Traces |
| The Chat Completions stream loop | The `openAi` protocol | `openRouter`, and every provider serving either |
| OpenRouter's additions | The `openRouter` protocol | `openrouter` |
| What a conversation is | Theorem's transcript, or the host's under `history: 'provider'`; server state is only a shortcut | Every protocol, on every switch |
| Signed reasoning and per-part extras | The transcript, keyed by protocol; schemas from that protocol | The protocol and its extensions |
| A tool-call id | The kernel; the wire id beside it | Protocols, `callId` |
| A call's cost | The upstream's reply, read by the protocol; else the provider's `prices`, applied by the kernel | Traces, evals |
| A trace's provider name | The provider's `traceName`, else its id | Traces, the trace catalog |
| A refusal's wording | The kernel's labels | Protocols return names, never text |
| The studio's providers, with no project | One list in `studio/providers.ts` | Studio server and page (two copies today) |
| A project's providers | The project's setup file | Studio. It never adds its own (audit C17) |
| A new model's provider | The first registered provider serving a protocol with an endpoint for the profile's type | Studio. Nothing hard-codes `'google'` / `'typesafe'` (audit C21) |
| A protocol's or provider's icon | Studio presentation, by id, with a generic icon for others | Studio only |

## 9. Deleted

- **Old contract:** `ProviderAdapter`, `defineProvider`'s current shape, `ModelProvider`,
  `ProviderEvent`, `ProviderCompleteRequest`, `translateProviderEvent`, `translated`,
  `resolvedVault`, `registeredTurnProvider`, `apiVersion`.
- **Model support, everywhere:** `ProviderCapabilities`, `capabilities()`, `DeclaredSupport`,
  `declaredSupportSchema`, `DECLARABLE_FEATURES`, `declared`, `validateRequest`; Google's "known
  model" lists and the model-id string tests in `adapters.ts`; `OPENROUTER_BUILTINS` /
  `GOOGLE_BUILTINS` as lists to check against (the wire mapping stays in the protocols).
- **Name lists:** `PROVIDERS`, `PROTOCOLS`, `PROTOCOL_PROVIDERS`, `PROFILE_TYPE_PROTOCOLS`,
  `protocolsForProfileType`, `isValidProfileProtocol`, and the trace catalog's `PROVIDERS` with its
  `'gcp.gemini'` key. The studio and docs read registered protocols and providers instead.
- **Presets:** `PROVIDER_FACTS` and `ProviderFacts` (`needsKey` → `key`; `traceName` → `traceName`;
  `decisionsUrl` → the `systemOne` serve's `baseUrl`; `takesServer`, `cacheOn`, `storesOn` → gone or
  options; `mediaFamily` → gone with the media token tables). `JEV_USD_PER_MILLION_INPUT_TOKENS`
  moves into the `typesafe` provider's `prices`.
- **OpenRouter inside `openAi`:** every OpenRouter field and row in the generic Chat Completions
  code moves to the `openRouter` protocol.
- **Duplicates:** local's hand-written Chat Completions loop; `@openrouter/sdk` (we decode a cloned
  raw body and use the SDK only to validate it); the three OpenRouter base-URL defaults; the two
  header builders; the second tape-slot remapping.
- **Local:** the `providers/local` subpath (`createLocalProvider`, `createCompatibleChatProvider`).
- **Bindings:** `providerOptions` (now `options`), `providerOptions.server`.
- **Continuation:** `onMismatch` (a mismatch always rebuilds). `history: 'provider'` stays.
- **Studio:** the second `STUDIO_PROVIDERS`, `PROVIDER_LABEL`, the `held()` factory names.

## 10. Order

1. Kernel contract: `defineProtocol`, `extendProtocol`, `defineProvider`, `authorize`, `send` / `connect`,
   `checkBinding`, the fallback and retries in the runtime, `protocol` and `options` on bindings.
2. Protocols: `openAi` first (one loop, from the two), then `openRouter` extended from it, then
   `geminiInteractions`, `geminiLive`, `openRouterImages`, `systemOne`.
3. Providers: `gemini`, `openrouter`, `typesafe`, `local`, as data.
4. Delete section 9, and update `docs/contracts/providers.md`, README, and the catalog.
5. Studio: read names, descriptions, endpoints, and option rows from what's registered, and fix
   C17 / C21 / C22.

Coordinate with the host/live session before editing `src/kernel/mod.ts`, `schema.ts` and
`kernel/types.ts`; it is changing their exports.

## 11. Decisions

Decided on 16 Oct: protocol → provider → model; the protocol owns the path per profile type
(option c); no model-support facts anywhere; `builtInTools` stays on the binding; the provider is
`gemini`, and Vertex will be `vertex`.

Also decided on 16 Oct: a provider is where and who only (location, sign-in, headers, key slots,
prices, which protocols it serves). Every difference on the wire is a protocol, extended from a base
where it nearly matches one. This removes the provider's `body`, `decode`, `open`, `callId`,
`options`, `state`, `extras`, and `custom`, and `extendProvider`.

Also decided on 16 Oct: switching provider or model mid-conversation always works; `onMismatch`
goes; `history: 'provider'` stays, and the host carries the conversation across a switch.

Decided on 16 Oct, the two model facts the kernel kept:

1. **Media token counts for compaction are dropped.** Compaction uses the generic estimate for
   images, audio, and video. The upstream usually returns the real count, so a hand-kept table per
   model family isn't worth maintaining. `presets/google/media-tokens.ts`, `MediaTokenFamily`,
   `mediaTokenFamily` and `PROVIDER_FACTS.mediaFamily` go.
2. **Prices are kept where the API returns no cost.** TypeSafe's Jev price stays as it is, moved
   into the `typesafe` provider's `prices`. The `gemini` provider gets a price table
   (`providers/gemini/prices.ts`), updated when Google changes prices. The kernel applies either
   when the reply carries no cost; `decision/usage.ts` stops testing `provider === 'typesafe'`.
   - The table follows Google's price page: input and output per million tokens, the higher rate
     above the long-context threshold, cached input, and audio input where it differs. Thinking
     tokens are billed as output.
   - It records the date it was checked. A trace marks the cost as worked out by Theorem, not
     reported by the API.
   - A model not in the table gets no cost, only tokens. It is never guessed.
   - OpenRouter reports its own cost, so a Gemini model through OpenRouter uses that.
   - This is the one place model facts are kept, by your decision: prices, because the bill matters
     and the API won't say.
