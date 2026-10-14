# Providers (`@theoremjs/agents/providers`)

Use this contract when you add an adapter or change the boundary between an adapter and the kernel.
A registered provider supplies model operations. The kernel applies the profile, validates model events, and executes client tools.

## Export

Use the providers entrypoint for adapter contracts, factories, schemas, and transport utilities.

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/providers` / `jsr:@theoremjs/agents/providers` |
| Module | `src/providers/mod.ts` |
| Root | `mod.ts` also exports provider contracts and first-party factories |
| Local subpath | `@theoremjs/agents/providers/local` exports the existing local codec |
| Testing subpath | `@theoremjs/agents/providers/testing` exports offline conformance fixtures and reports |
| Live subpath | `@theoremjs/agents/providers/google/live` exports the existing Google socket codec |

## Ownership

Keep protocol code in the adapter. Keep execution authority in the kernel.

| Source | Responsibility |
| --- | --- |
| `src/providers/adapters.ts` | First-party definitions and lazy construction of operations |
| `src/kernel/provider-contract.ts` | Public schemas, adapter interfaces, and registry |
| `src/kernel/provider-runtime.ts` | Capability checks, credentials, terminal validation, and checkpoints |
| `src/kernel/provider-live.ts` | Normalized live operations for the session runner |
| `src/providers/openrouter/chat.ts` | Official SDK transport and response decoding |
| `src/providers/openrouter/openai/reasoning-state.ts` | Native reasoning associated with portable tool-call IDs |
| `src/providers/google/interactions/` | Google request and event translation |
| `src/providers/google/live/` | Google WebSocket request and event translation |
| `src/providers/decision/native.ts` | Native decision HTTP operation |
| `src/providers/shared/` | Server-sent events (SSE), retries, tool arguments, and tracing utilities |

## Package boundary

Register executable adapter code on the host. Store only model-binding data in profiles.
Loading profile JSON does not import an adapter or resolve credentials.

| Action | Owner |
| --- | --- |
| Encode requests, open transport, decode responses | Adapter |
| Validate requirements and model events | Kernel |
| Apply guardrails, approvals, and execution limits | Kernel |
| Execute client tools | Kernel |
| Execute hosted provider tools | Upstream provider |
| Supply credentials and trace storage | Host |

First-party factories load operation implementations lazily. Defining or registering these providers does not open HTTP or WebSocket transport.
The factories do not read environment variables for credentials or endpoints.
The host supplies a vault. It can also supply fetch, waits, and a WebSocket opener.

## Registered providers

Register providers before profiles. Use the definition's model helper to validate options and produce ordinary binding data.

| Factory | Operations |
| --- | --- |
| `openRouterAdapter` | Chat, image, speech, and decisions |
| `googleAdapter` | Interactions and live sessions, subject to model capabilities |
| `openAIChat` | Compatible text chat |
| `typesafeAdapter` | Decisions; no client tools |
| External `ProviderAdapter` | Its declared operations |

```ts
import {
  createKernelScope, defineProfile, defineProvider, openRouterAdapter,
} from '@theoremjs/agents';

const scope = createKernelScope();
const router = defineProvider({
  id: 'company-router',
  connection: { baseURL: 'https://openrouter.ai/api/v1' },
  keySlot: 'company',
  adapter: openRouterAdapter(),
});
scope.providers.register(router);
scope.profiles.register(defineProfile({
  id: 'analyst',
  type: 'text',
  identity: { handle: 'Analyst' },
  tools: { allow: [] },
  inputs: { text: true },
  models: { default: router.model('model-id', {
    maxOutputTokens: 4096,
    providerOptions: { cache: { mode: 'automatic' } },
  }) },
}));
```

`defineProvider` checks the connection and credential-slot names. Its `.model()` helper checks shared settings and adapter options.
Profile registration checks each binding against the registered adapter again.

`ProviderRegistry` supplies `register`, `registerMany`, `get`, `require`, `has`, `list`, and `reset`.
Registration replaces an existing definition with the same ID. Each kernel scope has its own registry.
Each run snapshots its selected definition. Called agents and compactors resolve their own bindings.

The snapshot captures schemas and binds adapter methods to their original receiver.
Object adapters and class adapters use the same contract. Class continuation methods retain their receiver too.
Replacing a registration affects later runs. It does not replace an active run's captured methods or continuation descriptor.
Connection data is cloned. Hidden mutable adapter state is not cloned; adapters must keep active connection semantics stable.

The default scope supplies `registerProvider`, `registerProviders`, `getProvider`, `requireProvider`, `hasProvider`, `listProviders`, and `resetProviders`.
`runTurn`, `runSession`, `runDecision`, and `compactHistory` receive host options, including the vault.
They resolve adapters from registered model bindings. An unknown provider fails before model transport opens.

## Model bindings

Use a binding to select a registered provider and an upstream model or deployment.

| Field | Contract |
| --- | --- |
| `provider` | Nonempty registered provider ID |
| `apiId` | Nonempty upstream model or deployment ID |
| Shared settings | Output tokens, temperature, effort aliases and selection, summaries, builtins, and compaction |
| `keySlot`, `fallbackKeySlot` | Optional overrides of the definition's credential slots |
| `providerOptions` | JSON object, parsed by the selected adapter; defaults to an empty object |
| Decision timeout | Decision bindings retain `timeoutMs` |

`modelBindingSchema` checks shared data. The adapter's options schema checks `providerOptions`.
Bindings have no protocol enum. Cache, storage, interaction persistence, and local server settings belong in adapter options.
Provider definitions supply credential defaults. Profiles do not contain credential values or resolver functions.

## Adapter contract

Implement `ProviderAdapter` when an endpoint needs a different protocol. Reuse a factory when its protocol matches the endpoint.
An endpoint address alone does not establish compatibility.

| Member | Contract |
| --- | --- |
| `apiVersion` | `1` |
| `id` | Stable implementation ID |
| `connectionSchema` | Validates connection data; output must be JSON-compatible |
| `optionsSchema` | Validates model options; output must be a JSON object |
| `credentialSchema` | Validates a resolved credential |
| `capabilities` | Declares profile types, content kinds, builtins, and feature support |
| `validateRequest` | Checks restrictions beyond shared capability checks |
| `create` | Asynchronously returns supported operations |
| `continuation` | Optional version, state schema, and compatibility key |

Feature support is `supported`, `unsupported`, or `unknown`.
The kernel derives requirements from the profile and actual request. Required features need `supported` status before transport opens.
The adapter checks remaining restrictions, such as MIME types, tool schemas, and option combinations.

`ProviderContext` supplies connection data, options, model ID, abort signal, and `resolveCredential`.
It also supplies fetch, wait, an optional WebSocket opener, and `tapUpstream`.
Credential access covers only the selected primary and explicit fallback slots. Transport utilities are optional; adapters can use an SDK.

Implement only the operations that the adapter provides.

| Operation | Input | Output |
| --- | --- | --- |
| `complete` | `ProviderTurnRequest` | Async stream of `ProviderModelEvent` |
| `openSession` | `ProviderSessionRequest` | `ProviderLiveConnection` |
| `decide` | `ProviderDecisionRequest` | Validated native decision result |

The kernel rejects a missing required operation. Requests contain normalized history, content, tools, and generation settings.
The adapter converts these values to its upstream format.

## Event authority and termination

Report model output and tool requests through `ProviderModelEvent`. Do not report kernel decisions as provider output.

`ProviderContentEvent` permits text, thoughts, structured output, media, citations, grounding, evidence, usage, session notifications, and errors.
Other model events carry tool requests, cancellations, response identity, or terminal `done` status.
The kernel rejects stages, guardrail verdicts, approvals, and client-tool execution results from adapters.

Tool requests need nonempty IDs and names, with JSON-object arguments. A repeated settled call cannot authorize another execution.
The kernel holds pending client calls until it validates model-step termination.

| Boundary | Condition for release |
| --- | --- |
| Turn | Successful terminal event, then stream exhaustion with no subsequent event |
| Live session | Successful model-step terminal; a generation notification alone is insufficient |
| Parallel calls | Verified parallel-tool support |

A missing terminal, malformed event, error, or interruption prevents pending calls from executing.
EOF alone is not successful completion. Cancellation does not silently replay a request.

`ProviderLiveConnection` sends text, audio, video, context, and approved tool results. It also closes the session.
Its optional `closeInfo` reports the close code, diagnostic reason, and preceding close warning.
The live kernel applies its labels and tracing policy to these values.

## OpenRouter

Use `openRouterAdapter` for OpenRouter chat and native image, speech, or decision endpoints.

| Operation | Transport |
| --- | --- |
| Chat | Pinned official `@openrouter/sdk` |
| Image, speech, and decisions | Separate native HTTP endpoints |

Chat uses the pinned official `@openrouter/sdk`. SDK retries and debug output are disabled.
Theorem controls transient retries and explicit quota fallback. The raw decoder preserves metadata omitted by SDK response projections.

Chat and native decision requests require routing support for supplied parameters.
Chat decodes text, reasoning, fragmented tool arguments, structured output, citations, and usage.
Checkpoints retain native reasoning for replay with matching portable tool-call IDs.

Set chat caching in `providerOptions.cache`. Native image and speech operations reject client tools, structured output, and chat-only settings.
Speech speed requires a verified OpenAI TTS model. Other model families reject this setting.

## Google Interactions

Use `googleAdapter` for Google Interactions. Its model options contain `store` and `persistViaInteractionId`. Its `googleMaps` builtin takes a `location` from the request's `builtInArgs`.

```ts
const binding = google.model('model-id', {
  providerOptions: { store: true, persistViaInteractionId: true },
});
```

With persistence enabled, checkpoint data contains the interaction ID.
After checkpoint validation, the adapter sends only history beyond the covered prefix.
After a mismatch, it sends portable history without the native ID.

Unknown model IDs have unknown feature support and no verified media kinds.
Builders can pass model capability declarations to `googleAdapter`.
Known live models provide live sessions and audio output. TTS models provide speech operations.

## Google Live

Use the Google adapter's `openSession` operation for native WebSocket sessions.
The adapter encodes Google frames. The kernel sends normalized input and approved tool results through the public connection.

| Data | Treatment |
| --- | --- |
| Native resumption handle | Checkpoint data |
| Portable history | Stored separately from displayed transcript content |
| Compatible checkpoint | Send only history beyond its covered prefix |
| Rebuilt session | Send the complete portable history |

The adapter requests input and output transcriptions for portable audio history.
The kernel records final transcriptions only after the outbound gate releases them.
Portable user text excludes the fences added to upstream input.
The normalized boundary preserves provider close warnings and errors.

## Local provider

Use `openAIChat` for endpoints that accept the compatible chat protocol.
The connection requires `baseURL`. The adapter appends `/chat/completions`.

```ts
const local = defineProvider({
  id: 'local-chat',
  connection: { baseURL: 'http://localhost:11434/v1' },
  adapter: openAIChat(),
});
```

The default declaration verifies text input, text output, and streaming.
Tools, structured output, and reasoning remain unknown until the builder declares verified deployment capabilities.
The kernel rejects unverified requirements before transport opens.
The codec assembles fragmented tool IDs, names, and arguments before it releases a call.

The local subpath retains `createLocalProvider` for codec consumers. Registered runners use `openAIChat`.

## Speech roles

Use a speech profile to resolve voice, format, and media settings before the adapter call.

| Adapter | Audio operation |
| --- | --- |
| OpenRouter | Native audio endpoint |
| Google | Interactions output audio |

Codecs preserve native media details and convert supported raw PCM to WAV.
The kernel validates the profile's speech role and input kinds.

## Verify an external adapter

Use `verifyProviderAdapter` before a host enables a custom protocol.
The `@theoremjs/agents/providers/testing` entrypoint imports public contracts and has no test-framework dependency.
It does not open transport at import time.

`ProviderAdapterFixtureBase` contains the name, profile, host fixtures, and expected outcome.
`ProviderAdapterFixture` adds the normalized request and operation.
Operations are `complete`, `decide`, or `openSession`. Live fixtures also supply an exercise callback.
Each fixture receives a new kernel scope. Its setup callback registers tools and output schemas.
The runner registers the supplied provider and profile after setup.
All profile model bindings must name that provider.

Host fetch and WebSocket fixtures supply deterministic upstream responses.
An omitted transport refuses network access. An explicitly supplied transport remains trusted host code.
The fixture can inspect `ProviderFixtureObservation`: events, operation value, error kind, safe error copy, and requested credential slots.
The runner never includes credentials or caught diagnostic messages in its report.

`ProviderFixtureResult` preserves fixture names and operation names.
Failures identify configuration, execution, expectation, or inspection.
`ProviderConformanceReport` separates fixture results, operation coverage, and named checks.
An explicit model identifies the deployment whose capability declaration the report checks.
Unsupported operations and supported operations without fixtures remain distinct.
Missing evidence is `unverified`. A fixture failure is `fail`; a satisfied fixture assertion is `pass`.

`ProviderConformanceCheck` names operation, cancellation, budgets, credential isolation, and terminal checks.
`ProviderFixtureControl` lets a fixture abort after it reaches a deterministic transport barrier.
Cancellation checks require this callback, an expected cancelled result, and cleanup assertions.
Preflight abort alone does not verify cooperative cancellation.
Budget fixtures require finite overrides, an expected error, and assertions for the exhausted budget.
Failed turn fixtures retain normalized events for these assertions.
Credential fixtures require an inspection callback and an observed credential request.
Terminal fixtures run through the turn boundary, including incomplete-stream rejection.
Checks without fixtures remain unverified.

The default fixture deadline is ten seconds. Expiry aborts the operation and returns a failed fixture result.
It also bounds an asynchronous setup or inspection that ignores cancellation.
It cannot interrupt synchronous host code or certify future upstream behavior.
Fixture assertions remain the builder's responsibility.

## Key vault (provider-neutral)

Supply credentials through host options. Keep credential values and resolver functions outside profiles.

| Vault entry | Resolution |
| --- | --- |
| String | Validate with the credential schema |
| JSON object | Validate with the credential schema |
| Resolver function | Call when needed, await its value, then validate it |
| Unfilled slot | Report an authentication failure when a required credential is requested |

`CredentialResolver` receives provider ID, model ID, selected slot, and abort signal.
The host resolver owns caching and refresh. Model slot overrides take precedence over definition defaults.
Fallback requires an explicitly configured slot. The adapter determines when to request it.
Vault lookup reads only own properties. An inherited primary entry is missing; an inherited fallback entry returns no credential.

Resolver failures and invalid values produce authentication failures without credential values in the diagnostic.
An exception while reading the selected vault property produces the same sanitized resolution failure.
Exceptions during credential parsing or inspection produce a sanitized shape failure, including transformed adapter values.
The runtime redacts resolved credential strings from upstream rows, adapter errors, and wording parameters.
Upstream row redaction includes JSON property names and nested values.
Tool credentials retain their separate contract.

## Saved provider state

Store native checkpoints beside portable history to resume a conversation or rebuild it after a provider change.
The kernel creates the checkpoint envelope and history hash. The adapter supplies validated native JSON data.

| Checkpoint field | Purpose |
| --- | --- |
| `providerId`, `adapterId` | Provider instance and adapter identity |
| `version`, `apiId` | State format version and upstream model identity |
| `compatibilityKey` | Deployment and relevant option identity; excludes secrets |
| `coveredHistoryLength`, `coveredHistoryHash` | Portable history prefix represented by the native state |
| `data` | Adapter state validated by its continuation schema |

Pass `providerState` with history on the next turn or session request.
Successful turn completion returns `providerState`. Live `provider_checkpoint` events contain the checkpoint and covered portable `history`.
Interface helpers retain checkpoints separately from displayed history. A branch discards native state.

Provider, model, deployment, version, or covered-history changes cause a mismatch.
The default policy rebuilds from portable history and emits `provider_warning` with `provider_state_rebuilt`.
Set `providerContinuation.onMismatch` to `error` to reject the mismatch instead.
Set `providerContinuation.history` to `provider` when the provider's stored conversation is the only history: pass `providerState` alone, and a request that also carries history is a mismatch.
Compatible checkpoints with malformed native data fail validation.
At browser ingress, chat and live must also validate conversation ownership before the kernel receives native state.
The React session boundary provides this check for live relays.
The relay must save checkpoint ownership before it exposes the checkpoint to the browser.
Failed or discarded output does not commit a usable history prefix or authorize pending tools.

## Exported API

The providers barrel exports all provider contracts and schemas, `KeyVault`, `googleAdapter`,
`openRouterAdapter`, `openAIChat`, `typesafeAdapter`, `parseSseStream`, `readSseChunks`,
`retryTransient`, `waitDefault`, `isTransientHttp`, `isTransientThrown`,
`parseToolArgumentsObject`, `historyToolArguments`, `tapFetch`, `tapeHeaders` and `networkFetch`.
The low-level live subpath exports `openGoogleLiveSession`, `GoogleLiveConnection`
and `OpenLiveWebSocket`.


| Group | Symbols |
| --- | --- |
| Provider definitions | `ProviderAdapter`, `ProviderBuiltinSpec`, `ProviderDefinition`, `DefinedProvider`, `RegisteredProvider`, `ProviderRegistry`, `defineProvider`, `createProviderRegistry` |
| Provider data | `JsonValue`, `JsonObject`, `CapabilitySupport`, `ProviderCapabilities`, `ResolvedProviderModel`, `ProviderModelSettings` |
| Provider vault | `ProviderCredential`, `CredentialContext`, `CredentialResolver`, `ProviderVault`, `ProviderWait`, `OpenProviderWebSocket` |
| Provider operations | `ProviderHostOptions`, `ProviderLimits`, `providerLimitsSchema`, `resolveProviderLimits`, `ProviderContext`, `ProviderOperations`, `ProviderRequest`, `ProviderTurnRequest`, `ProviderSessionRequest`, `ProviderDecisionRequest`, `ProviderLiveConnection`, `ProviderToolResult` |
| Provider output | `ProviderContentEvent`, `ProviderModelEvent`, `ProviderCheckpoint`, `ProviderWarning`, `ProviderContinuationPolicy` |
| Provider schemas | `jsonValueSchema`, `jsonObjectSchema`, `keySlotSchema`, `commonModelSettingsSchema`, `modelBindingSchema`, `decisionModelBindingSchema`, `providerCheckpointSchema`, `providerWarningSchema`, `providerContinuationSchema`, `providerCapabilitiesSchema` |
| Provider limits | `ProviderLimits`, `providerLimitsSchema`, `resolveProviderLimits` |

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
          "path": "src/providers/adapters.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/create-provider-import-isolation.test.ts"
        }
      ]
    },
    "Registered providers": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/provider-contract.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/extensions.test.ts"
        }
      ]
    },
    "Model bindings": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/provider-contract.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/extensions.test.ts"
        }
      ]
    },
    "Adapter contract": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/provider-contract.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/extensions.test.ts"
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
          "path": "tests/providers/extensions.test.ts"
        }
      ]
    },
    "OpenRouter": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/openrouter/chat.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/openrouter/chat.test.ts"
        }
      ]
    },
    "Google Interactions": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/adapters.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/google/interactions/stream.test.ts"
        }
      ]
    },
    "Google Live": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/adapters.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/observability/live-trace.test.ts"
        }
      ]
    },
    "Local provider": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/adapters.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/local/local.test.ts"
        }
      ]
    },
    "Speech roles": {
      "supports": [
        {
          "kind": "source",
          "path": "src/providers/openrouter/speech.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/openrouter/speech.test.ts"
        }
      ]
    },
    "Key vault (provider-neutral)": {
      "supports": [
        {
          "kind": "source",
          "path": "src/kernel/provider-runtime.ts"
        },
        {
          "kind": "contract_test",
          "path": "tests/providers/extensions.test.ts"
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
          "path": "tests/providers/extensions.test.ts"
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

Use host limits to bound setup, credentials, retries, and upstream output. Profiles contain none of these limits.
`ProviderHostOptions.limits` accepts positive safe-integer overrides. Timer limits must fit the runtime timer range.
`resolveProviderLimits` merges defaults and validates the result with `providerLimitsSchema`.
The adapter receives resolved limits through `ProviderContext.limits`.

| Budget | Default |
| --- | --- |
| Operation deadline | 120 seconds |
| Live connection deadline | 30 seconds |
| Active live response deadline | 120 seconds |
| Wire record and normalized event | 16 MiB each |
| Decompressed HTTP response and aggregate HTTP attempts | 64 MiB each |
| Normalized response cycle | 64 MiB and 100,000 events |
| Pending client tool calls | 32 |

The operation deadline includes creation and credential resolution. Retries retain the original deadline and consumption budget.
Theorem sends a request again when it fails with a network error or a 408, 429, 500, 502, 503 or 504 status, while the waits between tries stay within five seconds in all.
Each wait is the response's `Retry-After` when it gives one. Otherwise it is 1, 2, 4, then 8 seconds. A wait that would pass the five seconds is not taken, and the last answer goes back as it came.
A timeout or an abort is not retried. A 429 moves to the fallback key slot only after the last try.
Injected fetch counts decompressed bytes before forwarding each chunk. SSE records include incomplete records and comments.
Injected WebSocket transport checks message bytes before adapter JSON parsing.
Normalized accounting includes media, structured output, tool arguments, and native state. It measures UTF-8 JSON bytes.
Decision outputs use the same normalized byte limit. Compaction uses the bounded complete operation.
Live response budgets reset at validated terminal events. User-input idle time has no active response timer.
Exhaustion cancels transport, discards unreleased tool requests, and prevents checkpoint commitment.
Adapters must use the injected transport and signal. Theorem cannot interrupt arbitrary adapter code that bypasses them.
