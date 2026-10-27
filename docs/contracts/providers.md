# Providers (`@theoremjs/agents/providers`)

Use this contract when you add a protocol or a provider, or change the boundary between a protocol and the kernel.
A protocol is the code for one API shape. A provider is data: an address, the protocols that it serves, and a sign-in.
A model binding names a protocol, a registered provider, and a model. The kernel applies the profile, validates model events, and executes client tools.

## Export

Use the providers entrypoint for protocols, first-party providers, provider definitions, and vault contracts.

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/providers` / `jsr:@theoremjs/agents/providers` |
| Module | `src/providers/mod.ts` |
| Root | `mod.ts` also exports these names, the default-scope registry functions, and the binding schemas |

## Ownership

Keep the wire in the protocol. Keep the address and the sign-in in the provider. Keep execution authority in the kernel.

| Source | Responsibility |
| --- | --- |
| `src/kernel/protocols/protocol.ts` | `defineProtocol`, `extendProtocol`, protocol events, and operations |
| `src/kernel/protocols/provider.ts` | `defineProvider`, sign-in helpers, and the provider registry |
| `src/kernel/protocols/binding.ts` | Model binding schemas and `checkBinding` |
| `src/kernel/protocols/runtime.ts` | Sending, signing, transient retries, and key fallback for each call |
| `src/kernel/provider-runtime.ts` | Event validation, terminal checks, and checkpoints |
| `src/kernel/provider-live.ts` | Normalized live operations for the session runner |
| `src/providers/open-ai/protocol.ts` | The `openAi` protocol |
| `src/providers/openrouter/` | The `openRouterOpenAi`, `openRouterImages`, and `openRouterDecisions` protocols, and `openRouterProvider` |
| `src/providers/openrouter/openai/reasoning-state.ts` | Native reasoning details for replay |
| `src/providers/gemini/` | The `geminiInteractions` and `geminiLive` protocols, and `geminiProvider` |
| `src/providers/google/interactions/` | Gemini Interactions request and event translation |
| `src/providers/google/live/` | Gemini Live frame and event translation |
| `src/providers/system-one/protocol.ts` | The `systemOne` decision protocol |
| `src/providers/typesafe/provider.ts` | `typesafeProvider` |
| `src/providers/local/provider.ts` | `localProvider` |
| `src/providers/shared/` | Server-sent events (SSE), retries, tool arguments, tool drafts, and tracing utilities |

## Package boundary

Register providers and protocols on the host. Store only model-binding data in profiles.
Loading profile JSON does not import a protocol or resolve credentials.

| Action | Owner |
| --- | --- |
| Write requests and read replies | Protocol |
| Address, headers, and sign-in | Provider |
| Send, sign, retry, and move to the fallback key | Kernel |
| Validate bindings and model events | Kernel |
| Apply guardrails, approvals, and execution limits | Kernel |
| Execute client tools | Kernel |
| Execute hosted provider tools | Upstream provider |
| Supply credentials and trace storage | Host |

Defining or registering a provider does not open HTTP or WebSocket transport.
First-party providers do not read environment variables for credentials or endpoints.
The host supplies a vault. It can also supply fetch, waits, and a WebSocket opener.
A protocol never holds a key, a key slot, or a base URL.
A protocol that extends another has its own id, as `openRouterOpenAi` extends `openAi`. A binding names the protocol its provider serves.

## Registered providers

Register providers before profiles. Use the registered provider's model helper to check options and produce ordinary binding data.

| Provider | Serves |
| --- | --- |
| `openRouterProvider` (`openrouter`) | `openRouterOpenAi` (text, speech), `openRouterImages` (image), `openRouterDecisions` (decision) |
| `geminiProvider` (`gemini`) | `geminiInteractions` (text, image, speech), `geminiLive` (live) |
| Planned local embedding adapter | Embeddings through a host-supplied local runtime |
| `localProvider` (`local`) | `openAi` (text, speech), `ollamaEmbeddings` (embedding) |
| `typesafeProvider` (`typesafe`) | `systemOne` (decision) |
| A provider from `defineProvider` | The protocols that its `serves` function returns |

Every provider types a failed answer by its HTTP status (`kindOfHttpStatus`), unless its protocol's `error` reads a stated kind.

```ts
import { createKernelScope, defineProfile, openRouterProvider } from '@theoremjs/agents';

const scope = createKernelScope();
const router = scope.providers.register(openRouterProvider, {
  id: 'company-router',
  connection: { baseUrl: 'https://openrouter.ai/api/v1' },
  keySlot: 'company',
});
scope.profiles.register(defineProfile({
  id: 'analyst',
  type: 'text',
  identity: { handle: 'Analyst' },
  tools: { allow: [] },
  inputs: { text: true },
  models: { default: router.model('openRouterOpenAi', 'model-id', {
    maxOutputTokens: 4096,
    options: { cache: { mode: 'automatic' } },
  }) },
}));
```

`defineProvider` checks the ID, name, description, and `serves`, and freezes the definition.
A provider ID uses lowercase letters, digits, and `-`, and starts with a letter.
Its `connection` and `key` are zod schemas. `authorize` signs each request: `bearer()`, `header(name)`, or `query(name)`.
Each `Serve` names a protocol and a base URL. It can add headers, a different sign-in, or a `url` function.
`prices` fill in cost when a reply carries none.

Registration takes an optional `id`, `connection`, `keySlot`, and `fallbackKeySlot`. It parses the connection and calls `serves` once.
It refuses an ID that is already registered, a connection that does not parse, and a fallback slot equal to the primary slot.
It also refuses a slot on a provider without a key, and a protocol ID that a different protocol already holds.
The registered provider's `.model()` and `.decisionModel()` helpers check options against the protocol's schema.
Profile registration checks each binding again with `checkBinding`.

`ProviderRegistry` supplies `register`, `replace`, `get`, `require`, `list`, and `protocols`.
`register` refuses an existing ID. `replace` registers in place of the provider with the same ID.
Each kernel scope has its own registry. Called agents and compactors resolve their own bindings.
Replacing a registration affects later runs.

The default scope supplies `registerProvider`, `getProvider`, `listProviders`, and `listProtocols`.
`runTurn`, `runSession`, `runDecision`, and `compactHistory` receive host options, including the vault.
They resolve the provider from each model binding. An unknown provider fails at profile registration, before model transport opens.

## Model bindings

Use a binding to select a protocol, a registered provider, and an upstream model or deployment.

| Field | Contract |
| --- | --- |
| `protocol` | Nonempty ID of a protocol that the provider serves |
| `provider` | Nonempty registered provider ID |
| `apiId` | Nonempty upstream model or deployment ID |
| Shared settings | Output tokens, temperature, effort aliases, and selection, summaries, builtins, and compaction |
| `keySlot`, `fallbackKeySlot` | Optional overrides of the registration's credential slots |
| `options` | JSON object, parsed by the protocol's options schema; defaults to an empty object |
| `limits` | Optional points at which Theorem stops the model's calls (see [Operating budgets](#operating-budgets)). Each one left out is no limit |
| Decision timeout | Decision bindings add `timeoutMs` |

`modelBindingSchema` is strict. It checks shared data. The protocol's options schema checks `options`.
Cache, storage, and interaction persistence belong in protocol options. Server addresses belong in the registration's connection.
Registrations supply credential defaults. Profiles do not contain credential values or resolver functions.

`checkBinding` refuses a protocol that the provider does not serve, and a protocol with no endpoint for the profile type.
It also refuses options that do not parse, equal primary and fallback slots, and a slot on a provider without a key.
A live binding fails when its sign-in needs WebSocket headers and the runtime cannot send them.
A busy upstream model (503 or 529) fails a binding's call as `busy`. The kernel moves it to the fallback slot, and the profile's `autoContinue` decides whether it is sent again.

## Protocol contract

Use `extendProtocol` when an API nearly matches a protocol. Use `defineProtocol` when the API shape is new.
Reuse a protocol when the endpoint speaks it. An endpoint address alone does not establish compatibility.

| Member | Contract |
| --- | --- |
| `id` | Stable ID that bindings write; letters and digits, starting with a letter |
| `name`, `description` | Text for the studio and docs |
| `endpoints` | The path for each profile type. A type with no entry is not served |
| `options` | Zod schema for binding options |
| `continuation` | Optional version, state schema, and the options that change what saved state means |
| `reasoning`, `custom` | Optional schemas for the reasoning data and custom content that it emits |
| `framing` | Optional reader of the reply framing. Absent: SSE for a stream, one JSON row otherwise |
| `error` | Optional typing of a failed answer. Absent: the kind follows the HTTP status (`kindOfHttpStatus`) |
| `embeddingLimits` | Optional: what a named embedding model takes, per input and per request |
| `refusedOptions` | Optional: the options a named model refuses, though the protocol takes them for others. Absent: none |
| `create` | Returns the operations for one call |

`extendProtocol(base, extension)` gives the extension its own ID. Its options are the base's plus its own. It refuses a repeated field.
Its `body` adds to each request. Its `read` sees each reply row before the base. Endpoints, framing, and error typing default to the base's.
`carriesTo` reports whether reasoning that one protocol wrote may go back to another protocol in its lineage.
`modelOptions(protocol, apiId, options)` parses a model's options by the protocol's schema, less any option that model refuses, and throws a `config` error naming what does not fit. A binding is checked with it when it is registered, and a protocol may call it in its own operations.

`ProtocolContext` supplies the profile type, model ID, parsed options, built-in tool IDs, merged limits, and abort signal.
`send` posts to the endpoint of the profile type and yields reply rows. `connect` opens the WebSocket and sends the first frame.
`tapUpstream` records a row for tracing. The context never holds a key, a key slot, or a base URL.

Implement only the operations that the protocol provides.

| Operation | Input | Output |
| --- | --- | --- |
| `complete` | `ProtocolRequest` | Async stream of `ProtocolEvent` |
| `openSession` | `ProtocolRequest` | `ProtocolSession` |
| `decide` | `DecisionCall` | Validated native decision result |
| `embed` (planned) | `EmbeddingCall` | Ordered, validated embedding vectors |

The kernel rejects a missing required operation. Requests contain normalized history, content, tools, and generation settings.
The protocol converts these values to its upstream format.

### Embedding protocols

An embedding protocol is a provider wire contract for runEmbedding. It is
separate from a chat protocol even when both protocols use the same provider,
base URL, and credentials.

The protocol operation shape is:

```ts
{
  complete?(request: ProtocolRequest): AsyncIterable<ProtocolEvent>;
  openSession?(request: ProtocolRequest): Promise<ProtocolSession>;
  decide?(request: DecisionCall): Promise<DecisionResult>;
  embed?(request: EmbeddingCall): Promise<EmbeddingResult>;
}
```

`EmbeddingCall` contains the normalized ordered inputs, the request's `task`,
the selected upstream model id, provider options, and the abort signal. The protocol context supplies
the provider transport, signing, limits, and upstream tap. The embedding
operation does not use turn events or session checkpoints.

The kernel owns the public embedding profile and result contract. The protocol
owns:

- Provider request encoding.
- Media conversion and MIME rules beyond the profile declaration.
- Provider option validation.
- Provider batch selection.
- Response decoding.
- Provider error conversion.
- Provider usage and cost extraction.

The protocol does not require HTTP or text input. A local protocol can call a
host-supplied model runtime instead of using `send`.

Local execution remains a provider operation. The kernel does not load model
files, select an inference library, allocate device memory, or inspect a local
model's tensor contract. The host registers the runtime with the provider. The
model binding names the runtime model through `apiId` and provider options.

The local runtime boundary accepts normalized embedding inputs and returns the
same ordered vector result as a remote protocol. It can decode images, audio,
video, documents, or other MIME-typed media into native model input. The kernel
validates only the declared input parts, limits, and result vectors.

The provider registry must expose an embedding protocol separately from the
provider's chat protocol. A provider can serve both protocols through the same
registered connection:

```ts
return [
  { protocol: openRouterOpenAi, baseUrl, headers },
  { protocol: openRouterEmbeddings, baseUrl, headers },
]
```

The embedding protocol uses the `embedding` profile type as its endpoint
claim. A chat protocol must not claim that endpoint by adding embedding-only
options to its chat schema. Chat options describe messages, tools, generation,
and chat response decoding. Embedding options describe vector input and output.

The first provider protocols are implemented:

| Protocol | Upstream operation | Protocol-owned options |
| --- | --- | --- |
| Google embedding | `models/*:embedContent` and the synchronous batch operation | Task type, output dimensions, truncation, OCR, and audio extraction |
| OpenRouter embedding | `/api/v1/embeddings` | Encoding format and model-specific multimodal input |
| Ollama embedding | `/api/embed` | Truncation and output dimensions |

The Google embedding protocol declares model-specific support for text, image, audio, video,
and document input. It also declares supported task types and dimensions.
The direct API currently lists `gemini-embedding-2`, its preview model, and
`gemini-embedding-001`. The first implementation targets
`gemini-embedding-2`; it must not invent a Gemma embedding model ID.
The kernel treats these declarations as provider facts, not product policy.

The Google protocol sends a request's `task` the way each model takes it.
`gemini-embedding-001` gets `RETRIEVAL_QUERY` or `RETRIEVAL_DOCUMENT` as its
`taskType`, in place of the binding's default. Gemini Embedding 2 refuses
`taskType`, so the protocol writes the task into an input that is all text,
with Google's formats `task: search result | query: …` and
`title: none | text: …`. An input with media is sent as it is, as Google
advises. A binding that sets `taskType` on Gemini Embedding 2 fails with a
`config` error. The OpenRouter and Ollama protocols send no task.

The OpenRouter embedding protocol declares text and image content support for the selected
embedding model. On 2026-10-16, the embedding model catalog listed
`liquid/lfm-2.5-embedding-350m:free`,
`nvidia/nemotron-3-embed-1b:free`, and
`nvidia/llama-nemotron-embed-vl-1b-v2:free`. The protocol sends a string as it
is and each input with parts as one `{ content }` item of text and
`image_url` blocks, as OpenRouter documents.

Each protocol declares its models' limits, from the provider's documentation
and checked live on 2026-10-19:

| Protocol | Media one input may hold | Inputs per request |
| --- | --- | --- |
| Google, Gemini Embedding 2 | PNG and JPEG, at most 6; one PDF; MP3 and WAV; MP4 and MOV | 100 |
| Google, `gemini-embedding-001` | None | 100 |
| OpenRouter | Images, no count | No cap |
| Ollama | None | No cap |

Google caps audio and video by length (180 and 120 seconds) and a PDF at 6
pages, not by count; the kernel does not measure these, so Google truncates or
refuses. OpenRouter sends images only. A text-only OpenRouter model refuses an
image itself, since the protocol cannot tell its models apart. The OpenRouter
VL model took 13 images in one input, and timed out at 30.

#### Embedding trace, guardrail, and evaluation contract

runEmbedding writes one root trace for one public call. Each provider
request is a child model-call span. The trace records the profile, selected
model, provider, input count, input modalities, vector dimensions, usage, cost,
and terminal error. It does not record vector values by default.

The trace must apply the profile's scrub policy to input text and media
metadata. An observability option may include outbound wire data only under
the same explicit policy used by other provider calls. Credentials never enter
the trace.

Embedding guardrails apply before provider transport:

- Input and MIME limits reject oversized or disallowed content.
- Sensitive-data and injection detectors inspect text when the profile enables them.
- Network policy controls media-reference resolution.
- Quota policy counts the embedding operation and its provider attempts.

The provider must not manufacture guardrail verdicts. The kernel records
guardrail decisions beside the embedding trace and returns the profile's
sanitized error wording.

Embedding evaluation needs separate fixtures from turn evaluation. A fixture
must compare vector shape and provider behavior, not generated text. The
initial checks are:

| Check | Required assertion |
| --- | --- |
| Shape | Each vector has finite values and the declared dimension |
| Order | Sentinel inputs return vectors in input order |
| Similarity | Related and unrelated fixture pairs preserve the expected ranking |
| Modality | Accepted media reaches the provider in the declared encoding |
| Options | Task type and output dimensions reach the provider exactly |
| Failure | Auth, rate limit, unsupported media, malformed output, and abort errors normalize correctly |
| Privacy | Trace output excludes vector values, credentials, and scrubbed input |

Real provider smoke tests are required for capability claims. Offline fixtures
prove serialization, normalization, and failure handling only.

## Event authority and termination

Report model output and tool requests through `ProtocolEvent`. Do not report kernel decisions as model output.

`ProtocolContentEvent` permits text, thoughts, tool drafts, structured output, media, citations, grounding, evidence, usage, session notifications, and errors.
Other protocol events carry tool calls, cancellations, response identity, reasoning, custom content, raw rows, or terminal `done` status.
The kernel rejects any other event type, and a `done` event with a `gate` stop.
Stages, guardrail verdicts, approvals, and client-tool results come only from the kernel.

Tool calls need nonempty IDs and names, with JSON-object arguments. A repeated settled call cannot authorize another execution.
The kernel gives each call a Theorem ID and keeps the upstream ID beside it. A tool result goes back to the wire under the upstream ID.

Send a `tool_draft` for each piece of a tool call's arguments as the model streams them, so the host can show the call while the model writes it.
A draft is a preview and never runs. The `tool` event with the same `callId` is the call.
Use `toolDraftEvents` from `src/providers/shared/tool-draft.ts` to send nothing until the call has an ID and a name, then each new piece once.
A buffered reply sends no drafts. The `geminiInteractions`, `geminiLive`, and `openAi` protocols send drafts. `openRouterOpenAi` extends `openAi`.
Always send them: the kernel decides whether the host sees them.
The kernel holds pending client calls until it validates model-step termination.

| Boundary | Condition for release |
| --- | --- |
| Turn | Successful terminal event, then stream exhaustion with no subsequent event |
| Live session | Successful model-step terminal; a generation notification alone is insufficient |

A missing terminal, malformed event, error, or interruption prevents pending calls from executing.
EOF alone is not successful completion. Cancellation does not silently replay a request.

`ProtocolSession` sends text, audio, video, context, and approved tool results. It also closes the session.
Its optional `closeInfo` reports the close code, diagnostic reason, and preceding close warning.
The live kernel applies its labels and tracing policy to these values.

## TypeSafe

Use `typesafeProvider` for TypeSafe's Jev models. It signs each request with a bearer key and serves `systemOne`.
Jev 1.14 is `jev-1.14.0`, and `jev-preview` is its alias. `jev-latest` is the alias for the stable release, and TypeSafe moves it.
Pin the versioned id when a decision must not change under you.

`systemOne` takes two binding options. Both send one of TypeSafe's "danger zone" headers, which TypeSafe calls experimental. Leave an option out to keep the default.

| Option | Header it sends | Effect |
| --- | --- | --- |
| `images` | `TypeSafe-Danger-Zone-Images: true` | The decision may hold images (`DecisionRequest.assets`) and `box` questions |
| `longContext` | `TypeSafe-Danger-Zone-Long-Context: true` | The context window grows from 64k to 262k tokens, with less speed and accuracy |

`systemOne` sends each image in the `assets` map as `data_base64` with its format. It does not send multipart bodies.
TypeSafe reads a reference anywhere in a string, as the whole string or inside it, and puts the image there once for each use.
Without `images`, a request that holds images or a `box` question fails before it leaves the process.
A `box` question also fails on a pinned `jev-1.13.*` id.

## OpenRouter

Use `openRouterProvider` for OpenRouter. It signs each request with a bearer key.
Its connection takes `baseUrl`, `decisionUrl`, `siteUrl`, and `siteName`, and each is optional.
`siteUrl` goes out as `HTTP-Referer` and `siteName` as `X-Title`.

The planned `openRouterEmbeddings` protocol uses the same bearer credential and
connection headers as chat. It sends text or provider-supported multimodal
content to `/api/v1/embeddings` and normalizes each returned `embedding` array
to the kernel vector result.

| Protocol | Endpoint |
| --- | --- |
| `openRouterOpenAi` | Text at `/chat/completions`, speech at `/audio/speech` |
| `openRouterImages` | Image at `/images` |
| `openRouterDecisions` | Decision at `decisionUrl`, by default `https://openrouter.ai/api/alpha/decisions` |

`openRouterOpenAi` extends `openAi`. On text, it asks the router for providers that support every supplied parameter.
It decodes text, reasoning, fragmented tool arguments, structured output, citations, and usage.
It writes reasoning details as `reasoning` parts and sends them back with the history on the next request.
It writes the `webSearch` built-in as `web_search_options`.

`openRouterDecisions` sends the same questions and reads the same answers as `systemOne`, but it takes no options.
OpenRouter needs no opt-in for images or `box` questions, and runs every request with an image in long-context mode.
It ignores an `assets` map, so the protocol puts each image where its reference is, as an `image_url` part with a `data:` URL.
It reads references as TypeSafe does, in `state`, instructions, and criteria: a string that is one reference becomes the image part, and a longer string becomes an array of its text and images in order.
Model ids carry the vendor, such as `typesafe/jev-1.14`.
A model that cannot read an image somewhere, or cannot answer a `box`, refuses with OpenRouter's own error.

Set chat caching in `options.cache`. Native image and speech operations reject client tools, structured output, and chat-only settings.
The kernel controls transient retries and quota fallback for every protocol.

## Google Interactions

Use `geminiProvider` with the `geminiInteractions` protocol for Gemini text, image, and speech.
Its options contain `store` and `persistViaInteractionId`. Its `googleMaps` builtin takes a `location` from the request's `builtInArgs`.
The provider signs each request with the key in the `x-goog-api-key` header. Its connection takes an optional `host`.

The `geminiEmbeddings` protocol uses the same Google API key and host.
It sends text or provider-supported media to the embedding methods and
normalizes the returned values to the kernel vector result.

```ts
const binding = gemini.model('geminiInteractions', 'model-id', {
  options: { store: true, persistViaInteractionId: true },
});
```

`persistViaInteractionId` needs storage: leave `store` unset or set it to `true`.
With persistence enabled, checkpoint data contains the interaction ID.
After checkpoint validation, the protocol sends only history beyond the covered prefix.
After a mismatch, it sends portable history without the native ID.
Gemini speech returns `pcm` audio.
A failed answer keeps Gemini's own error only when it says the key was refused. Otherwise the HTTP status decides its kind, so a 503 or 529 is `busy`.

## Local non-text models

Use a local embedding protocol when a model runs in the host process or through
a local inference service that does not implement the OpenAI embeddings contract.
This includes Gemma embedding deployments and models that accept images, audio,
video, or documents without text.

The local protocol declares capabilities per model. A declaration identifies
accepted modalities, MIME types, batching, output dimensions, normalization,
and required preprocessing. It must not claim text support for a media-only model.

The current Ollama protocol uses HTTP. Native execution does not require a
fake `baseUrl`. A local provider may use an
in-process executor, a worker, a native binding, or a host-managed service.
These implementations share the `embed` operation and normalized result contract.

## Google Live

Use `geminiProvider` with the `geminiLive` protocol for native WebSocket sessions.
The protocol encodes Gemini frames. The kernel sends normalized input and approved tool results through the public session.
Live sends the key in the URL query, so a browser runtime can open the socket.
The session's setup waits for `connectTimeoutMs` when it is set. With no limit, it waits until the socket closes or the call is aborted.

| Data | Treatment |
| --- | --- |
| Native resumption handle | Checkpoint data |
| Portable history | Stored separately from displayed transcript content |
| Compatible checkpoint | Send only history beyond its covered prefix |
| Rebuilt session | Send the complete portable history |

The protocol requests input and output transcriptions for portable audio history.
The kernel records final transcriptions only after the outbound gate releases them.
Portable user text excludes the fences added to upstream input.
The normalized boundary preserves provider close warnings and errors.
A close with 1013 (try again later) is `busy`; 1011 is `unavailable` unless its reason names a quota.

## Local provider

Use `localProvider` for a server that speaks OpenAI Chat Completions, such as Ollama, llama.cpp, vLLM, or LM Studio.
Its connection requires `baseUrl`, up to and including `/v1`. The `openAi` protocol appends `/chat/completions`.
The key is optional. Name a slot only when the server takes a key.
It also serves `ollamaEmbeddings`, which posts text to Ollama's `/api/embed` at the same server, without the `/v1`.

```ts
const local = registerProvider(localProvider, {
  connection: { baseUrl: 'http://localhost:11434/v1' },
});
const binding = local.model('openAi', 'llama3.2');
```

Register `localProvider` again with a different `id` to reach a second server.
For a server that needs a different address scheme or sign-in, define a provider that serves `openAi`.
The protocol assembles fragmented tool IDs, names, and arguments before it releases a call.
A failed answer's kind follows its HTTP status. A 503 or 529 is `busy`.

## Speech roles

Use a speech profile to resolve voice, format, and media settings before the protocol call.

| Protocol | Audio operation |
| --- | --- |
| `openRouterOpenAi`, `openAi` | `/audio/speech` |
| `geminiInteractions` | Interactions output audio |

Protocols preserve native media details and convert supported raw PCM to WAV.

When `/audio/speech` answers with a binary body, default framing copies
`X-Generation-Id` onto the row as `id`. `openAi` speech (and `openRouterOpenAi`
through it) emits `response` from that id, so the call span records
`gen_ai.response.id` the same way chat Completions does from a JSON `id`. The
host never sees the `response` event. A reply with no such header leaves the
attribute unset.

The kernel validates the profile's speech role and input kinds.

## Key vault (provider-neutral)

Supply credentials through host options. Keep credential values and resolver functions outside profiles.

| Vault entry | Resolution |
| --- | --- |
| String | Validate with the provider's `key` schema |
| JSON object | Validate with the provider's `key` schema |
| Resolver function | Call when needed, await its value, then validate it |
| Unfilled slot | Report an authentication failure when a required credential is requested |

`CredentialResolver` receives provider ID, model ID, selected slot, and abort signal.
The host resolver owns caching and refresh. Binding slot overrides take precedence over registration defaults.
Fallback requires an explicitly configured slot. The kernel moves to it once, after a `rate_limit` or `busy` failure before the first event.
It moves only when the vault holds the fallback slot. After an `auth` failure, it drops the cached signer and tries once more.
Vault lookup reads only own properties. An inherited primary entry is missing; an inherited fallback entry is never tried.

Resolver failures and invalid values produce authentication failures without credential values in the diagnostic.
An exception while reading the selected vault property produces the same sanitized resolution failure.
Exceptions during credential parsing or inspection produce a sanitized shape failure, including transformed key values.
The runtime redacts resolved credential strings from upstream rows, protocol errors, and wording parameters.
Upstream row redaction includes JSON property names and nested values.
Tool credentials retain their separate contract.

## Saved provider state

Store native checkpoints beside portable history to resume a conversation or rebuild it after a provider change.
The kernel creates the checkpoint envelope and history hash. The protocol supplies validated native JSON data.

| Checkpoint field | Purpose |
| --- | --- |
| `protocol`, `provider` | Protocol ID and registered provider ID |
| `version`, `apiId` | State format version and upstream model identity |
| `keySlot` | The slot of the key that wrote the state |
| `compatibilityKey` | Hash of the connection and the options the protocol keys its state on |
| `coveredHistoryLength`, `coveredHistoryHash` | Portable history prefix represented by the native state, up to and including the step's own reply (its text, then its tool calls), as the turn's history holds it |
| `data` | Protocol state validated by its continuation schema |
| `wireCallIds` | Optional map from Theorem tool-call IDs to upstream IDs |

Pass `providerState` with history on the next turn or session request.
Successful turn completion returns `providerState`. Live `provider_checkpoint` events contain the checkpoint and covered portable `history`.
Interface helpers retain checkpoints separately from displayed history. A branch discards native state.

Protocol, provider, model, version, connection, key slot, or covered-history changes cause a mismatch.
A change to the binding's `limits` keeps the checkpoint, because limits do not change what the state means.
The kernel rebuilds from portable history and emits `provider_warning` with `provider_state_rebuilt` and the reason.
A key fallback starts without saved state. A request with a checkpoint and no history then fails, because the turn needs the conversation.
Set `providerContinuation.history` to `provider` when the provider's stored conversation is the only history: pass `providerState` alone, and a request that also carries history is a mismatch.
With `'stateless'`, a request that carries history or a checkpoint is refused, and completion returns no checkpoint.
Compatible checkpoints with malformed native data fail validation.
At browser ingress, chat and live must also validate conversation ownership before the kernel receives native state.
The React session boundary provides this check for live relays.
The relay must save checkpoint ownership before it exposes the checkpoint to the browser.
Failed or discarded output does not commit a usable history prefix or authorize pending tools.
A failed call, a busy model's included, leaves the saved state as it was.

## Exported API

The providers barrel exports the protocols, the first-party providers, the definition, and sign-in helpers, and the vault contracts.
The root also exports the default-scope registry functions, the binding schemas, and `checkBinding`, the limits, and `callProtocol`.

| Group | Symbols |
| --- | --- |
| Providers | `defineProvider`, `createProviderRegistry`, `Provider`, `ProviderDefinition`, `Registration`, `RegisteredProvider`, `ProviderRegistry`, `geminiProvider`, `openRouterProvider`, `typesafeProvider`, `localProvider` |
| Sign-in | `bearer`, `header`, `query`, `Authorize`, `Signer`, `Outgoing`, `Serve`, `endpointUrlSchema` |
| Protocols | `defineProtocol`, `extendProtocol`, `carriesTo`, `modelOptions`, `geminiInteractions`, `geminiLive`, `geminiEmbeddings`, `openAi`, `openRouterOpenAi`, `openRouterImages`, `openRouterDecisions`, `openRouterEmbeddings`, `ollamaEmbeddings`, `embeddingModelLimits`, `systemOne`, `Protocol`, `ProtocolDefinition`, `ProtocolExtension`, `ExtensionBodyAt`, `ExtensionReader`, `ModelProfileType` |
| Protocol operations | `ProtocolContext`, `ProtocolOperations`, `ProtocolRequest`, `ProtocolSession`, `ProtocolSocket`, `ProtocolEvent`, `ProtocolContentEvent`, `SendInit`, `UpstreamFailure`, `Continuation`, `DecisionCall`, `EmbeddingCall`, `EmbeddingMediaKind`, `EmbeddingModelLimits`, `LiveToolResult` |
| Model bindings | `ModelBinding`, `DecisionModelBinding` |
| Provider data | `JsonValue`, `JsonObject`, `jsonValueSchema`, `jsonObjectSchema`, `PriceTable`, `ModelPrice`, `Rates` |
| Provider vault | `ProviderHostOptions`, `KeyVault`, `KeyCredential`, `CredentialContext`, `CredentialResolver`, `OpenWebSocket` |
| Provider output | `ProviderCheckpoint`, `ProviderWarning`, `ProviderContinuationPolicy` |
| Provider limits | `ProviderLimits` |
| Root only | `registerProvider`, `getProvider`, `listProviders`, `listProtocols`, `modelBindingSchema`, `decisionModelBindingSchema`, `commonModelSettingsSchema`, `keySlotSchema`, `checkBinding`, `keySlotsOf`, `RuntimeAbilities`, `providerLimitsSchema`, `providerCheckpointSchema`, `providerWarningSchema`, `providerContinuationSchema`, `ProviderStateRebuilt`, `callProtocol`, `ProtocolCall`, `CallSetup`, `plainWebSocket` |

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/mod.ts"
        },
        {
          "kind": "config",
          "path": "package.json"
        }
      ]
    },
    "Ownership": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/mod.ts"
        },
        {
          "kind": "graph",
          "path": "docs/_map.mjs"
        }
      ]
    },
    "Package boundary": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/protocols/provider.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/providers.test.ts"
        }
      ]
    },
    "Registered providers": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/protocols/provider.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/create-provider.test.ts"
        }
      ]
    },
    "Model bindings": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/protocols/binding.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/kernel/protocols/protocols.test.ts"
        }
      ]
    },
    "Protocol contract": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/protocols/protocol.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/kernel/protocols/protocols.test.ts"
        }
      ]
    },
    "Event authority and termination": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/provider-runtime.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/kernel/protocols/protocols.test.ts"
        }
      ]
    },
    "OpenRouter": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/openrouter/protocol.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/openrouter/protocol.test.ts"
        }
      ]
    },
    "Google Interactions": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/gemini/interactions-protocol.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/gemini/interactions-protocol.test.ts"
        }
      ]
    },
    "Google Live": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/gemini/live-protocol.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/gemini/live-protocol.test.ts"
        }
      ]
    },
    "Local provider": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/local/provider.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/open-ai/protocol.test.ts"
        }
      ]
    },
    "Speech roles": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/open-ai/protocol.ts"
        },
        {
          "kind": "source",
          "path": "src/kernel/protocols/runtime.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/open-ai/protocol.test.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/openrouter/protocol.test.ts"
        }
      ]
    },
    "Key vault (provider-neutral)": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/protocols/runtime.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/registered-openrouter.test.ts"
        }
      ]
    },
    "Saved provider state": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/provider-runtime.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/kernel/protocols/checkpoints.test.ts"
        }
      ]
    },
    "Exported API": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/mod.ts"
        },
        {
          "kind": "source",
          "path": "mod.ts"
        }
      ]
    }
  }
}
```

## Operating budgets

Set limits when a model call must stop at a point that you choose, not at the provider's own limit.
Theorem sets no limit of its own. Each limit that is left out is no limit, so the provider's own limits apply.

A model in a profile sets its limits in `models.*.limits`. The host options of `runTurn`, `runSession`, `runDecision` and `runEmbedding` take `limits` too (`ProviderHostOptions.limits`). Each field that the host sets overrides the model's.
Each limit is a positive safe integer. A timer must also fit the runtime timer range. `providerLimitsSchema` checks the merged result.
The protocol receives the merged limits through `ProtocolContext.limits`.

| Field | What it stops |
| --- | --- |
| `operationTimeoutMs` | One call, with its retries and its credential resolution |
| `connectTimeoutMs` | The opening of a live session |
| `liveStepTimeoutMs` | A live session that waits for the model to answer |
| `maxWireRecordBytes` | One SSE record or one WebSocket message |
| `maxWireResponseBytes` | The decompressed bytes of one HTTP response, and of all the attempts of one step |
| `maxEventBytes` | One normalized event |
| `maxStepBytes` | All the normalized events of one step |
| `maxStepEvents` | The number of normalized events in one step |
| `maxPendingToolCalls` | The tool calls of one step that have no result yet |

Retries keep the original deadline and byte counts.
Theorem sends a request again when it fails with a network error or a 408, 429, 500, 502, 503, 504 or 529 status, while the waits between tries stay within five seconds in all, and at most four times.
A network error is any send that got no response and was not aborted or timed out. Its message is never read.
Each wait is the response's `Retry-After` when it gives one. Otherwise it is 1, 2, 4, then 8 seconds. A wait that would pass the five seconds is not taken, and the last answer goes back as it came.
A timeout or an abort is not retried. A 429 moves to the fallback key slot only after the last try.
Injected fetch counts decompressed bytes before forwarding each chunk. SSE records include incomplete records and comments.
Injected WebSocket transport checks message bytes before protocol JSON parsing.
Normalized accounting includes media, structured output, tool arguments, and native state. It measures UTF-8 JSON bytes.
Decision outputs use the same normalized byte limit. Compaction uses the bounded complete operation.
Live response budgets reset at validated terminal events. User-input idle time has no active response timer.
Exhaustion cancels transport, discards unreleased tool requests, and prevents checkpoint commitment.
Protocols must use `send` and `connect` from their context, and its signal. Theorem cannot interrupt protocol code that bypasses them.
