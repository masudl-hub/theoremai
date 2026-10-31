# Kernel (`@theoremjs/agents/kernel`)

Type-first contracts for profiles, turns, tools, compaction, stop/resume, and
`runTurn`. Import here when a host needs the kernel surface without pulling
first-party protocols or providers.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/kernel` / `jsr:@theoremjs/agents/kernel` |
| Module | `src/kernel/mod.ts` |
| Schema subpath | `@theoremjs/agents/schema` → `src/kernel/schema.ts` |
| Interface subpath | `@theoremjs/agents/interface` → `src/interface/mod.ts` ([Headless interface](#headless-interface)) |
| Also on | Root `@theoremjs/agents` / `mod.ts` re-exports the same interface helpers and many kernel exports |

## Ownership

| Scope | Path |
| --- | --- |
| Tree | `src/kernel/` (engine, registry, `stop.ts`, `types.ts`) |

## Facts and policy

**Rule: "Host decides, Theorem runs."** Two hosts shipping contradictory
products can run the same unforked kernel version; no end user and no model
may observe a decision the host did not make.

**Facts vs policy.** Provider wire shapes and protocol metadata may ship in `@theoremjs/agents/providers`. Product policy may not (prompts, personas,
end-user copy, demo apps, channel behavior). The kernel may ship overridable
defaults for mechanism text via the guardrails labels; it may not ship
unreplaceable copy or bundled product. Demo fixtures and cookbooks live in the repo-private
`studio/` package (`@theoremjs/studio`), never in the published artifact.
Package verification checks both agents and React output for Studio modules.
The React build type-checks the local Studio prototype, then removes it from the emitted package.

| Id | Property |
| --- | --- |
| P1 | No ambient authority — `defineProfile` / `defineProvider` succeed with every Deno permission denied (no env, net, read, write, run, ffi, sys). Deno loads the static module graph without consulting the permission system; construction must not exercise ambient I/O beyond that (`tests/kernel/zero-permission-import.test.ts`) |
| P2 | No unownable words — every user- or model-visible string is host-supplied or an overridable registered labels default |
| P3 | No buried policy — behavioral defaults are declared typed profile-schema fields, never only implementation constants |
| P4 | Inert extras — deleting optional packages (studio) changes no kernel behavior |

Continue-instruction text is the labels' `continue.instruction`, overridable
per profile (`labels`) or process-wide (`overrideLabels`). Only text profiles
send it (`CONTINUE_INSTRUCTION_TYPES` in `src/kernel/stop.ts`, which the
studio also reads); image and speech continue by re-sending the host's
request unchanged. Composer labels in `src/interface/` are semantic
keys only; English lives in `@theoremjs/react`.

Wire shapes are facts, declared once: every turn event is a zod schema in
`src/kernel/turn-events.ts`, and its TypeScript type is that schema's inferred
type. Policy modules such as `stop.ts` import those types; they never restate them.

A `filtered` stop comes from the provider's filter or from a Theorem guardrail.
`isGuardrailStop` in `src/kernel/stop.ts` tells them apart by `native`, so the
interface never words Theorem's own stop as the provider's.

## Profiles

A `Profile` is the contract defining an agent’s capabilities and the rules for its interactions. Its type determines which settings it accepts.

Hosts declare agents with `defineProfile` / `registerProfile` (or
`registerProfiles`). `getProfile` / `hasProfile` / `listProfiles` / `clearProfiles`
manage the default scope's profile registry; `scope.profiles` is another scope's.
Registration validates a profile's tool allow list against the same scope's
`tools`, and resolution reads tools and schemas from that scope only.

A `Profile` binds:

| Block | Role |
| --- | --- |
| `type` | Wire archetype discriminator: `'text'`, `'image'`, `'speech'`, `'live'`, `'host'`, `'decision'`, or `'embedding'` (`PROFILE_TYPES`) |
| `identity` | `handle`, optional `conditions`, `system`, and `systemByRole` — absent on `host`; `handle` only on `speech` and `decision`. `system` is a string or a list of lines. See [Prompt lines](#prompt-lines). |
| `models` | Host-named `ModelBinding`s (each carries a `protocol`, a registered `provider` ID, and `apiId`), `defaultModel` (registration always sets it: the declared one, else the only key), optional `allowModelSelect` / `maxSteps` — absent on `host`; `decision` binds exactly one model and never selects |
| `tools` | Allowlist ceiling (`allow: ToolId[]`) — present on `text`, `image`, `live`, `host`; absent on `speech` and `decision`. Tier loading (`t1Policy`, `t2Loader`) is declared only on `text` and `image`; `parallel` on every type that takes `tools` |
| `inputs` | Text / attachments / voice / slots / context / per-mime limits — present on `text`, `image`; `live` takes `slots` and `context` only, and may leave `inputs` out (its channels are `live.ingress`); absent on `speech`; `decision` carries its own `DecisionInputsSpec`, not turn inputs. Each `inputs.slots` entry is a value list or `{ label?, choices: { value, description? }[] }` (normalized at define); optional `label` / `description` are UI-only. `{name}` in `identity.system` becomes the chosen **value** for slot `name`; a prompt that uses a slot the request left unfilled is a `request` error; a `{name}` that is no slot stays as written |
| `image` / `speech` / `live` | Modality-specific pins (top-level, not nested under `outputs`) |
| `outputs` | Structured, streaming, validation — present on `text`, `image`, `speech`; absent on `live` |
| `turnBehaviour` | `resumption` (`allowContinue`, `autoContinue`, `maxContinues`) on `text` / `image` / `speech`; `atStepLimit` on **text**; `allowSteering` on **text and live** (inject gate via `profileAllowsInject`; an inject's `released` drops the draft the user never got, and a bad one warns `inject_released_invalid`; see [`stages.md`](stages.md)). Live must omit `turnBehaviour.resumption` (use `live.sessionResumption`) |
| `guardrails` | Quota, detect, blockedReply, network, taint — on `host` narrowed to `HostGuardrailsSpec` (`detect`, `network`); on `decision`, only pre-dispatch `disclosure` is active. A guarded `live` profile (a detector above `ignore` at `live_reply`) always requests its output transcript: `resolveTurn` sets `live.transcription.output` |
| `observability` | Trace destination, scrub, include, sampling (`writeTo`, `sampleRate`, …) |

Closed unions (`thinking`, stop kinds, turn stages,
MIME maps, …) live as `as const` arrays in `src/kernel/schema.ts`. Types are
derived from those arrays. `TURN_STAGES` / `TOOL_GATE_KINDS` /
`AWAITING_USER_INPUT_*` are foundation for the stages cutover
([`stages.md`](stages.md)); text `runTurn` mid-turn inject uses `TURN_STAGES` /
`onStage`. `TOOL_RESUME_CAUSES` names why a refused gate settles: `declined`,
`abandoned`, or `expired` (the host let a sign-in link run out). `EXTRA_FIELDS`
documents tool fields such as `auth.service`, the service a person signs in to. `REQUEST_FIELDS` documents every field of a `runTurn` request, and `API_EXPORTS` documents the exports a builder calls by name. `PROFILE_FIELDS` / `fieldMeta` document every authoring
path so host UIs and docs hover the live kernel types instead of copying them.
Which profile types may set each path is owned by `PROFILE_FIELD_SCOPE`
(`src/kernel/profile-scope.ts`): every field's `FieldMeta` carries its
`profileTypes` and `profileTypesReason`, and `defineProfile` rejects a field set
on any other type with that reason. `PROFILE_GRAPH` projects those sections into
the studio authoring graph (spine / branch / optional), taking each facet's
types from the same scope; the frontend must import it rather than inventing
facet kinds. Drift is gated by `tests/kernel/profile-graph.test.ts` and
`tests/kernel/profile-scope.test.ts`.

### Decision profile

A `decision` profile is a separate, bounded execution path for typed decisions.
Its `models` map binds exactly one model: a decision protocol (`systemOne`, or `openRouterDecisions` on OpenRouter), a registered provider ID, and upstream `apiId`.
Credentials inherit the provider registration's slots unless the model overrides them.
The profile's `decision.contract` is the host's stable id for the decision it
makes. The id names the decision on its trace (`theorem.decision.contract`);
it is not sent to the provider and does not limit which questions a call asks. At call time,
`runDecision` accepts non-null JSON `state` and named `choice`, `noul`, `score`, or
`box` questions, then returns validated typed answers and usage.
`validateDecisionRequest` exposes the same generic request checks for hosts to
call before spending quota. `systemOne` posts to TypeSafe's `/v1/systemone`; `openRouterDecisions`
posts to OpenRouter's `/api/alpha/decisions`. Bindings may set
`timeoutMs`; omission uses the operation limit (`ProviderLimits`).
A binding has no retry field. The kernel retries a transient failure within its five-second wait budget.
After a `rate_limit` or `busy`, it tries the fallback slot once. The kernel does not check that the
model can answer a question type: the protocol or the provider refuses one it cannot.
Provider-reported cost is used when available. OpenRouter reports one.
Otherwise the provider's prices give an estimated cost.
`typesafeProvider` prices `jev-*` models at $0.042 per million input tokens with output free.
It has no prompt, conversation history, attachments, tools, streaming, or
turn loop; its key comes only from the host's `vault` (`RunDecisionOptions.vault`)
through that slot, and an empty slot throws
`DecisionError('authentication', "The vault has no credential in slot '<slot>'")`.

A `box` question has `instructions` and no criteria. Its answer is `box` with the edges `top`,
`bottom`, `left`, and `right`, plus `confidence`. Each edge is a share of the image from its
top-left corner, from 0 to 1. The kernel rejects an answer whose `left` is not below `right`, or
whose `top` is not below `bottom`.
A `box` question may set `image`: a reference in `assets`, or the state field that holds one,
such as `photo.front`. A reference in `assets` wins over a field of the same name. The kernel
refuses an `image` on any other question type, or one that names no held image. The field never
reaches the provider: the kernel adds the `decision.box_image` label, "Give the box in <ghs02>.",
to the instructions, with a field written in backticks.

A request may carry `assets`: PNG or JPEG images as base64, by reference (`DecisionAsset`).
Write the reference in a string where the image belongs: a value in `state`, a question's
instructions, or one of its criteria. It can be the whole string, such as `{ "photo": "<ghs02>" }`,
or part of one, such as "Which item matches <ghs02>?". The model reads the image in its place.
Keys are never read. The kernel sends only the images that some string references, so choose
references that cannot occur in your text by accident. The kernel checks only the image type and
that the base64 is padded and bare. The provider keeps its own limits on size and count.
`systemOne` refuses a request that sends images or has a `box` question unless the binding sets
`options.images`, and it refuses a `box` question on `jev-1.13.*`. `openRouterDecisions` takes no
options.

`decision.guardrails.disclosure` is a host hook immediately before the request
leaves the process. It may return `allow` or `block`; a block prevents dispatch.
The hook receives the request's `assets` in its context, because the images leave the process too.
The registry refuses every other guardrail field (`quota`, `detect`, `blockedReply`,
`network`, `taint`) on a decision profile: the decision path runs no turn guardrails, and the
kernel does not scan the state. Decision profiles are served by `createTheoremDecisionHandler`,
`DecisionTransport`, `useTheoremDecision`, and `TheoremDecision` in `@theoremjs/react`.

Every decision writes one trace record through the profile's observability
policy, or through `RunDecisionOptions.sink` when the host passes one: a
`<operation> <apiId>` CLIENT root span (under `DecisionRequest.traceparent` when
given, stamped with `DecisionRequest.metadata`) carrying the
protocol's `gen_ai.operation.name` (`decide` for the first-party decision protocols), `gen_ai.provider.name` from the model binding,
`gen_ai.agent.name` (the profile), the requested and answering model, token
usage and its cost (`theorem.usage.cost_usd`), `theorem.decision.contract`, and the state, questions, and answers as
stored JSON content under the profile's scrub policy. The trace holds the type and size of each
image (`theorem.decision.assets`) and never the image. Invalid local requests are rejected before creating a trace. A failed dispatched decision ends
the span `ERROR` with `error.type` its error kind. As with turns, a failed
trace write never fails the decision.

### Embedding profile

An `embedding` profile is a first-class model profile with a separate
runEmbedding execution door. It does not enter `runTurn`, `runSession`, or
`runDecision`. The profile selects one or more embedding model bindings in the
same way as other selectable model profiles.

The profile has these fields:

| Field | Contract |
| --- | --- |
| `type` | `'embedding'` |
| `identity.handle` | The host-owned profile name |
| `models` | One or more model bindings; registration fills `defaultModel` |
| `allowModelSelect` | Allows the request to select a named embedding model |
| `inputs` | Text and media kinds, accepted MIME patterns, and byte/file limits |
| `guardrails` | Takes no field today: each `guardrails.*` field is scoped to other profile types, and `defineProfile` refuses it with a `config` error. The trace record is scrubbed with the default detectors |
| `observability` | Trace destination, sampling, scrubbing, and usage inclusion |
| `labels` | Host-owned wording for errors and other exposed text |

An embedding profile has no `tools`, `outputs`, `turnBehaviour`, `speech`,
`live`, `decision`, `system`, or `providerContinuation` block. It does not have
generation settings such as temperature, output tokens, reasoning effort, or
compaction.

The input declaration is provider-neutral:

```ts
{
  type: 'embedding',
  id: 'documents',
  identity: { handle: 'Document embeddings' },
  inputs: {
    text: true,
    attachments: { accept: ['image/*', 'application/pdf'] },
    maxFiles: 6,
    maxBytes: 20_000_000,
    maxTurnBytes: 20_000_000,
  },
  models: {
    default: {
      protocol: 'geminiEmbeddings',
      provider: 'gemini',
      apiId: 'gemini-embedding-2',
      options: { outputDimensionality: 768 },
    },
  },
}
```

The public request accepts one input or an ordered list of inputs. An input is
text, media, or a list of text and media parts. Media is MIME-typed data or a
provider-readable reference. It can represent an image, audio, video, document,
or another provider-supported non-text input. The kernel does not require text
when the selected model accepts only media.

The kernel validates structure, MIME patterns, byte limits, and input order.
The selected protocol encodes the parts for its provider or local runtime.

Each embedding protocol declares, through `embeddingLimits(apiId)`, what a
model takes: the MIME types of its media, how many of each kind one input may
hold, and how many inputs one request may carry. The kernel holds a request to
the profile and the model together. A file must be in both accept lists.
`maxFiles` counts the files in one input, and each kind is also held to the
model's own count. `maxBytes` is per file and `maxTurnBytes` is across the
request. A model with no media takes text only. A protocol that declares no
limits leaves the profile's alone. `embeddingRules` and `embeddingMediaIssues`
are the one check, which the kernel throws on and a client runs before it
sends.

runEmbedding resolves the profile, selects the model binding, validates the
input, and calls the protocol's embedding operation. The operation returns
ordered vectors with their dimensions. The kernel rejects non-finite values,
missing vectors, and a result whose order does not match the request.

The operation uses a separate request shape, as `runDecision` does. The shared
provider runtime still supplies credentials, key fallback, abort handling,
budgets, retries, upstream taps, and transport. The embedding request does not
carry turn history, tools, system prompts, or continuation state.

The initial multimodal input vocabulary is:

| Part | Meaning |
| --- | --- |
| `text` | Text supplied to the embedding model |
| `media` | Inline base64 data with a MIME type |
| `media-ref` | Provider-readable URI with a MIME type |

A request can say what its inputs are for with `task`: `'query'` for what
someone asks, `'document'` for what is searched. The kernel refuses any other
value and records it on the trace as `theorem.embedding.task`. The protocol
tells the model in the model's own way, and a model that embeds both the same
way ignores it. The kernel does not choose an output dimension. The protocol's options schema validates `outputDimensionality` and `embeddingLimits` declares model media capabilities.

Embedding model bindings must not assume a network endpoint. A binding can name
an in-process model, a worker, a native inference library, or a local service.
The host supplies the local runtime. The kernel does not load model files or
choose a device.

#### Embedding verification still required

The profile, request, protocol operation, and vector validation are implemented.
Trace-specific embedding attributes and native local execution remain planned.
The following facts need provider evidence before they become runtime claims:

| Area | Unverified assumption | Evidence required |
| --- | --- | --- |
| Google | Gemini Embedding 2 accepts text and a text-plus-image request | Direct requests on 2026-10-16 returned vectors |
| Google | Gemini Embedding 2 accepts `outputDimensionality: 768` | Direct request on 2026-10-16 returned a 768-value vector |
| Google | Gemini Embedding 2 supports synchronous batch requests | A two-input request on 2026-10-16 returned two 3072-value vectors |
| Google | Gemini Embedding 2 supports the planned audio, video, and PDF inputs | Real media requests are still required |
| Google | A `gemma-embedding-2` model is available through this API | The 2026-10-16 model list showed no such model; confirm another service or model ID |
| OpenRouter | Free text embeddings are available | `nvidia/nemotron-3-embed-1b:free` returned a 2048-value vector on 2026-10-16 |
| OpenRouter | Free multimodal embeddings are available | `nvidia/llama-nemotron-embed-vl-1b-v2:free` returned a 2048-value vector for text plus image on 2026-10-16 |
| OpenRouter | Free embedding model discovery is available | `/api/v1/embeddings/models` listed three free models on 2026-10-16 |
| OpenRouter | The tested text embedding model accepts the planned batch input | `liquid/lfm-2.5-embedding-350m:free` returned two vectors on 2026-10-16 |
| Local | A Gemma embedding deployment can use the normalized `embed` result | A local runtime fixture must return vectors for its native input shape |
| Local | A local model can accept non-text input without a text placeholder | A model-specific fixture must exercise its image, audio, video, or document input |
| Local | Model loading and device selection belong outside the kernel | A host integration must register an executor without adding filesystem or device logic to the kernel |
| Batching | Both providers preserve input order and expose usable batch limits | Sentinel similarity checks and limit probes are still required |
| Errors | Provider errors map cleanly to existing Theorem error kinds | Malformed, auth, rate-limit, quota, and unsupported-input probes |
| Usage | Embedding token and cost fields are available and stable | Both providers returned usage for the tested text calls; more models need inspection |

The implementation must keep unsupported facts as `unknown` or `unverified`.
It must not infer a model capability from its name alone.

Multimodal ingress uses provider-neutral `InteractionPart` values;
`InteractionMediaPart.type` is `MediaInputKind` (`image` | `audio` | `video` |
`document`). MIME → kind mapping lives in `MEDIA_INPUT_KINDS` (`schema.ts`)
and is applied by `mediaKindForMime` (`catalog.ts`).

`MEDIA_INPUT_KINDS` is the package's complete media-input vocabulary — every
MIME any supported transport can take on a turn, and nothing else. It is the
union of the documented provider input lists: Google Interactions / Live
(images `png`, `jpeg`, `webp`, `heic`, `heif`; audio `wav`, `mp3`, `mpeg`,
`aiff`, `aac`, `ogg`, `flac`, `m4a`, `l16`, `opus`, `alaw`, `mulaw`, `webm`;
video `mp4`, `mpeg`, `mov`, `avi`, `x-flv`, `mpg`, `webm`, `wmv`, `3gpp`;
documents `application/pdf`, `text/plain`, `text/html`, `text/css`,
`text/markdown`/`text/md`, `text/csv`, `text/xml`, `text/rtf`,
`text/javascript`/`application/x-javascript`,
`text/x-python`/`application/x-python`, `application/json`), verified
2026-09-12, plus
provider alias essences (`image/jpg`, `audio/x-wav`, `video/x-ms-wmv`, …). The
The `openAi`, `openRouterOpenAi`, and `openRouterImages` protocols forward a part's MIME verbatim on every `MediaInputKind`,
so their accepted set is open-ended and contributes no additional rows; what
they cannot carry — a `uri` reference part — is refused at request time with
`TheoremError` rather than by a second MIME table (see
`docs/contracts/providers.md`).

A host declares what it accepts only in `inputs.attachments.accept` /
`inputs.voice.accept`. `mediaChannelForMime(profile, mime)` (`catalog.ts`) is the
public answer to "does this profile take this file, and on which `TurnInput`
channel" — hosts filter and route channel ingress with it and keep no MIME table
of their own.

One check decides whether a turn's files are accepted: `attachmentIssues(rules,
files, clips)` (`attachments.ts`). It returns every reason at once — channel not
accepted, MIME not accepted, too many files, a file over its byte cap, the turn
over its total — each file's issue carrying the file's `name` when the host sent
one. The turn is all-or-nothing: `assertTurnAttachments` (run by input
sanitization and by `resolveInputParts`) throws one `input` `TheoremError` whose
`copy` is a list, one label line per issue (`attachmentIssueCopy`), so the
user reads every reason and the builder reads the codes in `errorInternal`
(`attachmentsRefused` builds that error). `attachmentIssueText(issue, labels)`
words one issue for a client that reports issues itself (the composer). An image
profile has no voice channel, and `defineProfile` refuses an attachment `accept`
entry outside images, video, and PDF (`IMAGE_ATTACHMENT_ACCEPT_MIMES`); every
attachment is a reference the model reads, and `maxFiles` caps them. The
headless interface's `validateProfileInputs` runs the same check before a send.
The name is never sent to the model.

Turn media arrives on `TurnInput.attachments` as either inline bytes or a
provider file reference:

| Input | Shape | Ingress |
| --- | --- | --- |
| `TurnBlob` | `{ mimeType, data, name? }` (base64) | MIME acceptance, kind resolution, base64 check, per-file / per-turn byte limits, text-MIME sanitization |
| `TurnMediaRef` | `{ mimeType, uri, name? }` (e.g. Gemini Files `files/<id>`) | MIME acceptance, file count, and kind resolution only — no base64 or byte limits; the host owns upload and cleanup |
| `InteractionMediaRefPart` | `{ type: MediaInputKind, mimeType, uri }` | Provider part emitted for a `TurnMediaRef`; `isMediaRefPart` narrows it |

`wireInteractionPart` emits `{ type, mimeType, uri }` for a reference part; the
`geminiInteractions` protocol snake-cases it to the documented Files input
`{ "type": "video", "uri": "files/<id>", "mime_type": "video/mp4" }`. The `openAi`,
`openRouterOpenAi`, `openRouterImages`, and `geminiLive` protocols throw `TheoremError` for reference
parts — see `docs/contracts/providers.md`.

`ModelBinding` contains `protocol`, registered `provider`, and upstream `apiId` strings,
shared generation settings, optional credential-slot overrides and JSON `options`.
`modelBindingSchema` validates shared data and refuses unknown fields.
Profile registration checks that the provider serves the protocol and parses `options` with the protocol's schema.
The protocol must have an endpoint for the profile type (`unsupported` otherwise).
Cache, storage, and persistence settings belong to protocol options.
The registration owns credential defaults (`keySlot`, `fallbackKeySlot`), and a binding may override them.
Provider vault lookup requires an own property for the selected slot. Inherited credentials and resolvers do not grant access.
A provider may declare `check: { protocol, path }`, a GET on where it serves `protocol`, signed as a call is. `checkKey(provider, { vault, slot? })` reads the slot (the provider's, unless `slot` names a model's own) the way a call does and sends that GET once, with an 8-second limit. A 2xx is `accepted`; 400, 401 or 403 is `refused`; no answer or any other status is `unreachable`. An empty slot is `empty`, and a provider with no `check` is `unchecked`. `said` is the refusal body, with the key removed and cut to 300 characters.

`registerProvider` returns a `RegisteredProvider` with typed `.model()` and `.decisionModel()` helpers.
The helpers check `options` against the protocol when the binding is made.
Scope `providers` supports registration, replacement, lookup, and listing.
The host registers providers before profiles reference them.
Registration validates the connection and freezes the result.
Each run resolves its provider when it starts. Called agents and compactors resolve independently.
A replacement registration affects later runs, not a run already started.

A protocol owns request encoding and reply decoding. The provider owns the base URL and sign-in.
The kernel owns the transport, keys, retries, and limits.
It validates operations and event authority before client tools run.
The provider contract at
`docs/contracts/providers.md` contains the schemas and credential-resolution rules.

`TurnRequest.sessionId` is an optional sticky routing key forwarded to OpenRouter
as `session_id` (distinct from `projectId` and native provider checkpoint data).

`TurnTokens` shares (`thinking`, `toolUse`, `cached`, `cacheWrite`) and `cost`
appear only when the provider reports them — see [Token usage](#token-usage).

THEOREM does not invent provider-API defaults for optional wire fields.
Hosts must set required fields explicitly (`type`, `models`, per-binding
`provider` / `apiId`).
First-party THEOREM opinions that *are* applied when the host omits a knob:
guardrails default on, and Interactions streaming defaults to SSE
(`outputs.streaming.mode` omitted → `stream: true`).

`projectProfile` / `resolveTurn` project a registered profile + `TurnRequest`
into a `ProjectedProfile` / `ResolvedGeneration` the runner and providers consume.


## Prompt lines

Use prompt lines when one agent speaks differently by channel, plan, or any other fact the host knows. `identity.conditions` names the facts and their values. Each entry of `identity.system` is a **line**. A line that opens with `when` goes only on turns where it fits.

```ts
identity: {
  handle: 'desk',
  conditions: { path: ['web', 'imessage'], plan: ['free', 'paid'] },
  system: [
    'You are the Harbor desk.',
    'when plan is free: Keep replies to one paragraph.',
    'when path is imessage: Write plain text.',
  ],
}
runTurn({ profile: 'desk', path: 'web', conditions: { plan: 'free' }, input });
```

| Rule | Owner |
| --- | --- |
| Every line that fits is sent, in order, a blank line apart. `req.system` follows the lines. | `pickSystemLines`, `resolveTurnSystemPrompt` |
| A turn states every condition with a listed value. `path` reads the turn's own `path`. | `turnFacts` |
| A `when` reads conditions and slots. It uses the activity-label grammar. `+`, `is null`, and dotted names are refused. | `systemLinesProblem` |
| A condition chooses lines and never fills text. Only a slot fills `{name}`. | `fillSlots` |
| A line is a string or a list of parts. A bare `{ private }` in the list of lines is refused. | `assertSystemLines` |
| Marks are settled on the prompt as written, so a dropped line never changes the marks of a kept line. | `pickSystemLines` |
| A tool in `tools.allow` may list only paths that `identity.conditions.path` lists. A turn checks this, because a tool can register after its profile. | `toolPathProblem` |

## Turn lifecycle

`runTurn(request, hostOptions?, sink?)` is the single deterministic execution path
for one **turn-based** agent turn (text / image / speech). It runs on the scope it
is called from (`scope.runTurn`, or the default scope's global `runTurn`); every
step reads that scope's registries and no other. Live profiles use
`runSession` instead (long-lived session; the conversational boundary is
`interactionStatus: IDLE` when the provider sends it, else `turnComplete` — a
gate boundary, not socket teardown). When `sink` is omitted, the runner resolves
`profile.observability` via `resolveTraceWriter` (named destination, inline
sink, or noop). An explicit third-argument sink always wins for that call.

Text turns emit **stage** events and invoke optional `TurnRequest.onStage`
(`docs/contracts/stages.md`): `pre_turn` before the first provider step;
`post_tool` after each tool body (may `deny` or `mutate` the result);
`before_end` before egress/validation
finalize (inject may re-enter the step loop under `maxSteps`); terminal `done`;
then `post_turn`. Inject requires `profileAllowsInject` (`allowSteering` on
text). Invalid affordances yield a follow-up `stage` event with `stageWarnings`.
AbortSignal / stage `abort` end with cancelled `done` then `post_turn`.
Live sessions emit the same stage names around utterance cycles and
`LiveSession.executeTool` (`docs/contracts/stages.md`).

1. **Resolve** — `resolveTurn` picks model, wire `apiId`, `transport`
   (`'interactions'` for Google Interactions, `'openAiCompat'` for OpenRouter/local),
   thinking, tools, structured schema, streaming mode (`outputs.streaming.mode`
   → SSE vs buffered), canary token (minted; the runner replaces it at step 4).
2. **Sanitize** — `sanitizeTurnRequest` reads injection/sensitive spans and acts on
   each per profile guardrails (unless disabled).
3. **Compaction (before)** — when `timing: 'before'` and threshold fires, kernel
   runs the compaction profile turn synchronously, then continues with the
   history it leaves (see [Compaction](#compaction)). The history meter counts text only;
   it reports each media part as `unknownMedia`.
4. **Canary bind** — while the `canary_leak` detector is above `ignore` somewhere, the turn's canary is the
   profile's (`profileCanary`: a hash of the profile id and the resolved system
   prompt, the same on every turn that sends that prompt, so a provider's prompt
   cache holds), and its note goes at the end of the system text.
5. **`pre_turn`** — stage emit + optional `onStage` (may inject). On a text
   turn the opening input is already the last message of turn history.
6. **Provider stream** — `provider.complete` yields partial events; runner may
   drop thoughts per `outputs.streaming.streamThoughts`. Reply text passes the
   progressive-yield gate; thoughts never stop the turn, but their leaks are
   omitted ([guardrails](./guardrails.md)). A tool call the model is still
   writing goes out as `tool_draft` pieces, read at its call's
   `tool_arguments_<kind>` boundary; the runner sends none while it withholds
   the reply. On a profile with `outputs.structured` and no function tools, the
   request carries the schema as its response format, and the reply's text is
   its JSON: it goes out as `structured_draft` pieces under `sse`, and not at all
   under `buffered`. A profile with `outputs.structured` and function tools
   answers through the **answer tool** (`ANSWER_TOOL`) instead: see
   [Structured output](#structured-output). Each provider call has its own gate;
   the turn carries a possible canary opening from one call into the next
   (`canaryCarry` and `thoughtCarry` on the step state), so a token split across
   tool steps is one match.
7. **Tool loop** — while under `maxSteps` (20 model calls when the profile sets none), tool calls execute via `executeRegisteredTool`
   (shared with `invokeTool`), threading the host's `credentials` source (`ToolCredentialSource`, read one slot at a time as a signed-in tool runs) for authenticated HTTP/MCP tools and the opaque `host` context slot; `pre_tool` / `post_tool` stages + `preTool` run on that path.
   Every call of a step is announced first. With `tools.parallel: true` they then run side
   by side; left out or false, one at a time in the order the model made them. A call whose
   `pre_tool` answers `waitFor` starts its body once those calls settle
   ([stages.md](./stages.md#same-round-batch-rules)). The step ends when each has settled.
   Each reads the turn's taint, destinations, and visible tools as they stood when the step
   began, so a tool the `tools.t2Loader` loads can be called from the next step. After the step, each call's result is recorded in the order the
   model made the calls, and its `post_tool` may inject. Gate (`stop.kind: 'gate'`) suspends the batch.
   The runner records each step's reply in portable history: the text it wrote
   (its structured reply, when it gave one), then its tool calls, then their results,
   so the next call reads what the model wrote before its calls.
   The kernel validates native state, and the model's protocol encodes the next request.
   Native continuation does not replace authoritative tool outcomes.
   Server-side `codeExecution` does not consume a runner step.
8. **`before_end`** — stage before egress/validation. `StageContext.reply` holds
   the answer the model wrote; no text in it means the turn would end with no
   answer. An inject goes into turn history after that answer, and re-enters the
   step loop when under `maxSteps`.
9. **Validation / repair** — structured output validators (`outputs.validation`)
   may trigger repair turns with `input.repair`. The repair prompt is the next
   user message in turn history (image and speech: it replaces the prompt
   input). From the first retry on, the model reads this turn only: the turn's
   input, its tool calls and results, the replies sent back, and the repairs.
   The conversation the host passed is left out, and the turn's `done` carries
   no `providerState`. A retry is not resolved again: it keeps the turn's canary, tool set
   and system prompt. Under `outputs.streaming.mode: 'sse'` text and media
   stream as they arrive; under `'buffered'` they are held until the reply
   passes. Each retry is marked with an `attempt` event. Out of retries, the last
   attempt goes out as it is, with its buffered events, and its `structured`
   event lists the fields still invalid as `failed: [{ path, error }]`.
10. **Egress** — progressive yield on the provider stream (canary, prompt
   echo, the other `guardrails.detect` detectors, a host's own) releases
   cleared prefixes: the detectors and a host's patterns hold exactly what could
   still become a match, a host's `find` a fixed tail; end-of-attempt may still refuse, repair, or withhold. SSE streaming and egress can both stay enabled.
11. **Trace** — the turn records one `invoke_agent` span tree (model calls,
   HTTP tries, tools, stage events) and writes it as one `TraceRecord` to the
   request's sink, else `profile.observability`; failures are swallowed.
   Providers tap each request body and data row (`tapUpstream`), recorded as
   `theorem.wire.request` / `theorem.upstream.row` under the include flags
   ([observability.md](observability.md#trace-records)).
12. **Terminal `done` then `post_turn`** — one `done` event with optional
    `stop`, optional `compaction` signal (`timing: 'after'`), then observe-only
    `post_turn`. Each model call emits a `tokens` event.
    The final `done.tokens` contains their aggregate usage (see [Token usage](#token-usage)).

`continueFrom` on `TurnRequest` resumes a resumeable stop. On a text profile the
turn's user message is the labels' `continue.instruction` (a continue turn takes no
`input.text`); the host passes the partial reply as the last assistant message in
`input.history`. On image and speech nothing is added: the host re-sends the
original request and the turn runs it again in full. `continueFrom` carries only
the `stop` being resumed. A model call that failed `busy` is one the turn may send
again itself (see the re-send rules below).

Trace context on the request, all optional:

| Field | Recorded as |
| --- | --- |
| `traceparent` | W3C parent of the root span; the turn joins that trace. Without it the turn starts a new trace. A malformed value throws. |
| `conversationId` | `gen_ai.conversation.id` |
| `links` (`TurnTraceLink[]`) | Span links on the root: `{ traceparent, kind: 'resume' \| 'continue' \| 'retry', stop? }` |
| `metadata` | Stored on the record untouched |

The terminal `done` carries `traceparent` (the turn's root), which a later
request passes in `links`. `ToolContext.traceparent` is the call's
`execute_tool` span, so a tool that runs a specialist or makes its own
outbound calls parents them there. `SessionRequest` and `InvokeToolRequest`
take `traceparent`, `conversationId`, `links`, and `metadata` the same way.

`runTurn`, `runSession`, `resolveTurn`, and `projectProfile` refuse a `'host'`
profile with `TheoremError` (`requireModelProfile`); host profiles only execute
tools through `invokeTool`.

A compaction profile resolves its own registered provider. `compactHistory` and turn-time
compaction use the same host options and credential vault as other registered operations.

## Stream events

`runTurn` yields `TurnEvent`. Protocols yield the narrower `ProtocolEvent` union.
The kernel validates protocol events before it releases them or executes client tools.

| `type` | Payload highlights |
| --- | --- |
| `thought` | Model reasoning stream (read for images, links, canary, prompt echo and boundary markers, and never stopped: a leak is flagged by default and omitted where the profile sets `redact` or `block`; dropped when `streamThoughts: false`) |
| `text` | User-visible assistant text |
| `tool_draft` | A piece of a tool call the model is still writing: `callId`, `name`, `text` (the next piece of its arguments' JSON). A preview only: the `tool` event with the same `callId` is the call. A draft stops when its call's check would redact or block what it holds, or when its `name` changes. Sent only when the provider streams the reply |
| `tool` | Tool call (`phase`: `running` / `progress` / `draft` / `complete` / `gate` / `error` / `cancel`, …; `pause` deprecated). A function tool's stream handler yields `{ kind: 'draft', text }` to preview its output as it writes it; each piece goes out as a `draft` phase, read first at the call's `tool_output_<kind>` boundary. An HTTP tool's successful text or JSON body goes out the same way as it arrives, with its credential replaced before any piece shows; an MCP tool's result arrives whole. A match there stops the drafts, and the `complete` output is still read whole. A function or agent tool's `progress` is read whole at that boundary too: one a check stops is not sent, and its `guardrail` event is. Drafts are sent only under `sse`, and the model never reads them |
| `structured_draft` | The next piece of a structured reply's JSON, `text`, read at `reply` as the reply's text and then at `reply_structured`, where the whole is read: a match there stops the drafts. A preview only: the `structured` event that follows is the reply. Sent only under `sse`, and not when the reply was held for its verdict |
| `structured` | Parsed JSON object when the profile names a structured schema; `removed` lists what item rules took out, `failed` the fields still invalid when validation ran out of retries |
| `attempt` | The turn threw the reply so far away and asks again: `attempt` counts the retries (1 for the first), `reason` is `validation`, or `egress`. The text, media, and structured events before it in the turn are not the reply. `keptReply(events)` drops them; `foldTurnEvents`, `appendAssistantEventsToHistory` (one assistant message per reply) and an agent tool's output read only the kept reply |
| `media` | Generated image/audio bytes + mime |
| `grounding` | Google search metadata: Live `groundingMetadata`, and Interactions tool results (`google_search_result` `search_suggestions` → `searchHtml`). Maps sources add normalized `chunks[].maps` (`title` / `uri` / `placeId`); the raw payload rides on `metadata`. The sources themselves travel as `citation` |
| `citation` | `sources` (`title` / `uri` / `type` / `placeId?`) a provider or a tool cited. From a provider: Google `url_citation` / `place_citation` annotations and `google_maps_result` places, OpenRouter citations and `url_citation` annotations. From a tool: its `sources(output)` on a completed call, with the call's `callId` (see [Tool sources](#tool-sources)) |
| `evidence` | Provider-native attachments. Google code execution sets `kind` (`code_execution_call` / `code_execution_result`) plus parsed `code` / `result` / `isError` / `id` / `callId`, and always keeps `raw`. Live ASR uses `input_transcription` / `output_transcription` (optional `interim`); Live `voiceActivity` uses `voice_activity` (`raw`); session resumption uses `session_resumption` + `resumable`. `partial: true` marks a step the provider started and never finished (the stream ended first); a partial tool call never runs. |
| `session` | Live control: `closing_soon` (optional `timeLeftMs`); `ended`, the provider's close after it warned of one — not an error: `ended { cause: 'go_away', code, closedAfterMs, errorKind? }` (`errorKind` when the code is not 1000), `timeLeftMs` (the last warning's window), `message` (the user's wording, labels `live.session_ended`) and the raw close as `errorInternal`; `waiting_for_input`, `turn_complete` (one spoken response ended), `working` (server still reasoning / awaiting async tools), `idle` (cycle boundary) |
| `stage` | Turn timeline (`stage`: `pre_turn` \| `pre_tool` \| `post_tool` \| `before_end` \| `post_turn`) — see [`stages.md`](stages.md). With `released`, an inject dropped the reply past that many characters: `keptReply` cuts it there |
| `tokens` | One per model call, after that call's output: `TurnTokens` (see [Token usage](#token-usage)); may gate `meter: 'input'` |
| `response` | Protocol → runner only, never yielded by `runTurn`: the response identity (`id`, `model`) as soon as the wire names it, and again when it grows or changes. The runner records it on the call's trace span (`gen_ai.response.id` / `gen_ai.response.model`), so a call that fails or is cut by a guardrail still names the model that served it |
| `compaction` | `timing: 'before'` ran the compactor: `outcome`, the `history` the turn used, `summary` when compacted, `failure` when not, `droppedMedia`, the meter's count and message counts (see [Compaction](#compaction)) |
| `done` | Terminal or live boundary: `stop` (`completed` / `interrupted` / `generation_complete` / …), `compaction`, `tokens` (the turn's usage), optional `providerState`; when `stop.kind` is `tool` or `gate`, required `tools` (`TurnToolSnapshot`) for host `invokeTool` resume, absent otherwise |
| `provider_checkpoint` | Live native checkpoint in `providerState`, with the covered portable `history` |
| `provider_warning` | Native state mismatch: `warning.code` is `provider_state_rebuilt`; `warning.reason` identifies the mismatch |
| `error` | `errorKind` (builder), `errorInternal` (host logs only), and `error`, the user's wording for the kind (profile `labels` → `overrideLabels` → default) — see [Public errors](guardrails.md#public-errors) |

### Token usage

`runTurn` emits exactly one `tokens` event per model call — each tool-loop step
and each repair attempt is a call — after that call's output and before the
next step. A provider that reports usage more than once per call contributes
its last report. Live sessions (`runSession`) pass through the one usage row
Gemini Live sends per model response; a Live response without one is not yet
estimated.

Meanings follow the OpenTelemetry GenAI conventions on every provider:

| Field | Meaning |
| --- | --- |
| `input` | Everything the model read: prompt, cached prompt, provider tool-use results (Google code execution / URL context) |
| `output` | Everything the model wrote, reasoning included |
| `total` | `input + output` |
| `thinking` | Reasoning share of `output`, counted even when thought text is not streamed |
| `toolUse` | Provider tool-use share of `input` |
| `cached` / `cacheWrite` | Cache-read / cache-write shares of `input` |
| `cost` | Provider-reported charge in US dollars (`usd`; OpenRouter also `upstreamUsd`; `partial` only on a `sumTokens` total) |
| `estimated` | Sides (`'input'` / `'output'`) the provider did not report; absent = both reported |
| `unknownMedia` | Per side, media parts an estimated side leaves out (no verified rule) |

**Estimated sides.** When a provider leaves a side out — or reports no usage at
all — the runner fills it with the shared token estimator
(`loadTokenEstimator`) and lists it in `estimated`. The prompt side counts the
system prompt, wire tool declarations, structured output schema, turn history,
and opening input; an Interactions continuation step (`previous_interaction_id`)
counts the stored interaction it extends — the previous call's prompt, that
call's text / tool calls / media, then the continuation's tool results and
stage injects. The output side counts streamed text, thought text, and tool-call
names and arguments; reasoning the provider does not stream cannot be counted.
Media is counted by the model family's verified rule (see
[History estimate](#history-estimate-meter-history)); output media is always
unknown. A call that failed with no usage emits no `tokens` event — what was
billed is unknown.

**Agent tool calls.** An agent tool's call carries the called agent's usage
as `tokens` on its `complete` or `error`, and `done.tokens` adds it in
([Agent tools](#agent-tools)); the call emits no `tokens` event of its own.

**Totals.** `sumTokens(calls)` is the one way to total calls — a turn, a
session, any range. Counts and shares add up; a side is `estimated` when any
call estimated it (its shares then cover only what providers reported);
`unknownMedia` adds up per side. `cost.usd` adds up over the calls that
reported a cost and carries `partial: true` when some did not; no reported cost
means no `cost`. `upstreamUsd` adds up where reported (OpenRouter sends it only
for BYOK). The trace record's `usage` and the CLI `test` total use it.

### Host client boundary

`runTurn` yields one stream for the host process. **Do not forward the stream
verbatim to browsers or end-user SSE** unless you intend to expose diagnostics.

| Field | Host logs / traces | End-user transport |
| --- | --- | --- |
| `error` | yes | yes |
| `errorKind` | yes | yes |
| `errorInternal` (error events, an ended session, `guardrail.errorInternal`) | yes | **never** to a visitor |
| `evidence` parsed fields (`kind`, `code`, `result`, citations) | yes | when useful in UI |
| `evidence.raw` | yes | only when you explicitly want provider internals |
| `text`, `media`, `structured`, `grounding` | yes | yes (after egress/canary gates) |
| `thought` | yes (also in trace when filtered from stream) | only when profile allows |
| `tool_draft` | yes | only under `sse`; a preview, never the call |
| `structured_draft`, a `tool` event's `draft` phase | yes | only under `sse`; a preview, never the reply or the output |

Use `forClient` / `forClientEvents` from `@theoremjs/agents/host` before WebSocket or SSE
flush. A development tool on the builder's own machine passes `reader: 'builder'` and reads
the raw reason instead ([host](host.md)). Pass a trace sink (`memorySink`, `jsonlSink`) as the third argument to
`runTurn` for wire-level audit (`theorem.upstream.row` and
`theorem.wire.request` events; see [observability.md](./observability.md)).

`TurnHistoryMessage` preserves `role`, `content`, `parts`, `tool_calls`,
`tool_call_id`, and opaque `metadata` across turns.

`content` and `parts` are sent together, never one instead of the other:
`historyMessageParts` (`src/kernel/interaction-parts.ts`) puts `content` first as a
text part, then `parts`. Every first-party protocol (`geminiInteractions`, `geminiLive`,
`openAi`, `openRouterOpenAi`, `openRouterImages`) builds history content from it, so a host that stores a text projection
alongside media does not lose either one. Chat Completions (`openAi`,
`openRouterOpenAi`) takes only text in assistant content, so an assistant
message's files leave a marker such as `[image: sent in the next message]` and
follow it in a user message led by "Files the assistant sent:", after the results
of any calls it made.

Google Interactions code execution (`codeExecution` builtin) is a server-side
tool: THEOREM does not run Python. Hosts receive the sandbox timeline as
`evidence` events (streamed SSE deltas, or a batched replay of `steps[]` when
`outputs.streaming.mode === 'buffered'`). Generated plots/annotated images arrive as
`media`. `maxSteps` does not bound Google's internal code loop; it only bounds
host function-calling round trips. The sandbox runtime cap (~30s per execution)
is Google's, not a THEOREM setting.

Streaming is controlled solely by `outputs.streaming.mode` on the profile
(`'sse'` or `'buffered'`). When omitted, THEOREM defaults to SSE. `'buffered'`
makes one non-streaming provider call on every chat transport (Interactions,
OpenRouter, local) and yields the same `TurnEvent` types when it answers.
There is no per-turn stream override.

## Registered tools

Tools, profiles, and structured schemas live in a kernel scope (see
[Kernel scope](#kernel-scope)). A host with one tenant registers at startup into the
default scope via `registerTool` or `registerTools`. Profiles declare **custom** tools on `tools.allow` and **provider builtins** on
`models.*.builtInTools`. On `text` / `image` turns visibility is `loadTier` (T0 at
turn start; T2 on demand, picked at turn start by `tools.t1Policy` or loaded
mid-turn by `tools.t2Loader`). On `live` every
allowed tool (and every model builtin) is wired at session setup regardless of
`loadTier`; on `host` every allowed tool is executable with no tiers and no path
gating. Each of these facts has one owner, and every kernel, CLI, and interface
reader goes through it: `profileToolAllow` (`src/kernel/tools/resolve.ts`) returns a
profile's allow list, empty for `speech` and `decision`; `profileToolsSpec`
returns the tiered spec (`t1Policy`, `t2Loader`) for `text` and `image` only;
`profileInputs` (`src/kernel/registry/catalog.ts`) returns turn inputs for `text` and
`image` only. So projection, resolution, execute eligibility, T2 promotion, and
T2 loading see no tools on `speech` and `decision`, and `invokeTool` rejects
`decision` explicitly.

The model's protocol writes each builtin the request asks for and owns how each is sent.
A request asks for fewer than the binding lists when a tool is toggled off or a step must answer.
The protocol reports what it wrote (`SendInit.wroteTools`). The kernel refuses an asked builtin the protocol did not write (`unsupported`).
A builtin's registered tool is its entry in the tool list: name, description, category, labels.
A builtin may take args. A request addresses them to a tool the model lists, by id, and the protocol parses them:
`runTurn({ profile, model, builtInArgs: { googleMaps: { location } } })`.
Resolution refuses args for a builtin the chosen model does not list, args for a builtin that
declares none, and args its schema rejects. It copies each builtin's id and parsed args onto the
normalized request. First-party codecs reject a builtin their provider does not run before sending.

A `complete` or `error` tool event carries `readBack`: the text the model read
for that call, after guardrails. History replays it (`appendToolExchangeToHistory`),
so a continued turn sends the provider exactly what `runTurn` / `invokeTool` sent,
and a live session sends Gemini the same text. Replaying a settled call without
one throws.
Its `output` (and an `error`'s message) is what the person is shown, read at
`tool_shown_<kind>` apart from `readBack`; neither read changes the other.

### Kernel scope

A `KernelScope` is one set of registries (`tools`, `profiles`, `schemas`) and the
runs bound to them: `runTurn`, `runSession`, `invokeTool`, `resolveTurn`,
`projectProfile`, `runDecision`. `createKernelScope()` returns empty registries,
isolated from every other scope; a run reads only the scope it was started on.
Two scopes can register the same tool, profile, and schema names without either
seeing the other's.

The global functions (`registerTool`, `registerProfile`, `registerStructured`,
`runTurn`, …) are `defaultKernelScope`'s methods. There is no ambient or
request-local lookup: a host serving many tenants, such as the studio, builds
a scope per request and runs on it. `registerHarnessTools()` fills the default
scope; another scope registers `askUserTool` itself.

Register a scope's tools and schemas before its profiles: a profile is checked
against them when it registers. An `outputs.structured` id that names no
registered schema, or an `outputs.validation.fields` path no such schema reaches
through object properties, is refused then.

### Tool sources

A function, HTTP, or MCP tool may declare `sources: (output) => Source[]`. Once a
call completes (after `post_tool`, on the output it settles with), the kernel
runs it and emits one `citation { sources, callId }` before the terminal
`complete` event; the transcript shows them on that call. It never runs for a
call that failed, gated, or was refused. Every source is checked against
`sourceSchema`: one that fails is not cited, and the call gets one tool
`warning` (`code: 'sources_invalid'`) naming each failure; a throw is the same
warning and cites nothing. The call still completes and the model's result is
unchanged. The call's `execute_tool` span records the cited sources as a
`theorem.grounding` event, and every tool warning (the tool's own and
`sources_invalid`) as a `theorem.tool.warning` event. A tool that cites nothing
omits `sources`.

### Tool images

An HTTP or MCP tool whose result names pictures by address may declare
`images: (output) => string[]`. Once a call succeeds and its result has passed the
`tool_output` guard and the after-call stages, the kernel fetches the distinct https
addresses and adds each as an `image` part to the model's result beside any the
server sent. A result the guard blocks or replaces fetches nothing and carries no
pictures. Only png, jpeg, gif and webp are taken.

The tool may also declare `imageLimits`. Each limit left out is no limit:

| Field | Limits |
| --- | --- |
| `count` | The pictures fetched; the first ones named are kept |
| `bytes` | The size of each picture |
| `totalBytes` | The size of all of a call's pictures, as the base64 the model reads |
| `timeoutMs` | How long each picture may take |

Registration refuses a count or size that is not a whole number above 0, and a
timeout that is not a finite number of ms above 0. With no limits, every picture
named goes to the model, so a large set can make a request that the provider refuses.
An address that is not absolute https, blocked, slow, too big, not an image, or
not answered, and a hook that throws, leave their pictures out and give the call
one tool `warning` (`code: 'images_unfetched'`) naming each reason; the call still
completes. A function tool returns the bytes itself as `parts` and has no hook.

Pictures are fetched without the tool's credentials. Every hop, redirects
included, runs through the profile's network policy: with no policy, any public
https host is allowed and private addresses are refused; a profile that allowlists
hosts must list the picture CDN hosts as well as the tool's endpoint, or the
pictures arrive as `images_unfetched`. The policy resolves a host before the
connection is made, so a host that changes its answer in between (DNS rebinding)
is not caught; the runtimes give no way to pin the address. The pictures carry the
tool-result provenance of the text beside them and are not scanned (there are no
image detectors, as for MCP image blocks). The fetched addresses are added to the
result's text, so `ungiven_images` with `fromTools` counts them as given.

### Agent tools

An agent tool (`type: 'agent'`) runs one turn of another registered profile and
returns its reply. The called agent is a standalone profile, not a part of the
caller: any agent may call it, and it answers the caller, never the user. The
kernel chooses nothing beyond running the one turn; any routing, chaining or
state is the host's, through `onAgentCall` and stages.

| Field | Meaning |
| --- | --- |
| `profile` | The agent to run: a `text`, `image`, or `speech` profile that takes text, registered before the tool |
| `maxCallsPerTurn` | Calls allowed in one turn of the caller; a call past it fails `call_limit` (`declined`) |
| `fieldText` | What the calling model reads on a field of the input, by field (`{ text: '…' }`); a field the profile does not take is refused at registration |
| `hostFields` | Fields the model fills that only the host reads, as a zod type by name (`{ media: z.string() }`); a name the input already has is refused at registration |
| `hostOnly` | Channels the profile takes that the model can't fill (`['attachments']`); a channel the profile does not take is refused at registration |
| `preTool` | As on a function tool, with the call's input |

**Input.** The tool's input is what the called profile takes, so the calling
model can send it anything the profile's `inputs` declares:

| Field | Present when | Value |
| --- | --- | --- |
| `text` | always | The message to the agent |
| `attachments` | `inputs.attachments` is set | Files, as `{ mimeType, data }` or `{ mimeType, uri }` |
| `voice` | `inputs.voice` is set | Recorded speech, as `{ mimeType, data }` |
| `slots` | `inputs.slots` is set | One of the declared choices for each slot sent |
| `speech` | the profile is a `speech` profile | `{ voice?, style?, speed? }` for this call |

A field the profile does not take, or a slot choice it does not declare, fails
the call `invalid_input` (`bad_response`); nothing is dropped. The called
turn checks MIME types, counts, and sizes as it does for any turn, and a file it
refuses fails the call `agent_failed` (`input`). The model then reads why, in
the labels' own lines for refused files, and `details.reasons` holds each
line's key and facts. `inputs.context` is not a
field: its senders are the page and the host, and the host sends it through
`onAgentCall`.

**Host fields.** A tool's `hostFields` add fields to its input that the called
agent never receives: the host's own handle for something, such as the id of a
stored file. The hook reads them as `call.hostInput` and returns the `input` the
agent is sent. `hostOnly` takes a channel out of the model's input, so the file
an id names reaches the agent only as the hook attached it. A call to a tool
with host fields on a request with no `onAgentCall` throws `config`.

Output is `{ text?, structured?, removed?, parts?, sources? }`: the reply's text, or its last
structured reply when the called profile declares `outputs.structured` (the text
of such a reply is the same JSON, so it is not returned twice), its images or
audio as `parts`, and what it cited as `sources`, which the caller's turn cites
as it does any tool's. A `post_tool` stage can
replace it (`mutate: { output }`) before the caller's model reads it.

**Registration.** `register` throws `config` when the profile is missing, is
another type, takes no text, allows a tool that is not registered, or allows a
tool that can stop on a gate (permission other than `auto`, or a sign-in
whose `onUnauthenticated` is `'gate'`). A gate inside the called
agent would have no one to answer it. Agents call agents only in registration
order, so calls can't loop.

**The host's hook.** `TurnRequest.onAgentCall(call)` (and the same field on
`InvokeToolRequest` and `SessionRequest`) runs before each call with `{ tool, callId, profile,
input, hostInput?, caller, depth, metadata?, signal? }`. It returns nothing to run the call
as is, `{ refuse }` to fail it (`refused_by_host`, `declined`, the model reads
`refuse`), or fields for the called agent's request: `input`, `speech`,
`model`, `effort`, `builtInArgs`, `metadata`, `onStage`, `conversationId`, `host`, `provider`. The
hook's `input` replaces what the model sent; its `speech` replaces the
model's. The hook's `host` is what the called agent's tools read as `ctx.host`.
The caller's `host` is not passed down: without the hook's, those tools read none. The hook passes
down to the called agent's own calls, with `depth` counting up from 1.
A hook that throws ends the caller's turn with that error: what the model should
read instead is the hook's to catch and return as `refuse`.

**Provider.** The called agent resolves its registered binding. The hook's `provider` and
`InvokeToolRequest.provider` supply host options, such as a vault or fetch, for that call.
They do not carry an executable model provider. In a live session a call runs on
the options `runSession` was opened with, unless the hook returns others.

**Outcomes.** The call completes with the reply when the agent's turn completes.
Any other stop, or an error the agent's turn reports or is refused with, fails
the call (`agent_failed`, with the agent's error kind or `failed`). `config`,
`request`, `auth`, and `internal` errors are the host's to fix and are thrown, as
a compactor's are. Host abort cancels both turns.

**Events and trace.** The called agent's reply (its `text` and
`structured_draft`) streams as the call's `draft` phases, until the agent
retries its reply (`attempt`). Its other events stream as the call's
`progress` (`data: { agent, event }`). Its `invoke_agent` span is a child of the
call's `execute_tool` span in the caller's record, sharing its canaries.

**Trust.** A called agent with no tools and no model builtins read only what it
was sent, so its result is `origin: 'local'`. One with tools is `delegated`
(depth 2) and taints the turn like any remote result.

**Usage.** The call's `complete` or `error` carries the called agent's own
`tokens`. The caller's `done.tokens` includes them; the caller's span keeps
only its own calls. A live session totals nothing: the call's `tokens` are the
agent's whole usage.

### Host context slot

Application context reaches tool hooks through one opaque slot. The kernel never
reads, logs, traces, or serializes it — it is not on `TurnEvent`,
pause `input`, `TraceRecord`, or `ProtocolRequest`.

| Field | Reaches |
| --- | --- |
| `TurnRequest.host?: unknown` | `ToolContext.host` for every tool the turn executes; `ToolLoadContext.host` for `tools.t1Policy` |
| `InvokeToolRequest.host?: unknown` | Same, for a host-initiated `invokeTool` |
| `InvokeToolRequest.onStage?: StageHandler` | Optional `pre_tool` / `post_tool` only ([`stages.md`](stages.md)) |
| `ToolContext.host?: unknown` | Read by `handler`, `preTool` |
| `ToolLoadContext.host?: unknown` | Read by `tools.t1Policy` |

`SessionRequest` has no host slot today. Target stages attach `SessionRequest.onStage`
for the session lifetime (immutable; no `setOnStage`) and require
`LiveSession.executeTool` for live tool execute — see [`stages.md`](stages.md).
Until that cutover, hosts still execute live tool calls through `invokeTool`.

### Session snapshot across a process boundary

`SessionRequest.snapshot?: TurnToolSnapshot` lets a relay process that does not
own the tool registry open a session. The registry-owning process resolves the
snapshot with `prepareTurnToolSnapshot(profile, request, modelId)` and hands it
across as data; `runSession` declares `snapshot.wire` at setup instead of
resolving locally. The profile's `tools.allow` remains the ceiling: any custom
id in the snapshot outside it is refused with `TheoremError`. Without a snapshot
and without the registry, a session declares no tools.

```ts
// Startup
registerTool({
  type: 'function',
  name: 'lookup_order',
  description: 'Fetch order state',
  category: 'operations',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'session_consent',
  input: z.object({ orderId: z.string() }),
  output: z.object({ finding: z.string() }),
  handler: async (input) => ({ finding: `Order ${input.orderId} is in transit.` }),
});

// Profile — custom allow + optional turn-start policy + optional mid-turn loader, both over T2 tools
tools: {
  allow: ['lookup_order', 'load_tools', 'deferred_order_tool'],
  t1Policy: (ctx) => (ctx.input?.text?.includes('order') ? ['deferred_order_tool'] : []),
  t2Loader: 'load_tools',
}
// models.fast.builtInTools: ['googleMaps', 'urlContext']

// Turn
runTurn({
  profile,
  input: { text: '...' },
}, hostOptions);

// Host resume: preserve the issued callId and operationId, and snapshot from gate done.tools
invokeTool({ profile, name: 'risky_tool', callId, operationId, input: {...}, resume: { granted: true }, snapshot, turnInput });
// ask_user completes with awaiting_user_input; answers are a new user turn (not resume on same call_id)
// T2 resume after loader: include `promoted: ['record_lookup']` (or rely on snapshot.visible when emitted on `done`)
invokeTool({ profile, name: 'record_lookup', callId, operationId, input: {...}, resume: { granted: true }, snapshot, promoted: ['record_lookup'], turnInput });

// Tool `preTool` returning `confirm` gates once; `resume.granted: true` skips preTool on the next invoke (same as `always_confirm` permission).
// A host `pre_tool` `confirm` gates once too: the granted resume runs the stage again, and its `confirm` asks nothing more.

// Host direct invoke (command palette)
invokeTool({ profile, name: 'lookup_order', input: {...} });

// Host step: several calls run as one, as a turn runs the model's (`tools.parallel`, `waitFor`)
invokeToolStep({ profile, calls: [{ name: 'lookup_order', input: {...} }, { name: 'read_weather', input: {...} }] });

// Host wants only how a call ended: runTool resolves to it; runToolStep yields each call's as it settles
const { phase, events } = await runTool({ profile, name: 'lookup_order', input: {...} });
```

| Layer | Owner | Role |
| --- | --- | --- |
| Registry | Host startup | Schema, handler, `access`, `loadTier`, `permission`, wire metadata |
| Profile | Host | `tools.allow` / `tools.t1Policy` / `tools.t2Loader`; `models.*.builtInTools` |
| Turn | Host | `sessionPermissions` for consent; `credentials` source for authenticated HTTP/MCP tools (read per slot, only when a tool signs in); path / input / transport |
| Execution | Kernel | Shared `executeRegisteredTool` for model and `invokeTool` paths |

The kernel assigns each client tool action an operation ID. Provider call IDs remain upstream correlation values.
Tool events carry the operation ID. The handler receives it as `ToolContext.operationId`.
Trusted invocations can restore the ID through `InvokeToolRequest.operationId`.
Model calls cannot assign this authority. New actions receive new IDs.
`GateReference` requires both IDs. Its public validator is `gateReferenceSchema`.
Transcript blocks and portable-history folds separate actions by operation ID.
Portable tool-result messages retain provider call IDs for upstream correlation. Legacy events use call IDs for display only.
External live execution must restore the held operation ID when it invokes a tool.
`LiveSession.answerToolCall` verifies that result phases carry the held operation ID and tool name.

The kernel retains no session database. React's server handler owns persisted approvals and checkpoint ownership.
Its session store uses atomic revision checks before a pending call reaches `invokeTool`.
Conflicting state transitions retry at most eight times. No tool executes inside that retry loop.
The separate credential store retains its existing contract.
The live client now checks held calls before page callbacks. It answers permission and auth gates before requesting page execution.
A page gate cannot authorize a browser callback. A kernel-owned `dispatch` phase carries a host-issued grant.
`PageToolExecution.dispatch` requires the acquired `ToolOperationClaim`, including final invocation evidence.
It returns `PageToolDispatch`: a grant ID and pending `PageAnswer`.
The kernel emits final prepared arguments only after grant persistence succeeds.
It checks cancellation before emission, then validates the returned answer through the tool output pipeline.
The service is trusted host code. Profiles, browser request bodies, and protocols cannot inject it.
Permission and sign-in resumes retain `gateKind`, so preparation that did not run before approval still runs before dispatch.
The shared executor accepts an optional host-owned `ToolExecutionCoordinator` through trusted `execution` options.
`createMemoryToolExecution` is the kernel's in-process coordinator. It checks the claim token on `settle` and `markUncertain`.
It refuses `settleNotStarted` for an operation that already has a record, and refuses new operations at the `maxOperations` of its `MemoryToolExecutionOptions`, when the host sets it.
A full coordinator reads as `config`: it frees no record, so it stays full until the process restarts or the host raises `maxOperations`. A claim token it did not issue, or a second record for one operation, reads as `internal`.
A page tool that runs with no coordinator reads as `config`. A coordinator or page dispatch that breaks this contract reads as `internal`, and `errorInternal` says what broke.
It holds no storage outside the process, so a host that resumes across workers supplies its own coordinator.
The host must reserve storage before returning an acquired claim. React handlers enforce finite capacity and reserve terminal evidence.
Capacity exhaustion must refuse dispatch. It must not remove unresolved claims to authorize another attempt.
A coordinator may declare `maxOutcomeBytes`, the most bytes of UTF-8 JSON it keeps for one outcome. One that declares none keeps any size. `createMemoryToolExecution` takes it as an option and has no default.
A larger result settles as the call's `result_too_large` failure, of kind `bad_response`, with the same `effects`. The model reads that failure, not the result.
`TurnRequest`, `InvokeToolRequest`, and `RunSessionOptions` carry this service. Profiles and provider options do not.
Nested agent turns inherit it. Each child tool action receives its own operation ID.
`ToolOperationIdentity` binds both IDs, the profile, the tool, and an accepted invocation hash.
Its optional `invocation` contains `SavedToolInvocation`. New body claims retain accepted data and final prepared input.
`toolInvocationHash` rejects non-JSON values and returns a canonical SHA-256 digest.
The session boundary uses the same digest for checkpoint ownership and browser result receipts.
The accepted data determines the hash. Preparation does not change that identity.
`preparedInput` records the validated input after preparation hooks. Unsupported object classes refuse dispatch before the body.
`savedToolInvocationSchema` validates JSON evidence. Older records without evidence remain readable.
A host can withhold their results when current access requires unavailable evidence.
`lookup` checks the exact operation identity before preparation hooks run. It does not acquire a body claim.
A settled lookup returns saved read-back only after current tool eligibility and disclosure checks.
`authorizeToolReplay` checks current profile eligibility and saved disclosure without calling handlers or preparation hooks.
If current output rules require redaction or refusal, replay fails closed. The saved action remains settled.
Host replay callbacks also check current resource access. Running or uncertain lookups refuse execution.
The host coordinator must apply current resource access before returning a saved outcome.
`begin` returns `BeginToolOperationResult`. Only an acquired claim permits the tool body.
The executor calls `begin` at the hand-off: right before the handler runs, the page dispatch, or the first send of an HTTP or MCP call.
Checks before the hand-off run with no claim: sign-in, a limit place, and the first hop's address check. A failure there saves as `not_started`, and a stop leaves no record.
An error after the claim keeps the kind of its cause and reads with the `tool.execution_uncertain` copy. A call to run an operation that is still running or uncertain reads as `conflict` (HTTP 409), with the same copy. The host settles that operation before it runs again. `errorInternal` names the state in each case.
`ToolOperationClaim` adds the worker's claim token. `settle` and `markUncertain` require that token.
`settleNotStarted` records a terminal refusal before any claim. It cannot settle a running operation.
`ToolOperationOutcome` contains a `TerminalToolEvent`, effect status, and validated replay data.
`ModelToolResult` retains the guarded read-back, media, provenance, and suspicious content signals.
`toolOperationOutcomeSchema` validates terminal events and replay data, including guarded model read-back and provenance.
`ToolOperationUncertainty` distinguishes interrupted execution, failed settlement writes, and a lost worker.
The executor saves settlement before it emits completion. An incomplete body or settlement failure retains a protected claim.
Live sessions also retain uncertain held calls after dispatch. They cannot execute again on the same connection.
Recovery across connections requires a host-owned durable coordinator.
React's `createTheoremSessionBoundary` applies the same authenticated namespace and atomic store to live setup.
It rejects unowned native state before transport. Ownership includes an operation-state fingerprint.
A ledger change invalidates old live ownership, including a settlement after checkpoint creation.
Chat can retain native state across approval when portable history contains every authoritative settled result.
Unknown effects, missing read-back, or edited results cannot satisfy that check. It records checkpoint ownership before browser delivery.
Running or uncertain operations refuse native resumption. They remain available for trusted host reconciliation.
A sign-in gate after dispatch cannot create a new executable approval under the same operation ID.
A replay returns the saved terminal event and guarded model result. It does not invoke the tool body.
The kernel owns no durable database. React's handler creates this coordinator from its atomic session store.
Its version 3 state retains ready, running, settled, and uncertain operations.
Each gate belongs to its issuing profile. A different profile cannot consume it through a shared session store.
The operation record owns the retained outcome; no separate cache can contradict it.
The memory store protects unresolved authority from idle and capacity eviction.
Pre-body validation hooks must be read-only or independently idempotent. Types do not prove that restriction.
These claims prevent automatic duplicate dispatch. Destination idempotency and reconciliation remain host responsibilities.

**Activity labels.** A tool's `labels.activity` and `labels.activityPast` say what
a call is doing and what it did, in the tool's words: `'Saving {title} to your
collection'`. Each `{path}` is a dot path into the call: the kernel fills it from
the input, then the output (`{results.0.name}` steps into a list by position).
Only text and numbers fill a placeholder. Text collapses its whitespace and is
shown whole; numbers keep at most two decimals. A **count** is a placeholder
with two words after its path: `{results.length hit|hits}` shows "1 hit" or
"3 hits". English plural rules pick the word, so 0 takes the second word. A
count fills only from a number. A third part is its fallback:
`{results.length hit|hits|some hits}`. The kernel does not shorten a
label. A host that needs a shorter label shortens it on its own page. The `running` phase carries
`activity` filled from the input, and `complete` carries `activityPast` filled from
the input and output. When a placeholder has no such value, the phase carries no
label and the transcript names the tool in words instead.

A label is one line, or a **list label**: a list of lines that the kernel reads
from the top. The kernel shows the first line that fits. A line fits when each
`{path}` has a value or a fallback, and its condition holds.

```ts
labels: {
  activity: [
    'when status is archived: archiving {title}',
    '+ renaming {title} to {new_title}',
    '+ moving {title} to {shelf}',
    'saving an item',
  ],
}
```

- A condition opens the line: `when <path> is <value>:`. It compares the
  input the model sent. The words are `is`, `is not`, `is null`, and `and`.
- `is null` holds only when the model sent `null`. `is not` is the opposite of
  `is`, so it holds for a field the model did not send.
- Neighbouring lines that open with `+ ` show together. The kernel joins each
  line that fits: "renaming A to B and moving A to C".
- The last line must always fit: no condition, and a fallback on each `{path}`.

`registerTool` throws a `config` error for a list label that cannot work. It
names the line. The causes are: a last line that does not always fit, a line
below one that always fits, a condition that names no input field, a condition
that compares a value the schema never allows, and a line that opens with
`when` and has no readable condition. Any label is refused for a count with one
word, or a count of a field the schema says is not a number. A one-line label can also open with a
condition. When the condition does not hold, the transcript names the tool.

`labels.activityFailed` says a call did not happen: `'Couldn't save {title}'`,
filled from the input as the model sent it. Every `error` phase carries it in
`activityPast`, and so does a `complete` phase a `post_tool` handler labelled
failed (`labelFailed`, see [`stages.md`](stages.md)). A tool with no failed
label, or one whose placeholder has no value, shows the labels'
`tool.activity_failed` line: "Couldn't complete", then the tool's name in words.

`labels.request` says what a gated call would do, as the rest of "@agent wants
to …": `'check the weather in {city}'`. The kernel fills it from the input onto
the gate (`ToolGate.request`) of a permission or confirmation gate, beside the
tool's `access`; the approval card names the tool in words when the request is
unset or a placeholder has no value.

Builtins (`type: 'builtin'`) are provider-native — kernel pins them in
`generation.builtins` but does not execute handlers.
Function tools (`type: 'function'`) run host TypeScript handlers.
A handler returns the type of the tool's `output` schema; any other return type fails to compile.
A handler that cannot type its result returns `uncheckedOutput(value)`.
A function tool with `answeredBy: 'page'` receives its result from the page.
A trusted host can supply `ToolContext.page` as a read-back value. It cannot claim an effect that happened before coordination.
With `PageToolExecution`, the kernel claims execution, issues a dispatch grant, and waits for its correlated result.
Confirmation gates retain `preparedArguments` when a check changes input before approval.
An unchanged approval uses these arguments. An edited approval runs the tool check again.
Permission and sign-in approval run checks that did not run before the gate.
The page receives final prepared input. Its result remains untrusted and passes the same output checks as a function result.
Without that service, a turn can emit a page gate. The built-in clients refuse to execute callbacks from that gate.
A live session without that service returns `tool.page_no_answer` for an unanswered call.
A timed-out browser result produces `tool.page_timed_out`. It does not restore an approval.
A function tool with neither a handler nor `answeredBy` does not register.
The kernel checks every result against `output`, and a mismatch fails the call as `invalid_output`.
Declarative HTTP tools (`type: 'http'`) call REST APIs directly with templated URLs, query parameters, headers, and body mapping.
A `read-only` HTTP tool is sent again after a network error or a 408, 429, 500, 502, 503, 504 or 529 status, on the same waits and limits as a model call (`docs/contracts/providers.md`). A `read-write` or `destructive` one is sent once.
Remote MCP tools (`type: 'mcp'`) call external Model Context Protocol servers over Streamable HTTP.
The preferred revision is `2026-07-28`; the kernel negotiates downward through
`MCP_PROTOCOL_VERSIONS` (`2026-07-28` → `2025-11-25` → `2025-06-18` → `2025-03-26`)
when a server rejects an unsupported protocol version (JSON-RPC or HTTP error body).
Calls are stateless. A server that answers `400` naming `Mcp-Session-Id` gets a
session: `initialize` at `2025-11-25` (no redirects followed, no client
capabilities, only the session ID and version read back), then
`notifications/initialized`, then the call. Sessions live in memory on the
scope's tool registry (`tools.mcpSessions`), keyed by server URL and a SHA-256 of
the credential headers, and kept with no limit unless the tool sets `session`:
`idleMs` drops a session left unused longer than that, and `max` drops the
tool's least recently used sessions past that count. They are never persisted. The ID travels as an origin-bound header, must be 1–256
visible ASCII characters, and stays out of events. A `404` in a session reopens
it once; a second fails the call with `mcp_session_expired`.
An MCP result is read as its `structuredContent` when that passes the tool's
`output` schema, else as its text blocks joined (a `resource` block's `text`, a
`resource_link`'s `uri`) and parsed against `output`. `image` and `audio` blocks
with base64 `data` and a `mimeType` become the call's media parts: they ride
the model's result as `parts` and the `complete` event as `parts`, and a
`post_tool` edit that replaces the output keeps them.

HTTP and MCP tools, and function tools that declare `auth`, integrate with:
- **Network Guardrails** (`guardrails.network`): SSRF protection blocking loopback and private subnets unless `allowPrivateNetworks: true` is configured. Owned by the guardrails contract — see `docs/contracts/guardrails.md#network`.
- **Stateless OAuth 2.1 & PKCE** (`src/kernel/auth`): RFC 7636 PKCE S256, RFC 9728 discovery, RFC 8414 AS metadata, RFC 9207 `iss` mix-up defense, RFC 8707 resource indicators (a token is only sent to URLs inside its resource — `tokenAudienceCovers`), and stateless state envelopes (`v1.salt.iv.ciphertext`) encrypted with AES-256-GCM under a per-state key derived by HKDF-SHA256 from a ≥32-byte, 256-bit-entropy secret and a fresh salt, with the version authenticated. Every flow's token is bound to its `resourceServerUrl`; `redirectUri` (https, loopback http, or reverse-domain app scheme, no fragment), `clientId` (a URL must be https), scope tokens, and `stateTtlMs` are validated. The envelope carries the SHA-256 of a required host `sessionBinding`, and the exchange refuses a callback whose session doesn't match it (login CSRF, RFC 6749 §10.12). The PKCE verifier never leaves the envelope. Discovery and token requests are network-guarded and never follow redirects.
- **Unauthenticated Handling**: Gates the turn via `ToolGate { kind: 'auth' }` (`tool.phase: 'gate'`, `stop.kind: 'gate'`) or reports synthetic error findings to the model per `onUnauthenticated: 'gate' | 'report_to_model'` (default `gate`). `'fail'` fails the call `not_authorized` (kind `auth`), for a key the host holds that no person can sign in to replace; a refused key fails the same way, as a call that started.
- **Sign-in**: a tool that signs in names its `auth.service` (the service as the person knows it); registration refuses one without it. The auth gate carries it, and its `readBack` is the `sign_in.pending` note. A live session holds a sign-in gate for its decision as any gate, or with `signInGate: 'answer'` answers the model with that note at once and releases the call, for a host whose sign-in finishes outside the session; the outcome, or `sign_in.expired` after `gateTtlMs`, reaches the model as the call's next result. A call the person signed in for (`resume.signIn` on a grant) has its result read after the `sign_in.done` note; a refused one reads `sign_in.declined`, or `sign_in.expired` for the `expired` cause.
- **Refused credentials**: a 401 to a request that carried a credential settles per `onUnauthenticated`: by default it gates for a new sign-in. A 403 `insufficient_scope` (RFC 6750) gates when every scope it asks for is one the tool declares in `auth.scopes`; otherwise the call fails `out_of_scope` with the `sign_in.out_of_scope` note, and a `progress` event `{ kind: 'auth_scope_refused', slot, requested, declared }` (`theorem.auth.scope_refused` on the tool span) records what was asked. Only well-formed scope tokens are read from the challenge.
- **Token Rotation**: Proactively refreshes expiring OAuth tokens during turns. The refreshed credential goes to the host's source with `set(slot, credential)`, and the call goes on only once that resolves, so a rotated refresh token is persisted before it is used; a `progress` event `{ kind: 'auth_token_refreshed', slot }` records it, and no token rides the event stream. Concurrent calls holding the same grant share one refresh. A confidential client's secret comes from the source's optional `clientSecret(clientId)` at refresh time and is sent in the token request body; it is never on the stored credential. A refused refresh emits `{ kind: 'auth_token_refresh_failed', slot }` with the server's text in `errorInternal` only; the model and the gate read fixed text. An OAuth credential without a `resource` is not sent anywhere; the call is unauthenticated.
- **Credential echo**: a tool response repeating the credential value it was sent with has it replaced by `[omitted - credential]` in the output, the model finding, and failure text.
- **API key in the URL**: for a service that takes its key as `?key=…`, `auth.queryParam` names the query parameter the key goes in, and the key goes in no header. Only an `api_key` tool sets it, with no `headerName` or `headerPrefix`, and not as one of `mapping.queryParams`; registration refuses anything else. The key joins the URL after the network checks, on every request of an HTTP or MCP call and on each `signedInFetch` of a function tool, and its echoes are omitted as for any credential. MCP sessions are keyed by a hash of the URL and headers, so the key is never held.
- **Function tools that sign in**: a function tool may declare the same `auth`. The kernel resolves it at the same point (after permission, before `preTool`) with the same gate, refresh, and `onUnauthenticated` rules, then hands the handler `ctx.signedInFetch(url, { method, headers, body })`: a guarded fetch that sends the credential to the URL's own origin only, never across a redirect, and an OAuth token only inside its `resource`. The handler never holds the credential. A 401, or a 403 `insufficient_scope`, throws `CredentialRefusedError` (exported so a handler that wraps its own errors can rethrow it untouched) out of `signedInFetch` and settles as under **Refused credentials**; any other response reaches the handler. Echoes of the credential in the output or failure text are omitted as for remote tools.
- **Endpoint templates**: the scheme and host are fixed text; a placeholder there is refused at registration and at call time, so tool input never chooses where a credential goes.
- **A service's limit**: an HTTP tool may declare `limit: { requests, windowMs }`, the most requests its service takes from one key in a window; registration refuses anything but a whole number of requests above 0 in a finite window above 0. Each call takes one place in the tool's window (its retries and redirects included) and holds it from send until a window after its answer, so requests the network delivers unevenly still land within the limit. A `429` with `Retry-After` holds every call of the tool until then. A call waits for a place at most the same five seconds a retry may; past that it sends nothing and fails `rate_limit_window` (kind `rate_limit`). The window belongs to the registered tool, so each scope's tool has its own.
- **A service's timeout**: an HTTP tool may declare `timeoutMs`, how long its service may take to answer, its body read included; registration refuses anything but a finite number of ms above 0. It starts at send, so a wait for a place in the limit is not counted. Past it the call fails `timeout` (kind `timeout`) and its place frees as if answered. Left out, a call waits as long as the caller's signal lets it.
- **A response's size**: an HTTP or MCP tool may declare `maxResponseBytes`, the most of a response body the kernel reads; registration refuses anything but a whole number above 0. Past it the kernel stops reading and the call fails `response_too_large` (kind `bad_response`). Left out, the kernel reads the whole body, however large, and holds it in memory.

Catalog `conflictsWith` is an optional mutual exclusion on registered builtins: the kernel drops a builtin when a turn also carries one it conflicts with. For example, `googleMaps` sets `conflictsWith: ['googleSearch', 'urlContext']`.
MIME classification (`MEDIA_INPUT_KINDS`, `ATTACHMENT_ACCEPT_MIMES`, …) lives in
`schema.ts`. Tool catalog constants: `TOOL_LOAD_TIERS`, `TOOL_ACCESS`,
`TOOL_PERMISSION`, `TOOL_TYPES`, `HTTP_METHODS`, `TOOL_AUTH_TYPES`,
`AUTH_UNAUTHENTICATED_POLICIES`. `src/kernel/tools/types.ts` imports those unions
for `HttpToolDef` / `ToolAuthConfig` and re-exports them — do not redefine
closed unions in the tools module.

## Outputs and guardrails

Profile `outputs` pins behavior the kernel enforces before the protocol runs:

| Pin | Effect |
| --- | --- |
| `structured` | Schema id or slot-mapped ids. Sent as the response format, or as the answer tool's input when the turn has function tools ([Structured output](#structured-output)) |
| `streaming` | `mode`, `streamThoughts`. Under `sse`, the reply, tool calls, and tool output stream as they are written, each piece checked first; thinking streams unless `streamThoughts` is `false`. Under `buffered`, each arrives whole |
| `validation` | Field validators, `maxRetries` (repair guidance is the labels' `repair.default_guidance`) |

### Structured output

A structured turn gets its output in one of two ways. The turn's function tools pick the way (`answersByTool`).

| The turn has | The request carries | The structured output is |
| --- | --- | --- |
| No function tools | The schema as its response format | The reply's JSON |
| Function tools | The answer tool, whose input schema is the profile's schema, and no response format | The input of the answer tool's call |

Use function tools and a schema together when the agent must do work before it gives its structured answer. Many endpoints refuse a response format beside tools, and many models given both write JSON at once and call no tool. The answer tool avoids both.

On a turn that answers by tool:

- Text the model writes is progress. It streams as `text`, and the reply gate reads it.
- The answer tool's call is not a tool call to the host. Its drafts go out as `structured_draft`, read at `reply_structured`. Its input is the `structured` event.
- The call ends the turn. Other calls in the same step do not run.
- The step that `turnBehaviour.atStepLimit: 'answer'` leaves without tools still has the answer tool.
- A turn that ends without the call is repaired while `outputs.validation.maxRetries` has a retry left. The repair's rejection is the label `structured.answer_missing`. With no retry left, the turn fails with a `bad_response` error and the stop `provider_error`.
- The tool's description is the label `structured.answer_tool`.
- A profile with `outputs.structured` cannot offer a tool of its own named as `ANSWER_TOOL`. The turn throws a `config` error.

On a turn that answers by response format, a reply that does not parse is repaired like any other reply that fails validation, while `outputs.validation.maxRetries` has a retry left. The repair carries the reply's text and says what went wrong:

- A reply cut at `length` has the rejection `structured.cut_off`.
- A reply that ended but is not valid JSON has the rejection `structured.not_json`.

With no retry left, the turn ends as it would without validation: at `length` with no `structured` event, or with the `bad_response` error and the stop `provider_error`.

Top-level modality pins (after `model`, not under `outputs`):

| Block | Effect |
| --- | --- |
| `image` | Optional aspect ratio, resolution, mime, max input images (type `'image'` only) |
| `speech` | TTS voice + `format` (unset sends none, so the provider picks; `pcm` → WAV; the kernel holds the `SPEECH_AUDIO_FORMATS` vocabulary; Gemini speech takes only `pcm` and its provider refuses `mp3`) (type `'speech'` only) |
| `live` | Voice, VAD, transcription, sessionResumption, contextCompression (type `'live'` only; omit → provider defaults) |

### Live profile (`type: 'live'`)

Live is a **session** contract (`runSession`), not a turn contract (`runTurn`). The profile shape is intentionally smaller than text/image:

| Block | On live? | Notes |
| --- | --- | --- |
| `identity` | yes | `handle`, `conditions`, `system` / `systemByRole` |
| `model` | yes | A binding whose protocol has a `live` endpoint, such as `geminiLive` |
| `live` | yes | Voice, VAD, transcription, resumption, compression, **`ingress`** (realtime mic / camera / text toggles; text off unless `ingress.text: true`) |
| `tools` | yes | `{ allow: ToolId[]; parallel? }` — `parallel` orders a step a host runs through `invokeToolStep`. Every allowlisted id and every model `builtInTools` id is wired once at Gemini Live setup regardless of `loadTier` (declarations cannot be added mid-session, so on live every allowed tool is effectively T0) |
| `guardrails` | optional | Canary, sanitize, egress (live outbound gate) |
| `inputs` | **no** | Turn file attachments — use `live.ingress` for realtime channels instead |
| `outputs` | **no** | No structured JSON or SSE/buffered turn streaming on Gemini Live |
| `turnBehaviour` | **no** | Use `live.sessionResumption` + `SessionRequest.providerState` |
| `tools.t1Policy` / `tools.t2Loader` | **no** | Declarations are fixed after setup; the whole allow list is the session declaration set |

### Host profile (`type: 'host'`)

A `host` profile is the explicit tool ceiling for host-driven execution — MCP
servers, web UIs, schedulers — and never runs a model. `invokeTool` under a
`host` profile executes any tool in `tools.allow` with no visibility or loading
tiers and no path gating; `preTool`, permission/auth **gates**, and the
tool-result guardrails (`resolveGuardrailPolicy(profile.guardrails)`) apply
unchanged.

`guardrails` on a host profile is `HostGuardrailsSpec` — a `Pick` of the one
guardrail vocabulary, not a second hierarchy. It carries only the switches that
fire on the `invokeTool` path: `detect` (the
detectors run over model-supplied arguments, tool result text, and tool failure
text) and `network` (SSRF clearance for declarative HTTP and MCP targets)
(`HOST_GUARDRAIL_FIELDS`). `defineProfile` throws a `TheoremError` naming the field for
`guardrails.quota` and `guardrails.egress`: a host profile
runs no model, so quota counts nothing, and egress gates user-visible model text in the turn runner, which a
host profile never enters.

| Block | On host? | Notes |
| --- | --- | --- |
| `tools` | yes | `{ allow: ToolId[]; parallel? }` — registered custom tools (`function`, `http`, `mcp`; `HostProfileToolsSpec`); builtins are rejected. `parallel` orders an `invokeToolStep` |
| `guardrails` | optional | `HostGuardrailsSpec` only — `detect`, `network` |
| `observability` | optional | Same shape as every other profile |
| `models` / `identity` / `inputs` / `outputs` / `turnBehaviour` / `key` / `maxSteps` | **no** | `registerProfile` rejects them when supplied |

`invokeToolStep` runs several of the host's calls as one step, the way a turn
runs the model's calls: every call the step names itself (no `callId`) is
announced first with one `stepId` (a model's call was announced by its turn), then
they run side by side with `tools.parallel: true` or one at a time in the order
given, and a call whose `pre_tool` answers `waitFor` starts once those calls in
the step settle (a name outside the step fails as `wait_unknown`, a wait that
cannot end as `wait_cycle`). Each call's events arrive as it gives them; its
terminal `tool` event says it settled. The calls share one snapshot. A call that
gates waits for its approval while the others finish, and the step's `done`
then stops `gate`; that call resumes on its own through `invokeTool`. A live
host runs the calls of one model message, which carry one `stepId`, this way.
Every call of a step also carries `stepCallCount`, how many calls the step has,
so a host knows the step is whole once it has seen that many announced.
`invokeTool` runs one call with no step: its `pre_tool` sees no step calls and a
`waitFor` fails as `wait_unknown`.

`runTool` and `runToolStep` run the same invokes for a host that wants only how
each call ended. `runTool` resolves to the call's terminal `tool` event
(`complete`, `gate`, or `error`) with every event the invoke emitted and the last
`running` activity label (`ToolCallResult`). `runToolStep` yields each call's
result as it settles, with its place in `calls` and only its own events
(`ToolStepCallResult`). Each call's id is chosen before the invoke starts, so a
call the step names itself is matched by id, not by the order it was announced.
A call that never settled ends as `invoke_failed`, of the kind the invoke's own
`error` event gave, else `internal`. A throw from the invoke rejects as it does
for `invokeTool`.

Each `invokeTool` writes its own trace record, rooted at `execute_tool {name}`
under the request's `traceparent`, with `conversationId` as
`gen_ai.conversation.id`, `links` as span links (for example to the paused turn
it resumes), and `metadata` stored on the record untouched. An `invokeToolStep`
writes one record rooted at `tool_step {profile}`, with an `execute_tool {name}`
span per call under it. The `host` slot is
never recorded. A `resume` sets `theorem.tool.approved` to the answer it
carried. See [observability.md](./observability.md#trace-records).

A browser reaches a host through `createTheoremHostHandler`
(`@theoremjs/web/server`) and `<TheoremHost />`. For a host the tools are the
interface, so its `describe` is the one exception to tool ids only: each
allowed tool's name, description, kind, access, permission, and input and
output JSON Schema (`hostInterface`), never its endpoint, headers or
credentials. `interfaceFromProfile` still refuses a host.

`resolveTurnTools` for a host profile yields `gated = visible = executable =
tools.allow`, `builtins = []`, and `wire` from `buildWire`. `expandT1Policy`,
`promoteLoadedTools`, and the T2 loader promotion are no-ops. `ModelProfile`
(`Exclude<Profile, HostProfile | DecisionProfile>`) names every type that runs
a model turn (a decision profile binds one model but runs through `runDecision`); `requireModelProfile` narrows to it and throws for `host` and
`decision`.

Profile `turnBehaviour` (top-level on chat/image/speech):

| Field | Effect |
| --- | --- |
| `resumption.allowContinue` | Stops after which the host offers the user a Continue (`isResumeableStop`); host UI policy, not enforced on `continueFrom`; omitted → all three; `[]` → none |
| `resumption.autoContinue` | Stops continued without asking; omitted → length and stream_incomplete, `[]` → none. When set, a text turn sends a listed failed model call again itself ([Resume policy](#resume-policy)); the host continues the rest once on its own |
| `resumption.maxContinues` | How many times one reply may be continued (enforced); omitted → no cap. Also how many failed model calls one text turn sends again itself; omitted → one |
| `allowSteering` | **Text and live.** Gates **inject** via `profileAllowsInject` / stages. Stage events always emit. Image/speech must omit |
| `atStepLimit` | **Text only.** What the last model call under `maxSteps` may do. Omitted or `'stop'`: it may call tools; if it does they run and the turn ends with stop `step_limit` and no answer (no `before_end`, no `done.tools`, no `providerState`). `'answer'`: that call is sent with no function tools and no builtins, so it writes the answer from the turn's history. Rejected with `maxSteps: 1` |

Stop / cancel is not a profile field: composer `ProfileInterface` always projects `canStop: true`
(`TurnRequest.signal`). Text interfaces also project resolved `allowSteering`.

### Mid-turn steering

**Branch:** stage events + `onStage` — [`docs/contracts/stages.md`](stages.md).
Text and live mid-turn / mid-cycle inject use stages (`onStage`). Tool `pre_tool`
gates and `LiveSession.executeTool` are on the same contract.

On text turns the runner always yields `{ type: 'stage', stage }`:

1. `pre_turn` — once before the first provider step.
2. `post_tool` — per tool call, before its terminal `tool` event (inject window before the next model step; may `deny` / `mutate` the result).
3. `before_end` — before egress/validation; an inject lands after the answer the model wrote and may re-enter the step loop under `maxSteps`.
4. `post_turn` — after terminal `done` (sees compaction-after when attached).

Inject applies only when `profileAllowsInject(profile)` (text + live when
`allowSteering !== false`). Where a named inject lands, the runner yields
`{ type: 'stage', stage, injected: [{ id, messages }] }` (see [stages.md](stages.md)).

A text turn's opening input (`input.text`, attachments, voice) has one owner:
turn history. It becomes the last user message of history when the turn opens,
with or without `onStage`, so stage handlers see it in `history` and every tool
result, inject, and repair lands after it on every provider. Providers get
`input: []` on text turns. Image and speech turns are a single call that reads
only the input, so they keep it there.

```ts
for await (const event of runTurn({
  profile: 'my.agent',
  input: { text: 'first message' },
  onStage: ({ stage }) => {
    if (stage === 'post_tool' && pendingFollowUp) {
      return { inject: [{ role: 'user', content: pendingFollowUp }] };
    }
  },
}, hostOptions)) {
  if (event.type === 'stage') {
    // UI: safe point to flush a client-held follow-up via host onStage
  }
}
```

Orchid-style durable absorb belongs in the host `onStage` implementation (claim/accept/consume), not in the kernel.

Profile `guardrails`:

| Flag | Effect |
| --- | --- |
| `quota` | Host HTTP helper only (`@theoremjs/agents/guardrails`); not enforced inside `runTurn` |
| `canary` | Canary token at the end of the system prompt, the same for the same prompt; egress checks leakage unless the model was given it this turn |
| `detect` | What each detector does with a match at each boundary: `ignore`, `flag`, `redact`, or `block` |
| `blockedReply` | What happens to a reply a detector blocks: `onBlock` (`retry`, the default, or `refuse`) and `maxRetries` (default 1) |

## Compaction

Optional per-model policy on `ModelBinding.compaction`. Kernel owns trigger, split,
and timing; host owns persistence/reassembly unless `timing: 'before'` runs the
compactor inline. History tokens come from the host (`input.historyTokens`) or
the shared token estimator (below).

```ts
compaction: {
  maxTokens: 2000,
  compactAt: 0.75,
  previousExchanges: 8,
  profile: "my.compactor", // leave out to compact itself
  timing: "after",
  meter: "history",
  trigger: (ctx) =>
    ctx.tokens > ctx.compactAt * ctx.maxTokens || hostRamPressure(),
}
```

### Meter

| Value | Counts |
| --- | --- |
| `history` (default) | `input.historyTokens` or local estimate of `history` only |
| `input` | Full prompt: the turn's last model-call `tokens.input` (after), else `input.inputTokens` (before, or after with no call count) |

With neither count positive, compaction does not fire and `trigger` is not
called. `tokens` events always stream; they gate compaction only when
`meter: 'input'`. The `input` meter's estimate, when the provider reports no
count, covers the whole prompt: current-turn media, system, tools, and schema.
`done.compaction.promptTokens` carries the last call's input tokens under either
meter; when that side is `estimated`, it is the estimate and
`promptTokensEstimated` is `true`. Under `meter: 'input'`, `unknownMedia`
carries the prompt media the estimate left out.

### History estimate (`meter: 'history'`)

1. Host `historyTokens` wins when set.
2. Else estimate from `input.history`:
   - **Text** — UTF-16 code units divided by four, rounded up per string,
     over content, text parts, tool-call names, and arguments. This is a rough
     estimate for every model family. `TOKEN_TEXT_ENCODING` identifies the
     method as `chars/4`; the name remains for API compatibility.
     `loadTokenEstimator` keeps its async API and loads no tokenizer data.
   - **Media** — not counted. Each media part is left out of `tokens` and counted in
     `unknownMedia` on `CompactionTokens`, `CompactionSignal`,
     `CompactionTriggerContext`, and the `compaction` event. Code:
     `src/kernel/engine/token-estimate.ts`.
   - Current-turn attachments/voice are **not** history.

### `previousExchanges`

| Value | Retain |
| --- | --- |
| `≥ 1` integer | That many recent user-started exchanges |
| `(0, 1)` fraction | Tail fitting in `fraction * maxTokens` (must be `< compactAt`), by the estimator; unknown media counts as 0 |
| `0` | Compact everything |

### Compaction profile

A compaction profile is a registered text profile that takes text. Minimal
summarizer:

```ts
registerProfile(defineProfile({
  type: "text",
  id: "my.compactor",
  identity: {
    handle: "Compactor",
    system: "Summarize this conversation concisely. Preserve unresolved issues, "
      + "decisions, and key facts.",
  },
  models: { summarizer: summarizerBinding },
  key: "main",
  maxSteps: 1,
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: "my.summary.schema" },
  guardrails: { detect: 'ignore' },
}));
```

Leave `profile` out and the agent compacts its own history. The summary turn
runs on the model being compacted for, with the agent's own instructions and no
tools, so the agent writes the summary as itself. Only a text profile that
takes text can compact itself, and that summary turn never compacts.

Compaction applies to `runTurn` profiles (`text`, `image`, `speech`);
`live` compacts with `live.contextCompression`.

### What the compactor reads

The compactor gets `toCompact` as its history, with the labels'
`compaction.request` as its input:

- Media its `inputs` do not accept is left out and counted in `droppedMedia`;
  a message left with nothing is skipped. Its byte limits are not applied to
  history, so `maxTokens` must fit the compactor's context.
- Tool calls and results become assistant text (`compaction.tool_call`,
  `compaction.tool_result`) naming the tool, so no provider needs the tools
  declared. A result's files follow it in a user message led by
  `compaction.tool_files`, because Chat Completions takes only text in
  assistant content.
- An earlier summary in `toCompact` is summarized with the rest.

A completed, non-empty reply is the summary: the structured output as JSON,
else the text. It replaces `toCompact` as an assistant message with
`metadata.compactionSummary: true`.

### Outcomes

Anything else is a failure: a stop other than `completed`, an `error` event, a
thrown error, or an empty reply. When everything in `toCompact` is media the
compactor does not take, it does not run and that is a failure too. A failure
never leaves a partial summary.

| `outcome` | History after |
| --- | --- |
| `compacted` | The summary, then `toRetain` |
| `deferred` | Unchanged: the compactor failed and the metered count is within `maxTokens`, so the next turn tries again |
| `dropped` | Earlier summaries in `toCompact`, then `toRetain`: the compactor failed over `maxTokens` |

`failure` carries the compactor's `stop`, `error` kind, `empty: true`, or
`unreadable: true`. When the compactor threw or reported an error,
`failure.errorInternal` holds why, for the builder only: `forClient` strips it
for a visitor.

Errors only the host can fix are thrown, not failures: a compactor that throws
or reports a `config`, `request`, `auth`, or `internal` error throws it from
`runTurn` before the turn's model call, or from `compactHistory`. The host's
abort is not a failure either: the turn ends `cancelled`, with no `compaction`
event. The `theorem.compaction` trace event records `outcome`, the message
counts, `dropped_media`, `failure_stop` / `failure_error` / `failure_reason` / `failure_empty` /
`failure_unreadable` and the `summary`; `gen_ai.conversation.compacted` is set only on
`compacted`.

### After-turn signal

```ts
for await (const event of runTurn(req, hostOptions)) {
  if (event.type === "done" && event.compaction?.needed) {
    const { history, tokens, unknownMedia, meter, promptTokens, promptTokensEstimated } =
      event.compaction;
    const result = await compactHistory(
      { profile: req.profile, model, history, tokens },
      hostOptions,
    );
    if (result) persistHistory(result.history);
  }
}
```

`compactHistory` runs the compactor on the history `done.compaction` carried,
with the same split, reading, outcomes, and trace event as `before`, in a trace
of its own (`traceparent`, `conversationId`, and `metadata` join it to the
turn's). `model` defaults to the profile's default model, which must have
`compaction`. It returns `CompactionResult` (`outcome`, `toCompact`,
`history`, `summary` / `failure`, `droppedMedia`, the compactor's `tokens`),
or `undefined` when the split leaves nothing to compact. The compactor resolves its registered binding.

No signal is attached when the turn has no history. `timing: 'before'` emits no
`compaction` event when the split leaves nothing to compact.

### Compaction exports

| Export | Role |
| --- | --- |
| `CompactionSpec` / `CompactionMeter` / `CompactionTriggerContext` | Config types |
| `CompactionSignal` | `done.compaction` payload |
| `compactHistory` / `CompactHistoryRequest` / `CompactionResult` / `CompactionOutcome` / `CompactionFailure` | Run the compactor after the turn |
| `CompactionSplit` / `CompactionTokens` | Split + resolved counts |
| `compactionMeter` / `resolveHistoryTokens` / `resolveCompactionTokens` | Meter resolution |
| `loadTokenEstimator` / `TOKEN_TEXT_ENCODING` / `TokenEstimator` / `TokenCount` | Shared token estimator (text heuristic; media is not counted) |
| `sumTokens` | Total of several calls' `TurnTokens` (see Token usage) |
| `compactionNeeded` / `shouldCompact` | Threshold / custom trigger |
| `splitForCompaction` | `{ toCompact, toRetain }` |

Register-time validation: `maxTokens`, `compactAt`, `previousExchanges`, `profile`, and `timing`
are set, `maxTokens > 0`, `compactAt ∈ (0,1)`,
`previousExchanges ≥ 0`, an integer when `≥ 1` and `< compactAt` when fractional, meter ∈ `{history,input}`,
compaction profile registered first and a text profile that takes text.

## Prompt cache (OpenRouter)

The `openRouterOpenAi` protocol validates per-model `options.cache`:

```ts
options: { cache: { mode: "automatic" | "system", ttl?: "5m" | "1h" } }
```

- `automatic` — top-level `cache_control` on the OpenRouter request.
- `system` — `cache_control` on the system instruction only.
- Omit — no opt-in (some upstream models may still auto-cache).

Pass `TurnRequest.sessionId` for OpenRouter sticky `session_id` routing.
`TurnTokens.cached` / `cacheWrite` report provider cache read/write when present
(Google Interactions implicit hits via `total_cached_tokens` included; OpenRouter
`prompt_tokens_details.cached_tokens` / `cache_write_tokens`).

## Stop and resume

`TurnStopKind` values are the `TURN_STOP_KINDS` array in `src/kernel/schema.ts`.
Providers map native finish reasons into `TurnStop` on terminal `done` events.
Its shape is `turnStop` in `src/kernel/turn-events.ts`; `src/kernel/stop.ts`
re-exports the type and owns only the resume policy below.

| `kind` | Meaning |
| --- | --- |
| `completed` | Normal completion |
| `length` | Output / budget cut off |
| `tool` | The model called tools and the turn hands them to the host; `done.tools` is the turn's tool snapshot |
| `gate` | A `pre_tool` gate (confirm / permission / auth) stopped a call before it ran; `done.tools` is the snapshot. Host resumes via `invokeTool` (live: `executeTool` with a `decision`) |
| `filtered` | Output blocked: the provider's content filter, or a Theorem guardrail (`native: 'egress'` for a reply a detector or the egress policy stopped, withheld, or replaced by policy copy; `'canary'`, `'prompt_echo'`, or `'provider_tool_leak'` for a leak in an event that is not reply text). Only the provider's filter is worded as a stop: Theorem's own stop already shows its error or refusal |
| `provider_error` | Upstream failure: a finish reason that says so, or any `error` the provider sent during the call (it outranks the call's own `done`) |
| `cancelled` | User / host abort |
| `stream_incomplete` | Stream ended without terminal reason |
| `step_limit` | The last model call `maxSteps` allows asked for tools: they ran, and the turn has no answer. `turnBehaviour.atStepLimit: 'answer'` (`StepLimitMode`) sends that call without tools instead |
| `interrupted` | Live barge-in |
| `generation_complete` | Live utterance boundary |

Mappers: `turnStopFromOpenAiFinishReason`, `turnStopFromInteractionStatus`,
`turnStopFromClientStreamEnd` (host SSE drop).

### Resume policy

`allowContinue` / `autoContinue` accept only `ContinueStopKind`
(`CONTINUE_STOP_KINDS`: `length` | `stream_incomplete` | `provider_error`).
`tool` uses host `invokeTool` + `resume`. `cancelled` / `completed` / `filtered` /
live boundaries are not continueFrom-eligible — `defineProfile` rejects them.

```ts
turnBehaviour: {
  resumption: {
    allowContinue: ['length', 'stream_incomplete', 'provider_error'],
    autoContinue: ['length', 'stream_incomplete'],
  },
  // text only — omit on image/speech
  allowSteering: true,
}
```

A text turn sends a failed model call again itself. The call must have stopped as
`provider_error` or `stream_incomplete`, the profile must set `autoContinue` and list
that stop in it, and the call must have given no reply and no tool call. A failure the
same call would meet again is not sent again: only the kinds `busy`, `unavailable`,
`bad_response`, `network`, `timeout`, and `rate_limit` are. A profile
that omits `autoContinue` sends nothing again: the default list advises the host only. The turn waits
`AUTO_CONTINUE_DELAY_MS`, then sends the same step again. Its history, its step
count and the record of what it has read are unchanged, so tool results gathered in
earlier steps are kept. One turn sends at most `maxContinues` calls again, or one
when the profile sets none. The failed call's `error` event is not emitted; the
turn's trace records `theorem.step.resume` with the step, the count, the stop and
the provider's reason. When no re-send is left, the turn ends with that `error`
and stop as before.

A call that gave part of its reply, and a reply cut at `length`, are not sent again
by the turn: the host continues them with `continueFrom`. A structured reply that does
not parse is the exception: validation repairs it ([Structured output](#structured-output)). A `continueFrom` turn is a
new turn, so it starts with no record of what the stopped turn read.

An agent tool's called profile follows the same rule under its own
`turnBehaviour.resumption`. When its turn still fails, the tool's failure message
carries the turn's public error text after the `tool.agent_failed` line.

| Constant / helper | Value / role |
| --- | --- |
| `CONTINUE_STOP_KINDS` | length, stream_incomplete, provider_error |
| `DEFAULT_ALLOW_CONTINUE` | = `CONTINUE_STOP_KINDS` |
| `DEFAULT_AUTO_CONTINUE` | length, stream_incomplete |
| `AUTO_CONTINUE_DELAY_MS` | `1500` — the pause before a text turn sends a failed model call again, and the suggested pause before a host's auto-continue |
| `isContinueStopKind` | Narrow to continue-eligible kinds |
| `isResumeableStop` | Profile `allowContinue` (`[]` allows none) or, when omitted, the default; always false outside ContinueStopKind |
| `shouldAutoContinue` | One silent resume when the profile's `autoContinue` lists the stop, whatever `allowContinue` offers; never outside ContinueStopKind |
| `isUserCancelledStop` | `kind === 'cancelled'` |
| `profileTurnResumption` | Read `turnBehaviour.resumption` |
| `profileAllowsSteering` | Text + `allowSteering !== false` (interface inject projection) |
| `profileAllowsInject` | Stage inject gate: text + live when `allowSteering !== false`; never image / speech / host ([`stages.md`](stages.md)) |

### Native state and portable history

Save the provider checkpoint beside portable history. Pass both on the next turn or session request.
`providerCheckpointSchema` identifies the protocol, provider, model, key slot, connection, and the protocol's continuation options (`compatibilityKey`), and state version.
The kernel records the covered history prefix with its length and hash.

On a mismatch, the kernel emits `provider_warning` (`provider_state_rebuilt`, with a reason) and rebuilds from portable history.
The reasons are `provider_changed`, `model_changed`, `version_changed`, `connection_changed`, `key_changed`, and `history_changed`.
`providerContinuation.history: 'provider'` resumes from the checkpoint alone; the covered-history check becomes "the request carries no history".
`providerContinuation.history: 'stateless'` keeps no conversation: a turn or session request that carries history or a checkpoint is refused with a `request` error, and completion carries no `providerState` (live sessions emit no `provider_checkpoint`). Compatible checkpoints with malformed native data fail validation.
Successful completion carries `providerState`. Live `provider_checkpoint` events also carry the covered portable history.

The live kernel preserves text spacing and final transcriptions that pass the outbound gate.
A rebuilt session with portable history does not repeat the initial greeting.
Native checkpoints do not authorize tool execution or replace tool outcomes.

### Continue turn

```ts
for await (const event of runTurn({
  profile: "my.agent",
  input: {
    history: [...priorHistory, { role: "assistant", content: bufferedAssistantText }],
  },
  continueFrom: { stop: previousDone.stop },
}, hostOptions)) { /* … */ }
```

`GenerationStopError` / `isGenerationStopError` optional throw path for hosts
that prefer exceptions over stream `done.stop`.

## Validation

Beyond compaction rules (above), `registerProfile` / `defineProfile` assert:

- Each `tools.allow` id is a registered **custom** tool (builtins rejected here).
- Each `models.*.builtInTools` id is a registered **builtin**.
- Each key in `models` is a host-named model id with a full `ModelBinding`.
- Profiles with attachments or voice set `maxFiles`, `maxBytes`, `maxTurnBytes`;
  those and every `limitsByMime` value are positive integers.
- Credential slots resolve from model overrides, then the provider registration's defaults.
  The kernel reads the credential from the vault when an operation runs.
- Each `efforts` level is one of `THINKING_LEVELS`. Which of those a model
  takes is not the kernel's to say: the Gemini protocols refuse a level
  outside `minimal`, `low`, `medium`, or `high` (`unsupported`).
- A slot-mapped `outputs.structured` names a slot in `inputs.slots`, and its
  `map` keys are that slot's choice **values**. At turn time `resolveTurn` rejects a slot
  the profile does not declare, or a value outside its choices (`request`).
- Model bindings require a protocol, a registered provider ID, and an upstream model ID.
  The provider must serve the protocol, and the protocol parses the binding's `options`.
- The protocol must have an endpoint for the profile type, or registration fails (`unsupported`).
- Credential-slot overrides are names; the provider registration supplies defaults.
- Protocols cannot manufacture guardrail, approval, stage, or client-tool execution events.
  The kernel refuses any event type outside `ProtocolEvent` (`provider.event_type`).
- Pending tool calls require a valid successful terminal. Turn streams must also reach EOF
  without another event after that terminal.


Runtime structured validation uses `outputs.validation.fields` keyed by dotted
paths; failures can trigger repair turns via `input.repair`.

**Item rules.** `outputs.validation.items` holds a check for the items of one
list, keyed by the list's dotted path (`claims`). `registerProfile` refuses a
path no structured schema reaches as a list with an `items` schema. A refused
item never fails the reply, and the rest of the reply is kept. A check reads the
item and the turn: `turn.toolResults` is every tool call the turn completed
(`{ tool, output }`, in order, across attempts), so a host can hold an item to
what its tools returned, such as a quote to the page that was read.

| `onFail` | What happens to a refused item |
| --- | --- |
| `drop` | It is removed |
| `fix` | The model rewrites the refused items alone, once and while `maxRetries` has an attempt left; an item refused again is removed |

The rewrite is one attempt: it reads only the refused items and each check's
error (`claims[0]: …`, counted among the refused), under a schema that holds
only their lists, so the model does not write the kept reply again. It keeps the
turn's tools and this turn's history. Its guidance is the labels' `repair.items_guidance`.
Rewrites go back by position. Field validators run first; a reply they send back
is rewritten whole.

Removed items leave on the `structured` event as `removed: [{ path, reason, item }]`,
and an agent tool returns them as `removed` beside `structured`, so the calling
model reads what was taken out and why. When item rules change a reply, the
held text of that attempt becomes the kept reply's JSON; text already streamed
is not sent again.

## Headless interface

Framework-neutral helpers for profile-driven runtime UIs, published at
`@theoremjs/agents/interface`. `@theoremjs/react` renders them.

`ProfileInterface` is `Profile` as JSON, what a host sends the browser:
resolved `inputs` (with `acceptAttr`), tool ids (`ProfileToolsView`: `allow`, and `page` for the
tools the page answers; a tool's definition, including its endpoint, and headers, stays on the host), and
`models`, `outputs`, `guardrails`, and `observability` without host functions
(`ModelBindingView` drops a compaction `trigger`; `ProfileOutputsView` drops
`validation`). Projection flows through kernel `projectProfileObject` /
`projectProfile`, then through `profileInterfaceSchema`, its one schema: a
field the schema does not name never leaves the host, and the browser's
transport checks `describe` against the same schema (`bad_response` when it
fails).

| Concern | Entrypoints |
| --- | --- |
| Spec | `interfaceFromProfile(profile, tools)` (projects against that tool registry), `clientProfileInterface(profile, tools)` (the same without `identity.system` and `systemByRole`, for a browser), `interfaceFromProjected` (an already projected profile) |
| Inputs | `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime` |
| Draft | `sanitizeUserDraft`, `prepareUserTurn` |
| Transcript | `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `streamThoughtsEnabled`, `argumentsSoFar(call)` (a call's arguments as far as the model has written them: the whole fields and the string still being written, to preview it live), `stopText(stop, blocks, labels)` (why a turn ended short, in its `stop.<kind>` label; nothing when it ended whole, when a Theorem guardrail stopped it, or when an error block says why), `WORDED_STOP_KINDS` |
| History | `appendUserDraftToHistory`, `appendToolExchangeToHistory` (replays `readBack`), `toolReadBack`, `userDraftToSteerInject`, … |
| Composer intents | `createComposerPendingMessage`, `orderComposerPendingMessages`, `consumeNextComposerSteer` / `Queue`, `convertSteersToFrontQueued`, `resolveComposerPrimary`, `resolveComposerMenuActions` |

`foldTurnEvents` maps kernel `media` events (base64) and also promotes http(s)
image / video / audio URLs found in completed tool `output` into `media` blocks
with `url` set (extension-based MIME guess). Copies of one file are promoted
once: a MediaWiki `/thumb/…/<N>px-` resize and its original share a key
(last two host labels + path, `utm_*` params ignored); the largest copy is
`url` and the smallest, when different, is `previewUrl`. Tool JSON in the tool
block is unchanged. `historyFromTranscriptBlocks` still ignores media blocks — the tool
exchange already carries the URL.

The `observability` view is the resolved policy without functions: `record`,
`sampleRate`, `include`, `scrub`, `resource`, `retainForDays`, `rotateAfterMiB`,
`writeTo` as absent, `false`, a registered id, or `'custom'` for an inline sink, and
`hasOnWriteError`.

A gated call's `auth` (`ToolGateAuth`: `slot`, `authType`, `service`) is the
one shape the kernel's gate answer and the interface's gated-tool context share.

### Composer pending intents

Headless contract for stash / queue / steer (Seance-aligned). Kernel owns stages +
`onStage` inject + `AbortSignal`; the interface owns pending list ops and the action matrix;
`@theoremjs/react` owns UI.

| Intent | Lifetime |
| --- | --- |
| `stash` | Never auto-sent; user promotes |
| `queue` | New user turn after the **agent run fully ends** (not on tool pause resolve) |
| `steer` | Inject at next inject-capable stage via host `onStage` (same run — `docs/contracts/stages.md`) |
| `send_now` | Immediate abort + send (not a pending kind) |

Primary matrix: idle+payload → Send; streaming+empty → Stop; streaming/gated+payload → Queue.
Enter matches primary. Menu offers Queue / Steer / Send now / Stash as applicable.
The run names each steer it took in on a `stage` event's `injected`, by the steer's id and with the messages it added (after the `injected` guardrails). The client drops those from pending; the transcript shows the steer's user messages where the reply took them in, and the history keeps them there, after what the reply said and did before. The steers still undelivered convert to the front of the queue when the run ends.
Tool **gate** does not drain the queue and does not offer Steer (not an inject stage).
Send now while gated walks away from every waiting gate in the message's own
request (`abandon` on the turn request, `walkAway` in `@theoremjs/react`): the
host settles each call cancelled, and the model reads those answers before the
message. Awaiting completions (`ask_user`) are not composer
`gated` — the turn may already be idle; use `awaitingFromEvents`.

```ts
import { interfaceFromProfile, foldTurnEvents, streamThoughtsEnabled } from '../src/interface/mod.ts';

const iface = interfaceFromProfile(profile);
const blocks = foldTurnEvents(events, { showThoughts: streamThoughtsEnabled(iface.outputs) });
```

React or other UI layers map `ProfileInterface` and `TranscriptBlock` to
components; this module does not ship UI.

## Exported API

Live barrel: `src/kernel/mod.ts`. Type surface: `export type *` from
`types.ts` (all public kernel types).

| Group | Symbols |
| --- | --- |
| Compaction | `compactHistory`, `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Token estimate | `loadTokenEstimator`, `TOKEN_TEXT_ENCODING`, `TokenCount`, `TokenEstimator`, `sumTokens` |
| Runner | `registerProvider`, `getProvider`, `listProviders`, `ProviderHostOptions`, `providerCheckpointSchema`, `runTurn`, `runSession`, `runDecision`, `runEmbedding`, `validateDecisionRequest`, `RunSessionOptions`, `SignInGatePolicy`, `RunDecisionOptions`, `RunEmbeddingOptions`, `DecisionError`, `prepareLiveInboundText`, `liveIngressEnabled`, `liveIngressEnabledFromSpec`, `liveIngressChannelDefault`, `hasAnyLiveIngress`, `assertLiveIngress`, `assertLiveIngressConfigured`, `LiveIngressChannel` |
| Providers | `defineProvider`, `registerProvider`, `createProviderRegistry`, `getProvider`, `listProviders`, `listProtocols`, `Provider`, `ProviderDefinition`, `RegisteredProvider`, `Registration`, `ProviderRegistry`, `ProviderTransport`, `Serve`, `PriceTable`, `ModelPrice`, `Rates`, `costFromPrices` |
| Provider sign-in | `Authorize`, `Signer`, `bearer`, `header`, `query`, `KeyCredential`, `ApiKeyCredential`, `BearerCredential`, `RuntimeAbilities`, `endpointUrlSchema` |
| Protocols | `defineProtocol`, `extendProtocol`, `callProtocol`, `checkKey`, `KeyCheck`, `carriesTo`, `modelOptions`, `plainWebSocket`, `Protocol`, `ProtocolDefinition`, `ProtocolExtension`, `ExtensionBodyAt`, `ExtensionReader`, `Continuation` |
| Model bindings | `ModelBinding`, `DecisionModelBinding`, `ModelProfileType`, `ProviderGenerationConfig`, `ProviderBuiltin`, `checkBinding`, `keySlotsOf`, `modelBindingSchema`, `decisionModelBindingSchema`, `commonModelSettingsSchema`, `DecisionModelSettings`, `ModelSettings` |
| Provider data | `JsonValue`, `JsonObject`, `jsonValueSchema`, `jsonObjectSchema`, `EstimatedCost` |
| Provider vault | `KeySlot`, `keySlotSchema`, `KeyVault`, `CredentialContext`, `CredentialResolver`, `OpenWebSocket` |
| Protocol operations | `ProtocolOperations`, `ProtocolContext`, `ProtocolRequest`, `ProtocolCall`, `ProtocolSession`, `ProtocolSocket`, `SendInit`, `Outgoing`, `DecisionCall`, `EmbeddingCall`, `EmbeddingMediaKind`, `EmbeddingModelLimits`, `LiveToolResult`, `UpstreamFailure`, `CallSetup` |
| Provider output | `ProtocolEvent`, `ProtocolContentEvent`, `ProviderCheckpoint`, `ProviderStateRebuilt`, `ProviderWarning`, `ProviderEvidence`, `ProviderContinuationPolicy`, `providerCheckpointSchema`, `providerWarningSchema`, `providerContinuationSchema` |
| Provider limits | `ProviderHostOptions`, `ProviderLimits`, `providerLimitsSchema` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaChannelForMime`, `MediaInputChannel`, `mediaKindForMime`, `getTool`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `registerTools`, `requireModelBinding`, `resetTools` |
| Schema | `PROFILE_FIELDS`, `PROFILE_GRAPH`, `PROFILE_TYPES`, `PROFILE_ID_MAX_CHARS`, `PROFILE_HANDLE_MAX_CHARS`, `EXTRA_FIELDS`, `REQUEST_FIELDS`, `API_EXPORTS`, `ApiExportMeta`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `spineFacetsForProfileType`, `profileGraphFacet`, `ProfileGraphFacet`, `ProfileGraphFacetId`, `ProfileGraphEditor`, `ProfileGraphRole`, `THINKING_LEVELS`, `KEY_SLOT_NAME`, `isKeySlotName`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `IMAGE_ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `COMPACTION_METERS`, `COMPACTION_OUTCOMES`, `COMPACTION_TIMINGS`, `CACHE_MODES`, `CACHE_TTLS`, `TURN_STOP_KINDS`, `CONTINUE_STOP_KINDS`, `TURN_STAGES`, `TURN_INJECT_STAGES`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION`, `TOOL_TYPES`, `AUTH_UNAUTHENTICATED_POLICIES`, `HTTP_METHODS`, `STUDIO_AUTH_TYPES`, `TOOL_AUTH_TYPES`, `AuthUnauthenticatedPolicy`, `CustomToolType`, `HttpMethod`, `StudioAuthType`, `ToolAccess`, `ToolAuthType`, `ToolPermission`, `ToolType`, `ToolGateKind`, `TurnStage`, `TurnInjectStage`, `AwaitingUserInputKind`, `BLOCKED_REPLY_ON_BLOCK`, `BlockedReplyOnBlock`, `ProfileType`, `ThinkingLevel`, `MediaInputKind`, `SummaryMode`, `StreamMode`, `SpeechAudioFormat`, `DEFAULT_RESUMED_AFTER_MS`, `CONTEXT_SENDERS`, `ContextSender`, `LIVE_ACTIVITY_HANDLINGS`, `LiveActivityHandling`, `LIVE_START_SENSITIVITIES`, `LiveStartSensitivity`, `LIVE_END_SENSITIVITIES`, `LiveEndSensitivity`, `CompactionMeter`, `CompactionTiming`, `CompactionOutcome`, `CacheMode`, `CacheTtl`, `STEP_LIMIT_MODES`, `StepLimitMode`, `ITEM_FAIL_ACTIONS`, `TOOL_RESUME_CAUSES`, `ToolResumeCause`, `STAGE_APPLY_WARNING_CODES`, `ToolLoadTier`, `FieldMeta` |
| Utilities | `base64ToBytes`, `bytesToBase64`, `isRecord`, `Equals` (compile-time type equality, for exact-shape checks) |
| Scope | `KernelScope`, `createKernelScope`, `defaultKernelScope`, `KernelRegistry`, `createKernelRegistry` |
| Profile editing | `unsetValue` (what leaving a field out stands for), `outOfScopeFields`, `profileTypesForField`, `systemPromptProblem`, `activityLabelProblem`, `CONTINUE_INSTRUCTION_TYPES`, `jsonSchemaFromZod`, `agentToolInputFor`, `agentToolOutput`, `ToolAuthConfig`, `ToolLabels` |
| Profiles | `ProfileDefinition`, `ProfileDefinitionBase`, `TextProfileDefinition`, `ImageProfileDefinition`, `SpeechProfileDefinition`, `LiveProfileDefinition`, `HostProfileDefinition`, `DecisionProfileDefinition`, `EmbeddingProfileDefinition`, `ProfileRegistry`, `createProfileRegistry`, `clearProfiles`, `defineProfile`, `normalizeProfileInputsSlots`, `normalizeSlotDecl`, `normalizeSlots`, `slotValues`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `projectProfileObject`, `requireModelProfile`, `resolveTurn`, `resolveTurnSystemPrompt`, `systemLinesProblem` |
| Tools | `ANSWER_TOOL`, `ToolRegistry`, `createToolRegistry`, `registerTool`, `registerTools`, `invokeTool`, `invokeToolStep`, `runTool`, `runToolStep`, `SettledToolCall`, `ToolCallResult`, `ToolStepCallResult`, `GATE_DECISIONS`, `GateDecision`, `answerGatedCall`, `GateAnswerRequest`, `HeldGatedCall`, `AnsweredGate`, `ToolGateAuth`, `gateExpired`, `resolveGateTtlMs`, `sessionPermissionsAfterApproval`, `askUserTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `resetTools`, `formatToolResult`, `projectForModel`, `coerceToolResultParts`, `leanToolResultData`, `wireInteractionPart`, `isMediaRefPart`, `prepareTurnToolSnapshot`, `buildHttpToolTarget`, `executeHttpTool`, `executeMcpTool`, `parseMcpRpcResponse`, `isUnsupportedMcpProtocolError`, `MCP_PROTOCOL_VERSIONS`, `mcpRequestMeta`, `McpProtocolVersion`, `resolveToolAuth`, `credentialPlacement`, `withCredentialQuery`, `CredentialQuery`, `ToolContext`, `GateReference`, `gateReferenceSchema`, `executeRegisteredTool`, `McpRpcResponse`, `ModelToolResult`, `PageAnswer`, `CredentialRefusedError` |
| Tool execution | `ToolExecutionCoordinator`, `createMemoryToolExecution`, `MemoryToolExecutionOptions`, `authorizeToolReplay`, `BeginToolOperationResult`, `ToolOperationClaim`, `ToolOperationIdentity`, `ToolOperationOutcome`, `ToolOperationUncertainty`, `toolOperationOutcomeSchema`, `SavedToolInvocation`, `savedToolInvocationSchema`, `toolInvocationHash`, `TerminalToolEvent`, `PageToolDispatch`, `PageToolExecution` |
| Auth (stateless OAuth/PKCE) | `createOAuthPkceFlow`, `exchangeOAuthPkce`, `refreshOAuthToken`, `discoverResourceMetadata`, `discoverAuthServerMetadata`, `validateIssuer`, `tokenAudienceCovers`, `generateCodeVerifier`, `computeCodeChallenge`, `sealStatePayload`, `unsealStatePayload`, `sealSecret`, `openSecret`, `SealSecretInput`, `OpenSecretInput`, `ToolCredentialSource`, `memoryCredentialSource`, `ProtectedResourceMetadata`, `AuthorizationServerMetadata`, `OAuthTokens`, `OAuth2Credential`, `ToolCredential`, `OAuthTransportOptions`, `OAuthEndpoints`, `CreatePkceFlowOptions`, `PkceFlowResult`, `ExchangePkceCodeOptions`, `ExchangePkceCodeResult`, `RefreshOAuthTokenOptions`, `SealedStatePayload`, `toBase64Url`, `fromBase64Url`, `credentialFromTypedSecret`, `credentialForSignInGate` |
| Structured | `SchemaRegistry`, `createSchemaRegistry`, `getStructured`, `registerStructured` |
| Stop / resume | `ProfileTurnBehaviourSpec`, `MediaTurnBehaviourSpec`, `ProfileTurnResumptionSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `ContinueStopKind`, `CONTINUE_STOP_KINDS`, `AUTO_CONTINUE_DELAY_MS`, `DEFAULT_ALLOW_CONTINUE`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isContinueStopKind`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `profileAllowsSteering`, `profileAllowsInject`, `profileTurnResumption`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |
| Stages (target foundation) | `TURN_STAGES`, `TURN_INJECT_STAGES`, `STAGE_AFFORDANCES`, `STAGE_AFFORDANCE_MATRIX`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `applyStageResult`, `awaitingUserInputSchema`, `toolGateSchema`, `isTurnStage`, `isTurnInjectStage`, `isToolGateKind`, `isAwaitingUserInput`, `stageAllowsAffordance`, `stageEventFields`, `profileAllowsInject`, `StageAffordance`, `StageContext`, `StageResult`, `StageMutate`, `StageHandler`, `StageApplyInput`, `StageApplyOutput`, `StageApplyWarning`, `StageApplyWarningCode`, `StageEventExtra`, `AwaitingUserInput`, `ToolGate` — see [`stages.md`](stages.md). Slices 1–3 landed on branch; publish when release cut matches docs. |
| Turn events | `TurnEvent`, `TurnEventOf`, `TurnEventType`, `CallDone`, `DoneFields`, `SessionEvent`, `SessionEventOf`, `TURN_EVENT_SCHEMAS` (each kind's schema, for a wire parser), `turnEventSchema`, `turnHistoryMessageSchema`, `turnToolSnapshotSchema`, `reasoningPartSchema`, `historyHash`, `turnDoneOf`, `keptReply`, `AttemptReason`, `InvalidField`, `z` (the zod these schemas are built with; compose them with it, since two copies of zod do not mix) |
| Interface (headless) | `interfaceFromProfile`, `clientProfileInterface`, `interfaceFromProjected`, `profileInterfaceSchema`, `inputsFromSpec`, `attachmentAcceptAttr`, `validateProfileInputs`, `pickMediaRecorderMime`, `sanitizeUserDraft`, `prepareUserTurn`, `buildUserTurnBlocks`, `foldTurnEvents`, `foldConversationTurn`, `resetBlockIds`, `stopText`, `WORDED_STOP_KINDS`, `WordedStopKind`, `streamThoughtsEnabled`, `collectPromotedMediaFromToolOutput`, `promotedMediaFromUrlString`, `PromotedToolMedia`, `defaultInterfaceEffort`, `effortSelectEnabled`, `generationSelectEnabled`, `interfaceEffortOptions`, `interfaceModelOptions`, `MODEL_SELECT_MIN_MODELS`, `modelSelectEnabled`, `appendAssistantEventsToHistory`, `appendToolDenialToHistory`, `appendToolExchangeToHistory`, `appendUserDraftToHistory`, `historyFromTranscriptBlocks`, `toolReadBack`, `applyTurnEventsToSession`, `branchInterfaceTurnSession`, `emptyInterfaceTurnSession`, `gatedToolFromEvents`, `awaitingFromEvents`, `promotedToolIdsFromEvents`, `toolSnapshotFromEvents`, `gatedToolsFromEvents`, `toolCallsOf`, `argumentsSoFar`, `settlesToolCall`, `toolCallRanWith`, `appendPausedTurnToHistory`, `answerOpenToolCalls`, `assertOpenToolCalls`, `removeLandedSteers`, `SettledToolCallEvent`, `ToolGateAuth`, `COMPOSER_PENDING_KINDS`, `cloneUserTurnDraft`, `composerPendingMoves`, `composerPendingPreview`, `consumeNextComposerQueue`, `consumeNextComposerSteer`, `convertSteersToFrontQueued`, `createComposerPendingMessage`, `moveComposerPendingWithinKind`, `orderComposerPendingMessages`, `promoteComposerPendingKind`, `removeComposerPendingMessage`, `resolveComposerMenuActions`, `resolveComposerPrimary`, `updateComposerPendingDraft`, `userDraftHasPayload`, `userDraftToSteerInject`, `AttachmentValidationCode`, `AttachmentValidationIssue`, `AttachmentValidationParams`, `AttachmentValidationResult`, `AwaitingToolContext`, `ComposerActionContext`, `ComposerInterfaceFields`, `ComposerMenuAction`, `ComposerPendingKind`, `ComposerPendingMessage`, `ComposerPrimaryAction`, `ComposerProfileInterface`, `ComposerRunPhase`, `CreateComposerPendingMessageArgs`, `FoldTurnEventsOptions`, `GatedToolContext`, `ImageProfileInterface`, `InterfaceEffortOption`, `InterfaceModelOption`, `LiveProfileInterface`, `ModelBindingView`, `PendingAttachment`, `PrepareUserTurnResult`, `ProfileGuardrailsView`, `ProfileObservabilityView`, `ProfileInputsInterface`, `ProfileInterface`, `ProfileOutputsView`, `ProfileToolsView`, `SpeechProfileInterface`, `TextProfileInterface`, `TranscriptBlock`, `TranscriptBlockKind`, `UserTurnDraft`, `UserTurnHistoryMedia`, `InterfaceTurnSession` |
| Attachments (kernel) | `attachmentIssues`, `attachmentIssueCopy`, `attachmentIssueText`, `attachmentsRefused`, `assertTurnAttachments`, `maxBytesForMime`, `requireMediaLimits`, `resolveMediaLimits`, `sanitizeCsvText`, `sanitizeTurnBlobs`, `AttachmentFacts`, `AttachmentRules` |

`PromotedToolMedia` and `media` `TranscriptBlock`s carry an optional
`previewUrl`: a smaller copy of `url` for thumbnails, when the tool output
offered one.

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Facts and policy": {
      "supports": [
        { "kind": "source", "path": "src/guardrails/labels.ts" },
        { "kind": "source", "path": "src/kernel/stop.ts" },
        { "kind": "contract_test", "path": "tests/kernel/two-hosts-boundary.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/zero-permission-import.test.ts" }
      ]
    },
    "Profiles": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/profiles.ts" },
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "source", "path": "src/kernel/schema.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/schema.test.ts" }
      ]
    },
    "Decision profile": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/decision.ts" },
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "contract_test", "path": "tests/kernel/decision.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" }
      ]
    },
    "Turn lifecycle": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/mod.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/steps.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/stages.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/state.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/stream.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "source", "path": "src/kernel/registry/resolve.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/turn-stages.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/abort.test.ts" }
      ]
    },
    "Stream events": {
      "supports": [
        { "kind": "source", "path": "src/kernel/types.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Kernel scope": {
      "supports": [
        { "kind": "source", "path": "src/kernel/scope.ts" },
        { "kind": "source", "path": "src/kernel/default-scope.ts" },
        { "kind": "source", "path": "src/kernel/registry/kernel-registry.ts" },
        { "kind": "contract_test", "path": "tests/kernel/scope.test.ts" }
      ]
    },
    "Registered tools": {
      "supports": [
        { "kind": "source", "path": "src/kernel/tools/mod.ts" },
        { "kind": "source", "path": "src/kernel/tools/execute.ts" },
        { "kind": "source", "path": "src/kernel/tools/resolve.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/steps.ts" },
        { "kind": "source", "path": "src/kernel/schema.ts" },
        { "kind": "source", "path": "src/guardrails/network.ts" },
        { "kind": "contract_test", "path": "tests/kernel/tools.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/network.test.ts" }
      ]
    },
    "Outputs and guardrails": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/gates.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Compaction": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/compaction.ts" },
        { "kind": "source", "path": "src/kernel/engine/token-estimate.ts" },
        { "kind": "contract_test", "path": "tests/kernel/token-estimate.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/compaction.test.ts" }
      ]
    },
    "Stop and resume": {
      "supports": [
        { "kind": "source", "path": "src/kernel/stop.ts" },
        { "kind": "contract_test", "path": "tests/kernel/turnStop.test.ts" }
      ]
    },
    "Validation": {
      "supports": [
        { "kind": "source", "path": "src/kernel/registry/profiles.ts" },
        { "kind": "source", "path": "src/kernel/engine/runner/schema-validation.ts" },
        { "kind": "contract_test", "path": "tests/kernel/profiles.test.ts" }
      ]
    },
    "Headless interface": {
      "supports": [
        { "kind": "source", "path": "src/interface/mod.ts" },
        { "kind": "source", "path": "src/interface/from-profile.ts" },
        { "kind": "source", "path": "src/interface/inputs.ts" },
        { "kind": "source", "path": "src/interface/blocks.ts" },
        { "kind": "source", "path": "src/interface/pending.ts" },
        { "kind": "source", "path": "src/interface/composer-actions.ts" },
        { "kind": "contract_test", "path": "tests/interface/headless.test.ts" },
        { "kind": "contract_test", "path": "tests/interface/composer-pending.test.ts" },
        { "kind": "contract_test", "path": "tests/web/gate-resume.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/kernel/mod.ts" },
        { "kind": "source", "path": "src/interface/mod.ts" },
        { "kind": "source", "path": "src/kernel/auth/mod.ts" },
        { "kind": "source", "path": "src/guardrails/network.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/auth.test.ts" },
        { "kind": "contract_test", "path": "tests/guardrails/network.test.ts" },
        { "kind": "contract_test", "path": "tests/interface/headless.test.ts" }
      ]
    }
  }
}
```
