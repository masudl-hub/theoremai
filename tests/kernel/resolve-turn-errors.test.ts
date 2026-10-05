import { TheoremError } from '../../src/guardrails/error.ts';
import {
  clearProfiles,
  projectProfile,
  registerProfile,
  registerStructured,
  resolveTurn,
} from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { TurnRequest } from '../../src/kernel/types.ts';
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

/** The kind and message a call throws as a TheoremError, or 'returned'. */
function thrown(body: () => unknown): string {
  try {
    body();
  } catch (err) {
    return err instanceof TheoremError ? `${err.kind}: ${err.message}` : String(err);
  }
  return 'returned';
}

const turn = (id: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({
  profile: id,
  input: { text: 'hi' },
  ...extra,
});

const say = (request: TurnRequest) => thrown(() => resolveTurn(request));

Deno.test('a host or decision profile never resolves a turn, and the refusal names the door', () => {
  clearProfiles();
  registerProfile({ id: 'h', type: 'host', tools: { allow: [] } } as never);
  registerStructured('decide', { jsonSchema: { type: 'object' } } as never);
  registerProfile({
    id: 'd',
    type: 'decision',
    identity: { handle: 'd' },
    models: { m: { protocol: 'decision', provider: 'openrouter', apiId: 'x/y' } },
    key: 'main',
    inputs: { state: 'json' },
    decision: { contract: 'decide' },
  } as never);
  check(
    say(turn('h')),
    "request: Profile h: type 'host' never runs a model — resolveTurn is not supported; execute tools with invokeTool",
    'host turn',
  );
  check(
    say(turn('d')),
    "request: Profile d: type 'decision' runs through runDecision — resolveTurn is not supported",
    'decision turn',
  );
  check(
    thrown(() => projectProfile('h')),
    "request: Profile h: type 'host' never runs a model — projectProfile is not supported; execute tools with invokeTool",
    'host projection',
  );
  check(
    thrown(() => projectProfile('d')),
    "request: Profile d: type 'decision' runs through runDecision — projectProfile is not supported",
    'decision projection',
  );
});

Deno.test('model, effort and continuation refusals are request errors; a missing default effort is a config error', () => {
  clearProfiles();
  define('fixed');
  define('select', {
    models: { a: { ...GEMINI }, b: { ...GEMINI, apiId: 'g2' } },
    defaultModel: 'a',
    allowModelSelect: true,
  });
  check(
    say(turn('fixed', { model: 'm' })),
    'request: Profile fixed does not allow model selection',
    'model not allowed',
  );
  check(
    say(turn('select', { model: 'z' })),
    "request: Unknown model 'z' for select",
    'unknown model',
  );
  define('bare');
  check(
    say(turn('bare', { effort: 'high' })),
    "request: Profile bare model 'm' has no selectable efforts",
    'no efforts',
  );
  const efforts = { lo: 'low', hi: 'high' };
  define('locked', { models: { m: { ...GEMINI, efforts, defaultEffort: 'lo' } } });
  check(
    say(turn('locked', { effort: 'hi' })),
    "request: Profile locked model 'm' does not allow effort selection",
    'effort not allowed',
  );
  define('open', {
    models: { m: { ...GEMINI, efforts, defaultEffort: 'lo', allowEffortSelect: true } },
  });
  check(
    say(turn('open', { effort: 'zz' })),
    "request: Unknown effort 'zz' for open model 'm'",
    'unknown effort',
  );
  check(say(turn('open', { effort: 'hi' })), 'returned', 'a declared effort');
  define('sole', { models: { m: { ...GEMINI, efforts: { only: 'low' } } } });
  check(say(turn('sole')), 'returned', 'a single effort needs no default');
  define('resumes', {
    turnBehaviour: { resumption: { maxContinues: 2 } },
  });
  const stop = { kind: 'length' } as never;
  check(
    say({ profile: 'resumes', continueFrom: { stop } } as never),
    'request: Profile resumes: continueFrom requires TurnRequest.continuation when turnBehaviour.resumption.maxContinues is set',
    'continuation required',
  );
  check(
    say({ profile: 'resumes', continueFrom: { stop }, continuation: 0 } as never),
    'request: Profile resumes: continuation must be >= 1',
    'continuation floor',
  );
  check(
    say({ profile: 'resumes', continueFrom: { stop }, continuation: 3 } as never),
    'request: Profile resumes: continuation 3 exceeds turnBehaviour.resumption.maxContinues (2)',
    'continuation ceiling',
  );
  check(
    say({ profile: 'resumes', continueFrom: { stop }, continuation: 1 } as never),
    'returned',
    'within the ceiling',
  );
});

Deno.test('chaining refusals are request errors that name the model', () => {
  clearProfiles();
  define('chained');
  define('unchained', {
    models: { m: { ...GEMINI, persistViaInteractionId: false } },
  });
  check(
    say(turn('unchained', { previousInteractionId: 'i1' })),
    "request: Profile unchained model 'm': previousInteractionId needs a binding with persistViaInteractionId: true",
    'id without chaining',
  );
  check(
    say(turn('chained', { store: false })),
    "request: Profile chained model 'm': store: false cannot apply to a binding with persistViaInteractionId: true — Google chains only from a stored interaction",
    'no store on a chain',
  );
  check(say(turn('chained', { previousInteractionId: 'i1' })), 'returned', 'a chain');
});

Deno.test('a transport is interactions only for Google interactions, and chaining needs interactions and the flag', () => {
  clearProfiles();
  const wire = (id: string, binding: Loose) => {
    define(id, { models: { m: binding } });
    return resolveTurn(turn(id)).generation;
  };
  const openRouter = { protocol: 'openAi', provider: 'openrouter', apiId: 'x/y' };
  check(wire('g', { ...GEMINI }).transport, 'interactions', 'google interactions');
  check(wire('g', { ...GEMINI }).chains, true, 'chains');
  check(wire('o', openRouter).transport, 'openAiCompat', 'openrouter');
  check(wire('o', openRouter).chains, false, 'no chain on a compat binding');
  const off = wire('f', { ...GEMINI, persistViaInteractionId: false });
  check([off.transport, off.chains], ['interactions', false], 'interactions without chaining');
});

const LIVE = { protocol: 'geminiLive', provider: 'google', apiId: 'lv' } as const;

Deno.test('a live profile streams over the live transport, takes its own spec, and refuses continueFrom', () => {
  clearProfiles();
  define('lv', {
    type: 'live',
    models: { m: { ...LIVE } },
    live: { voice: 'Aoede' },
    inputs: undefined,
    tools: { allow: [] },
  });
  const generation = resolveTurn({ profile: 'lv' } as never).generation;
  check(
    [generation.transport, generation.stream, generation.structured],
    ['geminiLive', true, null],
    'live wiring',
  );
  check(generation.live !== undefined, true, 'live spec');
  check(
    say({ profile: 'lv', continueFrom: { stop: { kind: 'length' } } } as never),
    "request: Profile lv: type 'live' uses live.sessionResumption, not turnBehaviour.resumption/continueFrom",
    'continueFrom',
  );
  check(projectProfile('lv').outputs, null, 'a live projection has no outputs');
});

Deno.test('a guarded text profile carries no live spec, and a resumption handle comes from the request first', () => {
  clearProfiles();
  define('guarded', {});
  const generation = resolveTurn(turn('guarded')).generation;
  check(generation.live, undefined, 'no live spec on a text profile');
  check(generation.speech, undefined, 'no speech spec');
  const handle = (request: object) =>
    resolveTurn({ profile: 'guarded', input: { text: 'hi', ...request } } as never).generation
      .sessionResumptionHandle;
  check(handle({ sessionResumptionHandle: 'inner' }), 'inner', 'from the input');
  check(
    resolveTurn({ ...turn('guarded'), sessionResumptionHandle: 'outer' }).generation
      .sessionResumptionHandle,
    'outer',
    'from the request',
  );
  check(
    resolveTurn({
      ...turn('guarded', {}),
      sessionResumptionHandle: 'outer',
      input: { text: 'hi', sessionResumptionHandle: 'inner' },
    } as never).generation.sessionResumptionHandle,
    'outer',
    'the request wins',
  );
});

Deno.test('a structured map follows the slot, falling back when the slot is unset, empty or unmapped', () => {
  clearProfiles();
  registerStructured('a', { jsonSchema: { type: 'object' } } as never);
  registerStructured('b', { jsonSchema: { type: 'object' } } as never);
  registerStructured('f', { jsonSchema: { type: 'object' } } as never);
  define('map', {
    inputs: { text: true, slots: { kind: ['a', 'b', '', 'undefined'] } },
    outputs: {
      structured: { by: 'kind', map: { a: 'a', b: 'b', undefined: 'b', '': 'b' }, fallback: 'f' },
    },
  });
  const id = (slots?: Record<string, string>) =>
    resolveTurn({ profile: 'map', input: { text: 'hi', ...(slots ? { slots } : {}) } } as never)
      .generation.structured?.id;
  check(id({ kind: 'a' }), 'a', 'mapped a');
  check(id({ kind: 'b' }), 'b', 'mapped b');
  check(id(), 'f', 'no slots');
  check(id({ kind: '' }), 'f', 'empty slot');
});

Deno.test('efforts: an empty ladder selects nothing; several without a default is a config error', () => {
  clearProfiles();
  define('empty', { models: { m: { ...GEMINI, efforts: {} } } });
  check(resolveTurn(turn('empty')).generation.thinking, undefined, 'empty ladder');
  check(
    thrown(() =>
      define('many', { models: { m: { ...GEMINI, efforts: { lo: 'low', hi: 'high' } } } }),
    ),
    "config: Profile many model 'm' must set defaultEffort when more than one effort is declared",
    'registration refuses several efforts without a default',
  );
});
