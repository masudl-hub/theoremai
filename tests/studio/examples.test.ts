import { assert, assertEquals } from '@std/assert';
import { resolveDraftItemCheck } from '../../studio/cookbooks/checks.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  addArchitectExample,
  addResearchExample,
  COOKBOOKS,
  compileStudio,
  compileWorkspace,
  createArchitectWorkspace,
  createConsoleExampleDraft,
  createExampleDraft,
  createLiveExampleDraft,
  createNarratorExampleDraft,
  createResearchScoutDraft,
  createResearchWorkspace,
  demoToolSpecs,
  duplicateAgent,
  editedSince,
  filesPrint,
  libraryDraft,
  projectProfileSlice,
  projectToolSlice,
  RESEARCH_FIRST_TURN_PROMPT,
  RESEARCH_PAGE_READER_STATE,
  RESEARCH_REPLY_SCHEMA_ID,
  rebased,
  removeAgent,
  removeLibraryTool,
  reopened,
  resetAgent,
  resetAll,
  resetLibraryTool,
  resolveCookbookSlice,
  type StudioWorkspace,
  startedHere,
  stitchCookbook,
  studioSource,
  withLibraryDraft,
  workspaceFromDraft,
  workspaceRunAgent,
} from '../../studio/mod.ts';
import { firstLine } from '../fixtures/prompt-line.ts';

function compiled(workspace: StudioWorkspace) {
  const result = compileWorkspace(workspace, ON_OWN_KEYS);
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

Deno.test('the research scout starts without effort select or attachments', () => {
  const scout = createResearchScoutDraft();
  assertEquals(scout.inputs.attachmentsAccept, []);
  assertEquals(scout.inputs.voiceAccept, []);
  assertEquals(scout.inputs.maxFiles, null);
  assertEquals(
    scout.modelBindings.map(({ allowEffortSelect }) => allowEffortSelect),
    [false, false],
  );
});

Deno.test('the research scout rewrites a candidate whose quote no tool returned, then drops it', async () => {
  const { agents } = compiled(createResearchWorkspace());
  const scout = agents.find((agent) => agent.agentId === 'research.scout')?.profile;
  assert(scout?.type === 'text', 'the scout is a text agent');
  const validation = scout.outputs?.validation;
  const shapes = scout.outputs?.structured;
  assert(shapes && typeof shapes === 'object');
  assertEquals(shapes.fallback, RESEARCH_REPLY_SCHEMA_ID);
  assertEquals(validation?.items?.candidates?.onFail, 'fix');
  assert((validation?.maxRetries ?? 0) >= 1, 'the answer and the rewrite each need a retry');
  const check = resolveDraftItemCheck(scout.id, 'candidates');
  const url = 'https://arxiv.org/abs/2401.01234';
  const refused = await check(
    { basis: 'page', url, evidence: [{ uri: url, quote: 'words no tool returned' }] },
    { toolResults: [{ tool: 'search_papers', output: { id: '2401.01234', abstract: 'Recall.' } }] },
  );
  assertEquals((refused as { isValid: boolean }).isValid, false);
});

Deno.test('the research agents print a real key slot, and say the quote check is owed', () => {
  const { agents } = compiled(createResearchWorkspace());
  const reader = agents.find((agent) => agent.agentId === 'research.pagereader');
  const scout = agents.find((agent) => agent.agentId === 'research.scout');
  assert(reader && scout);
  assert(studioSource(reader).includes("keySlot: 'typesafe'"));
  assert(studioSource(scout).includes('The check of each item of'));
});

Deno.test('the research scout links its page-reading tools to the Jev page reader', () => {
  const result = compiled(createResearchWorkspace());
  assertEquals(result.agents.map((agent) => agent.agentId).sort(), [
    'research.compactor',
    'research.console',
    'research.embedder',
    'research.illustrator',
    'research.judge',
    'research.pagereader',
    'research.podcast',
    'research.scout',
    'research.scout.live',
  ]);
  const seed = JSON.parse(RESEARCH_PAGE_READER_STATE) as { question?: string; passage?: string };
  assert(typeof seed.question === 'string' && seed.question.length > 0);
  assert(typeof seed.passage === 'string' && seed.passage.length > 0);
  const scout = result.agents.find((agent) => agent.agentId === 'research.scout');
  const stageRead = scout?.customTools
    .filter((tool) => tool.type !== 'agent' && tool.stageAgent === 'research.pagereader')
    .map((tool) => tool.name);
  assertEquals(stageRead, [
    'read_pages',
    'read_model_card',
    'read_dataset_card',
    'read_readme',
    'read_library_docs',
  ]);
  const added = addResearchExample(workspaceFromDraft(createExampleDraft()));
  assertEquals(
    added.agents.map((agent) => agent.identity.agentId),
    [
      'travel.concierge',
      'research.scout',
      'research.pagereader',
      'research.compactor',
      'research.podcast',
      'research.illustrator',
      'research.embedder',
      'research.scout.live',
      'research.console',
      'research.judge',
    ],
  );
  compiled(added);
});

Deno.test('the research scout carries the cookbook list', () => {
  const result = compiled(createResearchWorkspace());
  const run = workspaceRunAgent(result, 'research.scout');
  assert(run);
  const { profile, structured, customTools, dependencies } = run;
  const tool = (name: string) => customTools.find((each) => each.name === name);
  assert(profile.type === 'text');
  assertEquals(profile.outputs?.structured, {
    by: 'focus',
    map: { 'Hugging Face Open Research': 'research.models' },
    fallback: 'research.reply',
  });
  assertEquals(
    structured?.also?.map((shape) => shape.id),
    ['research.models'],
  );
  assertEquals(tool('read_readme')?.after, true);
  assertEquals(tool('export_report')?.access, 'read-write');
  const device = tool('check_device');
  assert(device?.type === 'function');
  assertEquals(device.answeredBy, 'page');
  assertEquals(profile.models.gemini?.builtInTools, ['googleSearch']);
  assertEquals(profile.models.open?.compaction?.profile, 'research.compactor');
  assertEquals(profile.inputs?.slots?.reader, {
    label: 'Reader',
    choices: [{ value: 'anyone' }, { value: 'reviewer' }, { value: 'student' }],
  });
  assertEquals(Object.keys(profile.guardrails?.detect ?? {}).includes('research.retraction'), true);
  assertEquals(profile.guardrails?.taint?.afterRemoteRead, 'write');
  const readReadme = tool('read_readme');
  assert(readReadme && readReadme.type !== 'agent');
  assertEquals(Object.keys(readReadme.stageQuestions ?? {}), ['passage']);
  assertEquals(dependencies.map((each) => each.profile.id).sort(), [
    'research.compactor',
    'research.illustrator',
    'research.pagereader',
    'research.podcast',
  ]);
  const source = studioSource(run);
  assert(source.includes('Your host runs research.pagereader'));
  assert(!source.includes('stageQuestions'));
  assert(source.includes("registerStructured('research.models'"));
});

Deno.test('every cookbook in COOKBOOKS compiles and slices cleanly', async () => {
  for (const cookbook of Object.values(COOKBOOKS)) {
    compiled(await cookbook.createWorkspace());
  }
  const identitySlice = projectProfileSlice('research', 'research.scout', {
    pick: ['identity', 'inputs'],
  });
  assert(identitySlice.includes('identity:'));
  assert(identitySlice.includes('inputs:'));
  assert(!identitySlice.includes('guardrails:'));

  const toolSlice = projectToolSlice('research', 'search_github', {
    pick: ['endpoint', 'mapping'],
  });
  assert(toolSlice.includes('endpoint:'));
  assert(toolSlice.includes('mapping:'));

  const resolved = resolveCookbookSlice('research:tool:search_github#endpoint,mapping');
  assertEquals(resolved, toolSlice);

  const stitched = stitchCookbook('research', {
    agentId: 'research.scout',
    toolsAllow: ['search_github', 'read_readme'],
    runner: { exportName: 'firstTurn', prompt: RESEARCH_FIRST_TURN_PROMPT },
  });
  assert(stitched.code.includes('export async function firstTurn'));
  compiled(stitched.workspace);
});

Deno.test('the examples between them use every demo tool', () => {
  const used = new Set([
    ...toolNames(createResearchWorkspace()),
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
      identity: { ...view.identity, agentId: 'my.agent', system: firstLine(view, 'Changed.') },
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
      identity: { ...view.identity, agentId, system: firstLine(view, 'Changed.') },
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
    identity: { ...view.identity, system: firstLine(view, 'Changed.') },
  });
  assert(filesPrint(edited) !== filesPrint(first));
});

Deno.test('a change, an added agent, and a removed one are each edits the files do not hold', () => {
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
      identity: { ...view.identity, system: firstLine(view, text) },
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
  assertEquals(by(architect.identity.agentId)?.identity.system[0]?.text, 'Edited in the studio.');
  assertEquals(by(narrator.identity.agentId)?.identity.system[0]?.text, 'Edited in the editor.');
  assertEquals(back.agents.length, edits.agents.length);
  assertEquals(back.toolSpecs[0]?.description, 'From the editor.');
  // Only the builder's own edits are left to save: the starts are the files'.
  assertEquals(back.starts.tools[tool.key]?.description, 'From the editor.');
  assertEquals(back.starts.agents[narrator.key]?.identity.system[0]?.text, 'Edited in the editor.');
  assertEquals(
    back.starts.agents[architect.key]?.identity.system[0]?.text,
    architect.identity.system[0]?.text,
  );
});

Deno.test('opening the files again keeps the keys in use and brings back a removed agent', () => {
  const held = createArchitectWorkspace();
  const [architect, narrator] = held.agents;
  assert(architect && narrator);
  const view = libraryDraft(held, architect.key);
  assert(view);
  const renamed = withLibraryDraft(held, architect.key, {
    ...view,
    identity: { ...view.identity, agentId: 'renamed', system: firstLine(view, 'Changed.') },
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
  const result = compileStudio(narrator, ON_OWN_KEYS);
  assert(result.ok && result.profile.type === 'speech');
  assertEquals(result.profile.speech, { voice: 'Kore', style: narrator.speech.style });

  const fast = compileStudio(
    { ...narrator, speech: { ...narrator.speech, speed: 1.2 } },
    ON_OWN_KEYS,
  );
  assert(fast.ok && fast.profile.type === 'speech');
  assertEquals(fast.profile.speech.speed, 1.2);
});
