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
    'observability.sampleRate',
  ]);
  assertEquals(differingSettings(project, project), []);
});

Deno.test('a section left out is one written empty, read setting by setting', () => {
  const empty = { outputs: {}, guardrails: {}, labels: {}, turnBehaviour: {}, observability: {} };
  assertEquals(differingSettings(empty, {}), []);
  assertEquals(differingSettings({}, empty), []);
  // The kernel's own lists, written out, are the lists it reads a section left out as.
  const resumption = {
    allowContinue: ['length', 'stream_incomplete', 'provider_error'],
    autoContinue: ['length', 'stream_incomplete'],
  };
  assertEquals(differingSettings({ turnBehaviour: {} }, { turnBehaviour: { resumption } }), []);
  // A profile that names no place for its records is recorded to the studio. Named, the place is
  // the profile's, and any other is a difference.
  assertEquals(differingSettings({}, { observability: { writeTo: 'studio' } }), []);
  assertEquals(
    differingSettings(
      { observability: { writeTo: false } },
      { observability: { writeTo: 'studio' } },
    ),
    ['observability.writeTo'],
  );
  assertEquals(
    differingSettings(
      { observability: { writeTo: 'traces' } },
      { observability: { writeTo: 'studio' } },
    ),
    ['observability.writeTo'],
  );
  assertEquals(differingSettings({ observability: {} }, { observability: { sampleRate: 0.5 } }), [
    'observability.sampleRate',
  ]);
  assertEquals(differingSettings({ labels: {} }, { labels: { 'tool.output_invalid': 'x' } }), [
    'labels.tool.output_invalid',
  ]);
  assertEquals(
    differingSettings({}, { turnBehaviour: { resumption: { ...resumption, autoContinue: [] } } }),
    ['turnBehaviour.resumption.autoContinue'],
  );
});
