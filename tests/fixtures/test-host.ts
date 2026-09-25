import { type ProfileDefinition, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { registerStructured } from '../../src/kernel/registry/schemas.ts';
import { registerHarnessTools } from '../../src/kernel/tools/mod.ts';
import type { GoogleImagePins } from '../../src/presets/google.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import {
  CHAT_MEDIA_LIMITS,
  geminiModels,
  HOST_BINDINGS,
  IMAGE_INPUT_MIMES,
  modelBindings,
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

registerStructured('chatTurn', { jsonSchema: MESSAGE_SCHEMA });
registerStructured('htmlTurn', {
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, html: { type: 'string' } },
    required: ['message'],
  },
});
registerStructured('tsxTurn', {
  jsonSchema: {
    type: 'object',
    properties: { message: { type: 'string' }, tsx: { type: 'string' } },
    required: ['message'],
  },
});
registerStructured('validTurn', {
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

const chat: ProfileDefinition = {
  type: 'text',
  id: 'chat',
  identity: { handle: 'chat', system: 'Reply in the structured turn schema.' },
  models: {
    gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite,
  },
  maxSteps: 1,
  key: 'slotA',
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

const pinned: ProfileDefinition = {
  type: 'text',
  id: 'pinned',
  identity: { handle: 'pinned', system: 'Keep replies short.' },
  models: {
    gemini35FlashLite: {
      ...HOST_BINDINGS.gemini35FlashLite,
      efforts: { normal: 'low' },
      allowEffortSelect: false,
    },
  },
  maxSteps: 1,
  key: 'slotA',
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: 'chatTurn' },
  guardrails: {
    canary: true,
    quota: { perDay: PIN_QUOTA },
  },
};

const selector: ProfileDefinition = {
  type: 'text',
  id: 'selector',
  identity: {
    handle: 'primary',
    systemByRole: { primary: 'You are Primary.', reviewer: 'You are Reviewer.' },
  },
  models: {
    gemini35FlashLite: {
      ...HOST_BINDINGS.gemini35FlashLite,
      efforts: { normal: 'low' },
      allowEffortSelect: false,
      maxOutputTokens: LONG_FLASH,
    },
    gemini31ProPreview: {
      ...HOST_BINDINGS.gemini31ProPreview,
      efforts: { normal: 'high' },
      allowEffortSelect: false,
    },
  },
  defaultModel: 'gemini35FlashLite',
  allowModelSelect: true,
  maxSteps: 1,
  key: 'slotB',
  tools: { allow: [] },
  inputs: {
    text: true,
    attachments: { accept: CHAT_ATTACH },
    voice: { accept: [...VOICE_INPUT_MIMES] },
    ...CHAT_MEDIA_LIMITS,
  },
  outputs: { structured: null },
  guardrails: {
    canary: true,
    quota: { perDay: CHAT_QUOTA },
  },
};

const formatter: ProfileDefinition = {
  type: 'text',
  id: 'formatter',
  identity: { handle: 'formatter', system: 'Produce source text in the structured turn schema.' },
  models: {
    gemini35FlashLite: {
      ...HOST_BINDINGS.gemini35FlashLite,
      builtInTools: [],
    },
  },
  maxSteps: 1,
  key: 'slotC',
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

const image: ProfileDefinition = {
  type: 'image',
  id: 'image',
  identity: { handle: 'image', system: 'Generate exactly one image.' },
  ...geminiModels('gemini31FlashLiteImage'),
  maxSteps: 1,
  image: {
    aspectRatio: '1:1',
    size: '1K',
    mimeType: 'image/jpeg',
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

const speech: ProfileDefinition = {
  type: 'speech',
  id: 'speech',
  identity: { handle: 'speech' },
  ...geminiModels('gemini31FlashTts'),
  maxSteps: 1,
  speech: { voice: 'Kore', format: 'pcm' },
  guardrails: {
    quota: { perDay: PIN_QUOTA },
  },
};

registerProfile(chat);
registerProfile(pinned);
registerProfile(selector);
registerProfile(formatter);
registerProfile(image);
registerProfile(speech);

export { modelBindings };
