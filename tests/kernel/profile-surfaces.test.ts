import { assertEquals } from '@std/assert';
import { profileInputs } from '../../src/kernel/registry/catalog.ts';
import { profileToolAllow, profileToolsSpec } from '../../src/kernel/tools/resolve.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { stubProfile } from '../fixtures/profiles.ts';

const TEXT_TOOLS = { allow: ['lookup'], t2Loader: 'lookup' };
const TEXT_INPUTS = { text: false };

function textProfile(): Profile {
  const base = stubProfile({ protocol: 'openAi', provider: 'openrouter', role: 'text' });
  if (base.type !== 'text') throw new Error('stubProfile role text');
  return { ...base, tools: TEXT_TOOLS, inputs: TEXT_INPUTS };
}

function imageProfile(): Profile {
  const base = stubProfile({ protocol: 'openAi', provider: 'openrouter', role: 'image' });
  if (base.type !== 'image') throw new Error('stubProfile role image');
  return { ...base, tools: TEXT_TOOLS, inputs: TEXT_INPUTS };
}

function liveProfile(): Profile {
  const base = stubProfile({ protocol: 'geminiLive', provider: 'google', role: 'live' });
  if (base.type !== 'live') throw new Error('stubProfile role live');
  return { ...base, tools: { allow: ['live-tool'] } };
}

const speech = stubProfile({ protocol: 'openAi', provider: 'openrouter', role: 'speech' });

const host: Profile = { type: 'host', id: 'host-test', tools: { allow: ['host-tool'] } };

const decision: Profile = {
  type: 'decision',
  id: 'decision-test',
  identity: { handle: 'Decision test' },
  models: { jev: { apiId: 'jev-latest' } },
  inputs: { state: 'json' },
  decision: { contract: 'test.v1' },
};

Deno.test('profileToolAllow returns tools.allow, or none for types without a tools block', () => {
  assertEquals(profileToolAllow(textProfile()), ['lookup']);
  assertEquals(profileToolAllow(imageProfile()), ['lookup']);
  assertEquals(profileToolAllow(liveProfile()), ['live-tool']);
  assertEquals(profileToolAllow(host), ['host-tool']);
  assertEquals(profileToolAllow(speech), []);
  assertEquals(profileToolAllow(decision), []);
});

Deno.test('profileToolsSpec returns the tiered spec for text and image only', () => {
  assertEquals(profileToolsSpec(textProfile())?.t2Loader, 'lookup');
  assertEquals(profileToolsSpec(imageProfile())?.t2Loader, 'lookup');
  for (const profile of [liveProfile(), host, speech, decision]) {
    assertEquals(profileToolsSpec(profile), undefined, profile.type);
  }
});

Deno.test('profileInputs returns turn inputs for text and image only', () => {
  assertEquals(profileInputs(textProfile()), TEXT_INPUTS);
  assertEquals(profileInputs(imageProfile()), TEXT_INPUTS);
  // decision declares inputs, but they are DecisionInputsSpec, not turn inputs.
  for (const profile of [liveProfile(), host, speech, decision]) {
    assertEquals(profileInputs(profile), undefined, profile.type);
  }
});
