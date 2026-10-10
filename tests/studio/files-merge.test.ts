import { assert, assertEquals } from '@std/assert';
import {
  atStart,
  createArchitectWorkspace,
  duplicateAgent,
  libraryDraft,
  mergedWithFiles,
  removeAgent,
  removeLibraryTool,
  type StudioDraft,
  type StudioWorkspace,
  startedHere,
  withFilesChosen,
  withLibraryDraft,
} from '../../studio/mod.ts';

/** One agent's draft changed, as the editor form changes it. */
function edit(workspace: StudioWorkspace, key: string, change: (draft: StudioDraft) => StudioDraft) {
  const view = libraryDraft(workspace, key);
  assert(view);
  return withLibraryDraft(workspace, key, change(view));
}

const system = (text: string) => (draft: StudioDraft): StudioDraft => ({
  ...draft,
  identity: { ...draft.identity, system: text },
});
const handle = (text: string) => (draft: StudioDraft): StudioDraft => ({
  ...draft,
  identity: { ...draft.identity, handle: text },
});

/** The project's files after the builder's editor changed them: a new open, with keys of its own. */
function filesAfter(change: (opened: StudioWorkspace) => StudioWorkspace): StudioWorkspace {
  return startedHere(change(createArchitectWorkspace()));
}

const first = (workspace: StudioWorkspace) => {
  const [agent] = workspace.agents;
  assert(agent);
  return agent;
};

Deno.test('files that say what they said merge to the same edits, with nothing to tell', () => {
  const old = createArchitectWorkspace();
  const edits = edit(old, first(old).key, system('Mine.'));
  const merge = mergedWithFiles(edits, createArchitectWorkspace(), old);
  assertEquals(merge.updated, []);
  assertEquals(merge.conflicts, []);
  assertEquals(merge.workspace.agents, edits.agents);
  assertEquals(merge.workspace.toolSpecs, edits.toolSpecs);
});

Deno.test('a setting only the files changed is the files\', and the builder keeps their own beside it', () => {
  const old = createArchitectWorkspace();
  const key = first(old).key;
  const edits = edit(old, key, system('Mine.'));
  const files = filesAfter((opened) => edit(opened, first(opened).key, handle('from-editor')));
  const merge = mergedWithFiles(edits, files, old);
  const agent = first(merge.workspace);
  assertEquals(agent.key, key);
  assertEquals(agent.identity.system, 'Mine.');
  assertEquals(agent.identity.handle, 'from-editor');
  assertEquals(merge.conflicts, []);
  assertEquals(merge.updated.map((each) => [each.kind, each.key, each.path.join('.')]), [
    ['agent', key, 'identity.handle'],
  ]);
  // The files' value is the start, so only the builder's edit is left to save.
  assertEquals(merge.workspace.starts.agents[key]?.identity.handle, 'from-editor');
  assertEquals(merge.workspace.starts.agents[key]?.identity.system, first(old).identity.system);
});

Deno.test('with no edits here the merge is the files, at their start', () => {
  const old = createArchitectWorkspace();
  const files = filesAfter((opened) => edit(opened, first(opened).key, system('Theirs.')));
  const merge = mergedWithFiles(old, files, old);
  assertEquals(first(merge.workspace).identity.system, 'Theirs.');
  assertEquals(merge.updated.length, 1);
  assert(atStart(merge.workspace));
});

Deno.test('both making the same change is no conflict', () => {
  const old = createArchitectWorkspace();
  const edits = edit(old, first(old).key, system('Agreed.'));
  const files = filesAfter((opened) => edit(opened, first(opened).key, system('Agreed.')));
  const merge = mergedWithFiles(edits, files, old);
  assertEquals(merge.conflicts, []);
  assertEquals(merge.updated, []);
  assert(atStart(merge.workspace));
});

Deno.test('a setting both changed is a conflict: the builder\'s stands until they take the files\'', () => {
  const old = createArchitectWorkspace();
  const key = first(old).key;
  const edits = edit(edit(old, key, system('Mine.')), key, handle('mine'));
  const files = filesAfter((opened) => edit(opened, first(opened).key, system('Theirs.')));
  const merge = mergedWithFiles(edits, files, old);
  assertEquals(merge.conflicts.map(({ kind, key, path, mine, theirs }) => ({ kind, key, path, mine, theirs })), [
    { kind: 'agent', key, path: ['identity', 'system'], mine: 'Mine.', theirs: 'Theirs.' },
  ]);
  assertEquals(first(merge.workspace).identity.system, 'Mine.');
  assertEquals(first(withFilesChosen(merge, [])).identity.system, 'Mine.');
  const taken = withFilesChosen(merge, [0]);
  assertEquals(first(taken).identity.system, 'Theirs.');
  // The edit that did not conflict stays either way.
  assertEquals(first(taken).identity.handle, 'mine');
});

Deno.test('a model the builder changed and another setting of it the files changed both hold', () => {
  const old = createArchitectWorkspace();
  const key = first(old).key;
  const [binding] = first(old).modelBindings;
  assert(binding);
  const bound = (workspace: StudioWorkspace, agentKey: string, change: Record<string, unknown>) =>
    edit(workspace, agentKey, (draft) => ({
      ...draft,
      modelBindings: draft.modelBindings.map((each, at) => (at === 0 ? { ...each, ...change } : each)),
    }));
  const edits = bound(old, key, { temperature: 0.11 });
  const files = filesAfter((opened) => bound(opened, first(opened).key, { maxOutputTokens: 321 }));
  const merge = mergedWithFiles(edits, files, old);
  assertEquals(merge.conflicts, []);
  const [merged] = first(merge.workspace).modelBindings;
  assertEquals(merged?.key, binding.key);
  assertEquals(merged?.temperature, 0.11);
  assertEquals(merged?.maxOutputTokens, 321);
});

Deno.test('tools each side allowed are all allowed', () => {
  const old = createArchitectWorkspace();
  const agent = first(old);
  const [tool, other] = old.toolSpecs;
  assert(tool && other);
  const without = (workspace: StudioWorkspace, name: string): StudioWorkspace => {
    const gone = workspace.toolSpecs.find((each) => each.toolName === name)?.key;
    return {
      ...workspace,
      agents: workspace.agents.map((each, at) =>
        at === 0 ? { ...each, tools: { ...each.tools, allow: each.tools.allow.filter((k) => k !== gone) } } : each
      ),
    };
  };
  const held = agent.tools.allow.map((k) => old.toolSpecs.find((each) => each.key === k)?.toolName ?? '');
  if (held.length < 2) return;
  const [mineGone, theirsGone] = held as [string, string];
  const edits = without(old, mineGone);
  const files = filesAfter((opened) => without(opened, theirsGone));
  const merge = mergedWithFiles(edits, files, old);
  assertEquals(merge.conflicts, []);
  const names = first(merge.workspace).tools.allow.map((k) =>
    merge.workspace.toolSpecs.find((each) => each.key === k)?.toolName
  );
  assertEquals(names, held.filter((name) => name !== mineGone && name !== theirsGone));
});

Deno.test('an agent the files add comes in, and one they remove goes unless the builder changed it', () => {
  const old = createArchitectWorkspace();
  const [architect, narrator] = old.agents;
  assert(architect && narrator);
  const files = filesAfter((opened) => removeAgent(opened, opened.agents[1]?.key ?? ''));
  const untouched = mergedWithFiles(old, files, old);
  assertEquals(untouched.workspace.agents.map((agent) => agent.key), [architect.key]);
  assertEquals(untouched.conflicts, []);

  const merge = mergedWithFiles(edit(old, narrator.key, system('Mine.')), files, old);
  assertEquals(merge.conflicts.map((each) => [each.key, each.path, each.theirs]), [[narrator.key, [], undefined]]);
  assertEquals(merge.workspace.agents.length, 2);
  assertEquals(withFilesChosen(merge, [0]).agents.map((agent) => agent.key), [architect.key]);

  // The other way: the files hold one more agent than the studio opened.
  const fewer = startedHere(removeAgent(old, narrator.key));
  const added = mergedWithFiles(fewer, createArchitectWorkspace(), fewer);
  assertEquals(added.workspace.agents.map((agent) => agent.identity.agentId), [
    architect.identity.agentId,
    narrator.identity.agentId,
  ]);
  assertEquals(added.conflicts, []);
});

Deno.test('an agent the builder removed stays removed, and is a conflict when the files changed it', () => {
  const old = createArchitectWorkspace();
  const [architect, narrator] = old.agents;
  assert(architect && narrator);
  const edits = removeAgent(old, narrator.key);
  const elsewhere = filesAfter((opened) => edit(opened, first(opened).key, system('Theirs.')));
  const merge = mergedWithFiles(edits, elsewhere, old);
  assertEquals(merge.workspace.agents.map((agent) => agent.key), [architect.key]);
  assertEquals(merge.conflicts, []);
  assertEquals(first(merge.workspace).identity.system, 'Theirs.');

  const onIt = filesAfter((opened) => edit(opened, opened.agents[1]?.key ?? '', system('Theirs.')));
  const clash = mergedWithFiles(edits, onIt, old);
  assertEquals(clash.conflicts.map((each) => [each.kind, each.name, each.path, each.mine]), [
    ['agent', narrator.identity.agentId, [], undefined],
  ]);
  assertEquals(clash.workspace.agents.length, 1);
  const back = withFilesChosen(clash, [0]);
  assertEquals(back.agents.map((agent) => agent.identity.agentId), [
    architect.identity.agentId,
    narrator.identity.agentId,
  ]);
  assertEquals(back.agents[1]?.identity.system, 'Theirs.');
  // The tool that ran it comes back with it, for the agent the files let use it.
  const ran = back.toolSpecs.find((tool) => tool.agentKey === back.agents[1]?.key);
  assert(ran && back.agents[0]?.tools.allow.includes(ran.key));
});

Deno.test('a tool the builder removed stays removed when the files left it alone', () => {
  const old = createArchitectWorkspace();
  const [tool] = old.toolSpecs;
  assert(tool);
  const edits = removeLibraryTool(old, tool.key);
  const files = filesAfter((opened) => edit(opened, first(opened).key, system('Theirs.')));
  const merge = mergedWithFiles(edits, files, old);
  assertEquals(merge.conflicts, []);
  assert(!merge.workspace.toolSpecs.some((each) => each.toolName === tool.toolName));
});

Deno.test('a tool the files changed is the files\', under the key the studio holds it by', () => {
  const old = createArchitectWorkspace();
  const [tool] = old.toolSpecs;
  assert(tool);
  const files = filesAfter((opened) => ({
    ...opened,
    toolSpecs: opened.toolSpecs.map((each, at) => (at === 0 ? { ...each, description: 'From the editor.' } : each)),
  }));
  const merge = mergedWithFiles(edit(old, first(old).key, system('Mine.')), files, old);
  assertEquals(merge.workspace.toolSpecs[0]?.key, tool.key);
  assertEquals(merge.workspace.toolSpecs[0]?.description, 'From the editor.');
  assertEquals(merge.updated.map((each) => [each.kind, each.name, each.path.join('.')]), [
    ['tool', tool.toolName, 'description'],
  ]);
  assertEquals(first(merge.workspace).identity.system, 'Mine.');
});

Deno.test('an agent the builder added stays through a change to the files, edited or not', () => {
  const old = createArchitectWorkspace();
  const added = duplicateAgent(old, first(old).key);
  const copy = added.agents[1];
  assert(copy);
  const files = filesAfter((opened) => edit(opened, first(opened).key, system('Theirs.')));
  for (const edits of [added, edit(added, copy.key, system('Mine.'))]) {
    const merge = mergedWithFiles(edits, files, old);
    assertEquals(merge.conflicts, []);
    assertEquals(merge.workspace.agents.map((agent) => agent.key), edits.agents.map((agent) => agent.key));
    assertEquals(first(merge.workspace).identity.system, 'Theirs.');
    assertEquals(merge.workspace.starts.agents[copy.key], added.starts.agents[copy.key]);
  }
  // With no reading of the old files to say otherwise, nothing the studio holds is taken away.
  assertEquals(mergedWithFiles(added, files).workspace.agents.length, added.agents.length);
});
