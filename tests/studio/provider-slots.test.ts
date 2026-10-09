import { assertEquals } from '@std/assert';
import { withProviderSlots } from '../../studio/server/handler.ts';

const providers: Record<string, { keySlot?: string; fallbackKeySlot?: string }> = {
  openrouter: { keySlot: 'team', fallbackKeySlot: 'spare' },
  local: {},
};
const providerOf = (id: string) => providers[id];

Deno.test("a model that names no key slot opens with its provider's", () => {
  const profile = { id: 'desk', models: { main: { provider: 'openrouter', apiId: 'a' } } };
  assertEquals<unknown>(withProviderSlots(profile, providerOf).models.main, {
    provider: 'openrouter',
    apiId: 'a',
    keySlot: 'team',
    fallbackKeySlot: 'spare',
  });
});

Deno.test('a model keeps the key slot it names', () => {
  const profile = { models: { main: { provider: 'openrouter', keySlot: 'mine' } } };
  assertEquals<unknown>(withProviderSlots(profile, providerOf).models.main, {
    provider: 'openrouter',
    keySlot: 'mine',
    fallbackKeySlot: 'spare',
  });
});

Deno.test('a model gains no key slot when its provider has none, or is not registered', () => {
  const profile = { models: { a: { provider: 'local' }, b: { provider: 'gone' } } };
  assertEquals(withProviderSlots(profile, providerOf), profile);
});

Deno.test('a profile with no models is left as it is', () => {
  const profile = { id: 'console' };
  assertEquals(withProviderSlots(profile, providerOf), profile);
});
