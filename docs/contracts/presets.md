# Presets (`@theoremjs/agents/presets`)

Optional convenience packs. Presets register host-convenience catalogs
(provider builtins, media vocabularies) without baking product opinions into the
kernel.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/presets` / `jsr:@theoremjs/agents/presets` |
| Module | `src/presets/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/presets/mod.ts` | Barrel re-exporting the Google pack, the local checks, OpenRouter's image inputs and TypeSafe's price |
| `src/presets/google.ts` | Documented in [`presets-google.md`](./presets-google.md) |
| `src/presets/local.ts` | What a local server would refuse on a binding |
| `src/presets/openrouter.ts` | The attachment types an OpenRouter `/images` profile may accept |
| `src/presets/typesafe.ts` | TypeSafe Jev's input price, which decision usage costs from |

## Role in the package

| Concern | Kernel | Preset |
| --- | --- | --- |
| Tool ids | `string` allowlist | Registers `googleSearch`, `googleMaps`, `urlContext`, `codeExecution`, each with its Interactions and Live wire name |
| Image/speech pins | Open `string` fields | Typed constants (`GOOGLE_IMAGE_RESOLUTIONS`, `GOOGLE_IMAGE_OUTPUT_MIMES`, voices, …) |
| Registration | `registerTools` API (default scope) or `scope.tools.registerMany` | `registerGooglePreset()` at host startup fills the default scope; `GOOGLE_BUILTIN_TOOLS` fills any other |

Call preset registration **before** registering profiles that allowlist preset
builtins. Import `@theoremjs/agents/presets/google` when you only need the Google pack.

Presets are optional — the kernel runs without them when hosts register their
own tools and vocabularies directly via `registerTools`.

## When to use

| Use preset | Skip preset |
| --- | --- |
| Google Gemini hosts wanting typed pins + search/maps/url/code-execution builtins | Custom tool catalog entirely host-owned |
| Quick start matching Google Interactions and Live wire types | Non-Google providers only |
| A local host that wants `efforts` on a model that does not think refused before the first call | A local server that reports nothing about its models |

## Exported API

This barrel re-exports the Google pack, the local checks, OpenRouter's image inputs and TypeSafe's price:

| Export | Role |
| --- | --- |
| `registerGooglePreset` | Register Google builtins into the default scope's tool registry |
| `GOOGLE_BUILTIN_TOOLS` | Catalog entries; register them into any scope's `tools` |
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
