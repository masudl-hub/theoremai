import { assert, assertEquals } from '@std/assert';
import {
  addArchitectExample,
  compileStudio,
  compileWorkspace,
  createArchitectWorkspace,
  createConsoleExampleDraft,
  createExampleDraft,
  createLiveExampleDraft,
  createNarratorExampleDraft,
  demoToolSpecs,
  duplicateAgent,
  editedSince,
  filesPrint,
  libraryDraft,
  rebased,
  removeAgent,
  removeLibraryTool,
  reopened,
  resetAgent,
  resetAll,
  resetLibraryTool,
  type StudioWorkspace,
  startedHere,
  withLibraryDraft,
  workspaceFromDraft,
} from '../../studio/mod.ts';

function compiled(workspace: StudioWorkspace) {
  const result = compileWorkspace(workspace);
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  return result;
}

const toolNames = (workspace: StudioWorkspace) => workspace.toolSpecs.map((tool) => tool.toolName);

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

Deno.test('resetting everything puts every agent and tool back, and a swap of names with it', () => {
  const start = addArchitectExample(workspaceFromDraft(createExampleDraft()));
  const [concierge, architect] = start.agents;
  const weather = start.toolSpecs.find((tool) => tool.toolName === 'get_weather');
  assert(concierge && architect && weather);
  assertEquals(resetAll(start), start);

  const swap = (workspace: typeof start, key: string, agentId: string) => {
    const view = libraryDraft(workspace, key);
    assert(view);
    return withLibraryDraft(workspace, key, {
      ...view,
      identity: { ...view.identity, agentId, system: 'Changed.' },
    });
  };
  const parked = swap(start, concierge.key, 'parked');
  const swapped = swap(
    swap(parked, architect.key, concierge.identity.agentId),
    concierge.key,
    architect.identity.agentId,
  );
  const reset = resetAll(removeLibraryTool(swapped, weather.key));

  assertEquals(reset.agents, start.agents);
  assertEquals(
    new Set(reset.toolSpecs.map((tool) => tool.toolName)),
    new Set(start.toolSpecs.map((tool) => tool.toolName)),
  );
  assertEquals(resetAll(reset), reset);
  compiled(reset);
});

Deno.test('two opens of the same files print the same, and an edit prints another', () => {
  const first = createArchitectWorkspace();
  const second = createArchitectWorkspace();
  assert(first.agents[0]?.key !== second.agents[0]?.key);
  assertEquals(filesPrint(first), filesPrint(second));
  assertEquals(filesPrint({ ...first, selected: 'elsewhere' }), filesPrint(first));

  const [architect] = first.agents;
  const view = architect && libraryDraft(first, architect.key);
  assert(architect && view);
  const edited = withLibraryDraft(first, architect.key, {
    ...view,
    identity: { ...view.identity, system: 'Changed.' },
  });
  assert(filesPrint(edited) !== filesPrint(first));
});

Deno.test('a change, an added agent and a removed one are each edits the files do not hold', () => {
  const opened = createArchitectWorkspace();
  const files = filesPrint(opened);
  const [architect] = opened.agents;
  assert(architect);
  assert(!editedSince(opened, files));
  assert(!editedSince({ ...opened, selected: 'elsewhere' }, files));
  assert(editedSince(duplicateAgent(opened, architect.key), files));
  assert(editedSince(removeAgent(opened, architect.key), files));
});

Deno.test('edits brought back over changed files keep the edits and take the rest from the files', () => {
  const system = (workspace: StudioWorkspace, key: string, text: string) => {
    const view = libraryDraft(workspace, key);
    assert(view);
    return withLibraryDraft(workspace, key, {
      ...view,
      identity: { ...view.identity, system: text },
    });
  };
  const old = createArchitectWorkspace();
  const [architect, narrator] = old.agents;
  const [tool] = old.toolSpecs;
  assert(architect && narrator && tool);
  // The builder changed one agent and added another in the studio.
  const edits = duplicateAgent(system(old, architect.key, 'Edited in the studio.'), narrator.key);
  // Meanwhile their editor changed the other agent and a tool.
  const opened = createArchitectWorkspace();
  const [, theirs] = opened.agents;
  assert(theirs);
  const changed = system(opened, theirs.key, 'Edited in the editor.');
  const files = startedHere({
    ...changed,
    toolSpecs: changed.toolSpecs.map((each, at) =>
      at === 0 ? { ...each, description: 'From the editor.' } : each,
    ),
  });

  const back = rebased(edits, files);
  const by = (id: string) => back.agents.find((agent) => agent.identity.agentId === id);
  assertEquals(by(architect.identity.agentId)?.identity.system, 'Edited in the studio.');
  assertEquals(by(narrator.identity.agentId)?.identity.system, 'Edited in the editor.');
  assertEquals(back.agents.length, edits.agents.length);
  assertEquals(back.toolSpecs[0]?.description, 'From the editor.');
  // Only the builder's own edits are left to save: the starts are the files'.
  assertEquals(back.starts.tools[tool.key]?.description, 'From the editor.');
  assertEquals(back.starts.agents[narrator.key]?.identity.system, 'Edited in the editor.');
  assertEquals(back.starts.agents[architect.key]?.identity.system, architect.identity.system);
});

Deno.test('opening the files again keeps the keys in use and brings back a removed agent', () => {
  const held = createArchitectWorkspace();
  const [architect, narrator] = held.agents;
  assert(architect && narrator);
  const view = libraryDraft(held, architect.key);
  assert(view);
  const renamed = withLibraryDraft(held, architect.key, {
    ...view,
    identity: { ...view.identity, agentId: 'renamed', system: 'Changed.' },
  });
  const keys = (workspace: StudioWorkspace) => [
    ...workspace.agents.map((agent) => agent.key),
    ...workspace.toolSpecs.map((tool) => tool.key),
  ];
  const again = reopened(createArchitectWorkspace(), renamed);
  assertEquals(keys(again), keys(held));
  assertEquals(filesPrint(again), filesPrint(held));
  assertEquals(again.selected, renamed.selected);

  const without = removeAgent(renamed, narrator.key);
  const back = reopened(createArchitectWorkspace(), without);
  assertEquals(back.agents[0]?.key, architect.key);
  assert(back.agents[1] && back.agents[1].key !== narrator.key);
  assertEquals(filesPrint(back), filesPrint(held));
  compiled(back);
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

Deno.test("the narrator's style and a speed reach its profile as written", () => {
  const narrator = createNarratorExampleDraft();
  const result = compileStudio(narrator);
  assert(result.ok && result.profile.type === 'speech');
  assertEquals(result.profile.speech, { style: narrator.speech.style });

  const fast = compileStudio({ ...narrator, speech: { ...narrator.speech, speed: 1.2 } });
  assert(fast.ok && fast.profile.type === 'speech');
  assertEquals(fast.profile.speech.speed, 1.2);
});
