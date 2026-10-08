import { TheoremError } from '../../src/guardrails/error.ts';
import {
  clearProfiles,
  projectProfile,
  registerProfile,
  registerStructured,
  resolveTurn,
} from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { clampThinkingLevel, mimeAllowed } from '../../src/kernel/registry/catalog.ts';
import type { ModelBinding, TurnRequest } from '../../src/kernel/types.ts';
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
  persistViaInteractionId: true,
} as const;
const SONAR = { protocol: 'openAi', provider: 'openrouter', apiId: 'x/y' } as const;

function define(id: string, over: Loose = {}): void {
  registerProfile({
    id,
    type: 'text',
    identity: { handle: id },
    key: 'main',
    models: { m: { ...GEMINI } },
    tools: { allow: [] },
    inputs: { text: true },
    ...over,
  } as never);
}

const withModel = (over: Loose): Loose => ({ models: { m: { ...GEMINI, ...over } } });

/** What resolving says, or the generation when it takes. */
function resolved(request: TurnRequest) {
  try {
    return resolveTurn(request).generation;
  } catch (err) {
    if (!(err instanceof TheoremError)) throw err;
    return err.message;
  }
}

const turn = (id: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({
  profile: id,
  input: { text: 'hi' },
  ...extra,
});

Deno.test('a turn may name a model only when the profile allows selection and declares it', () => {
  clearProfiles();
  define('fixed');
  define('select', {
    models: { a: { ...GEMINI }, b: { ...GEMINI, apiId: 'g2' } },
    defaultModel: 'a',
    allowModelSelect: true,
  });
  check(
    resolved(turn('fixed', { model: 'm' })),
    'Profile fixed does not allow model selection',
    'not allowed',
  );
  check(resolved(turn('select', { model: 'zzz' })), "Unknown model 'zzz' for select", 'unknown');
  check((resolved(turn('select', { model: 'b' })) as { model: string }).model, 'b', 'chosen');
  check((resolved(turn('select')) as { model: string }).model, 'a', 'default');
  check(
    (resolved(turn('select', { model: '' })) as { model: string }).model,
    'a',
    'an empty request is none',
  );
  check((resolved(turn('fixed')) as { apiId: string }).apiId, 'g', 'the sole model');
});

Deno.test('an effort is chosen by alias when the model allows it, else the default alias', () => {
  clearProfiles();
  define('none');
  define('lone', withModel({ efforts: { only: 'low' } }));
  define(
    'pick',
    withModel({ efforts: { a: 'low', b: 'high' }, defaultEffort: 'a', allowEffortSelect: true }),
  );
  define('locked', withModel({ efforts: { a: 'low', b: 'high' }, defaultEffort: 'b' }));
  const thinking = (id: string, effort?: string) =>
    (resolved(turn(id, effort ? { effort } : {})) as { thinking: unknown }).thinking;

  check(thinking('none'), undefined, 'no efforts, none asked');
  check(
    resolved(turn('none', { effort: 'a' })),
    "Profile none model 'm' has no selectable efforts",
    'effort asked of a model with none',
  );
  check(thinking('lone'), 'low', 'a lone effort is the default');
  check(thinking('pick'), 'low', 'the default alias');
  check(thinking('pick', 'b'), 'high', 'the one asked for');
  check(
    resolved(turn('pick', { effort: 'z' })),
    "Unknown effort 'z' for pick model 'm'",
    'unknown alias',
  );
  check(
    resolved(turn('locked', { effort: 'a' })),
    "Profile locked model 'm' does not allow effort selection",
    'selection off',
  );
  check(thinking('locked'), 'high', 'the default alias when locked');
});

Deno.test('a summaries flag becomes a mode, and left unset stays unset', () => {
  clearProfiles();
  define('on', withModel({ summaries: true }));
  define('off', withModel({ summaries: false }));
  define('unset');
  const summaries = (id: string) => (resolved(turn(id)) as { summaries: unknown }).summaries;
  check(summaries('on'), 'auto', 'true');
  check(summaries('off'), 'none', 'false');
  check(summaries('unset'), undefined, 'unset');
});

Deno.test('a structured output is picked by the slot value, else its fallback', () => {
  clearProfiles();
  registerStructured('resolve.happy', { jsonSchema: { type: 'object', title: 'happy' } });
  registerStructured('resolve.sad', { jsonSchema: { type: 'object', title: 'sad' } });
  registerStructured('resolve.other', { jsonSchema: { type: 'object', title: 'other' } });
  define('mapped', {
    inputs: { text: true, slots: { mood: ['happy', 'sad', 'meh'] } },
    outputs: {
      structured: {
        by: 'mood',
        map: { happy: 'resolve.happy', sad: 'resolve.sad' },
        fallback: 'resolve.other',
      },
    },
  });
  define('named', { outputs: { structured: 'resolve.sad' } });
  define('plain');
  const structured = (id: string, slots?: Record<string, string>) =>
    (
      resolved(turn(id, { input: { text: 'hi', ...(slots ? { slots } : {}) } })) as {
        structured: unknown;
      }
    ).structured;
  check(
    structured('mapped', { mood: 'happy' }),
    { id: 'resolve.happy', jsonSchema: { type: 'object', title: 'happy' } },
    'mapped',
  );
  check(
    structured('mapped', { mood: 'sad' }),
    { id: 'resolve.sad', jsonSchema: { type: 'object', title: 'sad' } },
    'mapped sad',
  );
  check(
    (structured('mapped', { mood: 'meh' }) as { id: string }).id,
    'resolve.other',
    'a choice not mapped',
  );
  check((structured('mapped') as { id: string }).id, 'resolve.other', 'no slots');
  check((structured('mapped', {}) as { id: string }).id, 'resolve.other', 'slot left out');
  check((structured('named') as { id: string }).id, 'resolve.sad', 'a named schema');
  check(structured('plain'), null, 'none declared');
});

Deno.test('the transport follows the model, streaming follows the profile, and chains need interactions', () => {
  clearProfiles();
  define('gem');
  define('router', { models: { m: { ...SONAR } } });
  define('buffered', { outputs: { streaming: { mode: 'buffered' } } });
  define('streamed', { outputs: { streaming: { mode: 'stream' } } });
  define('nochain', withModel({ persistViaInteractionId: false, store: true }));
  const gen = (id: string, extra: Partial<TurnRequest> = {}) =>
    resolved(turn(id, extra)) as unknown as Record<string, unknown>;
  check(gen('gem').transport, 'interactions', 'gemini');
  check(gen('router').transport, 'openAiCompat', 'openrouter');
  check(gen('gem').stream, true, 'default streaming');
  check(gen('streamed').stream, true, 'streamed');
  check(gen('buffered').stream, false, 'buffered');
  check(gen('gem').chains, true, 'chains on interactions');
  check(gen('router').chains, false, 'no chains elsewhere');
  check(gen('nochain').chains, false, 'persistence off');
  check(
    gen('gem', { previousInteractionId: 'i1' }).previousInteractionId,
    'i1',
    'the id rides when chaining',
  );
  check(
    resolved(turn('nochain', { previousInteractionId: 'i1' })),
    "Profile nochain model 'm': previousInteractionId needs a binding with persistViaInteractionId: true",
    'refused when not chaining',
  );
  check(
    resolved(turn('router', { previousInteractionId: 'i1' })),
    "Profile router model 'm': previousInteractionId needs a binding with persistViaInteractionId: true",
    'refused on openrouter',
  );
  check(gen('nochain').store, true, 'the binding store');
  check(gen('nochain', { store: false }).store, false, 'the turn overrides it');
  check(gen('gem').store, undefined, 'no store');
  check(
    resolved(turn('gem', { store: false })),
    "Profile gem model 'm': store: false cannot apply to a binding with persistViaInteractionId: true — the provider chains only from a stored interaction",
    'a chaining turn keeps storage on',
  );
});

Deno.test('a continue turn needs a counter inside the profile cap, and takes no text', () => {
  clearProfiles();
  const stop = { kind: 'length' } as never;
  define('capped', { turnBehaviour: { resumption: { maxContinues: 2 } } });
  define('uncapped');
  const go = (id: string, extra: Partial<TurnRequest>) =>
    resolved({ profile: id, input: {}, continueFrom: { stop }, ...extra } as TurnRequest);
  check(typeof go('uncapped', {}), 'object', 'uncapped needs no counter');
  check(typeof go('capped', { continuation: 1 }), 'object', 'attempt 1');
  check(typeof go('capped', { continuation: 2 }), 'object', 'attempt at the cap');
  check(
    go('capped', {}),
    'Profile capped: continueFrom requires TurnRequest.continuation when turnBehaviour.resumption.maxContinues is set',
    'no counter',
  );
  check(go('capped', { continuation: 0 }), 'Profile capped: continuation must be >= 1', 'zero');
  check(
    go('capped', { continuation: 3 }),
    'Profile capped: continuation 3 exceeds turnBehaviour.resumption.maxContinues (2)',
    'over the cap',
  );
  check(
    resolved({ profile: 'uncapped', input: { text: 'x' }, continueFrom: { stop } } as TurnRequest),
    'Profile uncapped: a continueFrom turn takes no input.text — its user message is the continue instruction',
    'continue with text',
  );
  check(
    typeof resolved(turn('capped', { continuation: 9 })),
    'object',
    'no continueFrom, no checks',
  );
});

Deno.test('image, speech and live profiles carry their own spec onto the generation', () => {
  clearProfiles();
  define('img', {
    type: 'image',
    image: { aspectRatio: '1:1' },
    models: {
      m: {
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: 'gi',
        persistViaInteractionId: false,
      },
    },
    outputs: { structured: null },
  });
  const generation = resolved(turn('img')) as unknown as Record<string, unknown>;
  check(generation.image !== undefined && generation.image !== null, true, 'image spec');
  check(generation.speech, undefined, 'no speech');
  check(generation.live, undefined, 'no live');
  const plain = resolved(turn('img')) as unknown as Record<string, unknown>;
  check(plain.structured, null, 'no structured');
});

Deno.test('a projection carries the profile fields a host reads, and nulls what the type lacks', () => {
  clearProfiles();
  define('proj', { maxSteps: 3, outputs: { structured: null } });
  const projected = projectProfile('proj');
  check(projected.id, 'proj', 'id');
  check(projected.type, 'text', 'type');
  check(projected.handle, 'proj', 'handle');
  check(projected.maxSteps, 3, 'maxSteps');
  check(projected.key, 'main', 'key');
  check(projected.defaultModel, 'm', 'defaultModel');
  check(projected.speech, null, 'no speech');
  check(projected.live, null, 'no live');
  check(projected.image, null, 'no image');
  check(projected.inputs, { text: true }, 'inputs');
  check(projected.outputs, { structured: null }, 'outputs');
  define('bare');
  check(projectProfile('bare').outputs, null, 'no outputs');
});

Deno.test('mimeAllowed matches a wildcard by prefix and an exact rule by essence', () => {
  check(mimeAllowed(['image/*'], 'image/png'), true, 'wildcard');
  check(mimeAllowed(['image/*'], 'imagex/png'), false, 'prefix keeps its slash');
  check(mimeAllowed(['image/*'], 'audio/png'), false, 'another category');
  check(mimeAllowed(['image/png'], 'IMAGE/PNG; q=1'), true, 'essence');
  check(mimeAllowed(['image/png'], 'image/jpeg'), false, 'exact only');
  check(mimeAllowed([], 'image/png'), false, 'nothing accepted');
  check(mimeAllowed(['image/*; x=y'], 'image/png'), true, 'rule parameters ignored');
});

Deno.test('a thinking level a model cannot take clamps to its default, then its first legal level', () => {
  const binding = (over: Partial<ModelBinding>): ModelBinding =>
    ({ ...GEMINI, ...over }) as ModelBinding;
  check(clampThinkingLevel(binding({}), 'high'), 'high', 'no efforts: as asked');
  check(clampThinkingLevel(binding({ efforts: {} }), 'high'), 'high', 'empty efforts: as asked');
  const two = binding({ efforts: { a: 'low', b: 'medium' }, defaultEffort: 'b' });
  check(clampThinkingLevel(two, 'low'), 'low', 'a legal level');
  check(clampThinkingLevel(two, 'high'), 'medium', 'the default alias level');
  check(
    clampThinkingLevel(binding({ efforts: { a: 'low', b: 'medium' } }), 'high'),
    'low',
    'no default: the first',
  );
  check(
    clampThinkingLevel(
      binding({ efforts: { a: 'low', b: 'medium' }, defaultEffort: 'zzz' }),
      'high',
    ),
    'low',
    'an undeclared default: the first',
  );
});

Deno.test('a turn is capped at 20 model calls unless its profile says otherwise', () => {
  clearProfiles();
  define('capped');
  define('own', { maxSteps: 3 });
  const steps = (id: string) => {
    const generation = resolved(turn(id));
    return typeof generation === 'string' ? generation : generation.maxSteps;
  };
  check(steps('capped'), 20, 'unset');
  check(steps('own'), 3, 'declared');
  check(projectProfile('capped').maxSteps ?? null, null, 'the projection keeps what was declared');
});
