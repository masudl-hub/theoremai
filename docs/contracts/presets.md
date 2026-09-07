# Presets (`theorum/presets`)

Optional convenience packs. Presets register host-convenience catalogs
(provider builtins, media vocabularies) without baking product opinions into the
kernel.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/presets` / `jsr:@theorum/core/presets` |
| Module | `src/presets/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/presets/mod.ts` | Barrel re-exporting the Google pack |
| `src/presets/google.ts` | Documented in [`presets-google.md`](./presets-google.md) |

## Role in the package

| Concern | Kernel | Preset |
| --- | --- | --- |
| Tool ids | `string` allowlist | Registers `googleSearch`, `googleMaps`, `urlContext`, `codeExecution` |
| Image/speech pins | Open `string` fields | Typed constants (`GOOGLE_IMAGE_SIZES`, voices, …) |
| Registration | `registerTools` API | `registerGooglePreset()` at host startup |

Call preset registration **before** registering profiles that allowlist preset
builtins. Import `theorum/presets/google` when you only need the Google pack.

Presets are optional — the kernel runs without them when hosts register their
own tools and vocabularies directly via `registerTools`.

## When to use

| Use preset | Skip preset |
| --- | --- |
| Google Gemini hosts wanting typed pins + search/maps/url/code-execution builtins | Custom tool catalog entirely host-owned |
| Quick start matching Google Interactions wire types | Non-Google providers only |

## Exported API

This barrel re-exports the Google pack:

| Export | Role |
| --- | --- |
| `registerGooglePreset` | Register Google builtins into the tool registry |
| `GOOGLE_BUILTIN_TOOLS` | Catalog entries |
| `GOOGLE_IMAGE_ASPECT_RATIOS`, `GOOGLE_IMAGE_INPUT_MIMES`, `GOOGLE_IMAGE_SIZES`, `GOOGLE_VOICE_INPUT_MIMES`, `GOOGLE_SPEECH_VOICES` | Profile authoring constants |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImagePins`, `GoogleImageSize`, `GoogleVoiceInputMime`, `GoogleSpeechVoice` | Typed pins and vocabularies |

```theorum-evidence
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
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "When to use": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
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
