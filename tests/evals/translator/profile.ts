/**
 * The translator profile the example suite evaluates: one text turn in, one
 * structured `{ lang, text }` out, no tools. Importing this module registers
 * it; the suite module imports it so `agents eval` finds the profile.
 */

import { registerProfile, registerStructured } from '../../../src/kernel/default-scope.ts';
import { geminiModels } from '../../fixtures/models.ts';

const TRANSLATOR = 'translator';

registerStructured('translation', {
  jsonSchema: {
    type: 'object',
    properties: {
      lang: { type: 'string', description: 'ISO 639-1 code of the target language' },
      text: { type: 'string', description: 'The translation' },
    },
    required: ['lang', 'text'],
  },
});

registerProfile({
  type: 'text',
  id: TRANSLATOR,
  identity: {
    handle: 'translator',
    system:
      'Translate the text the person gives you into the language they name. Reply with the target language code and the translation only.',
  },
  ...geminiModels('gemini35FlashLite'),
  maxSteps: 1,
  tools: { allow: [] },
  inputs: { text: true },
  outputs: { structured: 'translation' },
});

export { TRANSLATOR };
