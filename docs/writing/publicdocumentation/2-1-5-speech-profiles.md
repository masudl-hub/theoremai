# Speech Profiles & Audio Synthesis

Speech profiles (`type: 'speech'`) configure text-to-speech (TTS) agents that synthesize spoken audio files from written transcripts. They execute through `runTurn()`, transforming input text into binary audio streams.

---

## Speech Profile Configuration

Base profile fields (`identity`, `models`, `guardrails`, `observability`, `labels`) apply across all modalities as documented in [Profiles](2-1-profiles.md). Speech profiles declare a `speech` block configuring voice identification, speaking rate, delivery style, and audio format:

```ts
import { defineProfile } from '@theoremjs/agents';

export const harborAnnouncer = defineProfile({
  type: 'speech',
  id: 'harbor.radio_announcer',
  // ... identity, models

  speech: {
    voice: 'en-US-Standard-C',
    style: 'authoritative maritime dispatch; clear enunciation and measured pacing',
    speed: 1.0,   // Speaking rate multiplier (1.0 is the voice's default pace)
    format: 'mp3', // Audio container: 'mp3' | 'wav' | 'pcm' | 'opus'
  },

  // ... guardrails, observability, labels
});
```

---

## Audio Synthesis Settings & Overrides

The `speech` block specifies default audio synthesis properties:

```mermaid
sequenceDiagram
    autonumber
    participant App as Calling Application
    participant Kernel as runTurn()
    participant TTS as Speech Provider (TTS)

    App->>Kernel: runTurn({ profile, input: { text }, speech?: { voice, style, speed } })
    Note over Kernel: Merge profile defaults with per-turn speech overrides
    Kernel->>TTS: Synthesize audio for input text
    TTS-->>Kernel: Encoded audio stream
    Kernel-->>App: yield { type: 'media', media: { mimeType, data } }
    Kernel-->>App: yield { type: 'done', stop, tokens }
```

| Property | Type | Description |
| :--- | :--- | :--- |
| **`voice`** | `string` | The upstream TTS voice ID or voice alias recognized by the bound provider. |
| **`style`** | `string` | Plain-text guidance describing pace, accent, or delivery emotion (e.g. `'calm emergency broadcast'`). This instruction is interpreted by the provider and never spoken aloud. |
| **`speed`** | `number` | Rate multiplier relative to the voice's natural cadence (`1.0` is default; `1.2` is 20% faster). |
| **`format`** | `string` | Audio encoding container: `'mp3'`, `'wav'`, `'pcm'`, or `'opus'`. Providers unable to produce the declared format reject the turn at startup. |

### Per-Turn Overrides

Callers can override `voice`, `style`, and `speed` dynamically for an individual turn without changing the profile definition:

```ts
const events = runTurn({
  profile: 'harbor.radio_announcer',
  input: {
    text: 'Gale warning in effect for harbor approaches until 0400 hours.',
  },
  speech: {
    speed: 1.15,
    style: 'urgent dispatch',
  },
});
```

Any field declared in `TurnRequest.speech` supersedes the corresponding profile default for that turn alone.

---

## Invoking Speech Profiles: `runTurn()`

Speech profiles are invoked through `runTurn()`, following the request dispatch flow documented in [Text Profiles](2-1-1-text-profiles.md). Instead of streaming text tokens, speech turns yield binary audio payloads.

### Basic Invocation

```ts
import { runTurn } from '@theoremjs/agents';

const events = runTurn({
  profile: 'harbor.radio_announcer',
  input: {
    text: 'Vessel Northern Star, proceed to anchorage bravo.',
  },
});

for await (const event of events) {
  if (event.type === 'media') {
    // event.media contains { mimeType: 'audio/mp3', data: string } (base64-encoded)
    playAudio(event.media.mimeType, event.media.data);
  }
}
```

---

### Key Speech Events

| Event Type | Payload | Description |
| :--- | :--- | :--- |
| **`media`** | `event.media: { mimeType: string, data: string }` | Emitted when audio synthesis completes, containing the base64-encoded audio bytes and MIME type. |
| **`done`** | `event.stop: TurnStop`, `event.tokens?: TurnTokens` | Terminal event reporting completion status and character or token usage. |
| **`error`** | `event.errorKind: ErrorKind`, `event.error?: string` | Emitted if synthesis fails, the voice is unavailable, or the audio format is unsupported. |

---

## Related Guides

* **[Profiles](2-1-profiles.md)**: Universal profile identity, model bindings, inputs, and registry lifecycle.
* **[Text Profiles](2-1-1-text-profiles.md)**: Conversational agents and complete `runTurn()` mechanics.
* **[Live Profiles](2-1-2-live-profiles.md)**: Realtime bidirectional audio and voice activity detection over WebSockets.
