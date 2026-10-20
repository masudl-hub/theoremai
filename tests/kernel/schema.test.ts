import { assertEquals } from '@std/assert';
import {
  API_EXPORTS,
  ATTACHMENT_ACCEPT_MIMES,
  catalogPathFor,
  EXTRA_FIELDS,
  fieldMeta,
  isKeySlotName,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  PROFILE_FIELDS,
  PROFILE_TYPES,
  THINKING_LEVELS,
  VOICE_ACCEPT_MIMES,
} from '../../src/kernel/schema.ts';

Deno.test('a key slot is any short name the host picks', () => {
  for (const name of ['main', 'openai-prod', 'team_2', 'a', 'x'.repeat(32)]) {
    assertEquals(isKeySlotName(name), true, name);
  }
  for (const name of ['', 'my key', 'slot.a', '-lead', 'x'.repeat(33), 7]) {
    assertEquals(isKeySlotName(name), false, String(name));
  }
});

Deno.test('MEDIA_INPUT_KINDS values are MediaInputKind', () => {
  for (const kind of Object.values(MEDIA_INPUT_KINDS)) {
    assertEquals((MEDIA_INPUT_KIND_VALUES as readonly string[]).includes(kind), true);
  }
  assertEquals(ATTACHMENT_ACCEPT_MIMES.includes('image/*'), true);
  assertEquals(ATTACHMENT_ACCEPT_MIMES.includes('image/png'), true);
  assertEquals(VOICE_ACCEPT_MIMES.includes('audio/*'), true);
  assertEquals(VOICE_ACCEPT_MIMES.includes('audio/wav'), true);
});

Deno.test('PROFILE_FIELDS protocol / accept / text match live unions', () => {
  assertEquals(fieldMeta('models.*.protocol')?.type, 'string');
  assertEquals(fieldMeta('models.*.provider')?.type, 'string');

  const handle = fieldMeta('identity.handle');
  assertEquals(handle?.type, 'string');

  const profileType = fieldMeta('profile.type');
  assertEquals(profileType?.type.includes('text'), true);
  assertEquals(profileType?.type.includes('live'), true);
  assertEquals(profileType?.options, PROFILE_TYPES);

  const accept = fieldMeta('inputs.attachments.accept');
  assertEquals(accept?.type, 'string[]');
  assertEquals(accept?.options, ATTACHMENT_ACCEPT_MIMES);

  const effort = fieldMeta('models.*.efforts.*');
  assertEquals(effort?.options, THINKING_LEVELS);
});

Deno.test('catalogPathFor substitutes host map keys with *', () => {
  assertEquals(catalogPathFor(['identity', 'handle']), 'identity.handle');
  assertEquals(catalogPathFor(['models', 'flash', 'protocol']), 'models.*.protocol');
  assertEquals(catalogPathFor(['models', 'flash', 'apiId']), 'models.*.apiId');
  assertEquals(catalogPathFor(['inputs', 'attachments', 'accept']), 'inputs.attachments.accept');
  assertEquals(PROFILE_FIELDS[catalogPathFor(['models', 'pro', 'apiId'])] != null, true);
});

Deno.test('EXTRA_FIELDS covers registerTool keys shown in profile docs', () => {
  const registerToolKeys = [
    'registerTool.name',
    'registerTool.description',
    'registerTool.category',
    'registerTool.access',
    'registerTool.paths',
    'registerTool.loadTier',
    'registerTool.permission',
    'registerTool.input',
    'registerTool.output',
    'registerTool.handler',
    'registerTool.endpoint',
    'registerTool.method',
    'registerTool.headers',
    'registerTool.mapping',
    'registerTool.mapping.pathParams',
    'registerTool.mapping.queryParams',
    'registerTool.mapping.bodyParam',
    'registerTool.serverUrl',
    'registerTool.mcpToolName',
    'registerTool.auth',
    'registerTool.auth.type',
    'registerTool.auth.slot',
    'registerTool.auth.onUnauthenticated',
    'studio.authType',
  ];
  for (const key of registerToolKeys) {
    assertEquals(fieldMeta(key) != null, true, `missing EXTRA_FIELDS.${key}`);
  }
  const toolType = fieldMeta('registerTool.type');
  assertEquals(toolType != null, true, 'missing registerTool.type');
  assertEquals(toolType?.options?.includes('http'), true);
  assertEquals(toolType?.options?.includes('mcp'), true);
  const studioAuth = fieldMeta('studio.authType');
  assertEquals(studioAuth != null, true, 'missing studio.authType');
  assertEquals(studioAuth?.options?.includes('none'), true);
  assertEquals(studioAuth?.options?.includes('bearer'), true);
});

Deno.test('host is a profile type; load tiers belong to text and image', () => {
  assertEquals(PROFILE_TYPES.includes('host'), true);
  assertEquals(fieldMeta('tools.t1Policy')?.profileTypes, ['text', 'image']);
  assertEquals(fieldMeta('tools.t2Loader')?.profileTypes, ['text', 'image']);
  assertEquals(fieldMeta('profile.type')?.doc?.includes('host'), true);
});

Deno.test('every option description names one of its field options', () => {
  for (const [path, meta] of Object.entries({ ...PROFILE_FIELDS, ...EXTRA_FIELDS })) {
    for (const key of Object.keys(meta.optionDescriptions ?? {})) {
      assertEquals(meta.options?.includes(key), true, `${path}: '${key}' is not an option`);
    }
  }
});

Deno.test('API_EXPORTS names only exports of the package, each of the kind it says', async () => {
  const exported: Record<string, unknown> = await import('../../mod.ts');
  for (const [name, meta] of Object.entries(API_EXPORTS)) {
    const value = exported[name];
    assertEquals(typeof value, 'function', `${name} is not exported`);
    const isClass = /^class\b/.test(Function.prototype.toString.call(value));
    assertEquals(isClass ? 'class' : 'function', meta.kind, `${name} is a ${meta.kind}`);
  }
});
