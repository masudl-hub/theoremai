# Google preset (`theorum/presets/google`)

Google / Gemini convenience pack: grounding builtins plus typed vocabularies
for image and speech-adjacent profile fields.

## Export

| Field | Value |
| --- | --- |
| Import | `theorum/presets/google` / `jsr:@theorum/core/presets/google` |
| Module | `src/presets/google.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/presets/google.ts` | Google builtins + vocabularies |
| `src/presets/google/speech-voices.ts` | `GOOGLE_SPEECH_VOICES` list and `GoogleSpeechVoice` type |

## Builtins

`registerGooglePreset()` registers:

| Id | Notes |
| --- | --- |
| `googleSearch` | Interactions `google_search`; OpenRouter plugin `web` |
| `googleMaps` | Interactions `google_maps` |
| `urlContext` | Interactions `url_context` |
| `codeExecution` | Interactions `code_execution` (server-side Python sandbox) |

All are `type: 'builtin'`. Declare ids on `ModelSpec.builtInTools` — they are on whenever that model is selected (visibility still respects `loadTier`).
`codeExecution` combines with `googleSearch` on Gemini 3+ and with registered function tools when the profile allows them on Interactions. THEORUM also sends structured `responseFormat` on the same request when both are configured; Google may still reject that pairing at the API. `googleSearch` sets `forcePaidKey: true`, so enabling it selects the paid vault slot unless the model pins `key`. Google's sandbox runtime (~30s) is not a THEORUM knob.
Hosts may declare optional `conflictsWith` on registered builtins; the preset does not.

## Vocabularies

Constants (and matching types) for host profile authoring:

| Constant | Purpose |
| --- | --- |
| `GOOGLE_IMAGE_INPUT_MIMES` | png / jpeg / webp / heic / heif |
| `GOOGLE_VOICE_INPUT_MIMES` | webm / wav / mpeg / mp4 |
| `GOOGLE_IMAGE_ASPECT_RATIOS` / `GOOGLE_IMAGE_SIZES` | Image output pins |
| `GOOGLE_SPEECH_VOICES` | TTS voice names for `outputs.speech.voice` |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImageSize`, `GoogleVoiceInputMime` | Typed vocabulary unions |
| `GoogleImagePins`, `GoogleSpeechPins`, `GoogleSpeechVoice` | Typed pins assignable to kernel specs |

Kernel types stay stringly; these packs make Google hosts typed when they opt in.

## Exported API

| Export | Role |
| --- | --- |
| `registerGooglePreset` | Register builtins into catalog |
| `GOOGLE_BUILTIN_TOOLS` | Static catalog entries |
| `GOOGLE_IMAGE_ASPECT_RATIOS`, `GOOGLE_IMAGE_INPUT_MIMES`, `GOOGLE_IMAGE_SIZES`, `GOOGLE_VOICE_INPUT_MIMES`, `GOOGLE_SPEECH_VOICES` | Typed profile authoring constants |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImageSize`, `GoogleVoiceInputMime`, `GoogleImagePins`, `GoogleLivePins`, `GoogleSpeechPins`, `GoogleSpeechVoice` | Typed pins and vocabularies |

```theorum-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Builtins": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Vocabularies": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "source", "path": "src/presets/google/speech-voices.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorum.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "source", "path": "src/presets/mod.ts" }
      ]
    }
  }
}
```
