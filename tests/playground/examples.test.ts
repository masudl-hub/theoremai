import { assert, assertEquals } from '@std/assert';
import {
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
