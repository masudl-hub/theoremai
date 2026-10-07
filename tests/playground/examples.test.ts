import { assert, assertEquals } from '@std/assert';
import {
  addArchitectExample,
  compileWorkspace,
  createArchitectWorkspace,
  createConsoleExampleDraft,
  createExampleDraft,
  createLiveExampleDraft,
  createNarratorExampleDraft,
  demoToolSpecs,
  type PlaygroundWorkspace,
  workspaceFromDraft,
} from '../../playground/mod.ts';

function compiled(workspace: PlaygroundWorkspace) {
  const result = compileWorkspace(workspace);
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  return result;
}

const toolNames = (workspace: PlaygroundWorkspace) =>
  workspace.toolSpecs.map((tool) => tool.toolName);

Deno.test('every example compiles as it loads', () => {
  for (const draft of [
    createExampleDraft(),
    createLiveExampleDraft(),
    createNarratorExampleDraft(),
    createConsoleExampleDraft(),
  ]) {
    compiled(workspaceFromDraft(draft));
  }
});

Deno.test('the architect calls the narrator through its narrate tool', () => {
  const result = compiled(createArchitectWorkspace());
  assertEquals(
    result.agents.map((agent) => agent.agentId),
    ['studio.narrator', 'code.architect'],
  );
  const narrate = result.agents[1]?.customTools.find((tool) => tool.name === 'narrate');
  assertEquals(narrate?.type === 'agent' && narrate.profile, 'studio.narrator');
});

Deno.test('the examples between them use every demo tool', () => {
  const used = new Set([
    ...toolNames(workspaceFromDraft(createExampleDraft())),
    ...toolNames(createArchitectWorkspace()),
    ...toolNames(workspaceFromDraft(createConsoleExampleDraft())),
  ]);
  const unused = demoToolSpecs()
    .map((seed) => seed.data.toolName)
    .filter((name) => !used.has(name ?? ''));
  assertEquals(unused, []);
});

Deno.test('adding the architect brings its narrator, linked, and keeps the agents already there', () => {
  const start = workspaceFromDraft(createExampleDraft());
  const once = addArchitectExample(start);
  const twice = addArchitectExample(once);
  assertEquals(
    twice.agents.map((agent) => agent.identity.agentId),
    [
      'travel.concierge',
      'code.architect',
      'studio.narrator',
      'code.architect_2',
      'studio.narrator_2',
    ],
  );
  assertEquals(once.chatWith, start.chatWith);
  assertEquals(
    toolNames(twice).filter((name) => name.startsWith('narrate')),
    ['narrate', 'narrate_2'],
  );
  const second = twice.toolSpecs.find((tool) => tool.toolName === 'narrate_2');
  assertEquals(second?.agentKey, twice.agents[4]?.key);
  assert(twice.agents[3]?.tools.allow.includes(second?.key ?? ''));
  assert(!twice.agents[1]?.tools.allow.includes(second?.key ?? ''));
  compiled(twice);
});
