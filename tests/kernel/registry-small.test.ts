import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { detectAt } from '../../src/guardrails/detect-at.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  clampThinkingLevelForApiId,
  mediaChannelForMime,
  mimeAllowed,
  requireModelBinding,
} from '../../src/kernel/registry/catalog.ts';
import { profileTurnOutputs } from '../../src/kernel/registry/profile-outputs.ts';
import {
  providerBuiltins,
  providerCompleteRequest,
} from '../../src/kernel/registry/provider-request.ts';
import { createSchemaRegistry } from '../../src/kernel/registry/schemas.ts';
import { resolveTurnSystemPrompt } from '../../src/kernel/registry/system-prompt.ts';
import { pickSystemRole } from '../../src/kernel/registry/system-role.ts';
import { systemText } from '../../src/kernel/system-parts.ts';

/** The kind and message a call throws as a TheoremError, or 'returned'. */
function thrown(body: () => unknown): string {
  try {
    body();
  } catch (err) {
    return err instanceof TheoremError ? `${err.kind}: ${err.message}` : String(err);
  }
  return 'returned';
}

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

Deno.test('only a turn-shaped profile has turn outputs; live, host and decision have none even when given some', () => {
  const outputs = { structured: null };
  for (const type of ['live', 'host', 'decision']) {
    check(profileTurnOutputs({ type, outputs } as never), undefined, type);
  }
  for (const type of ['text', 'image', 'speech']) {
    check(profileTurnOutputs({ type, outputs } as never), outputs, type);
  }
});

Deno.test('a builtin that is not registered, or is registered as something else, is a config error naming it', () => {
  const tools = (found: unknown) => ({ get: () => found }) as never;
  for (const found of [undefined, { type: 'function' }]) {
    check(
      thrown(() => providerBuiltins(tools(found), ['codeExecution' as never])),
      "config: Builtin 'codeExecution' is not registered",
      'unregistered',
    );
  }
  check(
    providerBuiltins(tools({ type: 'builtin', wire: { w: 1 } }), ['a' as never, 'b' as never]),
    [
      { id: 'a', wire: { w: 1 } },
      { id: 'b', wire: { w: 1 } },
    ],
    'registered builtins carry their wire',
  );
});

Deno.test('interactions-only request fields are sent on the interactions transport and dropped elsewhere', () => {
  const generation = {
    model: 'm',
    apiId: 'a',
    transport: 'interactions',
    previousInteractionId: 'prev',
    store: true,
    googleMapsLocation: { latitude: 1, longitude: 2 },
    continuation: { c: 1 },
    builtins: [],
    tools: { wire: [{ name: 't' }] },
    stream: true,
    thinking: 'low',
    summaries: 'auto',
    maxOutputTokens: 9,
    temperature: 0.5,
    cache: 'c',
    sessionId: 's',
    input: 'in',
    history: ['h'],
    structured: 'st',
    image: 'im',
    speech: 'sp',
    live: 'lv',
    sessionResumptionHandle: 'rh',
    keySlot: 'k',
    fallbackKeySlot: 'fk',
  };
  const tools = { get: () => undefined } as never;
  const request = (over: object) =>
    providerCompleteRequest(tools, { ...generation, ...over } as never, 'sys');
  check(
    request({}),
    {
      model: 'm',
      apiId: 'a',
      previousInteractionId: 'prev',
      store: true,
      stream: true,
      thinking: 'low',
      summaries: 'auto',
      maxOutputTokens: 9,
      temperature: 0.5,
      builtins: [],
      googleMapsLocation: { latitude: 1, longitude: 2 },
      cache: 'c',
      sessionId: 's',
      system: 'sys',
      input: 'in',
      history: ['h'],
      continuation: { c: 1 },
      wireTools: [{ name: 't' }],
      structured: 'st',
      image: 'im',
      speech: 'sp',
      live: 'lv',
      sessionResumptionHandle: 'rh',
      keySlot: 'k',
      fallbackKeySlot: 'fk',
    },
    'interactions',
  );
  const other = request({ transport: 'generateContent' }) as unknown as Record<string, unknown>;
  for (const field of ['previousInteractionId', 'store', 'googleMapsLocation', 'continuation']) {
    check(other[field], undefined, `${field} off the interactions transport`);
  }
  check(other.model, 'm', 'the rest still goes');
});

Deno.test('a structured schema is registered once by id, refuses enforced and non-objects, and an unknown id says so', () => {
  const registry = createSchemaRegistry();
  const spec = { jsonSchema: { type: 'object' } } as never;
  registry.register('one', spec);
  check(registry.get('one'), spec, 'round trip');
  const refused = (id: string, bad: unknown, text: string) => {
    check(
      thrown(() => registry.register(id, bad as never)),
      `config: ${text}`,
      id,
    );
  };
  refused(
    'e',
    { jsonSchema: {}, enforced: true },
    "registerStructured 'e': enforced was removed; every structured schema is sent to the model as its response format",
  );
  for (const bad of [{}, { jsonSchema: 'x' }, { jsonSchema: [] }, { jsonSchema: null }]) {
    refused('j', bad, "registerStructured 'j': jsonSchema must be a JSON Schema object");
  }
  check(
    thrown(() => registry.get('nope')),
    "config: Unknown structured schema 'nope'",
    'unknown',
  );
});

const base = { type: 'text', guardrails: {}, identity: { handle: 'h' } };

Deno.test('a system role picks its own prompt, falls back to the profile prompt, and a speech profile has none', () => {
  const profile = (identity: object, type = 'text') => ({ ...base, type, identity }) as never;
  const roled = { handle: 'h', system: 'base', systemByRole: { editor: 'edit', empty: '' } };
  check(
    systemText(resolveTurnSystemPrompt(profile(roled), { input: { role: 'editor' } } as never)),
    'edit',
    'role',
  );
  check(
    systemText(resolveTurnSystemPrompt(profile(roled), { input: { role: 'empty' } } as never)),
    'base',
    'empty role falls back',
  );
  check(
    systemText(resolveTurnSystemPrompt(profile(roled), { input: { role: 'other' } } as never)),
    'base',
    'unknown role',
  );
  check(
    systemText(resolveTurnSystemPrompt(profile(roled), {} as never)),
    'base',
    'no input at all',
  );
  check(
    systemText(resolveTurnSystemPrompt(profile({ handle: 'h' }), {} as never)),
    '',
    'no prompt',
  );
  check(
    systemText(resolveTurnSystemPrompt(profile({ handle: 'h' }), { system: 'turn' } as never)),
    'turn',
    'turn system alone',
  );
  check(
    systemText(resolveTurnSystemPrompt(profile(roled), { system: 'turn' } as never)),
    'base\n\nturn',
    'joined',
  );
  check(
    systemText(
      resolveTurnSystemPrompt(profile({ handle: 'h', system: 'spoken' }, 'speech'), {} as never),
    ),
    '',
    'speech has no system prompt',
  );
});

Deno.test("the profile prompt is the host's own text, so the profile guardrails do not redact it", () => {
  const probe = `mail ops@example.com, key ${TEST_OPENAI_KEY}`;
  const guardrails = {};
  const policy = resolveGuardrailPolicy(guardrails as never);
  check(
    detectAt(probe, 'user', policy.detect).text !== probe,
    true,
    'the probe is changed by the profile policy',
  );
  const profile = { ...base, guardrails, identity: { handle: 'h', system: probe } } as never;
  check(
    systemText(resolveTurnSystemPrompt(profile, {} as never)),
    probe,
    'trusted text is kept whole',
  );
});

Deno.test('a role is taken only when the profile declares it as its own property', () => {
  const profile = (identity: object, type = 'text') => ({ ...base, type, identity }) as never;
  const roled = { handle: 'h', systemByRole: { editor: 'e', undefined: 'x', toString: 'y' } };
  check(pickSystemRole(profile(roled), 'editor'), 'editor', 'declared');
  check(pickSystemRole(profile(roled), undefined), 'h', 'none asked');
  check(pickSystemRole(profile(roled), ''), 'h', 'empty asked');
  check(pickSystemRole(profile(roled), 'constructor'), 'h', 'inherited name');
  check(pickSystemRole(profile({ handle: 'h' }), 'editor'), 'h', 'profile without roles');
  check(
    pickSystemRole(profile({ handle: 'h', systemByRole: { editor: 'e' } }, 'speech'), 'editor'),
    'h',
    'speech has no roles',
  );
});

Deno.test('an exact MIME rule matches only that type; a subtype wildcard matches the whole family', () => {
  check(mimeAllowed(['image/png'], 'image/png; charset=x'), true, 'exact, parameters ignored');
  check(mimeAllowed(['image/png'], 'image/pnx'), false, 'a longer sibling is not the rule');
  check(mimeAllowed(['image/png'], 'image/pn'), false, 'a shorter one either');
  check(mimeAllowed(['image/*'], 'image/anything'), true, 'wildcard');
  check(mimeAllowed(['image/*'], 'imagex/png'), false, 'wildcard keeps its slash');
  check(mimeAllowed(['image/*'], 'audio/wav'), false, 'another family');
  check(mimeAllowed([], 'image/png'), false, 'no rules');
});

Deno.test('a file is routed to the channel that accepts it, and nowhere when the kernel cannot classify it', () => {
  const profile = (inputs: object) => ({ type: 'text', id: 'p', inputs }) as never;
  const both = profile({
    attachments: { accept: ['image/png'] },
    voice: { accept: ['audio/wav'] },
  });
  check(mediaChannelForMime(both, 'image/png'), 'attachments', 'attachment');
  check(mediaChannelForMime(both, 'audio/wav'), 'voice', 'voice');
  check(mediaChannelForMime(both, 'image/gif'), undefined, 'accepted nowhere');
  const wildcard = profile({ attachments: { accept: ['application/*'] } });
  check(mediaChannelForMime(wildcard, 'application/x-foo'), undefined, 'unclassifiable');
  check(mediaChannelForMime(wildcard, 'application/pdf'), 'attachments', 'classifiable');
  check(mediaChannelForMime({ type: 'live', id: 'l' } as never, 'image/png'), undefined, 'live');
});

Deno.test('a missing model binding is a config error naming the profile and model', () => {
  const profile = { id: 'p', models: { m: { apiId: 'a' } } } as never;
  check(requireModelBinding(profile, 'm'), { apiId: 'a' }, 'present');
  check(
    thrown(() => requireModelBinding(profile, 'x')),
    "config: Profile p has no model binding for 'x'",
    'absent',
  );
});

Deno.test('a thinking level is kept when no model, or no effort ladder, bounds it', () => {
  check(clampThinkingLevelForApiId({}, 'nope', 'high' as never), 'high', 'unknown model');
  check(
    clampThinkingLevelForApiId({ m: { apiId: 'a' } as never }, 'a', 'high' as never),
    'high',
    'no ladder',
  );
});
