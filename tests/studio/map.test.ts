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
  identity: { ...blank.identity, agentId, profileType: 'text' as const },
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
  card: { head: 40, row: 20, foot: 10 },
  columnGap: 100,
  rowGap: 10,
  heading: 30,
  groupGap: 20,
  padding: 20,
};

Deno.test('the map holds every profile, tool, model and provider, joined as the workspace joins them', () => {
  const workspace = opened();
  const [desk, shop] = workspace.agents.map((agent) => agentNodeId(agent.key));
  const map = workspaceMap(workspace);

  assertEquals(
    map.columns.map((column) => column.map((group) => group.label)),
    [['Providers'], ['Models'], ['Profiles'], ['Tools']],
  );
  const [providers, models, agents, tools] = map.columns.map((column) =>
    column.flatMap((group) => group.nodes),
  );
  assertEquals(
    agents?.map((node) => node.label),
    ['desk', 'shop'],
  );
  // A profile is a card of its sections, as the tree lists them; each opens its own.
  assertEquals(
    agents?.[0]?.rows?.map((row) => [row.label, row.note]),
    [
      ['Models', 'small-model'],
      ['Tools', '2'],
      ['Inputs', ''],
      ['Observability', ''],
      ['Wording', ''],
    ],
  );
  assertEquals(agents?.[0]?.rows?.[1]?.opens, agentNodeId(workspace.agents[0]?.key ?? '', 'tools'));
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
  const section = (index: number, facet: string) =>
    agentNodeId(workspace.agents[index]?.key ?? '', facet);
  // The model feeds each profile's Models section, and its provider feeds it.
  assertEquals(
    map.links.filter((link) => link.kind === 'runs'),
    [
      { from: model, to: section(0, 'models'), kind: 'runs' },
      { from: model, to: section(1, 'models'), kind: 'runs' },
    ],
  );
  assertEquals(
    providers?.map((node) => [node.label, node.opens]),
    // A provider opens the first model it serves.
    [[binding?.provider, models?.[0]?.opens]],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'serves'),
    [{ from: providers?.[0]?.id ?? '', to: model, kind: 'serves' }],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'asks'),
    [{ from: toolSpecNodeId('ask_shop'), to: shop, kind: 'asks' }],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'allows').map((link) => [link.from, link.to]),
    [
      [section(0, 'tools'), toolSpecNodeId('find')],
      [section(0, 'tools'), toolSpecNodeId('ask_shop')],
      [section(1, 'tools'), toolSpecNodeId('price')],
    ],
  );

  assertEquals(
    mapNeighbours(map, shop ?? ''),
    new Set([shop, model, toolSpecNodeId('price'), toolSpecNodeId('ask_shop')]),
  );
  assertEquals(mapNeighbours(map, toolSpecNodeId('spare')), new Set([toolSpecNodeId('spare')]));
  assertEquals(mapNeighbours(map, model), new Set([model, providers?.[0]?.id, desk, shop]));
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
        included: [...desk.included, 'guardrails'],
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
    map.columns[1]?.map((group) => group.label),
    ['Shared settings', 'Models'],
  );
  assertEquals(map.columns[1]?.[0]?.nodes, [
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
    // On the section it sets where the profile has it, else on the profile.
    [agentNodeId(desk.key, 'guardrails'), agentNodeId(shop.key), toolSpecNodeId('price')],
  );
  assertEquals(
    map.links.filter((link) => link.kind === 'summarised'),
    [{ from: agentNodeId(desk.key, 'models'), to: agentNodeId(shop.key), kind: 'summarised' }],
  );
  assertEquals(mapLinkWords(map, id), 'Sets desk, shop, price.');
});

Deno.test('the map is laid out in columns, with a line from the side of each node that faces the other', () => {
  const workspace = opened();
  const [desk, shop] = workspace.agents.map((agent) => agentNodeId(agent.key));
  const map = workspaceMap(workspace);
  const layout = mapLayout(map, SIZES);

  // Four columns of 200 with 100 between, 20 around. A profile's card is its head, five sections
  // and its foot, so the profiles column is the tallest: two cards of 150.
  assertEquals(layout.width, 20 + 4 * 200 + 3 * 100 + 20);
  assertEquals(layout.height, 20 + 30 + 2 * 150 + 10 + 20);
  assertEquals(layout.headings, [
    { label: 'Providers', x: 20, y: 20 },
    { label: 'Models', x: 320, y: 20 },
    { label: 'Profiles', x: 620, y: 20 },
    { label: 'Tools', x: 920, y: 20 },
  ]);
  assertEquals(layout.nodes[desk ?? ''], { x: 620, y: 50, height: 150 });
  assertEquals(layout.nodes[shop ?? ''], { x: 620, y: 210, height: 150 });
  assertEquals(layout.nodes[toolSpecNodeId('find')], { x: 920, y: 50, height: 60 });

  const line = (from: string | undefined, to: string | undefined) =>
    layout.lines.find(({ link }) => link.from === from && link.to === to)?.d;
  const tools = agentNodeId(workspace.agents[0]?.key ?? '', 'tools');
  // Left to right: out of the card's right side, level with its Tools section, into the tool's left.
  assertEquals(line(tools, toolSpecNodeId('find')), 'M 820 120 C 870 120, 870 80, 920 80');
  // Right to left: out of the tool's left side, into the card's right, level with its head.
  assertEquals(line(toolSpecNodeId('ask_shop'), shop), 'M 920 150 C 870 150, 870 230, 820 230');
  // The arrowhead sits where the line arrives, heading the way the line does.
  const tip = (from: string | undefined, to: string | undefined) =>
    layout.lines.find(({ link }) => link.from === from && link.to === to)?.tip;
  assertEquals(tip(tools, toolSpecNodeId('find')), { x: 920, y: 80, heading: 1 });
  assertEquals(tip(toolSpecNodeId('ask_shop'), shop), { x: 820, y: 230, heading: -1 });
  // A model's note is one line, so it is as tall as a card's head; a tool's runs to two.
  assertEquals(layout.nodes[map.columns[1]?.[0]?.nodes[0]?.id ?? '']?.height, 40);
  // Each line names the nodes it joins, whichever section it lands on.
  assertEquals(layout.lines.find(({ link }) => link.from === tools)?.from, desk);
  assertEquals(layout.lines.length, map.links.length);
});

Deno.test('a line between two profiles bows out to the right of their column', () => {
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
    'M 820 100 C 870 100, 870 230, 820 230',
  );
});

Deno.test('a node that was moved goes where it was put, and its lines and the map follow it', () => {
  const workspace = opened();
  const [desk] = workspace.agents.map((agent) => agentNodeId(agent.key));
  const map = workspaceMap(workspace);
  const find = toolSpecNodeId('find');
  const tools = agentNodeId(workspace.agents[0]?.key ?? '', 'tools');
  const still = mapLayout(map, SIZES);

  // Put to the left of its profile: the line leaves the card's left side and arrives heading left.
  const left = mapLayout(map, SIZES, { [find]: { x: 320, y: 300 } });
  assertEquals(left.nodes[find], { x: 320, y: 300, height: 60 });
  const line = left.lines.find(({ link }) => link.from === tools && link.to === find);
  assertEquals(line?.d, 'M 620 120 C 570 120, 570 330, 520 330');
  assertEquals(line?.tip, { x: 520, y: 330, heading: -1 });
  // Everything else holds still.
  assertEquals(left.nodes[desk ?? ''], still.nodes[desk ?? '']);
  assertEquals(left.nodes[toolSpecNodeId('ask_shop')], still.nodes[toolSpecNodeId('ask_shop')]);

  // Put under its profile: the line bows round to the right. Put far out: the map grows to hold it.
  const under = mapLayout(map, SIZES, { [find]: { x: 640, y: 500 } });
  assertEquals(
    under.lines.find(({ link }) => link.to === find)?.d,
    'M 820 120 C 890 120, 890 530, 840 530',
  );
  const far = mapLayout(map, SIZES, { [find]: { x: 2000, y: 900 }, gone: { x: 5000, y: 5000 } });
  assertEquals([far.width, far.height], [2000 + 200 + 20, 900 + 60 + 20]);
  // Never off the top or the left.
  assertEquals(mapLayout(map, SIZES, { [find]: { x: -40, y: -40 } }).nodes[find], {
    x: 0,
    y: 0,
    height: 60,
  });
});
