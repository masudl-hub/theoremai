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
  libraryDraft,
  type PlaygroundWorkspace,
  removeLibraryTool,
  resetAgent,
  resetLibraryTool,
  withLibraryDraft,
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

Deno.test('resetting an agent puts back its start and leaves the other agents alone', () => {
  const start = addArchitectExample(workspaceFromDraft(createExampleDraft()));
  const [concierge, architect, narrator] = start.agents;
  assert(concierge && architect && narrator);
  assertEquals(resetAgent(start, concierge.key), start);

  const view = libraryDraft(start, concierge.key);
  const weather = start.toolSpecs.find((tool) => tool.toolName === 'get_weather');
  assert(view && weather);
  const edited = removeLibraryTool(
    withLibraryDraft(start, concierge.key, {
      ...view,
      identity: { ...view.identity, agentId: 'my.agent', system: 'Changed.' },
    }),
    weather.key,
  );
  const reset = resetAgent(edited, concierge.key);

  assertEquals(reset.agents[0], concierge);
  assertEquals(reset.agents.slice(1), start.agents.slice(1));
  assertEquals(reset.toolSpecs.at(-1), weather);
  assertEquals(reset.toolSpecs.length, start.toolSpecs.length);
  assertEquals(resetAgent(reset, concierge.key), reset);
  compiled(reset);
});

Deno.test('resetting the architect keeps it linked to its narrator', () => {
  const start = createArchitectWorkspace();
  const [architect] = start.agents;
  const narrate = start.toolSpecs.find((tool) => tool.toolName === 'narrate');
  assert(architect && narrate);
  const view = libraryDraft(start, architect.key);
  assert(view);
  const edited = withLibraryDraft(start, architect.key, {
    ...view,
    toolSpecs: view.toolSpecs.filter((tool) => tool.key !== narrate.key),
  });
  assert(!edited.toolSpecs.some((tool) => tool.key === narrate.key));

  const reset = resetAgent(edited, architect.key);
  assert(reset.agents[0]?.tools.allow.includes(narrate.key));
  assertEquals(reset.toolSpecs.at(-1), narrate);
  compiled(reset);
});

Deno.test('resetting a tool puts back its start and keeps who allows it', () => {
  const start = workspaceFromDraft(createExampleDraft());
  const weather = start.toolSpecs.find((tool) => tool.toolName === 'get_weather');
  assert(weather);
  assertEquals(resetLibraryTool(start, weather.key), start);
  const edited = {
    ...start,
    toolSpecs: start.toolSpecs.map((tool) =>
      tool.key === weather.key ? { ...tool, description: 'Changed.' } : tool,
    ),
  };
  const reset = resetLibraryTool(edited, weather.key);
  assertEquals(reset.toolSpecs, start.toolSpecs);
  assertEquals(reset.agents, start.agents);
});
