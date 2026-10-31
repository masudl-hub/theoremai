# Transcription Profiles

Transcription profiles (`type: 'transcription'`) turn one voice clip into text. They run through `runTurn`, so a turn gives back `text`, `tokens`, and `done` events, and a trace records the call.

---

## Transcription Profile Configuration

Base profile fields (`identity`, `models`, `guardrails`, `observability`, `labels`) apply as documented in [Profiles](2-1-profiles.md). `inputs` takes `voice` and the media limits. Everything else on `inputs` is refused.

```ts
import { defineProfile, openRouterProvider, registerProvider } from '@theoremjs/agents';

const openrouter = registerProvider(openRouterProvider, { keySlot: 'openrouter' });

export const harborScribe = defineProfile({
  type: 'transcription',
  id: 'harbor.scribe',
  identity: { handle: 'Radio scribe' },
  models: {
    scribe: openrouter.model('openRouterTranscriptions', 'mistralai/voxtral-mini-transcribe-3-0', {
      options: { provider: { zdr: true } },
    }),
  },
  inputs: {
    voice: { accept: ['audio/*'] },
    maxFiles: 1,
    maxBytes: 20 * 1024 * 1024,
    maxTurnBytes: 20 * 1024 * 1024,
  },
});
```

---

## Running a Transcription

Send the clip as `input.voice`. A turn takes exactly one clip and no text.

```ts
import { runTurn } from '@theoremjs/agents';

for await (const event of runTurn({
  profile: 'harbor.scribe',
  input: { voice: [{ mimeType: 'audio/mp4', data: clipBase64 }] },
})) {
  if (event.type === 'text') words += event.text;
}
```

A clip with no speech gives no `text` event, and the turn still ends with `done`.

---

## Architectural Invariants

* **No System Prompt**: The model follows no instruction, so a transcription profile has no `identity.system` and takes no `system` on the request. There is no canary to plant.
* **No Tools**: A transcription profile calls no tools and has no `outputs`.
* **One Clip, Stateless**: Each turn holds one clip. It keeps no history and no provider continuation.
* **Not an Agent Tool**: Agent tools take text, so another agent cannot call a transcription profile as a tool. Your host runs the turn.

---

## Supported Formats and Routing

`openRouterTranscriptions` reads WAV, MP3, M4A, AAC, OGG, Opus, FLAC, and WebM. It refuses any other MIME type with a `request` error, including raw PCM.

`options.provider` takes `zdr` and `data_collection`. OpenRouter's transcription endpoint ignores `only`, `order`, and `ignore`, so the binding refuses them.
