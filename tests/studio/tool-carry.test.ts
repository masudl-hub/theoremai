// deno-lint-ignore-file no-explicit-any
import { assertEquals } from '@std/assert';
import { createExampleDraft } from '../../studio/mod.ts';
import type { SettingSite } from '../../studio/server/save-wire.ts';
import {
  reachesOthers,
  sharedAsk,
  toolSnapshot,
  withToolCarry,
} from '../../studio/shared-carry.ts';
import { workspaceFromDraft } from '../../studio/workspace.ts';

// biome-ignore lint/suspicious/noExplicitAny: a JSON Schema the tests reach into
type Json = Record<string, any>;

const RESULT = {
  type: 'object',
  properties: { finding: { type: 'string' }, parts: { type: 'array', items: { type: 'string' } } },
  required: ['finding'],
  additionalProperties: false,
};

const AT = ['outputSchema', 'properties', 'source'];

/** The example's first three tools, each returning under `source` the one result the files write once. */
function withSource<T extends { outputJson: string }>(tool: T): T {
  const schema = JSON.parse(tool.outputJson) as Json;
  schema.properties = { ...schema.properties, source: RESULT };
  return { ...tool, outputJson: JSON.stringify(schema, null, 2) };
}

function shared() {
  const example = workspaceFromDraft(createExampleDraft());
  const keys = example.toolSpecs.slice(0, 3).map((tool) => tool.key);
  const toolSpecs = example.toolSpecs.map((tool) =>
    keys.includes(tool.key) ? withSource(tool) : tool,
  );
  const starts = {
    ...example.starts,
    tools: Object.fromEntries(toolSpecs.map((tool) => [tool.key, tool])),
  };
  const workspace = { ...example, toolSpecs, starts };
  const [first, second, third] = toolSpecs.filter((tool) => keys.includes(tool.key));
  if (!first || !second || !third) throw new Error('The example has three tools.');
  return { workspace, first, second, third };
}

const site = (more: Partial<SettingSite> = {}): SettingSite => ({
  path: AT,
  site: 2,
  shared: true,
  name: 'resultSchema',
  file: 'result.ts',
  line: 3,
  ...more,
});

const output = (workspace: ReturnType<typeof shared>['workspace'], key: string): Json =>
  JSON.parse(workspace.toolSpecs.find((tool) => tool.key === key)?.outputJson ?? '{}').properties
    .source;

function edited(
  workspace: ReturnType<typeof shared>['workspace'],
  key: string,
  change: (schema: Json) => void,
) {
  const toolSpecs = workspace.toolSpecs.map((tool) => {
    if (tool.key !== key) return tool;
    const schema = JSON.parse(tool.outputJson) as Json;
    change(schema.properties.source);
    return { ...tool, outputJson: JSON.stringify(schema, null, 2) };
  });
  return { ...workspace, toolSpecs };
}

Deno.test('a change inside a schema tools share is made on each tool that shares it', () => {
  const { workspace, first, second, third } = shared();
  const sites = {
    [first.toolName]: [site()],
    [second.toolName]: [site()],
    [third.toolName]: [site()],
  };
  const made = edited(workspace, first.key, (schema) => {
    schema.properties.finding.description = 'What it found.';
  });
  const carried = withToolCarry(toolSnapshot(workspace), made, sites);
  for (const tool of [first, second, third]) {
    assertEquals(
      output(carried.workspace, tool.key).properties.finding.description,
      'What it found.',
    );
  }
  assertEquals(carried.reach?.amongTools, { made: [second.key, third.key], left: [] });
  assertEquals(carried.reach && reachesOthers(carried.reach), true);
  assertEquals(carried.reach && sharedAsk(carried.reach, carried.workspace), {
    title: 'Change it for 2 other tools?',
    line: `resultSchema · result.ts:3 sets this once. ${second.toolName} and ${third.toolName} use it too, and will change with it.`,
  });
});

Deno.test('a tool that does not share the schema is left alone, and so is what a tool adds of its own', () => {
  const { workspace, first, second, third } = shared();
  // The third extends the shared result: the field it adds is written in its own file.
  const own = site({
    path: [...AT, 'properties', 'loaded'],
    site: 6,
    shared: false,
    name: 'loadResult',
    file: 'load.ts',
    line: 4,
  });
  const sites = { [first.toolName]: [site()], [third.toolName]: [site(), own] };
  const extended = edited(workspace, third.key, (schema) => {
    schema.properties.loaded = { type: 'string' };
  });
  const starts = {
    ...extended.starts,
    tools: Object.fromEntries(extended.toolSpecs.map((tool) => [tool.key, tool])),
  };
  const held = { ...extended, starts };

  const mine = withToolCarry(
    toolSnapshot(held),
    edited(held, third.key, (schema) => {
      schema.properties.loaded.description = 'Each one loaded.';
    }),
    sites,
  );
  assertEquals(mine.reach, undefined);
  assertEquals(output(mine.workspace, first.key), RESULT);

  const theirs = withToolCarry(
    toolSnapshot(held),
    edited(held, first.key, (schema) => {
      schema.properties.parts.items.description = 'One part.';
    }),
    sites,
  );
  assertEquals(output(theirs.workspace, third.key).properties.parts.items.description, 'One part.');
  assertEquals(output(theirs.workspace, third.key).properties.loaded, { type: 'string' });
  assertEquals(output(theirs.workspace, second.key), RESULT);
  assertEquals(theirs.reach?.amongTools, { made: [third.key], left: [] });
});

Deno.test('a value other code reads says so, with the lines that read it', () => {
  const { workspace, first, second } = shared();
  const readBy = [{ file: 'report.ts', line: 7 }];
  const made = (sites: Record<string, SettingSite[]>) =>
    withToolCarry(
      toolSnapshot(workspace),
      edited(workspace, first.key, (schema) => {
        schema.description = 'What it found.';
      }),
      sites,
    );

  const both = made({
    [first.toolName]: [site({ readBy })],
    [second.toolName]: [site({ readBy })],
  });
  assertEquals(both.reach && sharedAsk(both.reach, both.workspace), {
    title: 'Change it for 1 other tool?',
    line:
      `resultSchema · result.ts:3 sets this once. ${second.toolName} uses it too, and will change with it.` +
      ' Other code in your project reads it too (report.ts:7).',
  });

  // No other tool shares it: the question is the other code alone.
  const alone = made({ [first.toolName]: [site({ shared: false, readBy })] });
  assertEquals(alone.reach && reachesOthers(alone.reach), false);
  assertEquals(alone.reach && sharedAsk(alone.reach, alone.workspace), {
    title: 'Change it for your other code too?',
    line:
      'resultSchema · result.ts:3 sets this once. Other code in your project reads it too (report.ts:7).' +
      ' That code runs on the new value once you save.',
  });
});
