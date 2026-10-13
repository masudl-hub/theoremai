import { assertEquals } from '@std/assert';
import { differingSettings } from '../../studio/agreement.ts';

Deno.test('a profile differs in each setting that is not the same value, and in nothing studio policy sets', () => {
  const project = {
    models: { main: { apiId: 'a', builtInTools: [], compaction: { profile: 'writer' } } },
    tools: { allow: ['one', 'two'] },
    inputs: { text: true },
  };
  const studio = {
    // The provider's slot on the model, and the studio's state limit, are policy.
    models: { main: { apiId: 'a', keySlot: 'slot', compaction: {} } },
    tools: { allow: ['two', 'one'] },
    inputs: { text: true, maxStateBytes: 16_384 },
  };
  assertEquals(differingSettings(project, studio), [
    'models.main.builtInTools',
    'models.main.compaction.profile',
    'tools.allow',
  ]);
  assertEquals(differingSettings(project, project), []);
});
