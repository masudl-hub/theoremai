import { assertEquals } from '@std/assert';
import type { KeySlot, Protocol, Provider } from '../../src/kernel/schema.ts';
import {
  ATTACHMENT_ACCEPT_MIMES,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  coerceSpeechFormat,
  fieldMeta,
  isValidPair,
  isValidProfileProtocol,
  KEY_SLOTS,
  MEDIA_INPUT_KIND_VALUES,
  MEDIA_INPUT_KINDS,
  OVERFLOW_KEY_SLOTS,
  PROFILE_FIELDS,
  PROFILE_TYPE_PROTOCOLS,
  PROFILE_TYPES,
  PROTOCOL_PROVIDERS,
  PROTOCOLS,
  PROVIDERS,
  protocolsFor,
  protocolsForProfileType,
  providersFor,
  speechFormatsForProtocol,
  THINKING_LEVELS,
  VOICE_ACCEPT_MIMES,
} from '../../src/kernel/schema.ts';

Deno.test('PROTOCOL_PROVIDERS covers every protocol and only known providers', () => {
  assertEquals([...PROTOCOLS].sort().join(), Object.keys(PROTOCOL_PROVIDERS).sort().join());
  for (const protocol of PROTOCOLS) {
    for (const provider of PROTOCOL_PROVIDERS[protocol]) {
      assertEquals(PROVIDERS.includes(provider), true);
      assertEquals(isValidPair(protocol, provider), true);
    }
  }
  assertEquals(isValidPair('openAi', 'google'), false);
  assertEquals(isValidPair('geminiInteractions', 'openrouter'), false);
});

Deno.test('PROFILE_TYPE_PROTOCOLS covers every archetype and only known protocols', () => {
  assertEquals([...PROFILE_TYPES].sort().join(), Object.keys(PROFILE_TYPE_PROTOCOLS).sort().join());
  for (const type of PROFILE_TYPES) {
    const allowed = PROFILE_TYPE_PROTOCOLS[type];
    // host and native decision profiles do not select a chat/live wire protocol.
    assertEquals(allowed.length > 0, type !== 'host' && type !== 'decision');
    for (const protocol of allowed) {
      assertEquals(PROTOCOLS.includes(protocol), true);
      assertEquals(isValidProfileProtocol(type, protocol), true);
      assertEquals(protocolsForProfileType(type).includes(protocol), true);
    }
  }
});

Deno.test('PROFILE_TYPE_PROTOCOLS rejects every illegal type/protocol pair', () => {
  for (const type of PROFILE_TYPES) {
    for (const protocol of PROTOCOLS) {
      const ok = (PROFILE_TYPE_PROTOCOLS[type] as readonly string[]).includes(protocol);
      assertEquals(isValidProfileProtocol(type, protocol), ok);
    }
  }
  assertEquals(isValidProfileProtocol('text', 'geminiLive'), false);
  assertEquals(isValidProfileProtocol('image', 'geminiLive'), false);
  assertEquals(isValidProfileProtocol('speech', 'geminiLive'), false);
  assertEquals(isValidProfileProtocol('live', 'openAi'), false);
  assertEquals(isValidProfileProtocol('live', 'geminiInteractions'), false);
  assertEquals(isValidProfileProtocol('live', 'geminiLive'), true);
  assertEquals(isValidProfileProtocol('text', 'openAi'), true);
  assertEquals(isValidProfileProtocol('text', 'geminiInteractions'), true);
});

Deno.test('every PROFILE_TYPE_PROTOCOLS entry has PROTOCOL_PROVIDERS partners', () => {
  for (const type of PROFILE_TYPES) {
    for (const protocol of PROFILE_TYPE_PROTOCOLS[type]) {
      assertEquals(providersFor(protocol).length > 0, true);
    }
  }
});

Deno.test('providersFor / protocolsFor / coerce stay on PROTOCOL_PROVIDERS', () => {
  assertEquals([...providersFor('geminiInteractions')], ['google']);
  assertEquals([...providersFor('geminiLive')], ['google']);
  assertEquals([...providersFor('openAi')].sort().join(), 'local,openrouter');
  assertEquals([...protocolsFor('google')], ['geminiInteractions', 'geminiLive']);
  assertEquals(coerceProvider('geminiInteractions', 'openrouter'), 'google');
  assertEquals(coerceProtocol('openAi', 'google'), 'geminiInteractions');
  assertEquals(coerceProvider('openAi', 'local'), 'local');
});

Deno.test('Key slots are KEY_SLOTS without paid', () => {
  assertEquals([...OVERFLOW_KEY_SLOTS].join(), 'slotA,slotB,slotC');
  assertEquals(KEY_SLOTS.includes('paid'), true);
  for (const slot of OVERFLOW_KEY_SLOTS) {
    assertEquals(KEY_SLOTS.includes(slot), true);
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

Deno.test('speechFormatsForProtocol matches assertSpeechRole rules', () => {
  assertEquals([...speechFormatsForProtocol('openAi')], ['pcm', 'mp3']);
  assertEquals([...speechFormatsForProtocol('geminiInteractions')], ['pcm']);
  assertEquals([...speechFormatsForProtocol('geminiLive')], ['pcm']);
  assertEquals(coerceSpeechFormat('geminiInteractions', 'mp3'), 'pcm');
  assertEquals(coerceSpeechFormat('openAi', 'mp3'), 'mp3');
});

Deno.test('PROFILE_FIELDS protocol / accept / text match live unions', () => {
  const protocol = fieldMeta('models.*.protocol');
  assertEquals(protocol?.options, PROTOCOLS);
  assertEquals(protocol?.type.includes('geminiInteractions'), true);

  const handle = fieldMeta('identity.handle');
  assertEquals(handle?.type, 'string');

  const profileType = fieldMeta('type');
  assertEquals(profileType?.type.includes('text'), true);
  assertEquals(profileType?.type.includes('live'), true);

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

Deno.test('isValidPair matches createProvider routing table', () => {
  const legal: Array<[Protocol, Provider]> = [
    ['geminiInteractions', 'google'],
    ['openAi', 'openrouter'],
    ['openAi', 'local'],
  ];
  for (const [protocol, provider] of legal) {
    assertEquals(isValidPair(protocol, provider), true);
  }
  const illegal: Array<[Protocol, string]> = [
    ['openAi', 'google'],
    ['geminiInteractions', 'local'],
    ['geminiInteractions', 'openrouter'],
  ];
  for (const [protocol, provider] of illegal) {
    assertEquals(isValidPair(protocol, provider as Provider), false);
  }
});

Deno.test('KeySlot union matches KEY_SLOTS', () => {
  const sample: KeySlot = 'paid';
  assertEquals(KEY_SLOTS.includes(sample), true);
});

Deno.test('EXTRA_FIELDS covers registerTool keys shown in profile docs', () => {
  const registerToolKeys = [
    'name',
    'description',
    'category',
    'access',
    'paths',
    'loadTier',
    'permission',
    'input',
    'output',
    'handler',
    'endpoint',
    'method',
    'headers',
    'mapping',
    'mapping.pathParams',
    'mapping.queryParams',
    'mapping.bodyParam',
    'serverUrl',
    'mcpToolName',
    'auth',
    'auth.type',
    'auth.slot',
    'auth.onUnauthenticated',
    'playground.authType',
  ];
  for (const key of registerToolKeys) {
    assertEquals(fieldMeta(key) != null, true, `missing EXTRA_FIELDS.${key}`);
  }
  const toolType = fieldMeta('registerTool.type');
  assertEquals(toolType != null, true, 'missing registerTool.type');
  assertEquals(toolType?.options?.includes('http'), true);
  assertEquals(toolType?.options?.includes('mcp'), true);
  const playgroundAuth = fieldMeta('playground.authType');
  assertEquals(playgroundAuth != null, true, 'missing playground.authType');
  assertEquals(playgroundAuth?.options?.includes('none'), true);
  assertEquals(playgroundAuth?.options?.includes('bearer'), true);
  assertEquals(fieldMeta('type')?.doc?.includes('archetype'), true);
});

Deno.test('live wires every load tier; host is a model-less profile type', () => {
  assertEquals(PROFILE_TYPES.includes('host'), true);
  assertEquals(PROFILE_TYPE_PROTOCOLS.host, []);
  assertEquals(protocolsForProfileType('host'), []);
  assertEquals(isValidProfileProtocol('host', 'geminiInteractions'), false);
  assertEquals(fieldMeta('loadTier')?.doc?.includes('wire every allowed tool'), true);
  assertEquals(fieldMeta('tools.t1Policy')?.profileTypes, ['text', 'image']);
  assertEquals(fieldMeta('tools.t2Loader')?.profileTypes, ['text', 'image']);
  assertEquals(fieldMeta('type')?.doc?.includes('host'), true);
});
