# Presets (`@theoremjs/agents/presets`)

Use presets for hosted tool catalogs, typed media settings, and known-provider metadata.
Registered provider adapters declare capabilities and validate requests.
The token estimator uses preset media metadata when the binding names a known provider.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/presets` / `jsr:@theoremjs/agents/presets` |
| Module | `src/presets/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/presets/mod.ts` | Provider metadata, Google and OpenRouter catalogs, local checks, and TypeSafe price |
| `src/presets/facts.ts` | Metadata for the shipped provider names, including media token families |
| `src/presets/google.ts` | Documented in [`presets-google.md`](./presets-google.md) |
| `src/presets/local.ts` | What a local server would refuse on a binding |
| `src/presets/openrouter.ts` | OpenRouter hosted tool catalog and image attachment types |
| `src/presets/openrouter-facts.ts` | OpenRouter metadata without a default-scope registration import |
| `src/presets/typesafe.ts` | TypeSafe Jev's input price, which decision usage costs from |

## Role in the package

| Concern | Kernel | Preset |
| --- | --- | --- |
| Provider rules | Registered adapter capabilities and request validation | Known-provider metadata in `PROVIDER_FACTS`; media families inform token estimation |
| Tool ids | `string` allowlist | Registers hosted tool definitions. The selected provider adapter owns their wire encoding. |
| Image/speech pins | Open `string` fields | Typed constants (`GOOGLE_IMAGE_RESOLUTIONS`, `GOOGLE_IMAGE_OUTPUT_MIMES`, voices, …) |
| Registration | `registerTools` API (default scope) or `scope.tools.registerMany` | Google and OpenRouter registration functions fill the default scope. Their catalogs also register into an isolated scope. |

Call preset registration **before** registering profiles that allowlist preset
builtins. Import `@theoremjs/agents/presets/google` when you only need the Google pack.

The catalogs are optional. Hosts can register their own tools and vocabularies through `registerTools`.
External provider IDs need no entry in the preset metadata table.
The token estimator reads a known media family when one exists; hosts do not register that table.
Metadata modules do not import preset registration functions. This prevents an import cycle through the default kernel scope.

## When to use

| Use preset | Skip preset |
| --- | --- |
| Google Gemini hosts wanting typed pins + search/maps/url/code-execution builtins | Custom tool catalog entirely host-owned |
| OpenRouter hosts that need the hosted `webSearch` tool | Hosts that register their own hosted tool definitions |
| A local host that wants `efforts` on a model that does not think refused before the first call | A local server that reports nothing about its models |

## Exported API

This barrel exports provider metadata, catalogs, local checks, media settings, and TypeSafe's price:

| Export | Role |
| --- | --- |
| `PROVIDER_FACTS`, `ProviderFacts` | Each provider's answers to what the kernel's rules ask: `needsKey`, `takesServer`, and where it has them `cacheOn`, `storesOn`, `traceName` and `decisionsUrl` |
| `registerGooglePreset` | Register Google builtins into the default scope's tool registry |
| `GOOGLE_BUILTIN_TOOLS` | Catalog entries; register them into any scope's `tools` |
| `registerOpenRouterPreset` | Register OpenRouter hosted tools into the default scope's tool registry before registering profiles |
| `OPENROUTER_BUILTIN_TOOLS` | Hosted `webSearch` definition; pass the catalog to an isolated scope's `tools.registerMany` |
| `GOOGLE_SINGLE_TURN_API_IDS` | TTS models that reject history with a model turn, so they can't take compaction |
| `GOOGLE_SPEECH_FORMATS` | The audio format Gemini speech returns (`pcm`, wrapped as WAV); OpenRouter speech also takes `mp3`; the Google provider refuses any other |
| `GOOGLE_THINKING_LEVELS` | The thinking levels Gemini takes (`minimal`, `low`, `medium`, `high`); the Google providers refuse any other |
| `GOOGLE_NO_THINKING_API_IDS` | Models that reject any thinking setting, `summaries: false` included |
| `GOOGLE_NO_EFFORT_API_IDS` | Models that refuse a thinking level and take `summaries` |
| `GOOGLE_THINKING_REQUIRED_API_IDS` | Models that refuse a session without a thinking level |
| `GOOGLE_FREE_TIER_GROUNDING`, `GoogleFreeTierGrounding`, `googleFreeTierBuiltins` | Free-tier models and the grounding each one's quota allows |
| `googleBindingViolation`, `GoogleBindingViolation` | The first setting Google would refuse on a binding, optionally held to the free tier |
| `GOOGLE_IMAGE_ASPECT_RATIOS`, `GOOGLE_IMAGE_INPUT_MIMES`, `GOOGLE_IMAGE_RESOLUTIONS`, `GOOGLE_IMAGE_OUTPUT_MIMES`, `GOOGLE_VOICE_INPUT_MIMES`, `GOOGLE_SPEECH_VOICES` | Profile authoring constants |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImagePins`, `GoogleImageResolution`, `GoogleImageOutputMime`, `GoogleVoiceInputMime`, `GoogleSpeechVoice` | Typed pins and vocabularies |
| `googleEfforts`, `GoogleThinkingLevel` | A Gemini binding's `efforts`, typed to `GOOGLE_THINKING_LEVELS`; throws `config` on any other level when the binding is built |
| `localBindingViolation`, `LocalBindingViolation` | The first setting a local server would refuse on a binding: `efforts` on a model that does not think. The host says whether the model thinks. Ollama answers HTTP 400 "does not support thinking" for such a call (04/10/2026) |
| `ollamaModelThinks` | Whether an Ollama model thinks, read from the server's `/api/show` reply for it (`capabilities` lists `thinking`). The host fetches the reply; the preset makes no network call |
| `OPENROUTER_IMAGES_IGNORED_INPUTS` | `system` and `history`: `/images` sends the model the prompt text and the references only, so a profile's system prompt (the canary and `user_data` notes with it) never reaches it; `image.includeText` moves the turn to the chat path, which sends both |
| `OPENROUTER_IMAGES_INPUT_MIMES` | `/images` takes image references only (https URLs or bytes), so a profile on it accepts `image/*` and nothing wider; the send refuses video and PDF |
| `JEV_USD_PER_MILLION_INPUT_TOKENS` | TypeSafe Jev's input price per million tokens; output tokens are free |

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/presets/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/presets/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Role in the package": {
      "supports": [
        { "kind": "source", "path": "src/presets/mod.ts" },
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "When to use": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/presets/mod.ts" },
        { "kind": "doc", "path": "docs/contracts/presets-google.md" }
      ]
    }
  }
}
```
