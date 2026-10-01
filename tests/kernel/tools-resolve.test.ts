import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { createToolRegistry, type ToolRegistry } from '../../src/kernel/tools/registry.ts';
import {
  applyBuiltinMutualExclusions,
  buildWire,
  cloneTurnToolSnapshot,
  expandT1Policy,
  initialBuiltins,
  initialVisible,
  pathMatches,
  prepareTurnToolSnapshot,
  profileToolAllow,
  profileToolsSpec,
  promoteBuiltin,
  promoteLoadedTools,
  promoteTool,
  promotionTarget,
  resolveAllowedCustomToolIds,
  resolveModelBuiltinIds,
  resolveTurnTools,
  wireForTool,
} from '../../src/kernel/tools/resolve.ts';
import type { TurnToolSnapshot } from '../../src/kernel/tools/types.ts';
import type { ModelId, Profile, TurnRequest } from '../../src/kernel/types.ts';

/** The refusal a promotion would fail with, or undefined when the tool may be promoted. */
function refusal(...args: Parameters<typeof promotionTarget>) {
  const target = promotionTarget(...args);
  return 'failure' in target ? target.failure : undefined;
}

function check(actual: unknown, expected: unknown, label: string): void {
  try {
    assertEquals(actual, expected);
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}

function as<T>(value: unknown): T {
  return value as T;
}

type ToolLoadTier = 'T0' | 'T1' | 'T2';

const inputSchema = z.object({ q: z.string() });

function registryWith(): ToolRegistry {
  const tools = createToolRegistry();
  const fn = (name: string, loadTier: ToolLoadTier, paths: string[] = ['*']) =>
    tools.register({
      type: 'function',
      name,
      description: `${name} description`,
      category: 'test',
      access: 'read-only',
      paths,
      loadTier,
      permission: 'auto',
      input: inputSchema,
      output: z.object({}),
      handler: () => ({}),
    });
  const builtin = (
    name: string,
    loadTier: ToolLoadTier,
    conflictsWith?: string[],
    paths: string[] = ['*'],
  ) =>
    tools.register({
      type: 'builtin',
      name,
      description: `${name} description`,
      category: 'test',
      access: 'read-only',
      paths,
      loadTier,
      permission: 'auto',
      wire: {},
      ...(conflictsWith ? { conflictsWith } : {}),
    });
  fn('f0', 'T0');
  fn('f0b', 'T0');
  fn('f1', 'T1');
  fn('f2', 'T2');
  fn('f2b', 'T2');
  fn('fweb', 'T0', ['web']);
  fn('fweb2', 'T2', ['web']);
  builtin('b0', 'T0');
  builtin('b1', 'T1');
  builtin('b1b', 'T1');
  builtin('b2', 'T2');
  builtin('bweb', 'T0', undefined, ['web']);
  builtin('ca', 'T1', ['cb']);
  builtin('cb', 'T1');
  builtin('cc', 'T1', ['cd']);
  builtin('cd', 'T1', ['cc']);
  return tools;
}

const tools = registryWith();

function textProfile(allow: string[], extra: Record<string, unknown> = {}): Profile {
  return as<Profile>({ id: 'p', type: 'text', tools: { allow, ...extra }, models: {} });
}

function modelProfile(
  type: 'text' | 'image' | 'live',
  allow: string[],
  builtInTools?: string[],
  extra: Record<string, unknown> = {},
): Profile {
  return as<Profile>({
    id: 'p',
    type,
    tools: { allow, ...extra },
    models: { m: builtInTools ? { builtInTools } : {} },
  });
}

function snapshot(partial: Partial<TurnToolSnapshot> = {}): TurnToolSnapshot {
  return { builtins: [], gated: [], visible: [], executable: [], wire: [], ...partial };
}

const req = (path?: string, extra: Record<string, unknown> = {}) =>
  as<TurnRequest>({ path, ...extra });

Deno.test('pathMatches: wildcard and missing catalog match, a missing or empty turn path matches only a wildcard', () => {
  const cases: [string[] | undefined, string | undefined, boolean][] = [
    [undefined, undefined, true],
    [undefined, 'web', true],
    [['*'], undefined, true],
    [['web', '*'], 'other', true],
    [['web'], 'web', true],
    [['web'], 'other', false],
    [['web'], undefined, false],
    [['web'], '', false],
    [[''], '', false],
    [[], 'web', false],
  ];
  for (const [paths, turnPath, expected] of cases) {
    check(pathMatches(paths, turnPath), expected, `${JSON.stringify(paths)} / ${turnPath}`);
  }
});

Deno.test('applyBuiltinMutualExclusions drops a builtin whose conflict is also requested, whichever side declares it', () => {
  const cases: [string[], string[]][] = [
    [
      ['f0', 'missing', 'f1'],
      ['f0', 'missing', 'f1'],
    ],
    [
      ['b0', 'b1'],
      ['b0', 'b1'],
    ],
    [['cc', 'cd'], []],
    [['ca', 'cb'], ['cb']],
    [['cb', 'ca'], ['cb']],
    [
      ['ca', 'b0'],
      ['ca', 'b0'],
    ],
    [
      ['f0', 'ca', 'cb', 'b0'],
      ['f0', 'cb', 'b0'],
    ],
  ];
  for (const [requested, expected] of cases) {
    check(
      applyBuiltinMutualExclusions(tools, requested),
      expected,
      `requested ${JSON.stringify(requested)}`,
    );
  }
});

Deno.test('profileToolAllow and profileToolsSpec read the allow list and tools spec by profile type', () => {
  check(profileToolAllow(as<Profile>({ type: 'decision' })), [], 'decision has no tools');
  check(profileToolAllow(textProfile(['f0', 'f1'])), ['f0', 'f1'], 'text allow');
  check(profileToolAllow(as<Profile>({ type: 'host', tools: { allow: ['f0'] } })), ['f0'], 'host');
  const spec = { allow: ['f0'] };
  for (const type of ['text', 'image'] as const) {
    const profile = as<Profile>({ type, tools: spec });
    check(profileToolsSpec(profile) === spec, true, `${type} returns its tools spec`);
  }
  for (const type of ['live', 'host'] as const) {
    check(
      profileToolsSpec(as<Profile>({ type, tools: spec })),
      undefined,
      `${type} has no t1Policy spec`,
    );
  }
  check(profileToolsSpec(as<Profile>({ type: 'decision' })), undefined, 'decision');
});

Deno.test('resolveAllowedCustomToolIds keeps registered custom tools in allow order, filtered by path except for host', () => {
  const allow = ['fweb', 'missing', 'b0', 'f0', 'fweb2'];
  check(
    resolveAllowedCustomToolIds(tools, textProfile(allow), req('web')),
    ['fweb', 'f0', 'fweb2'],
    'path web',
  );
  check(resolveAllowedCustomToolIds(tools, textProfile(allow), req('other')), ['f0'], 'other path');
  check(resolveAllowedCustomToolIds(tools, textProfile(allow), req()), ['f0'], 'no path');
  check(
    resolveAllowedCustomToolIds(
      tools,
      as<Profile>({ type: 'host', tools: { allow } }),
      req('other'),
    ),
    ['fweb', 'f0', 'fweb2'],
    'host ignores path',
  );
});

Deno.test('resolveModelBuiltinIds keeps only the model builtins that exist as builtins and match the path', () => {
  const profile = as<Parameters<typeof resolveModelBuiltinIds>[1]>({
    models: {
      m: { builtInTools: ['bweb', 'f0', 'missing', 'b1'] },
      bare: {},
    },
  });
  check(resolveModelBuiltinIds(tools, profile, req('web'), 'm'), ['bweb', 'b1'], 'web');
  check(resolveModelBuiltinIds(tools, profile, req('other'), 'm'), ['b1'], 'other');
  check(resolveModelBuiltinIds(tools, profile, req('web'), 'bare'), [], 'no builtInTools');
  check(resolveModelBuiltinIds(tools, profile, req('web'), 'nope'), [], 'unknown model');
});

Deno.test('wireForTool and buildWire expose custom tools as function declarations and nothing else', () => {
  const wire = wireForTool(tools, 'f1');
  check(
    wire,
    {
      type: 'function',
      name: 'f1',
      description: 'f1 description',
      parameters: tools.get('f1') && (tools.get('f1') as { inputSchema: unknown }).inputSchema,
    },
    'f1 wire',
  );
  check(
    (wire?.parameters as { properties: unknown } | undefined)?.properties,
    { q: { type: 'string' } },
    'parameters are the input schema',
  );
  check(wireForTool(tools, 'b0'), undefined, 'builtin');
  check(wireForTool(tools, 'missing'), undefined, 'unknown');
  check(
    buildWire(tools, ['f1', 'b0', 'missing', 'f0']).map((w) => w.name),
    ['f1', 'f0'],
    'order kept, non-custom dropped',
  );
  check(buildWire(tools, []), [], 'empty');
});

Deno.test('promoteTool makes a tool visible once and adds its wire only when absent', () => {
  const state = snapshot({ visible: ['f0'], wire: [] });
  promoteTool(tools, state, 'f0');
  check(state.visible, ['f0'], 'already visible is a no-op');
  check(state.wire, [], 'no wire added for an already visible tool');

  promoteTool(tools, state, 'f1');
  check(state.visible, ['f0', 'f1'], 'visible');
  check(
    state.wire.map((w) => w.name),
    ['f1'],
    'wire',
  );

  const stale = snapshot({
    visible: [],
    wire: [{ type: 'function', name: 'f2', description: 'kept', parameters: {} }],
  });
  promoteTool(tools, stale, 'f2');
  check(stale.visible, ['f2'], 'visible even when its wire is present');
  check(
    stale.wire,
    [{ type: 'function', name: 'f2', description: 'kept', parameters: {} }],
    'no duplicate wire',
  );

  const other = snapshot({
    wire: [{ type: 'function', name: 'f0', description: 'x', parameters: {} }],
  });
  promoteTool(tools, other, 'f2');
  check(
    other.wire.map((w) => w.name),
    ['f0', 'f2'],
    'a different wire name does not block it',
  );

  for (const id of ['missing', 'b1']) {
    const none = snapshot();
    promoteTool(tools, none, id);
    check(none.visible, [id], `${id} is made visible`);
    check(none.wire, [], `${id} has no wire`);
  }
});

Deno.test('promoteBuiltin adds a builtin, evicts conflicts declared on either side, and ignores non-builtins', () => {
  const plain = snapshot({ builtins: ['b0'] });
  promoteBuiltin(tools, plain, 'b1');
  check(plain.builtins, ['b0', 'b1'], 'unrelated builtins stay');
  promoteBuiltin(tools, plain, 'b1');
  check(plain.builtins, ['b0', 'b1'], 'already present');

  const declared = snapshot({ builtins: ['b0', 'cb'] });
  promoteBuiltin(tools, declared, 'ca');
  check(declared.builtins, ['b0', 'ca'], 'the new builtin declares the conflict');

  const reverse = snapshot({ builtins: ['b0', 'ca'] });
  promoteBuiltin(tools, reverse, 'cb');
  check(reverse.builtins, ['b0', 'cb'], 'the existing builtin declares the conflict');

  const mutual = snapshot({ builtins: ['cc'] });
  promoteBuiltin(tools, mutual, 'cd');
  check(mutual.builtins, ['cd'], 'mutual');

  const odd = snapshot({ builtins: ['f0', 'missing'] });
  promoteBuiltin(tools, odd, 'cd');
  check(odd.builtins, ['f0', 'missing', 'cd'], 'non-builtin entries are not conflicts');

  for (const id of ['missing', 'f1']) {
    const untouched = snapshot({ builtins: ['b0'] });
    promoteBuiltin(tools, untouched, id);
    check(untouched.builtins, ['b0'], `${id} is not a builtin`);
  }
});

Deno.test('initialVisible shows every gated tool for live and host, and only T0 tools otherwise', () => {
  const gated = ['f0', 'f1', 'f2', 'b0', 'b1', 'missing'];
  for (const type of ['live', 'host'] as const) {
    const out = initialVisible(tools, as<Profile>({ type }), gated);
    check(out, gated, `${type} all`);
    check(out === gated, false, `${type} is a copy`);
  }
  for (const type of ['text', 'image', 'decision'] as const) {
    check(initialVisible(tools, as<Profile>({ type }), gated), ['f0', 'b0'], `${type} T0 only`);
  }
});

Deno.test('initialBuiltins keeps builtins that are T0, or any tier for live, minus mutual exclusions', () => {
  const gated = ['f0', 'f1', 'b0', 'b1', 'bweb', 'missing'];
  check(initialBuiltins(tools, as<Profile>({ type: 'text' }), gated), ['b0', 'bweb'], 'text');
  check(initialBuiltins(tools, as<Profile>({ type: 'live' }), gated), ['b0', 'b1', 'bweb'], 'live');
  check(
    initialBuiltins(tools, as<Profile>({ type: 'live' }), ['ca', 'cb', 'b0']),
    ['cb', 'b0'],
    'live exclusions',
  );
  check(initialBuiltins(tools, as<Profile>({ type: 'text' }), ['ca', 'cb']), [], 'T1 not initial');
});

Deno.test('resolveTurnTools gates custom then model builtins and derives builtins, visible, executable and wire', () => {
  const profile = modelProfile('text', ['f0', 'f1', 'f2', 'fweb'], ['b0', 'b1', 'bweb', 'f0']);
  const state = resolveTurnTools(
    tools,
    profile,
    req('web', { sessionPermissions: ['p1'] }),
    'm' as ModelId,
  );
  check(state.gated, ['f0', 'f1', 'f2', 'fweb', 'b0', 'b1', 'bweb'], 'gated');
  check(state.builtins, ['b0', 'bweb'], 'builtins');
  check(state.visible, ['f0', 'fweb', 'b0', 'bweb'], 'visible');
  check(state.executable, ['f0', 'fweb'], 'executable');
  check(
    state.wire.map((w) => w.name),
    ['f0', 'fweb'],
    'wire',
  );
  check(state.path, 'web', 'path');
  check(state.sessionPermissions, ['p1'], 'sessionPermissions');

  const noPath = resolveTurnTools(tools, profile, req(), 'm' as ModelId);
  check(noPath.gated, ['f0', 'f1', 'f2', 'b0', 'b1'], 'path-less gated');
  check(noPath.path, undefined, 'no path');
  check('sessionPermissions' in noPath && noPath.sessionPermissions, undefined, 'no permissions');
});

Deno.test('resolveTurnTools for a live profile makes every gated tool visible while executable excludes builtins', () => {
  const profile = modelProfile('live', ['f0', 'f1'], ['b1', 'b0']);
  const state = resolveTurnTools(tools, profile, req(), 'm' as ModelId);
  check(state.gated, ['f0', 'f1', 'b1', 'b0'], 'gated');
  check(state.builtins, ['b1', 'b0'], 'builtins');
  check(state.visible, ['f0', 'f1', 'b1', 'b0'], 'visible');
  check(state.executable, ['f0', 'f1'], 'executable');
  check(
    state.wire.map((w) => w.name),
    ['f0', 'f1'],
    'wire',
  );
});

Deno.test('resolveTurnTools resolves no model builtins for host and decision profiles, or without a model', () => {
  const host = as<Profile>({ id: 'h', type: 'host', tools: { allow: ['f0', 'fweb'] } });
  const hosted = resolveTurnTools(tools, host, req('other'), 'm' as ModelId);
  check(hosted.gated, ['f0', 'fweb'], 'host gated');
  check(hosted.visible, ['f0', 'fweb'], 'host visible');
  check(hosted.builtins, [], 'host builtins');

  const decision = as<Profile>({ id: 'd', type: 'decision' });
  const decided = resolveTurnTools(tools, decision, req(), 'm' as ModelId);
  check(decided, { builtins: [], gated: [], visible: [], executable: [], wire: [] }, 'decision');

  const profile = as<Profile>({
    id: 'p',
    type: 'text',
    tools: { allow: ['f0'] },
    models: { undefined: { builtInTools: ['b0'] } },
  });
  check(
    resolveTurnTools(tools, profile, req(), undefined).gated,
    ['f0'],
    'no model id resolves no builtins',
  );
  check(
    resolveTurnTools(tools, profile, req(), 'undefined' as ModelId).gated,
    ['f0', 'b0'],
    'a model that is literally named undefined still resolves',
  );
});

Deno.test('prepareTurnToolSnapshot resolves the turn then promotes the tools t1Policy selects', async () => {
  let seen: unknown;
  const profile = modelProfile('text', ['f0', 'f1', 'f2'], ['b0', 'b1'], {
    t1Policy: (ctx: unknown) => {
      seen = ctx;
      return ['f1', 'b1'];
    },
  });
  const request = req('web', {
    input: { text: 'hi' },
    sessionPermissions: ['p'],
    host: { h: 1 },
  });
  const state = await prepareTurnToolSnapshot(tools, profile, request, 'm' as ModelId);
  check(state.gated, ['f0', 'f1', 'f2', 'b0', 'b1'], 'gated');
  check(state.visible, ['f0', 'b0', 'f1'], 'visible');
  check(state.builtins, ['b0', 'b1'], 'builtins');
  check(state.executable, ['f0', 'f1'], 'executable');
  check(
    state.wire.map((w) => w.name),
    ['f0', 'f1'],
    'wire',
  );
  check(
    seen,
    {
      profile,
      input: { text: 'hi' },
      path: 'web',
      sessionPermissions: ['p'],
      gated: ['f0', 'f1', 'f2', 'b0', 'b1'],
      host: { h: 1 },
    },
    't1Policy context',
  );
  check(as<{ host: unknown }>(seen).host === request.host, true, 'host is passed by reference');
});

Deno.test('cloneTurnToolSnapshot copies every list and every wire parameter so a clone cannot change the original', () => {
  const original: TurnToolSnapshot = {
    builtins: ['b0'],
    gated: ['f0', 'b0'],
    visible: ['f0', 'b0'],
    executable: ['f0'],
    path: 'web',
    sessionPermissions: ['x'],
    wire: [{ type: 'function', name: 'f0', description: 'd', parameters: { a: { b: 1 } } }],
  };
  const copy = cloneTurnToolSnapshot(original);
  check(copy, original, 'equal');
  copy.builtins.push('c');
  copy.gated.push('c');
  copy.visible.push('c');
  copy.executable.push('c');
  copy.sessionPermissions?.push('c');
  (copy.wire[0].parameters as { a: { b: number } }).a.b = 2;
  copy.wire.push({ type: 'function', name: 'n', description: '', parameters: {} });
  check(original.builtins, ['b0'], 'builtins');
  check(original.gated, ['f0', 'b0'], 'gated');
  check(original.visible, ['f0', 'b0'], 'visible');
  check(original.executable, ['f0'], 'executable');
  check(original.sessionPermissions, ['x'], 'sessionPermissions');
  check(original.wire[0].parameters, { a: { b: 1 } }, 'parameters');
  check(original.wire.length, 1, 'wire length');

  const bare = cloneTurnToolSnapshot(snapshot());
  check('sessionPermissions' in bare && bare.sessionPermissions, undefined, 'no permissions');
  check(bare.path, undefined, 'no path');
});

async function t1Error(policy: () => unknown, state = snapshot()): Promise<TheoremError> {
  try {
    await expandT1Policy(
      tools,
      state,
      as<Profile>({ id: 'pid', type: 'text', tools: { allow: [], t1Policy: policy } }),
      req(),
    );
  } catch (err) {
    if (err instanceof TheoremError) {
      return err;
    }
    throw err;
  }
  throw new Error('expected a TheoremError');
}

Deno.test('expandT1Policy wraps a failing or malformed policy as a config error naming the profile', async () => {
  const cause = new Error('boom');
  const rejected = await t1Error(() => {
    throw cause;
  });
  check(rejected.kind, 'config', 'throw kind');
  check(rejected.message, "Profile 'pid' tools.t1Policy rejected: boom", 'throw message');
  check(rejected.cause === cause, true, 'cause kept');

  const asyncRejected = await t1Error(() => Promise.reject('plain'));
  check(asyncRejected.message, "Profile 'pid' tools.t1Policy rejected: plain", 'string reason');
  check(asyncRejected.cause, 'plain', 'string cause kept');

  for (const bad of ['f1', { length: 1 }, undefined, null, 7]) {
    const malformed = await t1Error(() => bad);
    check(malformed.kind, 'config', `${JSON.stringify(bad)} kind`);
    check(
      malformed.message,
      "Profile 'pid' tools.t1Policy must return ToolId[]",
      `${JSON.stringify(bad)} message`,
    );
  }
});

Deno.test('expandT1Policy promotes only gated, registered, non-T0 selections and recomputes executable', async () => {
  const state = snapshot({
    builtins: ['b0'],
    gated: ['f0', 'f1', 'f2', 'b0', 'b1', 'ca', 'cb', 'ghost'],
    visible: ['f0', 'b0'],
    executable: ['stale'],
  });
  const profile = as<Profile>({
    id: 'p',
    type: 'text',
    tools: {
      allow: [],
      t1Policy: () => ['f0', 'b0', 'ungated', 'f2b', 'ghost', 'f1', 'b1', 'ca', 'cb', 'f1'],
    },
  });
  await expandT1Policy(tools, state, profile, req());
  check(state.visible, ['f0', 'b0', 'f1'], 'visible');
  check(state.builtins, ['b0', 'b1', 'cb'], 'builtins');
  check(state.executable, ['f0', 'f1'], 'executable');
  check(
    state.wire.map((w) => w.name),
    ['f1'],
    'wire',
  );
});

Deno.test('expandT1Policy leaves a T0 selection alone even when it is not yet visible', async () => {
  const state = snapshot({ gated: ['f0', 'b0'], visible: [], builtins: [], executable: ['keep'] });
  const profile = as<Profile>({
    id: 'p',
    type: 'text',
    tools: { allow: [], t1Policy: () => ['f0', 'b0'] },
  });
  await expandT1Policy(tools, state, profile, req());
  check(state.visible, [], 'visible');
  check(state.builtins, [], 'builtins');
  check(state.wire, [], 'wire');
  check(state.executable, [], 'executable recomputed');
});

Deno.test('expandT1Policy without a policy, or on a live or host profile, changes nothing', async () => {
  for (const profile of [
    as<Profile>({ type: 'text', tools: { allow: [] } }),
    as<Profile>({ type: 'decision' }),
    as<Profile>({ type: 'live', tools: { allow: [], t1Policy: () => ['f1'] } }),
    as<Profile>({ type: 'host', tools: { allow: [], t1Policy: () => ['f1'] } }),
  ]) {
    const state = snapshot({ gated: ['f1'], executable: ['kept'] });
    await expandT1Policy(tools, state, profile, req());
    check(state, snapshot({ gated: ['f1'], executable: ['kept'] }), `${profile.type}`);
  }
});

Deno.test('expandT1Policy and promoteLoadedTools do not treat a visible tool that is no longer registered as executable', async () => {
  const state = snapshot({ gated: ['f2'], visible: ['gone', 'f0'] });
  await expandT1Policy(
    tools,
    state,
    as<Profile>({ type: 'text', tools: { allow: ['f2'], t1Policy: () => [] } }),
    req(),
  );
  check(state.executable, ['f0'], 'expand');

  const loaded = snapshot({ gated: ['f2'], visible: ['gone', 'b0'] });
  promoteLoadedTools(tools, loaded, ['f2'], textProfile(['f2']));
  check(loaded.executable, ['f2'], 'promote');
});

const BAD_ID = 'tools.t2Loader loaded ids must be plain strings';

Deno.test('promoteLoadedTools rejects non-string and prototype-polluting ids with a bad_response failure', () => {
  const profile = textProfile(['__proto__', 'constructor', 'prototype', 'f2']);
  for (const id of ['__proto__', 'constructor', 'prototype', 42, null, {}]) {
    const state = snapshot({ gated: ['f2'], path: 'web' });
    check(
      promoteLoadedTools(tools, state, ['f2', id as string], profile),
      {
        promoted: [],
        failure: { code: 'invalid_output', kind: 'bad_response', message: BAD_ID },
      },
      `${String(id)}`,
    );
    check(state.visible, [], `${String(id)} promotes nothing`);
  }
});

Deno.test('promoteLoadedTools does nothing for live and host profiles, even with invalid ids', () => {
  for (const type of ['live', 'host'] as const) {
    const profile = as<Profile>({ type, tools: { allow: ['f2'] } });
    const state = snapshot({ gated: ['f2'], executable: ['keep'] });
    for (const loaded of [['f2'], ['__proto__'], ['missing']]) {
      const result = promoteLoadedTools(tools, state, loaded, profile);
      check(result, { promoted: [] }, `${type} ${loaded}`);
      check('failure' in result, false, `${type} ${loaded} has no failure key`);
    }
    check(state, snapshot({ gated: ['f2'], executable: ['keep'] }), `${type} state untouched`);
  }
});

Deno.test('promoteLoadedTools promotes gated, path-matching T2 tools in order, and skips others silently', () => {
  const profile = textProfile(['f2', 'f2b', 'fweb2']);
  const state = snapshot({
    gated: ['f2', 'f2b', 'fweb2'],
    visible: ['f0', 'b0'],
    path: 'other',
    executable: ['stale'],
  });
  const result = promoteLoadedTools(tools, state, ['f2b', 'fweb2', 'f2'], profile);
  check(result, { promoted: ['f2b', 'f2'] }, 'result');
  check(state.visible, ['f0', 'b0', 'f2b', 'f2'], 'visible');
  check(state.executable, ['f0', 'f2b', 'f2'], 'executable excludes builtins');
  check(
    state.wire.map((w) => w.name),
    ['f2b', 'f2'],
    'wire',
  );

  const ungated = snapshot({ gated: ['f2'], path: 'web' });
  check(
    promoteLoadedTools(tools, ungated, ['f2b', 'f2'], profile),
    { promoted: ['f2'] },
    'ungated',
  );
  const unmatched = snapshot({ gated: ['fweb2'], path: 'other' });
  check(promoteLoadedTools(tools, unmatched, ['fweb2'], profile), { promoted: [] }, 'path');
  const matched = snapshot({ gated: ['fweb2'], path: 'web' });
  check(promoteLoadedTools(tools, matched, ['fweb2'], profile), { promoted: ['fweb2'] }, 'match');
  check(promoteLoadedTools(tools, snapshot(), [], profile), { promoted: [] }, 'nothing loaded');
});

Deno.test('promoteLoadedTools is all-or-nothing: a later invalid id discards earlier promotions', () => {
  const profile = textProfile(['f2', 'f1']);
  const state = snapshot({ gated: ['f2', 'f1'], executable: ['keep'] });
  const result = promoteLoadedTools(tools, state, ['f2', 'f1'], profile);
  check(
    result,
    {
      promoted: [],
      failure: {
        code: 'invalid_output',
        kind: 'bad_response',
        message:
          "tools.t2Loader attempted to promote tool 'f1' with loadTier 'T1' — only T2 tools may be promoted",
      },
    },
    'result',
  );
  check(state, snapshot({ gated: ['f2', 'f1'], executable: ['keep'] }), 'state untouched');
});

Deno.test('promotionTarget names why a loaded id may not be promoted, and accepts an allowed T2 custom tool', () => {
  const profile = textProfile(['f2', 'f1', 'b2', 'ghost']);
  const failure = (message: string) => ({ code: 'invalid_output', kind: 'bad_response', message });
  check(
    refusal(tools, 'f2b', profile),
    failure("tools.t2Loader attempted to promote tool 'f2b' outside profile allow"),
    'outside allow',
  );
  check(
    refusal(tools, 'f2b', as<Profile>({ type: 'decision' })),
    failure("tools.t2Loader attempted to promote tool 'f2b' outside profile allow"),
    'profile without tools',
  );
  check(
    refusal(tools, 'ghost', profile),
    failure("tools.t2Loader attempted to promote unknown tool 'ghost'"),
    'unknown',
  );
  check(
    refusal(tools, 'b2', profile),
    failure("tools.t2Loader attempted to promote builtin 'b2' — only custom tools may be promoted"),
    'builtin even at T2',
  );
  check(
    refusal(tools, 'f1', profile),
    failure(
      "tools.t2Loader attempted to promote tool 'f1' with loadTier 'T1' — only T2 tools may be promoted",
    ),
    'T1',
  );
  check(refusal(tools, 'f2', profile), undefined, 'T2 allowed');
});
