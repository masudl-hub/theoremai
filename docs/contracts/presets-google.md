# Google preset (`@theoremjs/agents/presets/google`)

Google / Gemini convenience pack: grounding builtins plus typed vocabularies
for image and speech-adjacent profile fields.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/presets/google` / `jsr:@theoremjs/agents/presets/google` |
| Module | `src/presets/google.ts` |
| Voices subpath | `@theoremjs/agents/presets/google/speech-voices` → `src/presets/google/speech-voices.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/presets/google.ts` | Google builtins + vocabularies |
| `src/presets/google/speech-voices.ts` | `GOOGLE_SPEECH_VOICES` list and `GoogleSpeechVoice` type |

## Builtins

`registerGooglePreset()` registers these into the default kernel scope; another scope registers `GOOGLE_BUILTIN_TOOLS` with `scope.tools.registerMany`:

| Id | Notes |
| --- | --- |
| `googleSearch` | Interactions `google_search`; Live `googleSearch`; OpenRouter plugin `web` |
| `googleMaps` | Interactions `google_maps`; Live `googleMaps` |
| `urlContext` | Interactions `url_context`; Live `urlContext` |
| `codeExecution` | Interactions `code_execution` (server-side Python sandbox); Live `codeExecution` |

All are `type: 'builtin'`. Declare ids on `ModelBinding.builtInTools` — they are on whenever that model is selected (visibility still respects `loadTier`).
`codeExecution` combines with `googleSearch` on Gemini 3+ and with registered function tools when the profile allows them on Interactions. THEOREM also sends structured `responseFormat` on the same request when both are configured; Google may still reject that pairing at the API. `googleSearch` uses the model's key slot like any call; a model that needs a billed key for it pins that slot with `key`. Google's sandbox runtime (~30s) is not a THEOREM knob.
Hosts may declare optional `conflictsWith` on registered builtins; the preset does not.

## Interaction persistence

`googleInteractionsPersistence(chained)` returns `{ store, persistViaInteractionId }`
set to the same value, to spread into a `geminiInteractions` binding. Google
chains a turn with `previous_interaction_id` only from a stored interaction, so
the two move together: `true` keeps turns on Google and chains them (free tier
keeps them 1 day, paid 55); `false` stores nothing and the host sends the history
every turn. With `persistViaInteractionId: false` the kernel never chains inside a
turn either: a step's calls go into the turn's history as one assistant message
(the first carrying the step's `thoughtSignature`), then each result and any
stage inject, and every step sends that history (`ResolvedGeneration.chains` is
`false`). The kernel does not pair them itself; a binding that sets them apart
reaches Google as written.

## Model rules

`googleBindingViolation(binding, { freeTier? })` returns the first setting Google would refuse on a binding as `{ field, message }`, or `undefined`:

| Rule | Field | Google's refusal (Live, 01/10/2026) |
| --- | --- | --- |
| A `GOOGLE_NO_THINKING_API_IDS` model pins `efforts` or sets `summaries` | `efforts` / `summaries` | `gemini-3.8-live` closes 1007 "Thinking level is not supported for this model" |
| A `GOOGLE_THINKING_REQUIRED_API_IDS` model has no `efforts` | `efforts` | `gemini-3.8-live-extended-thinking` closes 1007 "Thinking level must be specified for this model" |
| With `freeTier`, a model missing from `GOOGLE_FREE_TIER_GROUNDING` | `apiId` | The model has no free-tier quota |
| With `freeTier`, `googleSearch` or `googleMaps` the model's free quota doesn't allow | `builtInTools` | Live closes 1011 "You exceeded your current quota" at setup, whatever the key's usage, so it reads as a quota failure |

`GOOGLE_FREE_TIER_GROUNDING` maps each free-tier model to `{ googleSearch, googleMaps }` (AI Studio, Sep 2026); `googleFreeTierBuiltins(apiId)` lists the grounding builtins it allows. The playground's model policy reads this table. The kernel does not run the check; a host calls it on the profiles it registers.

## Vocabularies

Constants (and matching types) for host profile authoring:

| Constant | Purpose |
| --- | --- |
| `GOOGLE_IMAGE_INPUT_MIMES` | png / jpeg / webp / heic / heif |
| `GOOGLE_VOICE_INPUT_MIMES` | webm / wav / mpeg / mp4 |
| `GOOGLE_IMAGE_ASPECT_RATIOS` / `GOOGLE_IMAGE_RESOLUTIONS` / `GOOGLE_IMAGE_OUTPUT_MIMES` | Image output pins (png / jpeg out) |
| `GOOGLE_SPEECH_VOICES` | TTS voice names for `outputs.speech.voice` |
| `GOOGLE_SINGLE_TURN_API_IDS` | TTS models that reject history with a model turn, so they can't take compaction |
| `GOOGLE_NO_THINKING_API_IDS` | Models that reject any thinking setting, `summaries: false` included; leave `efforts` and `summaries` unset |
| `GOOGLE_THINKING_REQUIRED_API_IDS` | Models that refuse a session without a thinking level; pin `efforts` |
| `GOOGLE_FREE_TIER_GROUNDING` / `GoogleFreeTierGrounding` | Free-tier models and the grounding each one's quota allows |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImageResolution`, `GoogleImageOutputMime`, `GoogleVoiceInputMime` | Typed vocabulary unions |
| `GoogleImagePins`, `GoogleSpeechPins`, `GoogleSpeechVoice` | Typed pins assignable to kernel specs |

Kernel types stay stringly; these packs make Google hosts typed when they opt in.

## Exported API

| Export | Role |
| --- | --- |
| `registerGooglePreset` | Register builtins into catalog |
| `googleInteractionsPersistence` / `GoogleInteractionsPersistence` | `store` and `persistViaInteractionId` set together for a `geminiInteractions` binding |
| `GOOGLE_BUILTIN_TOOLS` | Static catalog entries |
| `GOOGLE_SINGLE_TURN_API_IDS` | TTS models that can't take compaction |
| `GOOGLE_NO_THINKING_API_IDS` | Models that take no `efforts` or `summaries` |
| `GOOGLE_THINKING_REQUIRED_API_IDS` | Models that need `efforts` |
| `GOOGLE_FREE_TIER_GROUNDING`, `GoogleFreeTierGrounding`, `googleFreeTierBuiltins` | Free-tier models and the grounding each allows |
| `googleBindingViolation`, `GoogleBindingViolation` | The first setting Google would refuse on a binding |
| `GOOGLE_IMAGE_ASPECT_RATIOS`, `GOOGLE_IMAGE_INPUT_MIMES`, `GOOGLE_IMAGE_RESOLUTIONS`, `GOOGLE_IMAGE_OUTPUT_MIMES`, `GOOGLE_VOICE_INPUT_MIMES`, `GOOGLE_SPEECH_VOICES` | Typed profile authoring constants |
| `GoogleImageAspectRatio`, `GoogleImageInputMime`, `GoogleImageResolution`, `GoogleImageOutputMime`, `GoogleVoiceInputMime`, `GoogleImagePins`, `GoogleLivePins`, `GoogleSpeechPins`, `GoogleSpeechVoice` | Typed pins and vocabularies |
| `GOOGLE_SPEECH_VOICES` / `GoogleSpeechVoice` | Published speech-voice vocabulary provided by `src/presets/google/speech-voices.ts` and consumed by profile authoring |

```theorem-evidence
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
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
      ]
    },
    "Model rules": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "contract_test", "path": "tests/presets/google.test.ts" }
      ]
    },
    "Vocabularies": {
      "supports": [
        { "kind": "source", "path": "src/presets/google.ts" },
        { "kind": "source", "path": "src/presets/google/speech-voices.ts" },
        { "kind": "contract_test", "path": "tests/kernel/theorem.test.ts" }
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
