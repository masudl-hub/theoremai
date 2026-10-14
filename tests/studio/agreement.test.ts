import { assertEquals } from '@std/assert';
import { differingSettings } from '../../studio/agreement.ts';

Deno.test('a profile differs in each setting that is not the same value, but for what the kernel reads a setting left out as, and studio policy', () => {
  const project = {
    models: { main: { apiId: 'a', builtInTools: [], compaction: { profile: 'writer' } } },
    tools: { allow: ['one', 'two'] },
    inputs: { text: true },
    turnBehaviour: { resumption: {} },
    observability: { sampleRate: 0.5 },
  };
  const studio = {
    // The studio's state limit is policy. A key slot the project's model does not name is not.
    models: { main: { apiId: 'a', keySlot: 'slot', compaction: {} } },
    tools: { allow: ['two', 'one'] },
    // Left out is the kernel's default: text accepted, no built-in tools.
    inputs: { maxStateBytes: 16_384 },
    // None is not the kernel's own list, and a rate left out is 1.
    turnBehaviour: { resumption: { allowContinue: [] } },
  };
  assertEquals(differingSettings(project, studio), [
    'models.main.compaction.profile',
    'models.main.keySlot',
    'tools.allow',
    'turnBehaviour.resumption.allowContinue',
    'observability',
  ]);
  assertEquals(differingSettings(project, project), []);
});
