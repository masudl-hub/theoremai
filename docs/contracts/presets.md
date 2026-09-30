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
| `src/presets/mod.ts` | Barrel re-exporting the Google pack |
| `src/presets/google.ts` | Documented in [`presets-google.md`](./presets-google.md) |

## Role in the package

| Concern | Kernel | Preset |
| --- | --- | --- |
| Tool ids | `string` allowlist | Registers `googleSearch`, `googleMaps`, `urlContext`, `codeExecution`, each with its Interactions and Live wire name |
| Image/speech pins | Open `string` fields | Typed constants (`GOOGLE_IMAGE_SIZES`, voices, …) |
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

## Exported API

This barrel re-exports the Google pack:

| Export | Role |
| --- | --- |
| `registerGooglePreset` | Register Google builtins into the default scope's tool registry |
| `GOOGLE_BUILTIN_TOOLS` | Catalog entries; register them into any scope's `tools` |
| `GOOGLE_SINGLE_TURN_API_IDS` | TTS models that reject history with a model turn, so they can't take compaction |
| `GOOGLE_NO_THINKING_API_IDS` | Models that reject any thinking setting, `summaries: false` included |
| `GOOGLE_IMAGE_ASPECT_RATIOS`, `GOOGLE_IMAGE_INPUT_MIMES`, `GOOGLE_IMAGE_SIZES`, `GOOGLE_VOICE_INPUT_MIMES`, `GOOGLE_SPEECH_VOICES` | Profile authoring constants |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImagePins`, `GoogleImageSize`, `GoogleVoiceInputMime`, `GoogleSpeechVoice` | Typed pins and vocabularies |
| `googleInteractionsPersistence`, `GoogleInteractionsPersistence` | A model binding's `store` and `persistViaInteractionId`, set together |

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
