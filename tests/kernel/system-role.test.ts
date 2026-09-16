import { assertEquals } from '@std/assert';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { pickSystemRole } from '../../src/kernel/registry/system-role.ts';
import { geminiModels } from '../fixtures/models.ts';

Deno.test('pickSystemRole prefers systemByRole when requested', () => {
  const profile = defineProfile({
    type: 'text',
    id: 'system.role.probe',
    identity: {
      handle: 'default_handle',
      system: 'base',
      systemByRole: { agent: 'agent system', user: 'user system' },
    },
    tools: { allow: [] },
    inputs: { text: true },
    ...geminiModels('gemini35FlashLite'),
  });
  assertEquals(pickSystemRole(profile, 'agent'), 'agent');
  assertEquals(pickSystemRole(profile, 'missing'), 'default_handle');
  assertEquals(pickSystemRole(profile), 'default_handle');
});
