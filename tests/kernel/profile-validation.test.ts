import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { createProfileRegistry, defineProfile } from '../../src/kernel/registry/profiles.ts';
import { createToolRegistry } from '../../src/kernel/tools/mod.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';

registerGooglePreset();

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

type Loose = Record<string, unknown>;

const BINDING = {
  protocol: 'geminiInteractions',
  provider: 'google',
  apiId: 'gemini-3.5-flash-lite',
  persistViaInteractionId: false,
} as const;

const textProfile = (over: Loose = {}): Loose => ({
  id: 'p',
  type: 'text',
  identity: { handle: 'p' },
  models: { m: { ...BINDING } },
  maxSteps: 1,
  key: 'main',
  tools: { allow: [] },
  inputs: { text: true },
  ...over,
});

const modelWith = (over: Loose): Loose => ({ models: { m: { ...BINDING, ...over } } });

/** A local model, clearing the Gemini-only chaining field `BINDING` carries. */
const LOCAL = { protocol: 'openAi', provider: 'local', persistViaInteractionId: undefined };

const decisionProfile = (over: Loose = {}): Loose => ({
  id: 'd',
  type: 'decision',
  identity: { handle: 'd' },
  models: { m: { protocol: 'decision', provider: 'openrouter', apiId: 'x/y' } },
  key: 'main',
  inputs: { state: 'json' },
  decision: { contract: 'decide' },
  ...over,
});

const DECISION_BINDING = { protocol: 'decision', provider: 'openrouter', apiId: 'x/y' };

const decisionModel = (over: Loose): Loose => ({
  models: { m: { protocol: 'decision', provider: 'openrouter', apiId: 'x/y', ...over } },
});

/** What defining the profile says, or `defined` when it takes. */
function said(definition: Loose): string {
  try {
    defineProfile(definition as never);
    return 'defined';
  } catch (err) {
    if (!(err instanceof TheoremError)) throw err;
    return err.message;
  }
}

function saidAtRegistration(
  definition: Loose,
  setup?: (tools: ReturnType<typeof createToolRegistry>) => void,
) {
  const tools = createToolRegistry();
  setup?.(tools);
  const registry = createProfileRegistry(tools);
  try {
    registry.register(definition as never);
    return 'registered';
  } catch (err) {
    if (!(err instanceof TheoremError)) throw err;
    return err.message;
  }
}

function table(rows: [label: string, definition: Loose, message: string][]): void {
  for (const [label, definition, message] of rows) check(said(definition), message, label);
}

Deno.test('a valid text and decision profile define', () => {
  check(said(textProfile()), 'defined', 'text');
  check(said(decisionProfile()), 'defined', 'decision');
});

Deno.test('a definition must be an object with an id and a known type', () => {
  for (const bad of [null, undefined, 'p', 5, [], [{ id: 'p' }]]) {
    check(
      said(bad as never),
      'Profile definition must be an object',
      `not an object: ${JSON.stringify(bad)}`,
    );
  }
  for (const id of [undefined, '', '   ', 5, null]) {
    check(said(textProfile({ id })), 'Profile definition must set id', `id ${JSON.stringify(id)}`);
  }
  check(
    said(textProfile({ type: 'video' })),
    'Profile p: type must be one of text, image, speech, live, decision, host',
    'unknown type',
  );
  check(
    said(textProfile({ type: undefined })),
    'Profile p: type must be one of text, image, speech, live, decision, host',
    'no type',
  );
});

Deno.test('a model route names its protocol, provider and apiId, and the pair must be valid', () => {
  const at = "Profile p model 'm'";
  table([
    ['no protocol', textProfile(modelWith({ protocol: false })), `${at} must set protocol`],
    ['no provider', textProfile(modelWith({ provider: false })), `${at} must set provider`],
    ['no apiId', textProfile(modelWith({ apiId: 0 })), `${at} must set apiId`],
    ['empty apiId', textProfile(modelWith({ apiId: false })), `${at} must set apiId`],
    [
      'protocol and provider that do not pair',
      textProfile(modelWith({ protocol: 'geminiLive', provider: 'openrouter' })),
      `${at}: protocol 'geminiLive' is not valid for provider 'openrouter'`,
    ],
    [
      'a protocol the type cannot use',
      textProfile(
        modelWith({
          protocol: 'geminiLive',
          provider: 'google',
          persistViaInteractionId: undefined,
        }),
      ),
      `${at}: type 'text' cannot use protocol 'geminiLive'. Supported: geminiInteractions, openAi`,
    ],
  ]);
  check(
    said(textProfile(modelWith({ apiId: '   ' }))),
    'defined',
    'a blank apiId is only refused for decisions',
  );
});

Deno.test('a profile declares models, a default among them, and selection needs a choice', () => {
  table([
    ['no models', textProfile({ models: {} }), 'Profile p must declare at least one model'],
    [
      'two models, no default',
      textProfile({ models: { a: { ...BINDING }, b: { ...BINDING } } }),
      'Profile p must set defaultModel when more than one model is declared',
    ],
    [
      'a default that is not declared',
      textProfile({ defaultModel: 'z' }),
      "Profile p defaultModel 'z' is not declared",
    ],
    [
      'selection with one model',
      textProfile({ allowModelSelect: true }),
      'Profile p allowModelSelect requires at least two models',
    ],
  ]);
  check(
    said(
      textProfile({
        models: { a: { ...BINDING }, b: { ...BINDING } },
        defaultModel: 'a',
        allowModelSelect: true,
      }),
    ),
    'defined',
    'two models and a default',
  );
});

Deno.test('key slots are names, a non-local model has a key, and a fallback is a different slot', () => {
  const bad = 'has space';
  const rule = "is not a key slot name; use letters, digits, '-' and '_', up to 32 characters";
  table([
    ['profile key', textProfile({ key: bad }), `Profile p: key '${bad}' ${rule}`],
    [
      'profile fallbackKey',
      textProfile({ fallbackKey: bad }),
      `Profile p: fallbackKey '${bad}' ${rule}`,
    ],
    ['model key', textProfile(modelWith({ key: bad })), `Profile p: models.m.key '${bad}' ${rule}`],
    [
      'model fallbackKey',
      textProfile(modelWith({ fallbackKey: bad })),
      `Profile p: models.m.fallbackKey '${bad}' ${rule}`,
    ],
    [
      'no key anywhere',
      textProfile({ key: undefined }),
      "Profile p model 'm': a google model needs models.*.key or the profile key",
    ],
    [
      'fallback equals key',
      textProfile({ fallbackKey: 'main' }),
      "Profile p model 'm': fallbackKey 'main' is the same slot as its key",
    ],
    [
      'model fallback equals the profile key',
      textProfile(modelWith({ fallbackKey: 'main' })),
      "Profile p model 'm': fallbackKey 'main' is the same slot as its key",
    ],
  ]);
  check(said(textProfile({ fallbackKey: 'backup' })), 'defined', 'a different fallback');
  check(
    said(textProfile(modelWith({ key: 'own', fallbackKey: 'main' }))),
    'defined',
    'own key, profile key as fallback',
  );
});

Deno.test('efforts are thinking levels with a default among them', () => {
  const at = "Profile p model 'm'";
  table([
    [
      'default without efforts',
      textProfile(modelWith({ defaultEffort: 'a' })),
      `${at}: defaultEffort and allowEffortSelect require efforts`,
    ],
    [
      'select without efforts',
      textProfile(modelWith({ allowEffortSelect: true })),
      `${at}: defaultEffort and allowEffortSelect require efforts`,
    ],
    [
      'default with an empty map',
      textProfile(modelWith({ efforts: {}, defaultEffort: 'a' })),
      `${at}: defaultEffort and allowEffortSelect require efforts`,
    ],
    [
      'not a thinking level',
      textProfile(modelWith({ efforts: { a: 'huge' } })),
      `${at} effort 'a': 'huge' is not a thinking level (none, minimal, low, medium, high, xhigh, max)`,
    ],
    [
      'two efforts, no default',
      textProfile(modelWith({ efforts: { a: 'low', b: 'high' } })),
      `${at} must set defaultEffort when more than one effort is declared`,
    ],
    [
      'default not declared',
      textProfile(modelWith({ efforts: { a: 'low' }, defaultEffort: 'z' })),
      `${at} defaultEffort 'z' is not declared`,
    ],
    [
      'select with one effort',
      textProfile(modelWith({ efforts: { a: 'low' }, allowEffortSelect: true })),
      `${at} allowEffortSelect requires at least two efforts`,
    ],
  ]);
  check(
    said(textProfile(modelWith({ efforts: { a: 'low' } }))),
    'defined',
    'a lone effort is the default',
  );
  check(
    said(
      textProfile(
        modelWith({
          efforts: { a: 'low', b: 'high' },
          defaultEffort: 'a',
          allowEffortSelect: true,
        }),
      ),
    ),
    'defined',
    'a choice of two',
  );
});

Deno.test('cache, persistence and server fields are only valid on the bindings they belong to', () => {
  const at = "Profile p model 'm'";
  const openRouter = {
    protocol: 'openAi',
    provider: 'openrouter',
    apiId: 'x/y',
    persistViaInteractionId: undefined,
  };
  table([
    [
      'cache on gemini',
      textProfile(modelWith({ cache: { mode: 'automatic' } })),
      `${at}: cache is only valid when protocol is 'openAi' and provider is 'openrouter'`,
    ],
    [
      'bad cache mode',
      textProfile(modelWith({ ...openRouter, cache: { mode: 'x' } })),
      `${at}: cache.mode must be one of automatic | system`,
    ],
    [
      'bad cache ttl',
      textProfile(modelWith({ ...openRouter, cache: { mode: 'system', ttl: '2h' } })),
      `${at}: cache.ttl must be one of 5m | 1h`,
    ],
    [
      'chaining left unset on gemini',
      textProfile(modelWith({ persistViaInteractionId: undefined })),
      `${at}: persistViaInteractionId is required on a 'geminiInteractions' binding — true chains on Google's stored interaction, false sends the host's history plus this turn's steps every call`,
    ],
    [
      'chaining with storage off',
      textProfile(modelWith({ persistViaInteractionId: true, store: false })),
      `${at}: persistViaInteractionId: true needs store left on — Google chains only from a stored interaction`,
    ],
    [
      'store on openrouter',
      textProfile(modelWith({ ...openRouter, store: true })),
      `${at}: store is only valid when protocol is 'geminiInteractions' and provider is 'google'`,
    ],
    [
      'persist on openrouter',
      textProfile(modelWith({ ...openRouter, persistViaInteractionId: true })),
      `${at}: persistViaInteractionId is only valid when protocol is 'geminiInteractions' and provider is 'google'`,
    ],
    [
      'both on openrouter',
      textProfile(modelWith({ ...openRouter, store: true, persistViaInteractionId: true })),
      `${at}: store and persistViaInteractionId is only valid when protocol is 'geminiInteractions' and provider is 'google'`,
    ],
    [
      'server on google',
      textProfile(modelWith({ server: 'http://x' })),
      `${at}: server is only valid when provider is 'local'`,
    ],
  ]);
  check(
    said(textProfile(modelWith({ ...openRouter, cache: { mode: 'system', ttl: '1h' } }))),
    'defined',
    'valid cache',
  );
  check(
    said(textProfile(modelWith({ ...openRouter, cache: { mode: 'automatic' } }))),
    'defined',
    'cache without ttl',
  );
  check(said(textProfile(modelWith({ store: true }))), 'defined', 'store on interactions');
  for (const server of ['', '   ', 5]) {
    check(
      said(textProfile(modelWith({ ...LOCAL, server, key: undefined }))),
      `${at}: server must be a non-empty string`,
      `server ${JSON.stringify(server)}`,
    );
  }
  check(
    said(
      textProfile({
        key: undefined,
        ...modelWith({ ...LOCAL, server: 'http://x' }),
      }),
    ),
    'defined',
    'a local server needs no key',
  );
});

Deno.test('resumption lists name only continue stop kinds', () => {
  const resumption = (over: Loose) => textProfile({ turnBehaviour: { resumption: over } });
  for (const path of ['allowContinue', 'autoContinue']) {
    check(
      said(resumption({ [path]: ['length', 'nope'] })),
      `Profile p: turnBehaviour.resumption.${path} may only include ContinueStopKind (length | stream_incomplete | provider_error); got 'nope'`,
      path,
    );
    check(
      said(resumption({ [path]: ['length', 'stream_incomplete', 'provider_error'] })),
      'defined',
      `${path} ok`,
    );
    check(said(resumption({ [path]: [] })), 'defined', `${path} empty`);
  }
  check(said(textProfile({ turnBehaviour: {} })), 'defined', 'no resumption');
});

Deno.test('egress counts are non-negative integers', () => {
  const enforce = () => ({ action: 'allow' as const });
  for (const key of ['maxRetries', 'holdback']) {
    const message = `Profile p: guardrails.egress.${key} must be a non-negative integer`;
    for (const bad of [-1, 1.5, Number.NaN]) {
      check(
        said(textProfile({ guardrails: { egress: { enforce, [key]: bad } } })),
        message,
        `${key} ${bad}`,
      );
    }
    for (const ok of [0, 1, 7]) {
      check(
        said(textProfile({ guardrails: { egress: { enforce, [key]: ok } } })),
        'defined',
        `${key} ${ok}`,
      );
    }
  }
});

Deno.test('observability must resolve to a finite retention and a positive rotation size', () => {
  const at = 'Profile p: observability';
  check(
    said(textProfile({ observability: { retainForDays: Number.POSITIVE_INFINITY } })),
    `${at}.retainForDays must be a finite number`,
    'infinite retention',
  );
  for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    check(
      said(textProfile({ observability: { rotateAfterMiB: bad } })),
      `${at}.rotateAfterMiB must be a positive number`,
      `rotate ${bad}`,
    );
  }
  check(said(textProfile({ observability: { rotateAfterMiB: 1 } })), 'defined', 'rotate 1');
  check(said(textProfile({ observability: { sampleRate: 0.5 } })), 'defined', 'sample');
  check(
    said(textProfile({ observability: { sampleRate: 5 } })).startsWith('Profile p: '),
    true,
    'a policy error is prefixed with the profile',
  );
});

Deno.test('a host profile sets tools.allow, and a decision profile is one model with a state and a contract', () => {
  const host = (over: Loose = {}) => ({ id: 'h', type: 'host', tools: { allow: [] }, ...over });
  check(said(host()), 'defined', 'host');
  check(said(host({ tools: {} })), "Profile h: type 'host' must set tools.allow", 'no allow');
  check(
    said(host({ tools: { allow: 'x' } })),
    "Profile h: type 'host' must set tools.allow",
    'allow not a list',
  );
  check(
    said(host({ observability: { rotateAfterMiB: 0 } })),
    'Profile h: observability.rotateAfterMiB must be a positive number',
    'host observability',
  );

  const at = "Profile d model 'm'";
  table([
    [
      'decision no models',
      decisionProfile({ models: {} }),
      "Profile d: type 'decision' must declare exactly one model",
    ],
    [
      'decision two models',
      decisionProfile({ models: { a: DECISION_BINDING, b: DECISION_BINDING } }),
      "Profile d: type 'decision' must declare exactly one model",
    ],
    [
      'decision no protocol',
      decisionProfile(decisionModel({ protocol: false })),
      `${at} must set protocol`,
    ],
    [
      'decision no provider',
      decisionProfile(decisionModel({ provider: false })),
      `${at} must set provider`,
    ],
    ['decision no apiId', decisionProfile(decisionModel({ apiId: false })), `${at} must set apiId`],
    [
      'decision blank apiId',
      decisionProfile(decisionModel({ apiId: '  ' })),
      `${at} must set apiId`,
    ],
    [
      'decision wrong protocol',
      decisionProfile(decisionModel({ protocol: 'openAi' })),
      `${at}: type 'decision' cannot use protocol 'openAi'. Supported: decision`,
    ],
    [
      'decision retry',
      decisionProfile(decisionModel({ retry: { maxAttempts: 2 } })),
      `${at}: decision retry configuration is unsupported; POSTs are never retried`,
    ],
    [
      'decision timeout 0',
      decisionProfile(decisionModel({ timeoutMs: 0 })),
      `${at} timeoutMs must be > 0`,
    ],
    [
      'decision timeout negative',
      decisionProfile(decisionModel({ timeoutMs: -5 })),
      `${at} timeoutMs must be > 0`,
    ],
    [
      'decision timeout NaN',
      decisionProfile(decisionModel({ timeoutMs: Number.NaN })),
      `${at} timeoutMs must be > 0`,
    ],
    [
      'decision timeout infinite',
      decisionProfile(decisionModel({ timeoutMs: Number.POSITIVE_INFINITY })),
      `${at} timeoutMs must be > 0`,
    ],
    [
      'decision state not json',
      decisionProfile({ inputs: { state: 'text' } }),
      "Profile d: decision inputs.state must be 'json'",
    ],
    [
      'decision cap zero',
      decisionProfile({ inputs: { state: 'json', maxStateBytes: 0 } }),
      'Profile d: decision inputs.maxStateBytes must be a positive integer',
    ],
    [
      'decision cap fractional',
      decisionProfile({ inputs: { state: 'json', maxStateBytes: 1.5 } }),
      'Profile d: decision inputs.maxStateBytes must be a positive integer',
    ],
    [
      'decision blank contract',
      decisionProfile({ decision: { contract: '  ' } }),
      'Profile d: decision.contract must be non-empty',
    ],
    [
      'decision key name',
      decisionProfile({ key: 'a b' }),
      "Profile d: key 'a b' is not a key slot name; use letters, digits, '-' and '_', up to 32 characters",
    ],
    [
      'decision model key name',
      decisionProfile(decisionModel({ key: 'a b' })),
      "Profile d: models.m.key 'a b' is not a key slot name; use letters, digits, '-' and '_', up to 32 characters",
    ],
    [
      'decision no key',
      decisionProfile({ key: undefined }),
      `${at}: a decision model needs models.*.key or the profile key`,
    ],
    [
      'decision observability',
      decisionProfile({ observability: { rotateAfterMiB: 0 } }),
      'Profile d: observability.rotateAfterMiB must be a positive number',
    ],
  ]);
  check(
    said(decisionProfile({ key: undefined, ...decisionModel({ key: 'own' }) })),
    'defined',
    'a model key suffices',
  );
  check(said(decisionProfile(decisionModel({ timeoutMs: 1000 }))), 'defined', 'a positive timeout');
  check(
    said(decisionProfile({ inputs: { state: 'json', maxStateBytes: 1 } })),
    'defined',
    'a positive cap',
  );
});

Deno.test('a field the type does not take, or a required one it omits, is named', () => {
  const missing = said(textProfile({ tools: undefined }));
  check(missing.startsWith("Profile p: type 'text' must set "), true, 'a required field');
  const out = said(textProfile({ live: { x: 1 } }));
  check(out.startsWith("Profile p: type 'text' must not set live"), true, 'out of scope');
});

Deno.test('registration checks a profile against the tools and the profiles already there', () => {
  const builtin = {
    type: 'builtin',
    name: 'web',
    description: 'd',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    wire: { live: 'web', geminiInteractions: 'web' },
  };
  const fn = {
    type: 'function',
    name: 'lookup',
    description: 'd',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({}),
    output: z.object({}),
    handler: () => ({}),
  };
  const setup = (tools: ReturnType<typeof createToolRegistry>) => {
    tools.register(builtin as never);
    tools.register(fn as never);
  };
  const reg = (definition: Loose) => saidAtRegistration(definition, setup);

  check(
    reg(textProfile({ tools: { allow: ['lookup'] } })),
    'registered',
    'a function tool is allowed',
  );
  check(
    reg(textProfile({ tools: { allow: ['web'] } })),
    "Profile p lists builtin 'web' in tools.allow — declare it on models.*.builtInTools instead",
    'builtin in allow',
  );
  check(
    reg({ id: 'h', type: 'host', tools: { allow: ['web'] } }),
    "Profile h lists builtin 'web' in tools.allow — type 'host' never runs a model",
    'builtin in a host allow',
  );
  check(
    reg(textProfile(modelWith({ builtInTools: ['web'] }))),
    'registered',
    'a builtin on the model',
  );
  check(
    reg(textProfile(modelWith({ builtInTools: ['lookup'] }))),
    "Profile p model 'm' lists 'lookup' in builtInTools — not a registered builtin",
    'a function as a builtin',
  );
  check(
    reg(textProfile(modelWith({ builtInTools: ['ghost'] }))),
    "Profile p model 'm' lists 'ghost' in builtInTools — not a registered builtin",
    'an unregistered builtin',
  );
  check(
    reg(textProfile({ tools: { allow: ['lookup'], t2Loader: 'lookup' } })),
    'registered',
    'a loader that is allowed and a function',
  );
  check(
    reg(textProfile({ tools: { allow: [], t2Loader: 'lookup' } })),
    "Profile p tools.t2Loader 'lookup' must also be listed in tools.allow",
    'a loader not allowed',
  );
  check(
    reg(textProfile({ tools: { allow: ['gone'], t2Loader: 'gone' } })),
    "Profile p tools.t2Loader 'gone' must be a registered type: 'function' tool",
    'a loader not registered',
  );

  const limits = (over: Loose) => textProfile({ inputs: { text: true, ...over } });
  check(
    reg(limits({ attachments: { accept: ['image/png'] } })),
    'Profile p must set maxFiles, maxBytes, and maxTurnBytes',
    'attachments without limits',
  );
  check(
    reg(limits({ voice: { accept: ['audio/wav'] }, maxFiles: 1, maxBytes: 1 })),
    'Profile p must set maxFiles, maxBytes, and maxTurnBytes',
    'voice with some limits',
  );
  check(
    reg(
      limits({ attachments: { accept: ['image/png'] }, maxFiles: 1, maxBytes: 1, maxTurnBytes: 1 }),
    ),
    'registered',
    'all three limits',
  );
  for (const name of ['maxFiles', 'maxBytes', 'maxTurnBytes']) {
    for (const bad of [0, -1, 1.5]) {
      check(
        reg(limits({ [name]: bad })),
        `Profile p: inputs.${name} must be a positive integer`,
        `${name} ${bad}`,
      );
    }
  }
  check(
    reg(limits({ limitsByMime: { 'image/png': 0 } })),
    "Profile p: inputs.limitsByMime['image/png'] must be a positive integer",
    'a per-mime limit',
  );
  check(reg(limits({ limitsByMime: { 'image/png': 5 } })), 'registered', 'a valid per-mime limit');
});

Deno.test('compaction names a registered text profile and keeps its numbers in range', () => {
  const compactor = textProfile({ id: 'summariser' });
  const compaction = (over: Loose) =>
    textProfile(
      modelWith({
        compaction: {
          profile: 'summariser',
          maxTokens: 100,
          compactAt: 0.5,
          previousExchanges: 2,
          timing: 'before',
          ...over,
        },
      }),
    );
  const run = (definition: Loose, others: Loose[] = [compactor]) => {
    const registry = createProfileRegistry(createToolRegistry());
    try {
      for (const other of others) registry.register(other as never);
      registry.register(definition as never);
      return 'registered';
    } catch (err) {
      if (!(err instanceof TheoremError)) throw err;
      return err.message;
    }
  };
  const at = 'Profile p model m compaction';
  check(run(compaction({})), 'registered', 'valid');
  check(run(compaction({ meter: 'history' })), 'registered', 'meter history');
  check(run(compaction({ meter: 'input' })), 'registered', 'meter input');
  check(run(compaction({ meter: null })), 'registered', 'meter null');
  check(run(compaction({ meter: 'tokens' })), `${at}: meter must be 'history' or 'input'`, 'meter');
  check(run(compaction({ maxTokens: 0 })), `${at}: maxTokens must be > 0`, 'maxTokens 0');
  check(run(compaction({ maxTokens: 1 })), 'registered', 'maxTokens 1');
  for (const bad of [0, 1, -0.5, 1.5]) {
    check(
      run(compaction({ compactAt: bad })),
      `${at}: compactAt must be in (0, 1)`,
      `compactAt ${bad}`,
    );
  }
  check(
    run(compaction({ previousExchanges: -1 })),
    `${at}: previousExchanges must be >= 0`,
    'negative',
  );
  check(run(compaction({ previousExchanges: 0 })), 'registered', 'zero exchanges');
  check(
    run(compaction({ previousExchanges: 0.5, compactAt: 0.5 })),
    `${at}: previousExchanges as fraction (0.5) must be < compactAt (0.5)`,
    'fraction at compactAt',
  );
  check(
    run(compaction({ previousExchanges: 0.25, compactAt: 0.5 })),
    'registered',
    'fraction below compactAt',
  );
  check(
    run(compaction({ previousExchanges: 1.5 })),
    `${at}: previousExchanges >= 1 must be an integer`,
    'fraction above one',
  );
  check(run(compaction({ previousExchanges: 1 })), 'registered', 'exactly one');
  check(
    run(compaction({}), []),
    `${at}: compaction profile 'summariser' must be registered before 'p'`,
    'unregistered compactor',
  );
  check(
    run(compaction({}), [textProfile({ id: 'summariser', inputs: { text: false, slots: {} } })]),
    `${at}: compaction profile 'summariser' must be a text profile that takes text`,
    'compactor that takes no text',
  );
});

Deno.test('a structured output maps only the choices of an existing slot', () => {
  const structured = (by: string, map: Loose) =>
    textProfile({
      inputs: { text: true, slots: { mood: ['happy', 'sad'] } },
      outputs: { structured: { by, map } },
    });
  check(said(structured('mood', { happy: {} })), 'defined', 'valid');
  check(
    said(structured('tone', { happy: {} })),
    "Profile p: outputs.structured.by 'tone' is not a slot in inputs.slots",
    'unknown slot',
  );
  check(
    said(structured('mood', { happy: {}, angry: {}, bored: {} })),
    "Profile p: outputs.structured.map maps angry, bored, not a choice of slot 'mood'",
    'unknown choices',
  );
  check(
    said(textProfile({ outputs: { structured: { by: 'mood', map: {} } } })).startsWith(
      'Profile p: outputs.structured.by',
    ),
    true,
    'no slots at all',
  );
});
