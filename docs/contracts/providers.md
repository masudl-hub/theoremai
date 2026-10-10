# Providers (`@theoremjs/agents/providers`)

Register a provider before registering profiles that reference it. A provider definition
holds host code and connection settings; a profile holds its provider ID, model ID and
serializable options. Credentials arrive separately through the vault when an operation runs.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/providers` / `jsr:@theoremjs/agents/providers` |
| Module | `src/providers/mod.ts` |
| Root | Provider contracts and first-party factories are also exported from `mod.ts` |
| Local subpath | `@theoremjs/agents/providers/local` exports the existing local codec |
| Live subpath | `@theoremjs/agents/providers/google/live` exports the existing Google socket codec |

## Ownership

The provider package owns protocol encoding, transport and decoding under `src/providers/`.
The kernel owns registration, request requirements, credentials, event validation and checkpoints.

| Source | Responsibility |
| --- | --- |
| `src/providers/adapters.ts` | First-party adapter definitions and lazy operation construction |
| `src/kernel/provider-contract.ts` | Public schemas, adapter interfaces and registry |
| `src/kernel/provider-runtime.ts` | Capability checks, credential resolution, terminal validation and checkpoints |
| `src/kernel/provider-live.ts` | Normalized live operations exposed to the live runner |
| `src/providers/openrouter/chat.ts` | Official SDK chat transport and normalized response decoding |
| `src/providers/openrouter/openai/reasoning-state.ts` | Native reasoning replay associated with portable tool-call IDs |
| `src/providers/google/interactions/` | Google request and event translation |
| `src/providers/google/live/` | Google WebSocket request and event translation |
| `src/providers/decision/native.ts` | Native decision HTTP operation |
| `src/providers/shared/` | SSE, retries, tool arguments and tracing utilities |

## Package boundary

| Authority | Owner |
| --- | --- |
| Protocol encoding and transport | Adapter |
| Approvals, guardrails and client execution | Kernel |

Definitions contain executable host code. Saved profiles do not. Loading a JSON profile
never imports a module named in that JSON, executes an adapter or resolves a credential.

Importing factories and defining a provider performs schema validation. First-party factories
load their operation implementations lazily. Construction does not open HTTP or WebSocket transport.
Hosts supply a vault and may supply fetch, waits and a WebSocket opener. No factory reads an
ambient environment variable to discover a credential or endpoint.

The kernel executes client tools, applies approvals and guardrails, and enforces turn limits.
An adapter encodes the tools offered by the kernel and reports requests to call them.
Hosted provider tools remain provider operations and evidence; they are not client-tool execution.

## Registered providers

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

`defineProvider` validates connection data and credential-slot names. Its `.model()` helper
validates shared settings and adapter options, returning ordinary model-binding data.
Profile registration validates the binding against the currently registered adapter again.

`ProviderRegistry` supplies `register`, `registerMany`, `get`, `require`, `has`, `list` and `reset`.
Registering the same ID replaces the definition. Registries belong to a kernel scope.
The default scope also supplies `registerProvider`, `registerProviders`, `getProvider`,
`requireProvider`, `hasProvider`, `listProviders` and `resetProviders`.

`runTurn`, `runSession`, `runDecision` and `compactHistory` receive host options rather than
an executable provider argument. A called agent or compaction profile resolves its own binding.
An unknown provider fails before opening model transport.

## Model bindings

`modelBindingSchema` requires nonempty `provider` and `apiId` strings. Shared settings include
output tokens, temperature, effort aliases and selection, summaries, builtins and compaction.
`keySlot` and `fallbackKeySlot` optionally override the definition's credential defaults.
`providerOptions` defaults to an empty JSON object and is parsed using the selected adapter.

There is no provider or protocol enum in the binding. The old top-level model fields for cache,
storage, interaction persistence and local server settings are rejected. Those settings belong
inside the adapter's options. Profile-level credential defaults belong in provider definitions.
Decision bindings retain their timeout and use the same provider ID and option boundary.

## Adapter contract

`ProviderAdapter` declares `apiVersion: 1`, an implementation ID and three schemas:
connection, options and credentials. Connection and options must produce JSON-compatible data.
Schema objects and adapter methods are host code and are never reconstructed from profile JSON.

The adapter supplies `capabilities`, `validateRequest` and asynchronous `create`.
Capabilities declare profile types, input/output kinds, builtins and feature support.
Feature support is `supported`, `unsupported` or `unknown`.

The kernel derives required features from the profile and the actual request. A required feature
must have verified support. A compatible-looking URL is not evidence of support.
`validateRequest` checks restrictions beyond these shared checks, such as option combinations.

`ProviderContext` provides the resolved connection, options, model ID, abort signal,
`resolveCredential`, fetch, wait, an optional WebSocket opener and `tapUpstream`.
Credential access is limited to the selected primary and explicitly selected fallback slots.
Transport helpers are optional; an adapter can use an SDK internally.

`ProviderOperations` implements only the operations it supports:

| Operation | Input | Output |
| --- | --- | --- |
| `complete` | `ProviderTurnRequest` | Async stream of `ProviderModelEvent` |
| `openSession` | `ProviderSessionRequest` | `ProviderLiveConnection` |
| `decide` | `ProviderDecisionRequest` | Checked native decision result |

A missing operation fails before transport starts. Requests carry normalized history, content,
tools and generation settings. Vendor wire fields belong to the adapter's encoder.

## Event authority and termination

`ProviderModelEvent` permits normalized content, tool requests, cancellations, response identity
and a terminal `done`. `ProviderContentEvent` includes text, thoughts, structured output,
media, citations, grounding, evidence, usage, session notifications and errors.

Adapters cannot emit stage results, guardrail verdicts, approvals or completed client tools.
The kernel validates events at the boundary. Tool calls require JSON-object arguments and
nonempty call IDs and names. A repeated settled call cannot authorize another execution.

For a turn, client calls are held until a successful terminal event and stream exhaustion.
A missing terminal, malformed event, error, interruption or event after termination prevents
pending calls from executing. Reading EOF is not successful completion.
Cancellation does not silently replay a model request.

Live sessions use a successful model-step terminal to release calls. A generation notification
alone does not authorize them. `ProviderLiveConnection` exposes asynchronous text, audio,
video, context, approved tool-result and close operations. Optional `closeInfo` reports the
close code, diagnostic reason and any preceding close warning after the event stream ends.
The live kernel applies its lexicon and tracing policy to those facts.

## OpenRouter

```ts
const adapter = openRouterAdapter();
```

`openRouterAdapter` uses the pinned official `@openrouter/sdk` for chat. SDK retries are disabled;
Theorem controls transient retries and explicitly configured quota fallback. The SDK logger
is disabled. The raw response decoder preserves metadata that an SDK response projection can omit.

Requests require support for supplied routing parameters. The adapter handles text and reasoning,
fragmented tool arguments, structured output, citations and usage. Native reasoning associated
with tool calls is stored in the provider checkpoint and replayed with matching call IDs.
Image, speech and native decision operations retain their separate upstream endpoints.
OpenRouter cache settings use `providerOptions.cache`.

## Google Interactions

```ts
const binding = google.model("model-id", {
  providerOptions: { store: true, persistViaInteractionId: true },
});
```

`googleAdapter` owns Interactions request encoding and streaming decoding.
Storage, interaction persistence and optional Google Maps location live in provider options.
The adapter stores an interaction ID as native checkpoint data when persistence is enabled.
After validation, it encodes only the portable-history suffix not covered by that checkpoint.
When continuation is rebuilt, it encodes portable history instead of using the native ID.

## Google Live

| Session data | Boundary |
| --- | --- |
| Input and approved tool read-back | Normalized connection operations |
| Native resumption handle | Provider checkpoint data |

The Google adapter opens the native WebSocket codec through `openSession`.
The live kernel sends normalized input and approved tool read-back through the public connection.
The adapter encodes Google frames and reports normalized content and model-step termination.
Session resumption handles belong to checkpoint data. Portable history remains separate.
Provider close warnings and errors are preserved through the normalized live boundary.

## Local provider

```ts
const local = defineProvider({
  id: "local-chat",
  connection: { baseURL: "http://localhost:11434/v1" },
  adapter: openAIChat(),
});
```

`openAIChat` supplies the reusable compatible-chat adapter. Its connection requires the API base URL; the adapter appends `/chat/completions`.
Its default deployment declaration supports text; uncertain tools, structured output and reasoning
remain unknown until the builder explicitly declares the deployment's capabilities.
The kernel therefore refuses unverified requirements before opening transport.
The existing `createLocalProvider` codec is exported by the local subpath for codec consumers;
registered Theorem runners use `openAIChat`.

## Speech roles

| Adapter | Audio operation |
| --- | --- |
| OpenRouter | Native audio endpoint |
| Google | Interactions output audio |

Speech profiles resolve their voice, format and media settings before calling the adapter.
OpenRouter uses its audio endpoint; Google uses Interactions output audio.
Protocol codecs preserve native media details and convert supported raw PCM to WAV.
The kernel still validates the profile's speech role and allowed input kinds.

## Key vault (provider-neutral)

```ts
const hostOptions = { vault: {
  company: async () => ({ token: await refreshToken() }),
} };
```

`ProviderCredential` is a string or JSON object. `CredentialResolver` receives provider ID,
model ID, selected slot and abort signal, returning that value directly or asynchronously.
`ProviderVault` and `KeyVault` accept values, resolvers and unfilled slots.

Resolution occurs when needed, followed by the adapter's credential-schema validation.
The host resolver owns refresh and caching. A primary model override wins over a definition
slot; fallback follows the same precedence and occurs only when explicitly configured.
Resolver failures and invalid shapes produce authentication failures without embedding values.
Resolved credential strings are redacted from upstream rows and adapter error diagnostics.
Error wording parameters receive the same protection. Tool credentials retain their separate contract.

## Saved provider state

`providerCheckpointSchema` envelopes native JSON data with provider ID, adapter ID, version,
model ID, compatibility key, covered portable-history length and covered-history hash.
The kernel computes the envelope and hash. An adapter declares its continuation schema and
compatibility key; the key must exclude secrets.

`providerState` travels on turn/session requests and successful completion output.
Live checkpoints also arrive as `provider_checkpoint` events. Interface helpers store them
separately from displayed history. A branch drops native state.

Provider, model, deployment, version or covered-history mismatches rebuild from portable history
and emit `provider_warning` with `provider_state_rebuilt`. A profile can instead choose
`providerContinuation.onMismatch: 'error'`. Compatible but malformed data fails validation.
Failed or discarded output does not authorize pending tools or commit a usable history prefix.

## Exported API

The providers barrel exports all provider contracts and schemas, `KeyVault`, `googleAdapter`,
`openRouterAdapter`, `openAIChat`, `typesafeAdapter`, `parseSseStream`, `readSseChunks`,
`retryTransient`, `waitDefault`, `isTransientHttp`, `isTransientThrown`,
`parseToolArgumentsObject`, `historyToolArguments`, `tapFetch`, `tapeHeaders` and `networkFetch`.
The low-level live subpath exports `openGoogleLiveSession`, `GoogleLiveConnection`
and `OpenLiveWebSocket`.


| Group | Symbols |
| --- | --- |
| Provider definitions | `ProviderAdapter`, `ProviderDefinition`, `DefinedProvider`, `RegisteredProvider`, `ProviderRegistry`, `defineProvider`, `createProviderRegistry` |
| Provider data | `JsonValue`, `JsonObject`, `CapabilitySupport`, `ProviderCapabilities`, `ResolvedProviderModel`, `ProviderModelSettings` |
| Provider vault | `ProviderCredential`, `CredentialContext`, `CredentialResolver`, `ProviderVault`, `ProviderWait`, `OpenProviderWebSocket` |
| Provider operations | `ProviderHostOptions`, `ProviderContext`, `ProviderOperations`, `ProviderRequest`, `ProviderTurnRequest`, `ProviderSessionRequest`, `ProviderDecisionRequest`, `ProviderLiveConnection`, `ProviderToolResult` |
| Provider output | `ProviderContentEvent`, `ProviderModelEvent`, `ProviderCheckpoint`, `ProviderWarning`, `ProviderContinuationPolicy` |
| Provider schemas | `jsonValueSchema`, `jsonObjectSchema`, `keySlotSchema`, `commonModelSettingsSchema`, `modelBindingSchema`, `decisionModelBindingSchema`, `providerCheckpointSchema`, `providerWarningSchema`, `providerContinuationSchema`, `providerCapabilitiesSchema` |

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
