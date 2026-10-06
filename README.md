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
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/ci.yml"><img src="https://img.shields.io/github/check-runs/masudl-hub/theoremai/main?nameFilter=lint&label=Biome%20%C2%B7%20ast-grep%20%C2%B7%20fallow&logo=biome" alt="Lint"></a>
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/security.yml"><img src="https://img.shields.io/github/check-runs/masudl-hub/theoremai/main?nameFilter=semgrep&label=Semgrep&logo=semgrep" alt="Semgrep"></a>
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/security.yml"><img src="https://img.shields.io/github/check-runs/masudl-hub/theoremai/main?nameFilter=snyk&label=Snyk&logo=snyk" alt="Snyk"></a>
  <a href="https://github.com/masudl-hub/theoremai/actions/workflows/mutation.yml"><img src="https://github.com/masudl-hub/theoremai/actions/workflows/mutation.yml/badge.svg" alt="Mutation testing"></a>
</p>

## What is Theorem?

I created Theorem because I needed a deterministic agent builder where the agent's profile was the source of truth, such that I had clean implementations rather than drifts.

Use Theorem when your application runs an AI agent and you need the agent to do what its profile says, on every turn. Theorem runs each turn from the profile and enforces the rules around it.

You describe an agent once, as a **profile**. A profile says:

- which models the agent may use;
- what the agent accepts: text, images, PDFs, audio, voice or typed slots;
- what the agent must return: free text, JSON that a schema checks, images, speech or a live audio session;
- which tools the agent may call;
- how every input and output is guarded.

Theorem then runs each request as a **turn** that follows the profile. It cleans the input. It decides which tools the model can see, and runs them through one gated pipeline. It checks what the model says before any of it reaches your user. It writes a trace to the place that you choose.

Theorem stays out of your product. It has no bundled prompts, personas, databases, `.env` reads or interface text. Your application supplies the keys, the credentials, the trace storage and the policy.


Current release: `0.3.0`, on JSR as `jsr:@theoremjs/agents` and on npm as `@theoremjs/agents`.

## What it gives you

| You need to | Theorem gives you | Read |
| :--- | :--- | :--- |
| Describe the whole agent in one place | Six profile types, several models per profile, typed file inputs, and outputs that a schema checks | [Profile types](#profile-types) |
| Stop a prompt injection or a data leak | Input scanning by trust level, canary tokens, and egress checks that can send the model back to try again | [Guardrails](#guardrails) |
| Let the model act, safely | One tool registry for function, HTTP, MCP and provider tools, gated in layers, with OAuth 2.1 and PKCE built in | [Tools](#tools) |
| Use any model provider | One door, `createProvider`, for Google, OpenRouter and local servers; `runSession` for Gemini Live | [Providers](#providers) |
| See what happened | Traces to JSONL, memory or your own sink, with sampling, scrubbing and retention | [Observability](#observability) |
| Trust the kernel | A kernel that imports with every Deno permission denied. A test proves it. | [Package Boundary](#package-boundary) |

---

---

## Quickstart

This walk-through builds one support agent and runs one turn. It has four steps: install, register a tool, define a profile, run a turn.

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

### Define a profile

The profile is the agent. It names the model, the tools that the agent may call and the guardrails. `defineProfile` checks it when your application starts.

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
    main: { protocol: "openAi", provider: "openrouter", apiId: "anthropic/claude-opus-5.5" },
  },
  defaultModel: "main",
  key: "openrouter",
  tools: { allow: ["search_tickets"] },
  inputs: { text: true },
});

registerProfile(support);
```

The profile sets no `guardrails`, so input cleaning, sensitive-data redaction and the canary stay on. [Guardrails](#guardrails) says what each one does.

### Run a turn

`createProvider` binds the profile to a model and a key vault. `runTurn` then streams typed events.

```ts
import { createProvider, runTurn } from "@theoremjs/agents";

const provider = createProvider(support, { vault: { openrouter: apiKey } });

for await (const event of runTurn(
  { profile: "support.agent", input: { text: "The export crashes on large CSVs. Can you file this?" } },
  provider,
)) {
  send(event); // text · thought · structured · media · tool · guardrail · stage · tokens · done
}
```

Every event is typed. A `structured` event arrives only after validation and the egress checks pass. The `done` event carries a normalized `stop`: `completed`, `length`, `gate`, `cancelled` or another kind. Read `stop` to decide whether to continue, resume or stop.

---

## Profile types

Use the `type` field to choose what the agent does. The type sets the shape of the profile and picks the runner.

Use the `type` field to choose what the agent does. The type sets the shape of the profile and picks the runner.

| Type | Runner | Takes | Returns | Transports |
| :--- | :--- | :--- | :--- | :--- |
| `text` | `runTurn` | text, attachments, voice notes, slots, history | text, thoughts, validated JSON, tool calls | Google Interactions, OpenRouter, local |
| `image` | `runTurn` | prompt + reference images | images, optionally with interleaved text | Google Interactions, OpenRouter |
| `speech` | `runTurn` | text | audio (WAV, or MP3 on OpenRouter) | Google Interactions, OpenRouter |
| `live` | `runSession` | realtime mic audio, camera frames, typed text | streamed audio, transcripts, tool calls | Gemini Live (WebSocket) |
| `host` | `invokeTool` | tool calls from your own code | guarded tool results | none; it never calls a model |
| `decision` | `runDecision` | non-null JSON state plus declared questions | typed choices, probabilities, scores, or `noul` | TypeSafe or OpenRouter Decisions API |

`defineProfile` rejects a field that does not belong to the type. Quota, canary or egress on a `host` profile, attachments on `live`, and steering on `image` all fail at startup, not halfway through a turn.


---

## Architecture

The runner is one deterministic path for one agent turn. A profile is a declaration that the host owns. `createProvider` routes turn transports, and `runSession` opens live sessions. Traces go to destinations that the host registers. There are no environment variables and no bundled database.

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
         '--tool calls--> tool pipeline --guarded results--> back to the stream
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

Use `onStage` when your application must act at a fixed point: stop a free-plan user at `pre_turn`, ask for confirmation at `pre_tool`, or change a tool result at `post_tool`. A turn that stops early can resume. After a `gate` stop, call `invokeTool` with `resume`. After a cut-off reply, start a new `runTurn` with `continueFrom`.

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

Every call goes through the same gated pipeline, whatever the tool type. Six layers decide whether the model can call a tool, and each layer has one owner.

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
- **Tool results.** Remote content is data. Theorem fences it, scans it, and refuses destructive calls after a remote read when `taint.afterRemoteRead` is set.
- **Network.** HTTP and MCP targets must pass `network.allowedHosts`. Theorem refuses private and metadata addresses by default.

The checks fail closed: a payload that cannot be scanned counts as a block. The guardrails have an adversarial corpus, fuzzing and mutation tests. The corpus ships as `@theoremjs/agents/guardrails/testing`.

### Observability

`observability` writes OpenTelemetry-shaped trace records for turns, host tool calls and live sessions to a destination that you register: JSONL, memory or your own sink. Use `sampleRate`, `include` and `scrub` to shape what it writes. `toOtlpJson` reshapes records for any OpenTelemetry backend.

---

## Providers

`createProvider` is the one door for turns. `runSession` opens live sessions.

```ts
import { createProvider, runSession } from "@theoremjs/agents";

const provider = createProvider(profile, { vault: hostKeyVault }, "deep"); // model id is optional
const session = await runSession({ profile: "support.voice" }, { vault: hostKeyVault });
```

| Protocol + provider | Transport | Profile types |
| :--- | :--- | :--- |
| `geminiInteractions` + `google` | Google Interactions API | text, image, speech |
| `geminiLive` + `google` | Gemini Live over WebSocket (`runSession`) | live |
| `openAi` + `openrouter` | OpenRouter chat completions via AI SDK Core | text, image, speech |
| `openAi` + `local` | Any OpenAI-compatible `/v1/chat/completions` (Ollama, llama.cpp, vLLM, LM Studio) | text |

Each model in `profile.models` names its own protocol and provider, so one profile can mix Google and OpenRouter. A profile names key slots (`key`, and `fallbackKey` for a retry when quota runs out). Your vault fills them, so a profile never holds a key. Adapters load on first use, and Theorem reads no environment variables.

---

## Documentation

Each topic has its own chapter in the [Theorem docs](https://theorem.masudlewis.com/docs): [Getting started](https://theorem.masudlewis.com/docs/start), [Choosing a modality](https://theorem.masudlewis.com/docs/modalities), [Setting the identity](https://theorem.masudlewis.com/docs/identity), [Binding models](https://theorem.masudlewis.com/docs/models), [Registering tools](https://theorem.masudlewis.com/docs/tools) (with the tool pipeline and OAuth), [Declaring inputs](https://theorem.masudlewis.com/docs/inputs), [Declaring outputs](https://theorem.masudlewis.com/docs/outputs), [Setting turn behaviour](https://theorem.masudlewis.com/docs/turn-behaviour), [Setting guardrails](https://theorem.masudlewis.com/docs/guardrails) (with streaming and live audio), [Recording traces](https://theorem.masudlewis.com/docs/traces), [Describing statuses](https://theorem.masudlewis.com/docs/statuses), [Running a turn](https://theorem.masudlewis.com/docs/runner) and [Building the interface](https://theorem.masudlewis.com/docs/interface).

---

## Public Entrypoints

Import from the narrowest entrypoint that has what you need. Each row gives the JSR name and the npm name.

| Entrypoint | Purpose |
| :--- | :--- |
| `jsr:@theoremjs/agents` / `@theoremjs/agents` | Main kernel API: profiles, schemas, runner, core types, provider constructors, declarative HTTP/MCP tool execution. |
| `jsr:@theoremjs/agents/kernel` / `@theoremjs/agents/kernel` | Profile/turn types, tool catalog, `requireModelBinding`, thinking clamps over host model maps, OAuth 2.1 PKCE helpers (`createOAuthPkceFlow`, `exchangeOAuthPkce`, `refreshOAuthToken`). |
| `jsr:@theoremjs/agents/providers` / `@theoremjs/agents/providers` | `createProvider` + the vault type + host option bags. |
| `jsr:@theoremjs/agents/providers/local` / `@theoremjs/agents/providers/local` | Direct local OpenAI-compat adapter (`createLocalProvider`). |
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
| `jsr:@theoremjs/agents/presets/google` / `@theoremjs/agents/presets/google` | Google builtins (search/maps/urlContext/codeExecution) + Interactions/OpenRouter wire metadata. |
| `jsr:@theoremjs/agents/presets/google/speech-voices` / `@theoremjs/agents/presets/google/speech-voices` | Gemini TTS voice names for `speech.voice` (`GOOGLE_SPEECH_VOICES`); no registry imports. |
| `jsr:@theoremjs/agents/schema` / `@theoremjs/agents/schema` | Profile vocabulary and field catalog (closed unions, field metadata) for host UIs and docs; no Deno APIs. |
| `jsr:@theoremjs/agents/providers/google/live` / `@theoremjs/agents/providers/google/live` | Gemini Live framing and session helpers (`openGoogleLiveSession`); live runs through `runSession`. |

Demo fixtures, such as the travel concierge seeds and local handlers, live in the **repo-private** `@theoremjs/playground` package under `playground/`. Theorem never publishes it with the kernel. A host that needs the fixtures links `file:../theoremai/playground`.

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
| Guardrail vocabulary | `AdvisoryLevel`, `TrustLevel`, `GuardrailStage`, `Severity`, `GuardrailHit`, `Verdict`, `GuardrailAction`, `GuardrailContext`, `GuardrailEvent`, `guardrailEventSchema`, `OutboundPayload`, `Provenance`, `ToolOrigin`, `ScanText`, `BlockedReplySpec`, `BlockedReplyOnBlock`, `ResolvedBlockedReply`, `UrlAllow`, `NameAllow`, `UrlDetector`, `ResolvedAllow`, `ProfileGuardrailsSpec`, `HostGuardrailsSpec`, `NetworkGuardrailSpec`, `QuotaGuardrailSpec`, `ResolvedGuardrailPolicy`, `DetectionOptions`, `SensitiveGroup`, `SensitiveSelection`, `SensitiveSwitches`, `GuardedToolText`, `TurnTaint`, `TaintGate`, `TaintGuardrailSpec`, `TRUST_LEVELS`, `GUARDRAIL_STAGES`, `SEVERITIES`, `TOOL_ORIGINS` |
| Guardrail policy | `resolveGuardrailPolicy`, `BLOCKED_REPLY_ON_BLOCK`, `hitRules`, `EGRESS_RULES`, `runEnforcer` |
| Tool boundary | `guardToolResult`, `guardToolFailureText`, `inspectToolArguments`, `toolCallEvent`, `wrapToolData`, `isRemoteOrigin`, `composeToolText`, `checkTaintGate`, `recordTaint`, `isTainted`, `isSuspicious`, `directives`, `advisoryLevel`, `DIRECTIVE_SIGNALS`, `Directive`, `DirectiveSignal`, `ADVISORY_LEVELS`, `TOOL_CLOSE`, `TOOL_ORIGINS`, `TAINT_GATES`, `InspectedToolArguments`, `textForScan`, `scanTextOf` |
| Quota | `QuotaSlotStatus`, `clientIp`, `quotaExhausted`, `releaseSlot`, `resetSlots`, `skipQuota`, `takeSlot` |
| Lexicon | `LEXICON_KEYS`, `LexiconKey`, `CLIENT_LEXICON_KEYS`, `ClientLexiconKey`, `LexiconOverrides`, `LexiconParams`, `lexiconDefault`, `lexiconText`, `overrideLexicon`, `resetLexicon` |
| Sanitize | `sanitizeProjectId`, `sanitizeTurnRequest`, `sanitizeTurnRequestWithEvents`, `SanitizedTurnRequest`, `guardrailFromHits`, `guardrailFromVerdict`, `guardrailTurnEvent`, `projectGuardrailTurnEvent`, `hitFromSpan`, `projectGuardrailEvent` |
| Canary / egress | `mintCanary`, `bindCanary`, `wrapUserData`, `scanTextForCanaryLeak`, `scanTextForPromptEcho`, `PROMPT_ECHO_WORDS`, `redactCanary`, `OMIT_CANARY`, `createCanaryStreamGate`, `eventHasCanary`, `createCanaryGateSession`, `filterCanaryGatedEvents`, `CanaryGateResult`, `CanaryGateSession`, `CanaryStreamGate`, `GivenUrls`, `createOutboundProgressiveGate`, `createProgressiveYieldGate`, `createLiveOutboundGateSession`, `processLiveOutboundBatch`, `finalizeLiveOutboundTurn`, `abortLiveOutboundTurn`, `LiveHeldOutput`, `LiveOutboundBatchResult`, `LiveOutboundGateSession`, `ProgressiveYieldGate`, `ProgressiveYieldGateOptions`, `ProgressiveYieldResult` |
| Compaction | `compactHistory`, `CompactionSplit`, `CompactionTokens`, `compactionMeter`, `compactionNeeded`, `resolveCompactionTokens`, `resolveHistoryTokens`, `shouldCompact`, `splitForCompaction` |
| Token estimate | `loadTokenEstimator`, `mediaTokenFamily`, `TOKEN_TEXT_ENCODING`, `MediaPayload`, `MediaTokenFamily`, `TokenCount`, `TokenEstimator`, `sumTokens` |
| Runner | `runTurn`, `runSession`, `runDecision`, `validateDecisionRequest`, `RunSessionOptions`, `SignInGatePolicy`, `RunDecisionOptions`, `DecisionError`, `prepareLiveInboundText`, `liveIngressEnabled`, `liveIngressEnabledFromSpec`, `liveIngressChannelDefault`, `hasAnyLiveIngress`, `assertLiveIngress`, `assertLiveIngressConfigured`, `LiveIngressChannel` |
| Attachments | `attachmentIssues`, `attachmentIssueCopy`, `attachmentIssueText`, `attachmentsRefused`, `assertTurnAttachments`, `maxBytesForMime`, `requireMediaLimits`, `resolveMediaLimits`, `sanitizeCsvText`, `sanitizeTurnBlobs`, `AttachmentFacts`, `AttachmentRules` |
| Catalog | `clampThinkingLevel`, `clampThinkingLevelForApiId`, `mediaChannelForMime`, `MediaInputChannel`, `mediaKindForMime`, `mimeAllowed`, `mimeEssence`, `modelEntryByApiId`, `requireModelBinding` |
| Schema | `PROFILE_FIELDS`, `PROFILE_GRAPH`, `PROFILE_TYPES`, `PROFILE_TYPE_PROTOCOLS`, `protocolsForProfileType`, `isValidProfileProtocol`, `EXTRA_FIELDS`, `REQUEST_FIELDS`, `API_EXPORTS`, `fieldMeta`, `catalogPathFor`, `DYNAMIC_FIELD_PARENTS`, `spineFacetsForProfileType`, `profileGraphFacet`, `ProfileGraphFacet`, `ProfileGraphFacetId`, `ProfileGraphEditor`, `ProfileGraphRole`, `PROTOCOLS`, `PROVIDERS`, `PROTOCOL_PROVIDERS`, `providersFor`, `protocolsFor`, `isValidPair`, `coerceProvider`, `coerceProtocol`, `THINKING_LEVELS`, `KEY_SLOT_NAME`, `isKeySlotName`, `MEDIA_INPUT_KINDS`, `MEDIA_INPUT_KIND_VALUES`, `MEDIA_WILDCARDS`, `ATTACHMENT_ACCEPT_MIMES`, `IMAGE_ATTACHMENT_ACCEPT_MIMES`, `VOICE_ACCEPT_MIMES`, `SUMMARY_MODES`, `STREAM_MODES`, `SPEECH_AUDIO_FORMATS`, `COMPACTION_METERS`, `COMPACTION_OUTCOMES`, `COMPACTION_TIMINGS`, `CACHE_MODES`, `CACHE_TTLS`, `TURN_STAGES`, `TURN_INJECT_STAGES`, `TURN_STOP_KINDS`, `CONTINUE_STOP_KINDS`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `TOOL_LOAD_TIERS`, `TOOL_ACCESS`, `TOOL_PERMISSION`, `TOOL_TYPES`, `AUTH_UNAUTHENTICATED_POLICIES`, `HTTP_METHODS`, `PLAYGROUND_AUTH_TYPES`, `TOOL_AUTH_TYPES`, `AuthUnauthenticatedPolicy`, `CustomToolType`, `HttpMethod`, `PlaygroundAuthType`, `ToolAccess`, `ToolAuthType`, `ToolPermission`, `ToolType`, `LIVE_ACTIVITY_HANDLINGS`, `LIVE_START_SENSITIVITIES`, `LIVE_END_SENSITIVITIES` |
| Scope | `KernelScope`, `createKernelScope`, `defaultKernelScope`, `KernelRegistry`, `createKernelRegistry` |
| Profiles | `ProfileDefinition`, `ProfileDefinitionBase`, `TextProfileDefinition`, `ImageProfileDefinition`, `SpeechProfileDefinition`, `LiveProfileDefinition`, `HostProfileDefinition`, `DecisionProfileDefinition`, `ProfileRegistry`, `createProfileRegistry`, `clearProfiles`, `defineProfile`, `getProfile`, `hasProfile`, `listProfiles`, `registerProfile`, `registerProfiles`, `projectProfile`, `resolveTurn`, `pickModel` |
| Tools | `ToolRegistry`, `createToolRegistry`, `registerTool`, `registerTools`, `invokeTool`, `GATE_DECISIONS`, `GateDecision`, `askUserTool`, `registerHarnessTools`, `getTool`, `hasTool`, `requireTool`, `listTools`, `resetTools`, `formatToolResult`, `prepareTurnToolSnapshot`, `buildHttpToolTarget`, `executeHttpTool`, `executeMcpTool`, `parseMcpRpcResponse`, `isUnsupportedMcpProtocolError`, `MCP_PROTOCOL_VERSIONS`, `McpProtocolVersion`, `resolveToolAuth`, `uncheckedOutput`, `UncheckedOutput` |
| Structured | `SchemaRegistry`, `createSchemaRegistry`, `getStructured`, `registerStructured` |
| Stop / resume | `ProfileTurnBehaviourSpec`, `MediaTurnBehaviourSpec`, `ProfileTurnResumptionSpec`, `TurnContinueFrom`, `TurnStop`, `TurnStopKind`, `ContinueStopKind`, `CONTINUE_STOP_KINDS`, `AUTO_CONTINUE_DELAY_MS`, `DEFAULT_ALLOW_CONTINUE`, `DEFAULT_AUTO_CONTINUE`, `GenerationStopError`, `isContinueStopKind`, `isGenerationStopError`, `isResumeableStop`, `isUserCancelledStop`, `profileAllowsSteering`, `profileAllowsInject`, `profileTurnResumption`, `shouldAutoContinue`, `turnStopFromClientStreamEnd`, `turnStopFromInteractionStatus`, `turnStopFromOpenAiFinishReason` |
| Stages (target foundation) | `TURN_STAGES`, `TURN_INJECT_STAGES`, `STAGE_AFFORDANCES`, `STAGE_AFFORDANCE_MATRIX`, `TOOL_GATE_KINDS`, `AWAITING_USER_INPUT_KINDS`, `AWAITING_USER_INPUT_STATUS`, `applyStageResult`, `awaitingUserInputSchema`, `toolGateSchema`, `isTurnStage`, `isTurnInjectStage`, `isToolGateKind`, `isAwaitingUserInput`, `stageAllowsAffordance`, `stageEventFields`, `profileAllowsInject`, `StageAffordance`, `StageContext`, `StageResult`, `StageMutate`, `StageHandler`, `StageApplyInput`, `StageApplyOutput`, `StageApplyWarning`, `StageApplyWarningCode`, `StageEventExtra`, `AwaitingUserInput`, `ToolGate` — contract [`docs/contracts/stages.md`](https://github.com/masudl-hub/theoremai/blob/main/docs/contracts/stages.md) |
| Turn events | `TURN_EVENT_SCHEMAS` (each kind's schema, for a wire parser), `turnEventSchema`, `turnHistoryMessageSchema`, `turnToolSnapshotSchema`, `turnDoneOf`, `z` (the zod these schemas are built with; compose them with it, since two copies of zod do not mix) — the event types themselves come through `export type *` from `src/kernel/types.ts` |
| Observability | `memorySink`, `noopSink`, `readTraceparent`, `writeTrace`, `buildRecord`, `traceRecordSchema`, `contentOf`, `inlineContent`, `toOtlpJson`, `startTrace`, `traceContent`, `traceBytes`, `traceJson`, `registerTraceDestination`, `requireTraceDestination`, `getTraceDestination`, `listTraceDestinationIds`, `clearTraceDestinations`, `isTraceSink`, `resolveTraceWriter`, `resolveObservabilityPolicy`, `traceSpanMeta`, `traceAttributeMeta`, `traceEventMeta`, `traceEventAttributeMeta`, `TRACE_ATTRIBUTE_GROUPS`, `TRACE_STATUS`, `TRACE_FIELDS`, `TRACE_SPAN_TYPES`, `TraceSpanMeta`, `TraceSpanType`, `TraceAttributeMeta`, `TraceEventMeta`, `TraceOptionMeta`, `TraceAttributeGroup`, `TraceValueFormat`, `TraceRecord`, `TraceSink`, `TraceWriteContext`, `TraceSpan`, `TraceSpanEvent`, `TraceSpanKind`, `TraceSpanLink`, `TraceSpanStatus`, `TraceAttributes`, `TraceAttributeValue`, `TraceContent`, `TraceBytes`, `TraceJson`, `TraceTree`, `SpanHandle`, `SpanOptions`, `SpanLinkInput`, `TraceClock`, `ProfileObservabilitySpec`, `ResolvedObservabilityPolicy`, `ResolvedTraceInclude`, `ResolvedTraceScrub`, `TraceIncludeSpec`, `TraceScrubSpec`, `ScrubSwitch`, `ResolvedScrubSwitch`, `OtlpTraceRequest`, `OtlpSpan`, `OtlpKeyValue`, `OtlpAnyValue` (file sink: `@theoremjs/agents/observability/jsonl` → `jsonlSink`, `JsonlSinkOptions`) |
| Providers | `CreateProviderOptions`, `GeminiOptions`, `KeyVault`, `LocalProviderConfig`, `OpenAiGatewayConfig`, `createProvider` (local: `@theoremjs/agents/providers/local` → `createLocalProvider`) |

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
provider_adapters_lazy = true
trace_sinks_host_injected = true
live_sessions = "Gemini Live via runSession; host owns mic, camera, and playback"
session_memory_in_kernel = false
```

**Facts and policy.** Provider facts may ship, such as model capabilities, wire shapes and protocol metadata. For example, see `@theoremjs/agents/presets/google`. Product policy may not ship: prompts, personas, end-user copy, demo apps and channel behaviour. Every string that a user or a model reads is either supplied by the host or is an overridable default in the kernel lexicon (`overrideLexicon`). Behavioural defaults are typed profile-schema fields. Optional packages, such as `playground/`, are inert extras. If you delete one, no kernel behaviour changes.

Four properties are invariant. Where a test or a lint checks one, the table names it.

| Id | Property | Check |
| --- | --- | --- |
| P1 | No ambient authority — construct with every Deno permission denied | `tests/kernel/zero-permission-import.test.ts` |
| P2 | No unownable words — user/model-visible strings are host-suppliable or lexicon defaults | lexicon + full-tree `scripts/docs-truth/copy-lint.mjs` + two-hosts test |
| P3 | No buried policy — behavioral defaults are declared profile-schema fields | `PROFILE_FIELDS` / schema |
| P4 | Inert extras — optional entrypoints removable without behavior change | publish-bundle gate excludes `playground/` |

Provider adapters load on the first `complete` call for their transport. `createProvider` and `@theoremjs/agents/providers` stay a thin barrel (`src/providers/mod.ts`). Implementation modules, such as `google/interactions/`, `openrouter/` and `local/`, are not pulled in when you import.

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
        { "kind": "source", "path": "src/guardrails/lexicon.ts" },
        { "kind": "contract_test", "path": "tests/kernel/two-hosts-boundary.test.ts" },
        { "kind": "contract_test", "path": "tests/kernel/zero-permission-import.test.ts" }
      ]
    }
  }
}
```
