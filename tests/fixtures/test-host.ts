import { registerProfile } from '../../src/kernel/registry/profiles.ts';
import { registerStructured } from '../../src/kernel/registry/schemas.ts';
import { registerHarnessTools } from '../../src/kernel/tools/mod.ts';
import type { Profile } from '../../src/kernel/types.ts';
import type { GoogleImagePins } from '../../src/presets/google.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import {
  CHAT_MEDIA_LIMITS,
  geminiModel,
  HOST_MODELS,
  IMAGE_INPUT_MIMES,
  VOICE_INPUT_MIMES,
} from './models.ts';
import { registerTestTools } from './test-tools.ts';

registerGooglePreset();
registerHarnessTools();
registerTestTools();

const CHAT_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/csv', 'text/plain'];
const FORMATTER_ATTACH = [...IMAGE_INPUT_MIMES, 'application/pdf', 'text/plain'];
const LONG_FLASH = 40_000;
const PIN_QUOTA = 4;
const CHAT_QUOTA = 10;
const FORMATTER_QUOTA = 20;

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' }, body: { type: 'string' } },
  required: ['message'],
};

registerStructured('chatTurn', { enforced: 'responseFormat', jsonSchema: MESSAGE_SCHEMA });
registerStructured('htmlTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, html: { type: 'string' } },
    required: ['message'],
  },
});
registerStructured('tsxTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, tsx: { type: 'string' } },
    required: ['message'],
  },
});
registerStructured('promptTurn', { enforced: 'prompt' });
registerStructured('validTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['code'],
  },
});
registerStructured('optionalCodeTurn', {
  enforced: 'responseFormat',
  jsonSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      code: { type: 'string' },
      diagram: {
        type: 'object',
        properties: {
          mermaid: { type: 'string' },
        },
        required: ['mermaid'],
      },
    },
    required: ['message'],
  },
});

const chat: Profile = {
  type: 'text',
  id: 'chat',
  identity: { handle: 'chat', system: 'Reply in the structured turn schema.' },
  model: {
    ...geminiModel('gemini35FlashLite'),
    controls: ['thinking'],
    maxSteps: 1,
    key: 'freeA',
  },
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'chatTurn' },
  guardrails: {
    canary: true,
    quota: { perDay: CHAT_QUOTA },
  },
};

const pinned: Profile = {
  type: 'text',
  id: 'pinned',
  identity: { handle: 'pinned', system: 'Keep replies short.' },
  model: {
    ...geminiModel('gemini35FlashLite'),
    thinking: 'low',
    controls: [],
    maxSteps: 1,
    key: 'freeA',
  },
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: 'chatTurn' },
  guardrails: {
    canary: true,
    quota: { perDay: PIN_QUOTA },
  },
};

const selector: Profile = {
  type: 'text',
  id: 'selector',
  identity: {
    handle: 'primary',
    systemByRole: { primary: 'You are Primary.', reviewer: 'You are Reviewer.' },
  },
  model: {
    protocol: 'geminiInteractions',
    provider: 'google',
    allow: ['gemini35FlashLite', 'gemini31ProPreview'],
    config: {
      gemini35FlashLite: {
        ...HOST_MODELS.gemini35FlashLite,
        maxOutputTokens: LONG_FLASH,
      },
      gemini31ProPreview: HOST_MODELS.gemini31ProPreview,
    },
    select: { fast: 'gemini35FlashLite', smart: 'gemini31ProPreview' },
    thinking: { fast: 'low', smart: 'high' },
    controls: [],
    maxSteps: 1,
    key: 'freeB',
  },
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: 'promptTurn' },
  guardrails: {
    canary: true,
    quota: { perDay: CHAT_QUOTA },
  },
};

const formatter: Profile = {
  type: 'text',
  id: 'formatter',
  identity: { handle: 'formatter', system: 'Produce source text in the structured turn schema.' },
  model: {
    ...geminiModel('gemini35FlashLite'),
    config: {
      gemini35FlashLite: {
        ...HOST_MODELS.gemini35FlashLite,
        builtInTools: [],
      },
    },
    controls: ['thinking'],
    maxSteps: 1,
    key: 'freeC',
  },
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: FORMATTER_ATTACH },
    slots: { language: ['html', 'tsx'] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: {
    structured: { by: 'language', map: { html: 'htmlTurn', tsx: 'tsxTurn' }, fallback: 'htmlTurn' },
  },
  guardrails: {
    canary: true,
    quota: { perDay: FORMATTER_QUOTA },
  },
};

const image: Profile = {
  type: 'image',
  id: 'image',
  identity: { handle: 'image', system: 'Generate exactly one image.' },
  model: {
    ...geminiModel('gemini31FlashLiteImage'),
    thinking: 'minimal',
    controls: [],
    maxSteps: 1,
    key: 'freeA',
  },
  image: {
    aspectRatio: '1:1',
    size: '1K',
    mimeType: 'image/jpeg',
    maxInputImages: 14,
  } satisfies GoogleImagePins,
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: IMAGE_INPUT_MIMES },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: null },
  guardrails: {
    canary: true,
    quota: { perDay: PIN_QUOTA },
  },
};

const speech: Profile = {
  type: 'speech',
  id: 'speech',
  identity: { handle: 'speech', system: 'Speak the user text clearly.' },
  model: {
    ...geminiModel('gemini31FlashTts'),
    thinking: 'minimal',
    controls: [],
    maxSteps: 1,
    key: 'freeA',
  },
  speech: { voice: 'Kore', format: 'pcm' },
  guardrails: {
    canary: true,
    quota: { perDay: PIN_QUOTA },
  },
};

registerProfile(chat);
registerProfile(pinned);
registerProfile(selector);
registerProfile(formatter);
registerProfile(image);
registerProfile(speech);
