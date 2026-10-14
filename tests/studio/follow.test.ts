import { assertEquals } from '@std/assert';
import { sourceOrigins } from '../../studio/server/origins.ts';
import { readProjectSource } from '../../studio/server/project-source.ts';
import { applyEdits, planSave, type SaveSubject } from '../../studio/server/save-plan.ts';

const ROOT = '/project';

/** A project held in memory: its files by path under `/project`. */
function project(files: Record<string, string>) {
  const held = new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text]));
  return readProjectSource(`${ROOT}/setup.ts`, ROOT, (path) => held.get(path));
}

/** The plan for `subjects`, each change as `of setting: status`, and each file as Save would leave it. */
function saved(files: Record<string, string>, subjects: SaveSubject[]) {
  const plan = planSave(project(files), subjects);
  const text = Object.fromEntries(
    Object.entries(files).map(([path, held]) => [
      path,
      applyEdits(
        held,
        plan.edits.filter((edit) => edit.file === `${ROOT}/${path}`),
      ),
    ]),
  );
  return {
    changes: plan.changes.map((change) => `${change.of} ${change.setting}: ${change.status}`),
    text,
    plan,
  };
}

const MODELS = `import { defineProvider } from '@theoremjs/agents';
export const google = defineProvider({ id: 'google' });
export const BASE = { summaries: true, maxOutputTokens: 100 };
const SLOT = 'fast';
export function lite(effort: string) {
  return google.model('flash-lite', { efforts: { normal: effort }, maxOutputTokens: 8192 });
}
export const MODELS = { [SLOT]: google.model('flash', { ...BASE, keySlot: 'free' }) };
`;

const HELPED = `import { defineProfile } from '@theoremjs/agents';
import { lite, MODELS } from './models.ts';
export const desk = defineProfile({ type: 'text', id: 'desk', models: { free: lite('low'), ...MODELS } });
export const shop = defineProfile({ type: 'text', id: 'shop', models: { free: lite('high') } });
`;

const binding = (effort: string, maxOutputTokens = 8192) => ({
  provider: 'google',
  apiId: 'flash-lite',
  efforts: { normal: effort },
  maxOutputTokens,
});
const fast = {
  provider: 'google',
  apiId: 'flash',
  summaries: true,
  maxOutputTokens: 100,
  keySlot: 'free',
};
const desk = (free: unknown, held: unknown = fast) => ({
  type: 'text',
  id: 'desk',
  models: { free, fast: held },
});
const shop = (free: unknown) => ({ type: 'text', id: 'shop', models: { free } });

Deno.test('a model a helper function builds is read where the function writes it', () => {
  const files = { 'setup.ts': HELPED, 'models.ts': MODELS };
  const { profiles, sites } = sourceOrigins(project(files));
  // Nothing is code's alone: a model's provider is the name its line is built on, and that is written.
  assertEquals(profiles.desk ?? [], []);
  const at = (name: string) =>
    sites?.profiles[name]?.map(
      (site) => `${site.path.join('.')} ${String(site.shared)} ${site.name ?? ''}`,
    );
  // What the function returns is one value for both. The argument each gives it is its own.
  assertEquals(at('shop'), ['models.free true lite', 'models.free.efforts.normal false ']);
  assertEquals(at('desk')?.slice(0, 2), [
    'models.free true lite',
    'models.free.efforts.normal false ',
  ]);
  const [mine, theirs] = [sites?.profiles.desk?.[0], sites?.profiles.shop?.[0]];
  assertEquals(mine?.site, theirs?.site);
});

Deno.test('an argument is changed at the call, and what the function returns only when each caller changes it', () => {
  const files = { 'setup.ts': HELPED, 'models.ts': MODELS };
  const own = saved(files, [
    { kind: 'profile', of: 'desk', before: desk(binding('low')), after: desk(binding('medium')) },
  ]);
  assertEquals(own.changes, ['desk models.free.efforts.normal: written']);
  assertEquals(own.text['setup.ts'], HELPED.replace("lite('low')", "lite('medium')"));
  assertEquals(own.text['models.ts'], MODELS);

  const alone = saved(files, [
    {
      kind: 'profile',
      of: 'desk',
      before: desk(binding('low')),
      after: desk(binding('low', 4096)),
    },
  ]);
  assertEquals(alone.changes, ['desk models.free: constant']);
  assertEquals(alone.plan.changes[0]?.sharedWith, ['shop']);
  assertEquals(alone.plan.edits, []);

  const both = saved(files, [
    {
      kind: 'profile',
      of: 'desk',
      before: desk(binding('low')),
      after: desk(binding('low', 4096)),
    },
    {
      kind: 'profile',
      of: 'shop',
      before: shop(binding('high')),
      after: shop(binding('high', 4096)),
    },
  ]);
  assertEquals(both.changes, [
    'desk models.free.maxOutputTokens: written',
    'shop models.free.maxOutputTokens: written',
  ]);
  assertEquals(both.text['models.ts'], MODELS.replace('8192', '4096'));
  assertEquals(both.text['setup.ts'], HELPED);
});

Deno.test('a model call, a computed key and a spread constant are each written where they are set', () => {
  const files = { 'setup.ts': HELPED, 'models.ts': MODELS };
  const after = {
    ...fast,
    apiId: 'flash-2',
    maxOutputTokens: 200,
    keySlot: 'paid',
    temperature: 0,
  };
  const { changes, text } = saved(files, [
    {
      kind: 'profile',
      of: 'desk',
      before: desk(binding('low')),
      after: desk(binding('low'), after),
    },
  ]);
  assertEquals(changes.sort(), [
    'desk models.fast.apiId: written',
    'desk models.fast.keySlot: written',
    'desk models.fast.maxOutputTokens: written',
    'desk models.fast.temperature: written',
  ]);
  assertEquals(
    text['models.ts'],
    MODELS.replace('maxOutputTokens: 100', 'maxOutputTokens: 200').replace(
      "google.model('flash', { ...BASE, keySlot: 'free' })",
      "google.model('flash-2', { ...BASE, keySlot: 'paid', temperature: 0 })",
    ),
  );
  const refused = saved(files, [
    {
      kind: 'profile',
      of: 'desk',
      before: desk(binding('low')),
      after: desk(binding('low'), { ...fast, provider: 'openAi' }),
    },
  ]);
  // No provider of the project is defined as that.
  assertEquals(refused.changes, ['desk models.fast.provider: code']);
  assertEquals(refused.plan.edits, []);
});

const ROUTED = MODELS.replace(
  'export const BASE',
  "export const router = defineProvider({ id: 'openrouter' });\nconst hidden = defineProvider({ id: 'hidden' });\nexport const BASE",
);
const INLINE = `import { defineProfile, defineProvider, registerProvider } from '@theoremjs/agents';
import { google, lite } from './models.ts';
registerProvider(defineProvider({ id: 'unnamed' }));
export const desk = defineProfile({ type: 'text', id: 'desk', models: { free: lite('low'), fast: google.model('flash') } });
export const shop = defineProfile({ type: 'text', id: 'shop', models: { free: lite('high') } });
`;
const plainFast = { provider: 'google', apiId: 'flash' };

Deno.test('a changed provider rewrites the name the model is built on, and never the provider it names', () => {
  const files = { 'setup.ts': HELPED, 'models.ts': ROUTED };
  const { changes, text } = saved(files, [
    {
      kind: 'profile',
      of: 'desk',
      before: desk(binding('low')),
      after: desk(binding('low'), { ...fast, provider: 'openrouter' }),
    },
  ]);
  assertEquals(changes, ['desk models.fast.provider: written']);
  assertEquals(text['models.ts'], ROUTED.replace("google.model('flash',", "router.model('flash',"));
});

Deno.test('a provider another file defines is imported where the model is written', () => {
  const files = { 'setup.ts': INLINE, 'models.ts': ROUTED };
  const to = (provider: string) =>
    saved(files, [
      {
        kind: 'profile',
        of: 'desk',
        before: desk(binding('low'), plainFast),
        after: desk(binding('low'), { ...plainFast, provider }),
      },
    ]);
  const swapped = to('openrouter');
  assertEquals(swapped.changes, ['desk models.fast.provider: written']);
  assertEquals(
    swapped.text['setup.ts'],
    INLINE.replace('{ google, lite }', '{ google, lite, router }').replace(
      "google.model('flash')",
      "router.model('flash')",
    ),
  );
  assertEquals(swapped.text['models.ts'], ROUTED);
  // One the project gives no name, and one its file keeps to itself, are code's to change.
  for (const provider of ['unnamed', 'hidden']) {
    const refused = to(provider);
    assertEquals(refused.changes, ['desk models.fast.provider: code']);
    assertEquals(refused.plan.edits, []);
  }
});

Deno.test('the provider of a model a function builds changes only when each agent it builds for changes it', () => {
  const files = { 'setup.ts': HELPED, 'models.ts': ROUTED };
  const routed = (effort: string) => ({ ...binding(effort), provider: 'openrouter' });
  const alone = saved(files, [
    { kind: 'profile', of: 'desk', before: desk(binding('low')), after: desk(routed('low')) },
  ]);
  assertEquals(alone.changes, ['desk models.free: constant']);
  assertEquals(alone.plan.edits, []);
  const both = saved(files, [
    { kind: 'profile', of: 'desk', before: desk(binding('low')), after: desk(routed('low')) },
    { kind: 'profile', of: 'shop', before: shop(binding('high')), after: shop(routed('high')) },
  ]);
  assertEquals(both.changes.sort(), [
    'desk models.free.provider: written',
    'shop models.free.provider: written',
  ]);
  assertEquals(
    both.text['models.ts'],
    ROUTED.replace("google.model('flash-lite',", "router.model('flash-lite',"),
  );
});

const FACTORY = `import { defineProfile } from '@theoremjs/agents';
type Variant = { id: string; strict: boolean; extra?: string[] };
function brain(variant: Variant) {
  return defineProfile({
    type: 'text',
    id: variant.id,
    maxSteps: 8,
    tools: { allow: variant.extra ?? [] },
    guardrails: { quota: { perDay: 500 }, ...(variant.strict ? { blockedReply: 'refuse' } : {}) },
  });
}
const MAIN: Variant = { id: 'main', strict: true };
export const main = brain(MAIN);
export const dev = brain({ id: 'dev', strict: false, extra: ['debug'] });
`;

const variant = (id: string, maxSteps: number, more: Record<string, unknown>) => ({
  type: 'text',
  id,
  maxSteps,
  guardrails: { quota: { perDay: 500 } },
  ...more,
});
const main = (maxSteps = 8, blockedReply = 'refuse') =>
  variant('main', maxSteps, {
    tools: { allow: [] },
    guardrails: { quota: { perDay: 500 }, blockedReply },
  });
const dev = (maxSteps = 8, allow = ['debug']) => variant('dev', maxSteps, { tools: { allow } });

Deno.test('a function that defines a profile for each call of it defines each one', () => {
  const source = project({ 'setup.ts': FACTORY });
  assertEquals([...source.profiles.keys()], ['main', 'dev']);
  const { profiles, sites } = sourceOrigins(source);
  assertEquals(profiles, {});
  // The whole call is one value for both. What only this one's arguments lead to is its own.
  assertEquals(
    sites?.profiles.main?.map((site) => `${site.path.join('.')} ${String(site.shared)}`),
    [' true', 'tools.allow false', 'id false'],
  );
  assertEquals(sites?.profiles.main?.[0]?.name, 'brain');
  // A call that does not say the id leaves the function's profiles unnamed.
  const unnamed = project({ 'setup.ts': `${FACTORY}export const other = brain(variantOf());\n` });
  assertEquals([...unnamed.profiles.keys()], []);
});

Deno.test('what the function writes is changed when each of its profiles changes it, an argument on its own', () => {
  const files = { 'setup.ts': FACTORY };
  const one = saved(files, [{ kind: 'profile', of: 'main', before: main(), after: main(9) }]);
  assertEquals(one.changes, ['main maxSteps: constant']);
  assertEquals(one.plan.changes[0]?.sharedWith, ['dev']);
  assertEquals(one.plan.changes[0]?.name, 'brain');

  const each = saved(files, [
    { kind: 'profile', of: 'main', before: main(), after: main(9) },
    { kind: 'profile', of: 'dev', before: dev(), after: dev(9) },
  ]);
  assertEquals(each.changes, ['main maxSteps: written', 'dev maxSteps: written']);
  assertEquals(each.text['setup.ts'], FACTORY.replace('maxSteps: 8', 'maxSteps: 9'));

  const argument = saved(files, [
    { kind: 'profile', of: 'dev', before: dev(), after: dev(8, ['trace']) },
  ]);
  assertEquals(argument.changes, ['dev tools.allow.0: written']);
  assertEquals(argument.text['setup.ts'], FACTORY.replace("['debug']", "['trace']"));
});

Deno.test('a tool registered from a constant is written where the constant is', () => {
  const files = {
    'setup.ts': `import { registerTool } from '@theoremjs/agents';
import { wipe } from './wipe.ts';

registerTool(wipe);
`,
    'wipe.ts': `export const wipe = { type: 'function' as const, name: 'wipe', description: 'Clears the desk.' };
`,
  };
  const tool = (description: string) => ({ type: 'function', name: 'wipe', description });
  const plan = saved(files, [
    { kind: 'tool', of: 'wipe', before: tool('Clears the desk.'), after: tool('Clears it all.') },
  ]);
  assertEquals(plan.changes, ['wipe description: written']);
  assertEquals(
    plan.text['wipe.ts'],
    files['wipe.ts'].replace('Clears the desk.', 'Clears it all.'),
  );
});
