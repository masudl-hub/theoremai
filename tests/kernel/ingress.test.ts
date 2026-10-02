import { wrapUserData } from '../../src/guardrails/canary.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { clearProfiles, registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { assertOutputMode } from '../../src/kernel/registry/ingress.ts';
import type { Profile, TurnRequest } from '../../src/kernel/types.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';

registerGooglePreset();

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

type Loose = Record<string, unknown>;

const GEMINI = {
  protocol: 'geminiInteractions',
  provider: 'google',
  apiId: 'g',
  persistViaInteractionId: false,
} as const;
const LIMITS = { maxFiles: 5, maxBytes: 1000, maxTurnBytes: 2000 };

function define(id: string, over: Loose = {}): void {
  registerProfile({
    id,
    type: 'text',
    identity: { handle: id },
    key: 'main',
    models: { m: { ...GEMINI } },
    tools: { allow: [] },
    inputs: {
      text: true,
      attachments: { accept: ['image/png', 'image/jpg', 'application/x-foo'] },
      voice: { accept: ['audio/wav'] },
      ...LIMITS,
    },
    // the profile's own guardrails would redact the probes below
    guardrails: { sanitizeInput: false, redactSensitive: false },
    ...over,
  } as never);
}

function parts(request: TurnRequest) {
  try {
    return resolveTurn(request).generation.input as unknown as Loose[];
  } catch (err) {
    if (!(err instanceof TheoremError)) throw err;
    return err.message;
  }
}

const png = (name = 'a') => ({ mimeType: 'image/png', data: btoa(name) });

Deno.test('text, attachments and voice become typed parts in that order, text wrapped as user data', () => {
  clearProfiles();
  define('chat');
  check(
    parts({
      profile: 'chat',
      input: {
        text: 'hello',
        attachments: [png('i')],
        voice: [{ mimeType: 'audio/wav', data: btoa('v') }],
      },
    }),
    [
      { type: 'text', text: wrapUserData('hello') },
      { type: 'image', mimeType: 'image/png', data: btoa('i') },
      { type: 'audio', mimeType: 'audio/wav', data: btoa('v') },
    ],
    'all three',
  );
  check(
    parts({ profile: 'chat', input: { attachments: [png()] } }),
    [{ type: 'image', mimeType: 'image/png', data: btoa('a') }],
    'no text, no text part',
  );
  check(parts({ profile: 'chat', input: {} }), [], 'nothing');
});

Deno.test('image/jpg is sent as image/jpeg, a reference keeps its uri, and the MIME is reduced to its essence', () => {
  clearProfiles();
  define('chat');
  check(
    parts({
      profile: 'chat',
      input: { attachments: [{ mimeType: 'image/jpg', data: btoa('j') }] },
    }),
    [{ type: 'image', mimeType: 'image/jpeg', data: btoa('j') }],
    'jpg',
  );
  check(
    parts({
      profile: 'chat',
      input: { attachments: [{ mimeType: 'IMAGE/PNG; q=1', data: btoa('p') }] },
    }),
    [{ type: 'image', mimeType: 'image/png', data: btoa('p') }],
    'essence',
  );
  check(
    parts({ profile: 'chat', input: { attachments: [{ mimeType: 'image/png', uri: 'files/1' }] } }),
    [{ type: 'image', mimeType: 'image/png', uri: 'files/1' }],
    'reference',
  );
  check(
    parts({
      profile: 'chat',
      input: { attachments: [{ mimeType: 'application/x-foo', data: btoa('f') }] },
    }),
    "MIME 'application/x-foo' is not a supported media input type",
    'a type the profile accepts but the kernel cannot classify',
  );
});

Deno.test('a profile that takes no text refuses it, and speech needs text and takes neither system nor media', () => {
  clearProfiles();
  define('mute', { inputs: { text: false, attachments: { accept: ['image/png'] }, ...LIMITS } });
  check(
    parts({ profile: 'mute', input: { text: 'x' } }),
    'Profile mute does not accept text input',
    'text refused',
  );
  check(
    typeof parts({ profile: 'mute', input: { attachments: [png()] } }),
    'object',
    'media still fine',
  );

  define('voice', {
    type: 'speech',
    speech: { voice: 'Kore' },
    models: { m: { ...GEMINI, apiId: 'tts' } },
    inputs: undefined,
    tools: undefined,
    outputs: undefined,
    guardrails: undefined,
  });
  check(
    parts({ profile: 'voice', input: { text: '  ' } }),
    'Profile voice (speech) requires text input',
    'blank text',
  );
  check(
    parts({ profile: 'voice', input: {} }),
    'Profile voice (speech) requires text input',
    'no text',
  );
  check(
    parts({ profile: 'voice', input: { text: 'say' }, system: 'be kind' }),
    'Profile voice (speech) takes no system prompt — the input text is the transcript',
    'system prompt',
  );
  check(
    parts({ profile: 'voice', input: { text: 'say', attachments: [png()] } }),
    'Profile voice (speech) does not accept media input',
    'attachments',
  );
  check(
    parts({
      profile: 'voice',
      input: { text: 'say', voice: [{ mimeType: 'audio/wav', data: 'YQ==' }] },
    }),
    'Profile voice (speech) does not accept media input',
    'voice',
  );
  check(
    typeof parts({ profile: 'voice', input: { text: 'say', attachments: [] } }),
    'object',
    'an empty list is no media',
  );
});

Deno.test('an image profile sends its pinned references first, and a continue sends no instruction', () => {
  clearProfiles();
  define('img', {
    type: 'image',
    inputs: { text: true, attachments: { accept: ['image/png'] }, ...LIMITS },
    image: { aspectRatio: '1:1', references: [{ mimeType: 'image/png', data: btoa('ref') }] },
    models: { m: { ...GEMINI, apiId: 'gi' } },
    outputs: { structured: null },
  });
  check(
    parts({ profile: 'img', input: { text: 'fox', attachments: [png('own')] } }),
    [
      { type: 'text', text: wrapUserData('fox') },
      { type: 'image', mimeType: 'image/png', data: btoa('ref') },
      { type: 'image', mimeType: 'image/png', data: btoa('own') },
    ],
    'references before attachments',
  );
  check(
    parts({ profile: 'img', input: {}, continueFrom: { stop: { kind: 'length' } as never } }),
    [{ type: 'image', mimeType: 'image/png', data: btoa('ref') }],
    'an image continue has no instruction',
  );
  define('chat');
  const continued = parts({
    profile: 'chat',
    input: {},
    continueFrom: { stop: { kind: 'length' } as never },
  });
  check(
    Array.isArray(continued) && continued.length === 1 && continued[0]?.type === 'text',
    true,
    'a text continue sends the instruction',
  );
});

Deno.test('a repair becomes the prompt, even where the profile takes no user text', () => {
  clearProfiles();
  define('mute', { inputs: { text: false, ...LIMITS } });
  const result = parts({
    profile: 'mute',
    input: { repair: { previousOutput: 'draft', rejection: 'too long' } },
  });
  check(
    Array.isArray(result) && result.length === 1 && result[0]?.type === 'text',
    true,
    'one text part',
  );
  const text = String((result as Loose[])[0]?.text);
  check(
    text.includes('draft') && text.includes('too long'),
    true,
    'it carries the output and the rejection',
  );
});

Deno.test('a slot value must be one of its declared choices, and only declared slots may be set', () => {
  clearProfiles();
  define('slotted', { inputs: { text: true, slots: { mood: ['happy', 'sad'] } } });
  const slots = (value: Record<string, string>) =>
    parts({ profile: 'slotted', input: { text: 'x', slots: value } });
  check(typeof slots({ mood: 'happy' }), 'object', 'a choice');
  check(slots({ tone: 'happy' }), "Profile slotted has no slot 'tone'", 'undeclared');
  check(
    slots({ mood: 'angry' }),
    "Profile slotted: slot 'mood' takes happy, sad, not 'angry'",
    'not a choice',
  );
  check(
    slots({ toString: 'x' }),
    "Profile slotted has no slot 'toString'",
    'an inherited property is no slot',
  );
  check(typeof parts({ profile: 'slotted', input: { text: 'x' } }), 'object', 'no slots');
  define('slotless');
  check(
    parts({ profile: 'slotless', input: { text: 'x', slots: { a: 'b' } } }),
    "Profile slotless has no slot 'a'",
    'a profile with no slots',
  );
});

Deno.test('image generation carries its pins and refuses a profile that declares two output formats', () => {
  clearProfiles();
  define('img', {
    type: 'image',
    inputs: { text: true, attachments: { accept: ['image/png'] }, ...LIMITS },
    image: {
      aspectRatio: '1:1',
      resolution: '1K',
      mimeType: 'image/jpeg',
      n: 2,
      seed: 7,
      includeText: true,
    },
    models: { m: { ...GEMINI, apiId: 'gi' } },
    outputs: { structured: null },
  });
  const image = resolveTurn({ profile: 'img', input: { text: 'x' } }).generation.image;
  check(
    image,
    {
      type: 'image',
      mimeType: 'image/jpeg',
      aspectRatio: '1:1',
      resolution: '1K',
      quality: undefined,
      background: undefined,
      n: 2,
      seed: 7,
      outputCompression: undefined,
      includeText: true,
    },
    'pins',
  );
  define('img2', {
    type: 'image',
    inputs: { text: true, attachments: { accept: ['image/png'] }, ...LIMITS },
    image: { aspectRatio: '1:1' },
    models: { m: { ...GEMINI, apiId: 'gi' } },
    outputs: { structured: null },
  });
  check(
    resolveTurn({ profile: 'img2', input: { text: 'x' } }).generation.image?.includeText,
    false,
    'includeText defaults off',
  );

  const said = (profile: Loose, structuredId: string | null) => {
    try {
      assertOutputMode(profile as unknown as Profile, structuredId);
      return 'ok';
    } catch (err) {
      return err instanceof TheoremError ? err.message : String(err);
    }
  };
  check(said({ id: 'p', type: 'text' }, null), 'ok', 'none');
  check(said({ id: 'p', type: 'text' }, 'schema'), 'ok', 'structured alone');
  check(said({ id: 'p', type: 'image' }, null), 'ok', 'image alone');
  check(said({ id: 'p', type: 'speech' }, null), 'ok', 'speech alone');
  const tail =
    ' Only one of a structured JSON schema (outputs.structured), image, or speech may be active.';
  const head = 'Profile p declares multiple output wire formats';
  check(
    said({ id: 'p', type: 'image' }, 'schema'),
    `${head} (structured, image).${tail}`,
    'image and structured',
  );
  check(
    said({ id: 'p', type: 'speech' }, 'schema'),
    `${head} (structured, speech).${tail}`,
    'speech and structured',
  );
});
