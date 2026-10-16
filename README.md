<h1 align="center">Theorem</h1>

<h3 align="center">
  A deterministic agent builder for TypeScript. The agent's profile is the source of truth.
</h3>

<p align="center">
  <a href="#what-it-gives-you"><strong>Why</strong></a> •
  <a href="#quickstart"><strong>Quickstart</strong></a> •
  <a href="#profile-types"><strong>Profile types</strong></a> •
  <a href="#architecture"><strong>Architecture</strong></a> •
  <a href="#tools"><strong>Tools</strong></a> •
  <a href="#guardrails"><strong>Guardrails</strong></a> •
  <a href="#providers"><strong>Providers</strong></a> •
  <a href="#public-entrypoints"><strong>Entrypoints</strong></a>
</p>

<p align="center">
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml"><img src="https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://jsr.io/@theoremjs/agents"><img src="https://jsr.io/badges/@theoremjs/agents" alt="JSR"></a>
  <a href="https://jsr.io/@theoremjs/agents/score"><img src="https://jsr.io/badges/@theoremjs/agents/score" alt="JSR score"></a>
  <a href="https://www.npmjs.com/package/@theoremjs/agents"><img src="https://img.shields.io/npm/v/@theoremjs/agents?logo=npm&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/masudl-hub/theoremai/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml"><img src="https://img.shields.io/github/check-runs/masudl-hub/theoremai/main?nameFilter=lint&label=Biome%20%C2%B7%20ast-grep%20%C2%B7%20fallow&logo=biome" alt="Lint"></a>
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/security.yml"><img src="https://img.shields.io/github/check-runs/masudl-hub/theoremai/main?nameFilter=semgrep&label=Semgrep&logo=semgrep" alt="Semgrep"></a>
  <a href="https://snyk.io/test/github/masudl-hub/theoremai"><img src="https://snyk.io/test/github/masudl-hub/theoremai/badge.svg" alt="Snyk"></a>
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/mutation.yml"><img src="https://github.com/masudl-hub/theoremai/actions/workflows/mutation.yml/badge.svg" alt="Mutation testing"></a>
</p>

## What is Theorem?

Theorem runs AI agents from typed profiles. The profile declares the agent's models, tools, inputs, outputs, and guardrails.

Use Theorem when your application runs an AI agent and you need the agent to do what its profile says, on every turn. Theorem runs each turn from the profile and enforces the rules around it.

You describe an agent once, as a **profile**. A profile says:

- which models the agent may use;
- what the agent accepts: text, images, PDFs, audio, voice or typed slots;
- what the agent must return: free text, JSON that a schema checks, images, speech or a live audio session;
- which tools the agent may call;
- how every input and output is guarded.

Theorem then runs each request as a **turn** that follows the profile. It cleans the input. It selects the tools that the model can see. It executes client tools through one gated pipeline. It checks what the model says before any of it reaches your user. It writes a trace to the place that you choose.

Theorem does not include application prompts, personas, or databases. It does not read `.env` files for provider credentials.
Your application supplies credentials, trace storage, and product policy. You can replace kernel wording through the labels.


Install `jsr:@theoremjs/agents` from JSR or `@theoremjs/agents` from npm.

## What it gives you

| You need to | Theorem gives you | Read |
| :--- | :--- | :--- |
| Describe the whole agent in one place | Six profile types, several models per profile, typed file inputs, and outputs that a schema checks | [Profile types](#profile-types) |
| Stop a prompt injection or a data leak | Input scanning by trust level, canary tokens, and egress checks that can send the model back to try again | [Guardrails](#guardrails) |
| Let the model act, safely | One tool registry for function, HTTP, MCP and provider tools, gated in layers, with OAuth 2.1 and PKCE built in | [Tools](#tools) |
| Connect model servers | Protocols for Gemini, OpenRouter, TypeSafe and OpenAI-compatible servers, and providers that you define | [Providers](#providers) |
| See what happened | Traces to JSONL, memory or your own sink, with sampling, scrubbing and retention | [Observability](#observability) |
| Trust the kernel | A kernel that imports with every Deno permission denied. A test proves it. | [Package Boundary](#package-boundary) |

---

---

## Quickstart

Use these steps to create a support agent and run one turn.
Install the package, register the provider and tool, define the profile, then run the turn.

### Install

```bash
deno add jsr:@theoremjs/agents
# or
npm install @theoremjs/agents zod
```

The npm package runs on Node 20 and later and in browsers. Its type declarations need TypeScript 5.7 or later.

### Register a tool

Register each tool once, when your application starts. A profile refers to it by name.

```ts
import { z } from "zod";
import { registerTool } from "@theoremjs/agents";

registerTool({
  type: "function",
  name: "search_tickets",
  description: "Search support tickets by keyword.",
  category: "support",
  access: "read-only",
  paths: ["*"],
  loadTier: "T0",
  permission: "auto",
  input: z.object({ query: z.string().min(2) }),
  output: z.object({ tickets: z.array(z.object({ id: z.string(), title: z.string() })) }),
  handler: async ({ query }) => ({ tickets: await db.tickets.search(query) }),
});
```

### Register a provider

A **provider** is data about a model service: its address, the protocols that it serves, and how to sign in.
A **protocol** is the code for one API shape. It writes each request and reads each reply.
Register the provider before the profile. The registration sets its connection and its credential slots.

```ts
import { openRouterProvider, registerProvider } from "@theoremjs/agents";

const router = registerProvider(openRouterProvider, { keySlot: "openrouter" });
```

Each run captures the registered provider. A later registration affects later runs only.

### Define a profile

The profile selects models and tools. It also declares inputs, outputs, and guardrails.
The registered provider's `.model()` helper takes a protocol and a model ID. It checks the settings and returns plain binding data.

```ts
import { defineProfile, registerProfile } from "@theoremjs/agents";

const support = defineProfile({
  type: "text",
  id: "support.agent",
  identity: {
    handle: "support",
    system: "You help customers with their account. Cite the docs you used.",
  },
  models: {
    main: router.model("openRouter", "openrouter/free"),
  },
  defaultModel: "main",
  tools: { allow: ["search_tickets"] },
  inputs: { text: true },
});

registerProfile(support);
```

The profile sets no `guardrails`, so input cleaning, sensitive-data redaction and the canary stay on. [Guardrails](#guardrails) says what each one does.

### Run a turn

`runTurn` resolves the registered provider from the profile. Pass credentials through the vault.

```ts
import { runTurn } from "@theoremjs/agents";

for await (const event of runTurn(
  { profile: "support.agent", input: { text: "Find support tickets about failed large CSV exports." } },
  { vault: { openrouter: apiKey } },
)) {
  send(event); // text · thought · structured · media · tool · guardrail · stage · tokens · done
}
```

Every event is typed. A `structured` event arrives only after validation and the egress checks pass. The `done` event carries a normalized `stop`: `completed`, `length`, `gate`, `cancelled` or another kind. Read `stop` to decide whether to continue, resume or stop.

---

## Profile types

Use the `type` field to choose what the agent does. The type sets the shape of the profile and picks the runner.

| Type | Runner | Takes | Returns | First-party protocols |
| :--- | :--- | :--- | :--- | :--- |
| `text` | `runTurn` | text, attachments, voice notes, slots, history | text, thoughts, validated JSON, tool calls | `geminiInteractions`, `openRouter`, `openAi` |
| `image` | `runTurn` | prompt + reference images | images, optionally with interleaved text | `geminiInteractions`, `openRouterImages` |
| `speech` | `runTurn` | text | audio (WAV, or MP3 on OpenRouter) | `geminiInteractions`, `openRouter`, `openAi` |
| `live` | `runSession` | realtime mic audio, camera frames, typed text | streamed audio, transcripts, tool calls | `geminiLive` |
| `host` | `invokeTool`, `invokeToolStep` | tool calls from your own code, one at a time or as a step | guarded tool results | none; it never calls a model |
| `decision` | `runDecision` | non-null JSON state plus declared questions | typed choices, probabilities, scores, or `noul` | `systemOne` |

A protocol that you define can serve the same profile types. Its `endpoints` name the profile types that it serves.

`defineProfile` rejects a field that does not belong to the type. Quota, canary or egress on a `host` profile, attachments on `live`, and steering on `image` all fail at startup, not halfway through a turn.


---

## Architecture

Tool handlers receive `ToolContext.operationId`, a kernel-issued ID for their action.
Provider call IDs remain available for correlation. Approval clients preserve both IDs from the issued gate.
These IDs distinguish actions. A host-owned execution coordinator retains their claims and outcomes.
The React handler creates that coordinator from its atomic session store. Process restarts require durable shared storage.

The runner is one deterministic path for one agent turn. A profile is a declaration that the host owns. Registered providers and their protocols supply model operations; `runSession` opens live sessions. Traces go to destinations that the host registers. There are no environment variables and no bundled database.

```text
 request
    |
    v
 INGRESS    sanitize by trust level, attachment limits, quota
 RESOLVE    pick model and effort, tool snapshot, canary
    |   stage: pre_turn
    v
 STEP LOOP (up to maxSteps)
    provider stream --text--> progressive yield --> your client
         |
         '--validated calls--> tool pipeline --guarded results--> next model step
    |   stream ends
    v
 END OF ATTEMPT
    reply blocked: blockedReply retry       --> back to the step loop
    output validation: fails --> repair round, back to the step loop
    |   stage: before_end
    v
 done + stop kind --> your client
    |   stage: post_turn
    v
 trace sink (scrubbed)
```

Use `onStage` to act at a fixed point in the turn:

- Apply a host limit at `pre_turn`.
- Request confirmation at `pre_tool`.
- Change a tool result at `post_tool`.
 A turn that stops early can resume. After a `gate` stop, call `invokeTool` with `resume`. After a cut-off reply, start a new `runTurn` with `continueFrom`.

For a React interface, use the separate package [`@theoremjs/react`](https://github.com/masudl-hub/theoremai/blob/main/react/README.md). It builds on the headless projection `@theoremjs/agents/interface`. The agents package does not include React.

---

## Tools

Use tools to let the model act: look something up, call an API, change a record. You register each tool once in a catalog that the whole host shares. A profile picks tools from the catalog, and each turn narrows the choice again.

| Type | What runs |
| :--- | :--- |
| `function` | Your handler, in process. |
| `http` | A declarative REST call. Auth is `bearer`, `api_key` or `oauth2`. |
| `mcp` | One tool on a remote MCP server over Streamable HTTP. |
| `builtin` | A provider-native tool (Google Search, Maps, URL context, code execution) from a preset. |

Every client-tool call uses the same gated pipeline. Provider-native tools execute upstream through the protocol. Six layers decide whether the model can call a tool, and each layer has one owner.

| Layer | Owner | What it decides |
| :--- | :--- | :--- |
| **Catalog** | Host, at startup | `registerTool`: schema, handler, `access`, `loadTier`, `permission` |
| **Allow** | Profile | `tools.allow` for custom tools; `models.*.builtInTools` for provider tools |
| **Paths** | Tool | `paths` globs matched against `TurnRequest.path` |
| **Visibility** | Registry and profile | `T0` always visible; `T2` on demand: picked at turn start by `tools.t1Policy(ctx)` or loaded mid-turn by `tools.t2Loader` |
| **Permission** | Tool and host | `auto` runs; `session_consent` asks once per session; `always_confirm` asks every call |
| **Hooks** | Tool and host | The tool's `preTool` and the turn's `onStage` can deny, confirm or rewrite the call |

A tool that must act as the signed-in user takes OAuth 2.1 with PKCE. The call becomes an auth gate, and the helpers in `@theoremjs/agents/kernel` finish the sign-in.

---

## Guardrails

Theorem scans each piece of text according to where it came from.

| Trust | Source | Treatment |
| :--- | :--- | :--- |
| `trusted` | `identity.system`, written by you at startup | Passed through |
| `assembled` | `TurnRequest.system`, built by your code per turn | Full scan |
| `untrusted` | User text, history, slots, attachments, steering, stage injections | Full injection and sensitive-data scan |

- **Coming in.** `detect` replaces prompt-injection phrasing, secrets and personal data with a placeholder before the model sees them.
- **Going out.** A **canary** is a secret token that Theorem hides in the system prompt. If the token appears in a reply, the prompt leaked, and the `canary_leak` detector stops the reply. The `prompt_leak` detector also stops a reply that repeats 12 words of the prompt. Both are set in `detect`, like every other detector. `egress` checks every outbound payload and can send the model back to repair its answer.
- **Tool results.** Remote content is data. Theorem fences it, scans it, and refuses destructive calls after a remote read when `taint.afterRemoteRead` is set. `taint.remoteDestination` gates a call that sends to an address only remote content named.
- **Network.** HTTP and MCP targets must pass `network.allowedHosts`. Theorem refuses private and metadata addresses by default.

The checks fail closed: a payload that cannot be scanned counts as a block. The guardrails have an adversarial corpus, fuzzing and mutation tests. The corpus ships as `@theoremjs/agents/guardrails/testing`.

### Observability

`observability` writes OpenTelemetry-shaped trace records for turns, host tool calls and live sessions to a destination that you register: JSONL, memory or your own sink. Use `sampleRate`, `include` and `scrub` to shape what it writes. `toOtlpJson` reshapes records for any OpenTelemetry backend.

---

## Providers

Host options can set finite `limits` for provider setup, credentials, transport, and normalized output.
Defaults bound each operation to 120 seconds and each live connection opening to 30 seconds.
Retries share the deadline and byte budget. Limits do not enter the profile.

A model call uses a **protocol**, a **provider** and a **binding**.
The protocol is the code for one API shape. The provider is data: an address, the protocols that it serves, and a sign-in.
The binding under `models` names the protocol, the registered provider ID and the model.

| Provider | ID | Protocols |
| :--- | :--- | :--- |
| `geminiProvider` | `gemini` | `geminiInteractions` (text, image, speech), `geminiLive` (live) |
| `openRouterProvider` | `openrouter` | `openRouter` (text, speech), `openRouterImages` (image), `systemOne` (decision) |
| `typesafeProvider` | `typesafe` | `systemOne` (decision) |
| `localProvider` | `local` | `openAi` (text, speech), for a server such as Ollama |

Register providers before profiles. `registerProvider(provider, { id, connection, keySlot, fallbackKeySlot })` returns the registered provider.
`registerProfile` refuses a binding whose provider does not serve its protocol, or whose protocol has no endpoint for the profile type.
Put shared generation settings on the binding. Put protocol-specific settings in `options`. The protocol's schema validates them.

```ts
import { bearer, defineProvider, localProvider, openAi, registerProvider } from "@theoremjs/agents";
import { z } from "zod";

registerProvider(localProvider, { connection: { baseUrl: "http://127.0.0.1:11434/v1" } });

const gateway = defineProvider({
  id: "gateway",
  name: "Company gateway",
  description: "The chat gateway of the company.",
  connection: z.strictObject({ baseUrl: z.string() }),
  key: z.string().trim().min(1),
  authorize: bearer(),
  serves: (at) => [{ protocol: openAi, baseUrl: at.baseUrl }],
});
registerProvider(gateway, { connection: { baseUrl: "https://gateway.example/v1" }, keySlot: "gateway" });
```

Use `defineProvider` for a server that speaks a protocol that Theorem has. `bearer`, `header` and `query` put the key on each request.
Use `extendProtocol` for an API that nearly matches a protocol. Use `defineProtocol` for a new API shape.
A protocol never holds a key or an address. The kernel signs and sends each request.

### Supply credentials

Pass the vault in host options to `runTurn`, `runSession`, or `runDecision`.
Provider registrations name default credential slots. Bindings can override them with `keySlot` and `fallbackKeySlot`.
After a quota refusal (HTTP 429), the kernel retries once with the key in `fallbackKeySlot`, if the vault holds it.
The vault accepts strings, JSON credential objects, or asynchronous resolvers. The host owns credential caching and refresh.
Supply each slot as an own property of the vault. The runtime ignores inherited entries.

```ts
import { runTurn } from "@theoremjs/agents";

const events = runTurn(
  { profile: "support.agent", input: { text: "Why did the export fail?" } },
  { vault: hostKeyVault },
);
```

### Save continuation state

Keep portable conversation history when a protocol supplies native state.
A **checkpoint** contains versioned native state and identifies its covered history prefix.
Save the returned `providerState` checkpoint beside that history. Send both on the next request.
The kernel validates the checkpoint's protocol, provider, model, connection, key slot, version, and covered history.

On a mismatch, the kernel rebuilds from portable history and emits a `provider_state_rebuilt` warning.
Set `providerContinuation.history` to `provider` to resume from the checkpoint alone when the provider stores the conversation.
A failed or incomplete model step cannot authorize pending client tools.

See [the provider contract](https://github.com/masudl-hub/theoremai/blob/main/docs/contracts/providers.md) for the protocol and provider schemas and the operation boundaries.

---

## Documentation

Use the [Theorem docs](https://theorem.masudlewis.com/docs) for task procedures.

| Task | Chapter |
| --- | --- |
| Create an agent | [Getting started](https://theorem.masudlewis.com/docs/start) |
| Select a profile type | [Choosing a modality](https://theorem.masudlewis.com/docs/modalities) |
| Set instructions | [Setting the identity](https://theorem.masudlewis.com/docs/identity) |
| Connect models | [Binding models](https://theorem.masudlewis.com/docs/models) |
| Register tools | [Registering tools](https://theorem.masudlewis.com/docs/tools) |
| Declare input | [Declaring inputs](https://theorem.masudlewis.com/docs/inputs) |
| Declare output | [Declaring outputs](https://theorem.masudlewis.com/docs/outputs) |
| Set continuation and steering | [Setting turn behaviour](https://theorem.masudlewis.com/docs/turn-behaviour) |
| Set guardrails | [Setting guardrails](https://theorem.masudlewis.com/docs/guardrails) |
| Record traces | [Recording traces](https://theorem.masudlewis.com/docs/traces) |
| Replace wording | [Describing statuses](https://theorem.masudlewis.com/docs/statuses) |
| Run an operation | [Running a turn](https://theorem.masudlewis.com/docs/runner) |
| Add an interface | [Building the interface](https://theorem.masudlewis.com/docs/interface) |

---

For tool execution across several workers, pass a host-owned `ToolExecutionCoordinator` through the trusted request's `execution` option.
The React server handler creates this service from its atomic session store.
`ToolOperationIdentity` identifies the accepted invocation. `ToolOperationClaim` adds its worker token.
`savedToolInvocationSchema` validates JSON dispatch evidence.
`SavedToolInvocation` retains accepted request data and the final input used at dispatch.
Use `toolInvocationHash` to compute the same canonical JSON digest as the coordinator.
Use this evidence to check current resource access before you disclose a cached result.
For browser effects, `PageToolExecution` issues a dispatch grant only after the claim.
`PageToolDispatch` contains the grant ID and a pending `PageAnswer`. Host code supplies result delivery.
The browser receives the final prepared arguments, then returns a result against that grant.
Neither profile JSON nor a provider event can supply this service.
`BeginToolOperationResult` reports whether a worker acquired the claim or an earlier operation already exists.
`ToolOperationOutcome` retains the terminal event and a guarded `ModelToolResult` for replay.
For a custom host replay path, call `authorizeToolReplay` before delivering a saved outcome.
It checks current eligibility and disclosure without running handlers or preparation hooks.
Its validator is `toolOperationOutcomeSchema`. `TerminalToolEvent` restricts the retained event to completion or failure.
`ToolOperationUncertainty` records why a dispatched operation has no confirmed outcome.
An unresolved claim never becomes an approval again. Check the destination before creating a replacement action.

## Public Entrypoints

Import from the narrowest entrypoint that has what you need. Each row gives the JSR name and the npm name.

| Entrypoint | Purpose |
| :--- | :--- |
| `jsr:@theoremjs/agents` / `@theoremjs/agents` | Main kernel API: profiles, schemas, runner, core types, provider constructors, declarative HTTP/MCP tool execution. |
| `jsr:@theoremjs/agents/kernel` / `@theoremjs/agents/kernel` | Profile/turn types, tool catalog, `requireModelBinding`, thinking clamps over host model maps, OAuth 2.1 PKCE helpers (`createOAuthPkceFlow`, `exchangeOAuthPkce`, `refreshOAuthToken`). |
| `jsr:@theoremjs/agents/providers` / `@theoremjs/agents/providers` | Protocols, first-party providers, provider definitions, sign-in helpers and vault contracts. |
| `jsr:@theoremjs/agents/guardrails` / `@theoremjs/agents/guardrails` | Sanitization, canary/egress gates, public error mapping, inbound injection/sensitive-data primitives. |
| `jsr:@theoremjs/agents/guardrails/testing` / `@theoremjs/agents/guardrails/testing` | Adversarial corpus + fuzz helpers (test/harness only). |
| `jsr:@theoremjs/agents/observability` / `@theoremjs/agents/observability` | Trace sinks, trace record helpers and OTLP/JSON export. |
| `jsr:@theoremjs/agents/observability/jsonl` / `@theoremjs/agents/observability/jsonl` | Optional file sink (`jsonlSink`): daily rotating JSONL through `node:fs`, kept out of browser and Worker bundles. |
| `jsr:@theoremjs/agents/observability/openinference` / `@theoremjs/agents/observability/openinference` | Optional OpenInference usage names (reasoning tokens, cost) for Phoenix. |
| `jsr:@theoremjs/agents/observability/phoenix` / `@theoremjs/agents/observability/phoenix` | Optional: eval results as Phoenix span annotations. |
| `jsr:@theoremjs/agents/host` / `@theoremjs/agents/host` | Optional Deno HTTP helpers (`json`, status mapping, cutout mint flush). |
| `jsr:@theoremjs/agents/interface` / `@theoremjs/agents/interface` | Headless interface projection of a profile (transcript, composer, gates) that UI packages such as `@theoremjs/react` render. |
| `jsr:@theoremjs/agents/cli` / `@theoremjs/agents/cli` | Profile inspection and stress-test CLI (`agents` binary on npm). |
| `jsr:@theoremjs/agents/presets` / `@theoremjs/agents/presets` | Optional convenience packs (`registerGooglePreset`, …). |
| `jsr:@theoremjs/agents/presets/google` / `@theoremjs/agents/presets/google` | Google builtins (search/maps/urlContext/codeExecution) as tool-list entries. |
| `jsr:@theoremjs/agents/presets/google/speech-voices` / `@theoremjs/agents/presets/google/speech-voices` | Gemini TTS voice names for `speech.voice` (`GOOGLE_SPEECH_VOICES`); no registry imports. |
| `jsr:@theoremjs/agents/schema` / `@theoremjs/agents/schema` | Profile vocabulary and field catalog (closed unions, field metadata) for host UIs and docs; no Deno APIs. |

The studio is a separate package, `@theoremjs/studio`. It is never part of the kernel package. Install it beside the kernel to open your project's agents in a local studio: `npm install -D @theoremjs/studio`, then `npx theorem-studio`. It needs Deno. Demo fixtures, such as the travel concierge seeds and local handlers, are only in the repo: a host that needs them links `file:../theoremai/studio`.

Internal files stay in the source for maintainability. Package consumers should use the public entrypoints above.


### Exported API

Open the block below to see every named export of the root barrel (`mod.ts`).

<details>
<summary>Every named export from the root barrel (<code>mod.ts</code>)</summary>

Named exports from the root barrel (same symbols hosts get from `@theoremjs/agents` /
`jsr:@theoremjs/agents`):

| Group | Symbols |
| --- | --- |
| Guardrails errors | `ERROR_KINDS`, `ErrorKind`, `ErrorCopy`, `ErrorCopies`, `errorKindSchema`, `errorCopiesSchema`, `TheoremError`, `TheoremErrorOptions`, `errorKind`, `publicError`, `toErrorEvent`, `describeError`, `isAbortError`, `throwIfAborted` |
| Network guardrails | `assertSafeUrl`, `fetchGuarded`, `dnsOverHttpsResolver`, `isLocalhostName`, `isPrivateOrLocalAddress`, `GuardedFetchOptions`, `ResolveHost`, `DnsOverHttpsOptions` |
| Guardrail vocabulary | `AdvisoryLevel`, `TrustLevel`, `GuardrailStage`, `Severity`, `GuardrailHit`, `Verdict`, `GuardrailAction`, `GuardrailContext`, `GuardrailEvent`, `guardrailEventSchema`, `OutboundPayload`, `Provenance`, `ToolOrigin`, `ScanText`, `BlockedReplySpec`, `BlockedReplyOnBlock`, `ResolvedBlockedReply`, `UrlAllow`, `NameAllow`, `UrlDetector`, `ResolvedAllow`, `ProfileGuardrailsSpec`, `HostGuardrailsSpec`, `NetworkGuardrailSpec`, `QuotaGuardrailSpec`, `ResolvedGuardrailPolicy`, `SensitiveGroup`, `SensitiveSelection`, `SensitiveSwitches`, `GuardedToolText`, `TurnTaint`, `TaintGate`, `TaintGuardrailSpec`, `TurnDestinations`, `DestinationGate`, `DestinationVerdict`, `TRUST_LEVELS`, `GUARDRAIL_STAGES`, `SEVERITIES`, `TOOL_ORIGINS` |
| Guardrail policy | `resolveGuardrailPolicy`, `BLOCKED_REPLY_ON_BLOCK`, `hitRules`, `EGRESS_RULES` |
| Tool boundary | `guardToolResult`, `guardToolFailureText`, `inspectToolArguments`, `toolCallEvent`, `wrapToolData`, `isRemoteOrigin`, `composeToolText`, `checkTaintGate`, `recordTaint`, `isTainted`, `isSuspicious`, `checkDestinationGate`, `turnDestinations`, `addGivenDestinations`, `addHistoryDestinations`, `addRequestDestinations`, `addResultDestinations`, `DESTINATION_GATES`, `directives`, `advisoryLevel`, `DIRECTIVE_SIGNALS`, `Directive`, `DirectiveSignal`, `ADVISORY_LEVELS`, `TOOL_CLOSE`, `TOOL_ORIGINS`, `TAINT_GATES`, `InspectedToolArguments`, `textForScan`, `scanTextOf` |
| Quota | `QuotaSlotStatus`, `clientIp`, `quotaExhausted`, `releaseSlot`, `resetSlots`, `skipQuota`, `takeSlot` |
| Labels | `LABEL_KEYS`, `LabelKey`, `CLIENT_LABEL_KEYS`, `ClientLabelKey`, `LabelOverrides`, `LabelParams`, `labelDefault`, `labelText`, `overrideLabels`, `resetLabels` |
| Sanitize | `sanitizeProjectId`, `sanitizeTurnRequest`, `sanitizeTurnRequestWithEvents`, `SanitizedTurnRequest`, `guardrailFromHits`, `guardrailFromVerdict`, `guardrailTurnEvent`, `projectGuardrailTurnEvent`, `hitFromSpan`, `projectGuardrailEvent` |
| Canary / egress | `mintCanary`, `bindCanary`, `wrapUserData`, `scanTextForCanaryLeak`, `scanTextForPromptEcho`, `PROMPT_ECHO_WORDS`, `redactCanary`, `OMIT_CANARY`, `createCanaryStreamGate`, `eventHasCanary`, `createCanaryGateSession`, `filterCanaryGatedEvents`, `CanaryGateResult`, `CanaryGateSession`, `CanaryStreamGate`, `GivenUrls`, `createOutboundProgressiveGate`, `createProgressiveYieldGate`, `createLiveOutboundGateSession`, `processLiveOutboundBatch`, `finalizeLiveOutboundTurn`, `abortLiveOutboundTurn`, `LiveHeldOutput`, `LiveOutboundBatchResult`, `LiveOutboundGateSession`, `ProgressiveYieldGate`, `ProgressiveYieldGateOptions`, `ProgressiveYieldResult` |
| Compaction | `compactHistory`, `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Token estimate | `loadTokenEstimator`, `TOKEN_TEXT_ENCODING`, `TokenCount`, `TokenEstimator`, `sumTokens` |
| Runner | `runTurn`, `runSession`, `runDecision`, `runEmbedding`, `validateDecisionRequest`, `RunSessionOptions`, `SignInGatePolicy`, `RunDecisionOptions`, `DecisionError`, `prepareLiveInboundText`, `liveIngressEnabled`, `liveIngressEnabledFromSpec`, `liveIngressChannelDefault`, `hasAnyLiveIngress`, `assertLiveIngress`, `assertLiveIngressConfigured`, `LiveIngressChannel` |
| Attachments | `attachmentIssues`, `attachmentIssueCopy`, `attachmentIssueText`, `attachmentsRefused`, `assertTurnAttachments`, `maxBytesForMime`, `requireMediaLimits`, `resolveMediaLimits`, `sanitizeCsvText`, `sanitizeTurnBlobs`, `AttachmentFacts`, `AttachmentRules` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaChannelForMime`, `MediaInputChannel`, `mediaKindForMime`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `requireModelBinding` |
| Schema | `PROFILE_FIELDS`, `PROFILE_GRAPH`, `PROFILE_TYPES`, `PROFILE_ID_MAX_CHARS`, `PROFILE_HANDLE_MAX_CHARS`, `EXTRA_FIELDS`, `REQUEST_FIELDS`, `API_EXPORTS`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `spineFacetsForProfileType`, `profileGraphFacet`, `ProfileGraphFacet`, `ProfileGraphFacetId`, `ProfileGraphEditor`, `ProfileGraphRole`, `THINKING_LEVELS`, `KEY_SLOT_NAME`, `isKeySlotName`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `IMAGE_ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `COMPACTION_METERS`, `COMPACTION_OUTCOMES`, `COMPACTION_TIMINGS`, `CACHE_MODES`, `CACHE_TTLS`, `TURN_STAGES`, `TURN_INJECT_STAGES`, `TURN_STOP_KINDS`, `CONTINUE_STOP_KINDS`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION`, `TOOL_TYPES`, `AUTH_UNAUTHENTICATED_POLICIES`, `HTTP_METHODS`, `STUDIO_AUTH_TYPES`, `TOOL_AUTH_TYPES`, `AuthUnauthenticatedPolicy`, `CustomToolType`, `HttpMethod`, `StudioAuthType`, `ToolAccess`, `ToolAuthType`, `ToolPermission`, `ToolType`, `LIVE_ACTIVITY_HANDLINGS`, `LIVE_START_SENSITIVITIES`, `LIVE_END_SENSITIVITIES` |
| Scope | `KernelScope`, `createKernelScope`, `defaultKernelScope`, `KernelRegistry`, `createKernelRegistry` |
| Profiles | `ProfileDefinition`, `ProfileDefinitionBase`, `TextProfileDefinition`, `ImageProfileDefinition`, `SpeechProfileDefinition`, `LiveProfileDefinition`, `HostProfileDefinition`, `DecisionProfileDefinition`, `EmbeddingProfileDefinition`, `ProfileRegistry`, `createProfileRegistry`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `resolveTurn`, `pickModel` |
| Tools | `ToolContext`, `GateReference`, `gateReferenceSchema`, `ToolRegistry`, `createToolRegistry`, `registerTool`, `registerTools`, `invokeTool`, `invokeToolStep`, `GATE_DECISIONS`, `GateDecision`, `askUserTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `resetTools`, `formatToolResult`, `prepareTurnToolSnapshot`, `buildHttpToolTarget`, `executeHttpTool`, `executeMcpTool`, `parseMcpRpcResponse`, `isUnsupportedMcpProtocolError`, `MCP_PROTOCOL_VERSIONS`, `McpProtocolVersion`, `resolveToolAuth`, `credentialPlacement`, `withCredentialQuery`, `CredentialQuery`, `uncheckedOutput`, `UncheckedOutput` |
| Structured | `SchemaRegistry`, `createSchemaRegistry`, `getStructured`, `registerStructured` |
| Stop / resume | `ProfileTurnBehaviourSpec`, `MediaTurnBehaviourSpec`, `ProfileTurnResumptionSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `ContinueStopKind`, `StepLimitMode`, `CONTINUE_STOP_KINDS`, `AUTO_CONTINUE_DELAY_MS`, `DEFAULT_ALLOW_CONTINUE`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isContinueStopKind`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `profileAllowsSteering`, `profileAllowsInject`, `profileTurnResumption`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |
| Stages (target foundation) | `TURN_STAGES`, `TURN_INJECT_STAGES`, `STAGE_AFFORDANCES`, `STAGE_AFFORDANCE_MATRIX`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `applyStageResult`, `awaitingUserInputSchema`, `toolGateSchema`, `isTurnStage`, `isTurnInjectStage`, `isToolGateKind`, `isAwaitingUserInput`, `stageAllowsAffordance`, `stageEventFields`, `profileAllowsInject`, `StageAffordance`, `StageContext`, `StageResult`, `StageMutate`, `StageHandler`, `StageApplyInput`, `StageApplyOutput`, `StageApplyWarning`, `StageApplyWarningCode`, `StageEventExtra`, `AwaitingUserInput`, `ToolGate` — contract [`docs/contracts/stages.md`](https://github.com/masudl-hub/theoremai/blob/main/docs/contracts/stages.md) |
| Turn events | `TURN_EVENT_SCHEMAS` (each kind's schema, for a wire parser), `turnEventSchema`, `turnHistoryMessageSchema`, `turnToolSnapshotSchema`, `reasoningPartSchema`, `historyHash`, `turnDoneOf`, `keptReply` (a turn's events without the replies a retry threw away), `z` (the zod these schemas are built with; compose them with it, since two copies of zod do not mix) — the event types themselves come through `export type *` from `src/kernel/types.ts` |
| Observability | `memorySink`, `noopSink`, `readTraceparent`, `writeTrace`, `buildRecord`, `traceRecordSchema`, `contentOf`, `inlineContent`, `toOtlpJson`, `startTrace`, `traceContent`, `traceBytes`, `traceJson`, `registerTraceDestination`, `requireTraceDestination`, `getTraceDestination`, `listTraceDestinationIds`, `clearTraceDestinations`, `isTraceSink`, `resolveTraceWriter`, `resolveObservabilityPolicy`, `traceSpanMeta`, `traceAttributeMeta`, `traceEventMeta`, `traceEventAttributeMeta`, `TRACE_ATTRIBUTE_GROUPS`, `TRACE_STATUS`, `TRACE_FIELDS`, `TRACE_SPAN_TYPES`, `TraceSpanMeta`, `TraceSpanType`, `TraceAttributeMeta`, `TraceEventMeta`, `TraceOptionMeta`, `TraceAttributeGroup`, `TraceValueFormat`, `TraceRecord`, `TraceSink`, `TraceWriteContext`, `TraceSpan`, `TraceSpanEvent`, `TraceSpanKind`, `TraceSpanLink`, `TraceSpanStatus`, `TraceAttributes`, `TraceAttributeValue`, `TraceContent`, `TraceBytes`, `TraceJson`, `TraceTree`, `SpanHandle`, `SpanOptions`, `SpanLinkInput`, `TraceClock`, `ProfileObservabilitySpec`, `ResolvedObservabilityPolicy`, `ResolvedTraceInclude`, `ResolvedTraceScrub`, `TraceIncludeSpec`, `TraceScrubSpec`, `ScrubSwitch`, `ResolvedScrubSwitch`, `OtlpTraceRequest`, `OtlpSpan`, `OtlpKeyValue`, `OtlpAnyValue` (file sink: `@theoremjs/agents/observability/jsonl` → `jsonlSink`, `JsonlSinkOptions`) |
| Providers | `registerProvider`, `getProvider`, `listProviders`, `listProtocols`, `createProviderRegistry`, `defineProvider`, `Provider`, `ProviderDefinition`, `Registration`, `RegisteredProvider`, `ProviderRegistry`, `geminiProvider`, `openRouterProvider`, `typesafeProvider`, `localProvider` |
| Provider sign-in | `bearer`, `header`, `query`, `Authorize`, `Signer`, `Outgoing`, `Serve`, `endpointUrlSchema` |
| Protocols | `defineProtocol`, `extendProtocol`, `carriesTo`, `geminiInteractions`, `geminiLive`, `geminiEmbedding`, `openAi`, `openRouter`, `openRouterImages`, `openRouterEmbedding`, `ollamaEmbedding`, `systemOne`, `Protocol`, `ProtocolDefinition`, `ProtocolExtension`, `ExtensionBodyAt`, `ExtensionReader`, `ModelProfileType` |
| Protocol operations | `ProtocolContext`, `ProtocolOperations`, `ProtocolRequest`, `ProtocolSession`, `ProtocolSocket`, `ProtocolEvent`, `ProtocolContentEvent`, `SendInit`, `UpstreamFailure`, `Continuation`, `DecisionCall`, `EmbeddingCall`, `LiveToolResult`, `callProtocol`, `ProtocolCall`, `CallSetup` |
| Model bindings | `ModelBinding`, `DecisionModelBinding`, `modelBindingSchema`, `decisionModelBindingSchema`, `commonModelSettingsSchema`, `keySlotSchema`, `checkBinding`, `keySlotsOf`, `RuntimeAbilities` |
| Provider data | `JsonValue`, `JsonObject`, `jsonValueSchema`, `jsonObjectSchema`, `PriceTable`, `ModelPrice`, `Rates` |
| Provider vault | `ProviderHostOptions`, `KeyVault`, `KeyCredential`, `CredentialContext`, `CredentialResolver`, `OpenWebSocket`, `plainWebSocket` |
| Provider output | `ProviderCheckpoint`, `ProviderWarning`, `ProviderStateRebuilt`, `ProviderContinuationPolicy`, `providerCheckpointSchema`, `providerWarningSchema`, `providerContinuationSchema` |
| Provider limits | `ProviderLimits`, `providerLimitsSchema`, `resolveProviderLimits` |

</details>

Kernel types that the root barrel re-exports follow `export type *` from `src/kernel/types.ts`. For the detail behind them, read the [kernel contract](https://github.com/masudl-hub/theoremai/blob/main/docs/contracts/kernel.md).


## Package Boundary

Use this section to see what Theorem will not do, so that you know what your application must own. The rule is: **the host decides, Theorem runs.** Theorem is ready for host applications while these statements stay true:

```toml
[boundary]
# Rule: "Host decides, Theorem runs."
profiles_in_package = false
demos_in_package = false
env_files_in_package = false
ambient_secret_reads = false
business_logic_in_kernel = false
unownable_user_or_model_copy = false
provider_keys_host_owned = true
protocols_hold_keys = false
trace_sinks_host_injected = true
live_sessions = "registered provider via runSession; host owns mic, camera, and playback"
session_memory_in_kernel = false
```

**Facts and policy.** Provider facts may ship, such as prices, wire shapes and protocol metadata. For example, see `@theoremjs/agents/presets/google`. Product policy may not ship: prompts, personas, end-user copy, demo apps and channel behaviour. Every string that a user or a model reads is either supplied by the host or is an overridable default in the kernel labels (`overrideLabels`). Behavioural defaults are typed profile-schema fields. Optional packages, such as `studio/`, are inert extras. If you delete one, no kernel behaviour changes.

Four properties are invariant. Where a test or a lint checks one, the table names it.

| Id | Property | Check |
| --- | --- | --- |
| P1 | No ambient authority — construct with every Deno permission denied | `tests/kernel/zero-permission-import.test.ts` |
| P2 | No unownable words — user/model-visible strings are host-suppliable or labels defaults | labels + full-tree `scripts/docs-truth/copy-lint.mjs` + two-hosts test |
| P3 | No buried policy — behavioral defaults are declared profile-schema fields | `PROFILE_FIELDS` / schema |
| P4 | Inert extras — optional entrypoints removable without behavior change | publish-bundle gate excludes `studio/` |

Provider definition and registration validate without opening transport (`src/kernel/protocols/provider.ts`). A protocol never holds a key, a key slot or a base URL. The kernel signs each request with the registered provider's sign-in.

Domain rules, delivery policy, product copy, database access and session memory belong in your application, not in Theorem.


## Contributing

To change Theorem, please read [CONTRIBUTING.md](https://github.com/masudl-hub/theoremai/blob/main/CONTRIBUTING.md).

## License

MIT License. Copyright (c) ORCHID AI LLC.

```theorem-evidence
{
  "sections": {
    "Architecture": {
      "supports": [
        { "kind": "source", "path": "src/kernel/engine/runner/mod.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Public Entrypoints": {
      "supports": [
        { "kind": "config", "path": "package.json" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    },
    "Package Boundary": {
      "supports": [
        { "kind": "source", "path": "src/providers/mod.ts" },
        { "kind": "source", "path": "src/guardrails/labels.ts" },
        { "kind": "contract_test", "path": "tests/kernel/two-hosts-boundary.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/zero-permission-import.test.ts" }
      ]
    }
  }
}
```
