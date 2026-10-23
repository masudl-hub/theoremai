import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  createArchitectWorkspace,
  createExampleDraft,
  decisionExampleDraft,
  defaultToolSpec,
  type StudioWorkspace,
} from '../../studio/mod.ts';
import {
  type Box,
  drawnAt,
  HALF,
  lineKey,
  placeAt,
  RUNNER,
  rowId,
  TOOL_RUNNER,
  TRACE_DESTINATIONS,
  type TreeMapLayout,
  TURN_STEPS,
  treeMapLayout,
} from '../../studio/ui/lib/tree-map-layout.ts';

/**
 * The code architect without its narrator, the decision example through OpenRouter, and the travel
 * concierge as an agent tool the architect calls: two agents drawn, one provider they share, and a
 * tool of each type.
 */
function pictureWorkspace(): { workspace: StudioWorkspace; agents: string[] } {
  const base = createArchitectWorkspace();
  const narrate = base.toolSpecs.find((tool) => tool.toolType === 'agent');
  const trimmed: StudioWorkspace = {
    ...base,
    agents: base.agents
      .filter((agent) => agent.key !== narrate?.agentKey)
      .map((agent) => ({
        ...agent,
        tools: { ...agent.tools, allow: agent.tools.allow.filter((key) => key !== narrate?.key) },
      })),
    toolSpecs: base.toolSpecs.filter((tool) => tool !== narrate),
  };
  const architect = trimmed.agents[0];
  const jev = decisionExampleDraft();
  const throughOpenRouter = {
    ...jev,
    modelBindings: jev.modelBindings.map((binding) => ({
      ...binding,
      provider: 'openrouter',
      protocol: 'openRouterDecisions',
      apiId: 'typesafe/jev-1.14',
      options: {},
    })),
  };
  const both = addAgent(addAgent(trimmed, throughOpenRouter), createExampleDraft());
  const [, decision, concierge] = both.agents;
  const ask = defaultToolSpec({
    toolName: 'ask_concierge',
    toolType: 'agent',
    agentKey: concierge?.key ?? '',
    description: 'Asks the travel concierge.',
    category: 'demo',
  });
  const convert = both.toolSpecs.find((tool) => tool.toolName === 'convert_units');
  const workspace: StudioWorkspace = {
    ...both,
    agents: both.agents.map((agent) =>
      agent.key === architect?.key
        ? {
            ...agent,
            tools: {
              ...agent.tools,
              allow: [...agent.tools.allow, ...(convert ? [convert.key] : []), ask.key],
            },
          }
        : agent,
    ),
    toolSpecs: [...both.toolSpecs, ask],
  };
  return { workspace, agents: [architect?.key ?? '', decision?.key ?? ''] };
}

function picture(box?: Box): TreeMapLayout {
  const { workspace, agents } = pictureWorkspace();
  const named = treeMapLayout(workspace, agents, () => 0);
  const labels = new Map<string, string>([
    ...named.rows.map((row) => [rowId(row), row.node.label] as const),
    ...named.feeds.map((feed) => [feed.id, feed.label] as const),
  ]);
  return treeMapLayout(workspace, agents, (id) => 40 + 7 * (labels.get(id) ?? '').length, box);
}

const width = (layout: TreeMapLayout, id: string) => {
  const label =
    layout.feeds.find((feed) => feed.id === id)?.label ??
    layout.rows.find((row) => rowId(row) === id)?.node.label ??
    '';
  return 40 + 7 * label.length;
};

const BOX: Box = { width: 860, height: 740 };

for (const box of [undefined, BOX]) {
  Deno.test(`growing, no token of the tree map stands on another${box ? ', filling a box' : ''}`, () => {
    const layout = picture(box);
    const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
    for (let step = 0; step <= 200; step += 1) {
      const grow = step / 200;
      const seen = ids.filter((id) => (drawnAt(layout, id, grow) ?? 1) > 0);
      for (const [index, a] of seen.entries()) {
        for (const b of seen.slice(index + 1)) {
          const [p, q] = [placeAt(layout, a, grow), placeAt(layout, b, grow)];
          const apart =
            p.x + width(layout, a) <= q.x ||
            q.x + width(layout, b) <= p.x ||
            Math.abs(p.y - q.y) >= 2 * HALF;
          assert(apart, `${a} and ${b} meet at ${grow}`);
        }
      }
    }
  });
}

Deno.test('what feeds the tree is shared: one runner, each provider once, its protocols under it', () => {
  const { feeds, rows } = picture();
  const feed = (id: string) => feeds.find((each) => each.id === id);
  const under = (id: string) => feeds.filter((each) => each.under === id).map((each) => each.label);
  const label = (id: string) =>
    rows.find((row) => rowId(row) === id)?.node.label ?? feed(id)?.label ?? id;
  const from = (id: string) => (feed(id)?.from ?? []).map(label);
  assertEquals(
    under(RUNNER),
    TURN_STEPS.map((step) => step.label),
  );
  assertEquals(
    new Set(feeds.filter((each) => each.under === RUNNER).map((each) => each.column)).size,
    1,
  );
  assertEquals(under('provider:gemini'), ['geminiInteractions']);
  assertEquals(under('provider:openrouter').sort(), ['openRouterDecisions', 'openRouterOpenAi']);
  assertEquals(from('provider:openrouter'), ['Provider stream']);
  const tools = feeds.filter((each) => each.kind === 'tool');
  assertEquals(
    tools.map((tool) => tool.of),
    ['function', 'http', 'mcp', 'agent'],
  );
  const mcp = tools.find((tool) => tool.of === 'mcp');
  assertEquals(under(mcp?.id ?? ''), []);
  assertEquals(from(`${TOOL_RUNNER}/sessions`), [mcp?.label]);
  const remote = tools.filter((tool) => tool.of === 'http' || tool.of === 'mcp');
  assertEquals(from(`${TOOL_RUNNER}/network`), [...remote.map((tool) => tool.label), 'Guardrails']);
  assertEquals(from(`${TOOL_RUNNER}/sign-in`), []);
  const agent = tools.find((tool) => tool.of === 'agent');
  const subagent = feeds.find((each) => each.under === agent?.id);
  assertEquals(subagent?.label, 'travel.concierge');
  assert(feed(RUNNER)?.from.includes(subagent?.id ?? ''));
  assertEquals(from(TOOL_RUNNER), ['Tool loop', ...tools.map((tool) => tool.label)]);
  assertEquals(under(TOOL_RUNNER).length, 5);
  assertEquals(from(TRACE_DESTINATIONS), ['Telemetry']);
  assertEquals(from(`${RUNNER}/tools`), ['Tools']);
  assertEquals(from(`${RUNNER}/trace`), ['Observability', 'Observability']);
  assertEquals(
    feeds.map((each) => each.column),
    [...feeds.map((each) => each.column)].sort(),
  );
});

Deno.test('closed the tree map is as it was, and grown every node growing adds has drawn', () => {
  const layout = picture(BOX);
  for (const [id, { x, y }] of layout.closed) assertEquals(placeAt(layout, id, 0), { x, y });
  const added = layout.feeds.filter((feed) => !layout.few.has(feed.id));
  assertEquals(added.length, 18);
  for (const feed of added) {
    assertEquals(drawnAt(layout, feed.id, 0), 0);
    assertEquals(drawnAt(layout, feed.id, 1), 1);
  }
});

Deno.test('grown into a box, the tree map fills it', () => {
  const layout = picture(BOX);
  const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
  const ends = ids.map((id) => ({ id, ...placeAt(layout, id, 1) }));
  const right = Math.max(...ends.map((end) => end.x + width(layout, end.id)));
  const bottom = Math.max(...ends.map((end) => end.y)) + HALF;
  const top = Math.min(...ends.map((end) => end.y)) - HALF;
  assert(Math.abs(BOX.height - 16 - bottom) <= 1, `the map ends at ${bottom}`);
  assert(top >= 16 - 1 && top <= 16 + 1, `the map starts at ${top}`);
  assert(BOX.width - 16 - right <= 2, `the map ends ${BOX.width - 16 - right} short of the box`);
});

Deno.test('grown into a box, each line runs level clear of every token, down its own lane', () => {
  const layout = picture(BOX);
  const at = (id: string) => placeAt(layout, id, 1);
  const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
  const rails = new Set<number>();
  for (const feed of layout.feeds) {
    const lane = layout.lanes.get(feed.id);
    const sources = [...feed.from, ...(feed.late ?? [])];
    if (sources.length === 0) continue;
    assert(lane, `${feed.id} has no lane`);
    const rail = at(lane.of).x - lane.by;
    assert(!rails.has(rail), `${feed.id} shares its lane`);
    rails.add(rail);
    for (const source of sources) {
      let x = at(source).x + width(layout, source);
      let y = at(source).y;
      const level: [number, number, number][] = [];
      for (const jog of layout.jogs.get(lineKey(source, feed.id)) ?? []) {
        const next = at(jog.lane.of).x - jog.lane.by;
        level.push([y, x, next]);
        x = next;
        y = at(jog.near).y + (jog.side * layout.row) / 2;
      }
      level.push([y, x, rail], [at(feed.id).y, rail, at(feed.id).x]);
      for (const [runY, left, right] of level) {
        for (const id of ids.filter((each) => each !== source && each !== feed.id)) {
          const token = at(id);
          const behind =
            token.x < right &&
            token.x + width(layout, id) > left &&
            Math.abs(token.y - runY) < HALF;
          assert(!behind, `${source} to ${feed.id} runs behind ${id}`);
        }
      }
    }
  }
});
