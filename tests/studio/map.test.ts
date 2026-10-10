import { assertEquals } from '@std/assert';
import {
  createBlankDraft,
  defaultModelBinding,
  newToolSpec,
  type ToolSpecDraft,
} from '../../studio/draft.ts';
import { mapLayout, mapLinkWords, mapNeighbours, workspaceMap } from '../../studio/map.ts';
import type { SharedSetting } from '../../studio/server/save-wire.ts';
import { sharedEntries } from '../../studio/shared-settings.ts';
import { modelBindingNodeId, toolSpecNodeId } from '../../studio/tree.ts';
import {
  addAgent,
  agentNodeId,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../../studio/workspace.ts';

const blank = createBlankDraft();
const named = (agentId: string) => ({
  ...blank,
  identity: { ...blank.identity, agentId },
  modelBindings: [defaultModelBinding({ key: `${agentId}-model`, modelId: 'small-model' })],
});
const tool = (key: string, over: Partial<ToolSpecDraft> = {}): ToolSpecDraft => ({
  ...newToolSpec(blank),
  key,
  toolName: key,
  description: `Does ${key}.`,
  ...over,
});

/** `desk` allows `find` and asks `shop` through `ask_shop`; `shop` allows `price`; nothing allows `spare`. */
function opened(): StudioWorkspace {
  const start = addAgent(workspaceFromDraft(named('desk')), named('shop'));
  const [desk, shop] = start.agents;
  if (!desk || !shop) throw new Error('two agents');
  return {
    ...start,
    agents: [
      { ...desk, tools: { ...desk.tools, allow: ['find', 'ask_shop'] } },
      { ...shop, tools: { ...shop.tools, allow: ['price'] } },
    ],
    toolSpecs: [
      tool('spare'),
      tool('price'),
      tool('ask_shop', { toolType: 'agent', agentKey: shop.key }),
      tool('find'),
    ],
  };
}

const SIZES = {
  node: { width: 200, height: 60 },
  columnGap: 100,
  rowGap: 10,
  heading: 30,
  groupGap: 20,
  padding: 20,
};

Deno.test('the map holds every agent, tool and model, joined as the workspace joins them', () => {
  const workspace = opened();
  const [desk, shop] = workspace.agents.map((agent) => agentNodeId(agent.key));
  const map = workspaceMap(workspace);

  assertEquals(
    map.columns.map((column) => column.map((group) => group.label)),
    [['Models'], ['Agents'], ['Tools']],
  );
  const [models, agents, tools] = map.columns.map((column) =>
    column.flatMap((group) => group.nodes),
  );
  assertEquals(
    agents?.map((node) => node.label),
    ['desk', 'shop'],
  );
  // Tools follow the agents that allow them; one no agent allows goes last.
  assertEquals(
    tools?.map((node) => node.label),
    ['find', 'ask_shop', 'price', 'spare'],
  );
  assertEquals(tools?.[0]?.note, 'Does find.');

  // Both agents start on the same model: one node, joined to each, opening the first agent's.
  const binding = workspace.agents[0]?.modelBindings[0];
  assertEquals(models?.length, 1);
  assertEquals(
    models?.[0]?.opens,
    agentNodeId(workspace.agents[0]?.key ?? '', modelBindingNodeId(binding?.key ?? '')),
  );
  const model = models?.[0]?.id ?? '';
  assertEquals(
    map.links.filter((link) => link.kind === 'runs'),
    [
      { from: model, to: desk, kind: 'runs' },
      { from: model, to: shop, kind: 'runs' },
    ],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'asks'),
    [{ from: toolSpecNodeId('ask_shop'), to: shop, kind: 'asks' }],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'allows').map((link) => [link.from, link.to]),
    [
      [desk, toolSpecNodeId('find')],
      [desk, toolSpecNodeId('ask_shop')],
      [shop, toolSpecNodeId('price')],
    ],
  );

  assertEquals(
    mapNeighbours(map, shop ?? ''),
    new Set([shop, model, toolSpecNodeId('price'), toolSpecNodeId('ask_shop')]),
  );
  assertEquals(mapNeighbours(map, toolSpecNodeId('spare')), new Set([toolSpecNodeId('spare')]));
  assertEquals(
    mapLinkWords(map, shop ?? ''),
    `Runs on ${models?.[0]?.label ?? ''}. Allows price. Asked by ask_shop.`,
  );
  assertEquals(mapLinkWords(map, toolSpecNodeId('spare')), '');
});

Deno.test('the map shows a shared setting over what it sets, and an agent that writes another its summaries', () => {
  const start = opened();
  const [desk, shop] = start.agents;
  if (!desk || !shop) throw new Error('two agents');
  const workspace: StudioWorkspace = {
    ...start,
    agents: [
      {
        ...desk,
        modelBindings: desk.modelBindings.map((binding) => ({ ...binding, compactWith: shop.key })),
      },
      shop,
    ],
  };
  const setting: SharedSetting = {
    name: 'STANDARD_GUARDRAILS',
    label: 'Standard guardrails',
    file: 'setup.ts',
    line: 4,
    key: 'guardrails',
    profiles: ['desk', 'shop'],
    tools: ['price'],
    readByCode: false,
  };
  const map = workspaceMap(workspace, sharedEntries(workspace, [setting]));
  const id = 'shared:setup.ts:STANDARD_GUARDRAILS';

  assertEquals(
    map.columns[0]?.map((group) => group.label),
    ['Shared settings', 'Models'],
  );
  assertEquals(map.columns[0]?.[0]?.nodes, [
    {
      id,
      kind: 'shared',
      label: 'Standard guardrails',
      note: 'STANDARD_GUARDRAILS · setup.ts:4',
      opens: agentNodeId(desk.key, 'guardrails'),
      type: 'guardrails',
    },
  ]);
  assertEquals(
    map.links.filter((link) => link.kind === 'sets').map((link) => link.to),
    [agentNodeId(desk.key), agentNodeId(shop.key), toolSpecNodeId('price')],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'summarised'),
    [{ from: agentNodeId(desk.key), to: agentNodeId(shop.key), kind: 'summarised' }],
  );
  assertEquals(mapLinkWords(map, id), 'Sets desk, shop, price.');
});

Deno.test('the map is laid out in columns, with a line from the side of each node that faces the other', () => {
  const workspace = opened();
  const [desk, shop] = workspace.agents.map((agent) => agentNodeId(agent.key));
  const map = workspaceMap(workspace);
  const layout = mapLayout(map, SIZES);

  // Three columns of 200 with 100 between, 20 around; the tools column is the tallest: four nodes.
  assertEquals(layout.width, 20 + 200 + 100 + 200 + 100 + 200 + 20);
  assertEquals(layout.height, 20 + 30 + 4 * 60 + 3 * 10 + 20);
  assertEquals(layout.headings, [
    { label: 'Models', x: 20, y: 20 },
    { label: 'Agents', x: 320, y: 20 },
    { label: 'Tools', x: 620, y: 20 },
  ]);
  assertEquals(layout.nodes[desk ?? ''], { x: 320, y: 50 });
  assertEquals(layout.nodes[shop ?? ''], { x: 320, y: 120 });
  assertEquals(layout.nodes[toolSpecNodeId('find')], { x: 620, y: 50 });

  const line = (from: string | undefined, to: string | undefined) =>
    layout.lines.find(({ link }) => link.from === from && link.to === to)?.d;
  // Left to right: out of the agent's right side, into the tool's left.
  assertEquals(line(desk, toolSpecNodeId('find')), 'M 520 80 C 570 80, 570 80, 620 80');
  // Right to left: out of the tool's left side, into the agent's right.
  assertEquals(line(toolSpecNodeId('ask_shop'), shop), 'M 620 150 C 570 150, 570 150, 520 150');
  assertEquals(layout.lines.length, map.links.length);
});

Deno.test('a line between two agents bows out to the right of their column', () => {
  const start = opened();
  const [desk, shop] = start.agents;
  if (!desk || !shop) throw new Error('two agents');
  const workspace: StudioWorkspace = {
    ...start,
    agents: [
      {
        ...desk,
        modelBindings: desk.modelBindings.map((binding) => ({ ...binding, compactWith: shop.key })),
      },
      shop,
    ],
  };
  const layout = mapLayout(workspaceMap(workspace), SIZES);
  assertEquals(
    layout.lines.find(({ link }) => link.kind === 'summarised')?.d,
    'M 520 80 C 570 80, 570 150, 520 150',
  );
});
