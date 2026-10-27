import { assertEquals } from '@std/assert';
import { differingSettings } from '../../studio/agreement.ts';
import { compileStudio } from '../../studio/compile.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import { createExampleDraft } from '../../studio/mod.ts';
import { withoutStudioFills } from '../../studio/policy.ts';
import { agentModule } from '../../studio/source.ts';

Deno.test('a profile differs in each setting that is not the same value, but for what the kernel reads a setting left out as, and studio policy', () => {
  const project = {
    models: { main: { apiId: 'a', builtInTools: [], compaction: { profile: 'writer' } } },
    tools: { allow: ['one', 'two'] },
    inputs: { text: true },
    turnBehaviour: { resumption: {} },
    observability: { sampleRate: 0.5 },
  };
  const studio = {
    // A key slot the project's model does not name is a difference, and so is a state limit.
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
    'inputs.maxStateBytes',
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

Deno.test("a profile as a file holds it leaves out the studio's own trace store", () => {
  const filled = { id: 'desk', observability: { writeTo: 'studio' }, labels: {} };
  assertEquals<unknown>(withoutStudioFills(filled), { id: 'desk', labels: {} });
  const sampled = { id: 'desk', observability: { writeTo: 'studio', sampleRate: 0.5 } };
  assertEquals<unknown>(withoutStudioFills(sampled), {
    id: 'desk',
    observability: { sampleRate: 0.5 },
  });
  const own = { id: 'desk', observability: { writeTo: 'traces' } };
  assertEquals(withoutStudioFills(own), own);
  const off = { id: 'desk', observability: { writeTo: false } };
  assertEquals(withoutStudioFills(off), off);
});

Deno.test("a new agent's file names no trace store of the studio's", () => {
  const compiled = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  if (!compiled.ok) throw new Error('the example compiles');
  assertEquals(agentModule(compiled).includes("'studio'"), false);
});

Deno.test('a host profile differs in detect only at the tool boundaries, the ones a host reads', () => {
  const host = (detect: unknown) => ({ type: 'host', id: 'desk', guardrails: { detect } });
  // `action` reaches every boundary, and the studio writes only the tool ones: the same to a host.
  const project = host({ ids: { action: 'redact', at: { tool_arguments_function: 'flag' } } });
  const studio = host({ ids: { at: { tool_arguments_function: 'flag' } } });
  assertEquals(differingSettings(project, studio), [
    'guardrails.detect.ids.tool_arguments_http',
    'guardrails.detect.ids.tool_arguments_mcp',
    'guardrails.detect.ids.tool_arguments_agent',
    'guardrails.detect.ids.tool_output_function',
    'guardrails.detect.ids.tool_output_http',
    'guardrails.detect.ids.tool_output_mcp',
    'guardrails.detect.ids.tool_output_agent',
    'guardrails.detect.ids.tool_failure_function',
    'guardrails.detect.ids.tool_failure_http',
    'guardrails.detect.ids.tool_failure_mcp',
    'guardrails.detect.ids.tool_failure_agent',
    'guardrails.detect.ids.tool_shown_function',
    'guardrails.detect.ids.tool_shown_http',
    'guardrails.detect.ids.tool_shown_mcp',
    'guardrails.detect.ids.tool_shown_agent',
  ]);
  assertEquals(
    differingSettings({ ...project, type: 'text' }, { ...studio, type: 'text' }).includes(
      'guardrails.detect.ids.reply',
    ),
    true,
  );
});
