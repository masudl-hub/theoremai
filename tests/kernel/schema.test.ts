import { assertEquals } from '@std/assert';
import type { KeySlot, Protocol, Provider } from '../../src/kernel/schema.ts';
import {
  ATTACHMENT_ACCEPT_MIMES,
  catalogPathFor,
  coerceProtocol,
  coerceProvider,
  EXTRA_FIELDS,
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
    assertEquals(allowed.length > 0, true);
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

Deno.test('PROFILE_FIELDS protocol / accept / text match live unions', () => {
  const protocol = fieldMeta('model.protocol');
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

  const thinking = fieldMeta('model.config.*.thinking.on');
  assertEquals(thinking?.options, THINKING_LEVELS);
});

Deno.test('catalogPathFor substitutes host map keys with *', () => {
  assertEquals(catalogPathFor(['identity', 'handle']), 'identity.handle');
  assertEquals(catalogPathFor(['model', 'protocol']), 'model.protocol');
  assertEquals(catalogPathFor(['model', 'config', 'flash', 'apiId']), 'model.config.*.apiId');
  assertEquals(catalogPathFor(['inputs', 'attachments', 'accept']), 'inputs.attachments.accept');
  assertEquals(PROFILE_FIELDS[catalogPathFor(['model', 'config', 'pro', 'apiId'])] != null, true);
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
    'type',
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
  ];
  for (const key of registerToolKeys) {
    if (key === 'type') {
      assertEquals(EXTRA_FIELDS.type != null, true, 'missing EXTRA_FIELDS.type');
      continue;
    }
    assertEquals(fieldMeta(key) != null, true, `missing EXTRA_FIELDS.${key}`);
  }
  assertEquals(EXTRA_FIELDS.type?.options, ['builtin', 'function']);
});
