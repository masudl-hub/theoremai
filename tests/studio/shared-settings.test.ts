import { assertEquals } from '@std/assert';
import { createBlankDraft } from '../../studio/draft.ts';
import type { SharedSetting } from '../../studio/server/save-wire.ts';
import {
  sharedAt,
  sharedEntries,
  sharedLinks,
  sharedNodeId,
} from '../../studio/shared-settings.ts';
import {
  type AgentDraft,
  addAgent,
  type StudioWorkspace,
  withSharedCarried,
  workspaceFromDraft,
} from '../../studio/workspace.ts';

const blank = createBlankDraft();
const named = (agentId: string) => ({ ...blank, identity: { ...blank.identity, agentId } });

/** Three agents: `desk` and `shop` share their guardrails, `yard` has its own. */
function opened(): StudioWorkspace {
  return ['shop', 'yard'].reduce(
    (workspace, id) => addAgent(workspace, named(id)),
    workspaceFromDraft(named('desk')),
  );
}

const setting = (over: Partial<SharedSetting>): SharedSetting => ({
  name: 'STANDARD_GUARDRAILS',
  label: 'Standard guardrails',
  file: 'shared.ts',
  line: 1,
  key: 'guardrails',
  profiles: ['desk', 'shop'],
  tools: [],
  readByCode: false,
  ...over,
});

const agent = (workspace: StudioWorkspace, id: string): AgentDraft => {
  const found = workspace.agents.find((each) => each.identity.agentId === id);
  if (!found) throw new Error(`No agent ${id}.`);
  return found;
};

/** `workspace` with one agent changed. */
const edit = (
  workspace: StudioWorkspace,
  id: string,
  change: (agent: AgentDraft) => AgentDraft,
) => ({
  ...workspace,
  agents: workspace.agents.map((each) => (each.identity.agentId === id ? change(each) : each)),
});

Deno.test('a shared setting is edited in the section its key fills, on the agents that share it', () => {
  const workspace = opened();
  const [desk, shop] = [agent(workspace, 'desk').key, agent(workspace, 'shop').key];
  const entries = sharedEntries(workspace, [
    setting({}),
    setting({ name: 'MODELS', key: 'models' }),
    // Not the whole of a section, or read by a profile the studio could not open: changed in code.
    setting({ name: 'STEPS', key: 'maxSteps' }),
    setting({ name: 'tone', key: undefined }),
    setting({ name: 'LIMITS', profiles: ['desk', 'gone'] }),
  ]);
  assertEquals(
    entries.map(({ facet, agents }) => [facet, agents]),
    [
      ['guardrails', [desk, shop]],
      ['models', [desk, shop]],
      [undefined, [desk, shop]],
      [undefined, [desk, shop]],
      [undefined, [desk]],
    ],
  );
  assertEquals(sharedLinks(entries), [
    { fields: ['guardrails'], agents: [desk, shop] },
    { fields: ['modelBindings'], agents: [desk, shop] },
  ]);
  const [guardrails, models] = entries;
  if (!guardrails || !models) throw new Error('No entries.');
  assertEquals(sharedNodeId(guardrails, shop), `agent:${shop}/guardrails`);
  assertEquals(sharedAt(entries, `agent:${shop}/guardrails`), guardrails);
  assertEquals(sharedAt(entries, `agent:${desk}/modelBinding:model-1`), models);
  assertEquals(sharedAt(entries, `agent:${desk}/models`), models);
  assertEquals(sharedAt(entries, `agent:${desk}`), undefined);
  assertEquals(sharedAt(entries, `agent:${agent(workspace, 'yard').key}/guardrails`), undefined);
});

Deno.test('a change to a shared setting is made on every agent that shares it, and on no other', () => {
  const before = opened();
  const links = sharedLinks(sharedEntries(before, [setting({})]));
  // What the two set apart in the same section stays apart.
  const apart = edit(before, 'shop', (shop) => ({
    ...shop,
    guardrails: { ...shop.guardrails, quotaMessage: 'Come back tomorrow.' },
  }));
  const after = edit(apart, 'desk', (desk) => ({
    ...desk,
    guardrails: { ...desk.guardrails, quotaEnabled: !desk.guardrails.quotaEnabled },
    identity: { ...desk.identity, handle: 'Desk' },
  }));
  const carried = withSharedCarried(apart, after, links);
  const [desk, shop, yard] = ['desk', 'shop', 'yard'].map((id) => agent(carried, id));
  assertEquals(shop?.guardrails.quotaEnabled, desk?.guardrails.quotaEnabled);
  assertEquals(shop?.guardrails.quotaMessage, 'Come back tomorrow.');
  assertEquals(shop?.identity.handle, agent(before, 'shop').identity.handle);
  assertEquals(yard, agent(before, 'yard'));

  // Nothing shared moved: the workspace is the one given.
  const renamed = edit(before, 'yard', (each) => ({
    ...each,
    guardrails: { ...each.guardrails, quotaEnabled: true },
  }));
  assertEquals(withSharedCarried(before, renamed, links) === renamed, true);
  assertEquals(withSharedCarried(before, before, links) === before, true);
});
