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
  atRest,
  type Box,
  beside,
  drawnAt,
  GUARDRAIL_RUNTIME,
  goneAt,
  HALF,
  HEADING,
  KEY_VAULT,
  LEAVE_TO,
  lineKey,
  PROVIDER_STREAM,
  placeAt,
  rowId,
  TOOL_RUNTIME,
  TRACE_DESTINATIONS,
  type TreeMapLayout,
  TURN_LOOP,
  TURN_STEPS,
  treeMapLayout,
  underKey,
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

const BOX: Box = { width: 860, height: 1010 };

/**
 * Growing, no two tokens at rest meet: a token passes another only on its way, out from under the
 * node it grows from or into its zone.
 */
function assertApartAtRest(layout: TreeMapLayout, ids: string[], wide: (id: string) => number) {
  for (let step = 0; step <= 200; step += 1) {
    const grow = step / 200;
    const still = ids.filter((id) => atRest(layout, id, grow));
    for (const [index, a] of still.entries()) {
      for (const b of still.slice(index + 1)) {
        const [p, q] = [placeAt(layout, a, grow), placeAt(layout, b, grow)];
        const apart =
          p.x + wide(a) <= q.x || q.x + wide(b) <= p.x || Math.abs(p.y - q.y) >= 2 * HALF;
        assert(apart, `${a} and ${b} meet at ${grow}`);
      }
    }
  }
}

for (const box of [undefined, BOX]) {
  Deno.test(`growing, no token of the tree map at rest stands on another${box ? ', filling a box' : ''}`, () => {
    const layout = picture(box);
    const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
    assertApartAtRest(layout, ids, (id) => width(layout, id));
  });
}

Deno.test('what feeds the tree is shared: the registries beside the tree, the runner after them', () => {
  const { feeds, rows } = picture();
  const feed = (id: string) => feeds.find((each) => each.id === id);
  const under = (id: string) => feeds.filter((each) => each.under === id).map((each) => each.label);
  const label = (id: string) =>
    rows.find((row) => rowId(row) === id)?.node.label ?? feed(id)?.label ?? id;
  const from = (id: string) => (feed(id)?.from ?? []).map(label);
  const tools = feeds.filter((each) => each.kind === 'tool');
  assertEquals(
    tools.map((tool) => tool.of),
    ['function', 'http', 'mcp', 'agent'],
  );
  // Columns: the tools, providers and trace destinations as registries beside the tree, then the runner.
  const columnOf = (kind: string) =>
    new Set(feeds.filter((each) => each.kind === kind).map((each) => each.column));
  assertEquals(columnOf('tool'), new Set([1]));
  assertEquals(columnOf('provider'), new Set([1]));
  assertEquals(columnOf('destinations'), new Set([1]));
  assertEquals(columnOf('stream'), new Set([2]));
  assertEquals(columnOf('protocol'), new Set([2]));
  assertEquals(columnOf('tool-runtime'), new Set([2]));
  assertEquals(columnOf('guardrail-runtime'), new Set([2]));
  assertEquals(feed('telemetry')?.column, 2);
  assertEquals(
    feeds.map((each) => each.column),
    [...feeds.map((each) => each.column)].sort(),
  );

  assertEquals(from('provider:openrouter'), []);
  const asked = tools.find((tool) => tool.of === 'agent');
  const subagent = feeds.find((each) => each.under === asked?.id);
  // The agent tool's agent's models stand under their providers, each from the agent under the tool.
  for (const model of feeds.filter((each) => each.kind === 'model'))
    assert(model.from[0] === subagent?.id || from(model.id)[0] === 'Models', model.id);
  assert(feeds.some((each) => each.kind === 'model' && each.from[0] === subagent?.id));
  assertEquals(
    rows.filter((row) => row.node.ref.facet === 'modelBinding'),
    [],
  );
  assertEquals(from('provider:gemini/geminiInteractions'), ['gemini']);
  assertEquals(from('provider:openrouter/openRouterOpenAi'), ['openrouter']);
  assertEquals(from(TRACE_DESTINATIONS), ['Observability', 'Observability']);

  const mcp = tools.find((tool) => tool.of === 'mcp');
  assertEquals(from(`${TOOL_RUNTIME}/sessions`), [mcp?.label]);
  assertEquals(
    from(`${GUARDRAIL_RUNTIME}/network`),
    tools.filter((tool) => tool.of === 'http' || tool.of === 'mcp').map((tool) => tool.label),
  );
  assertEquals(new Set(from(`${GUARDRAIL_RUNTIME}/sanitize`)), new Set(['Inputs']));
  assertEquals(new Set(from(`${GUARDRAIL_RUNTIME}/egress`)), new Set(['Outputs']));
  assertEquals(from(`${GUARDRAIL_RUNTIME}/result`), ['Tool runner']);
  const models = feeds.filter((each) => each.kind === 'model');
  assert(models.length > 0);
  for (const model of models) assert(model.under?.startsWith('provider:'), model.id);
  assertEquals(columnOf('model'), new Set([1]));
  assertEquals(from(`${TOOL_RUNTIME}/sign-in`), ['Key vault']);
  assertEquals(from(PROVIDER_STREAM), ['Key vault']);
  assertEquals(feed(KEY_VAULT)?.column, 1);
  assertEquals(from(TURN_LOOP), ['Turn behaviour']);
  assertEquals(feed(TURN_LOOP)?.column, 2);
  assertEquals(
    from(TOOL_RUNTIME),
    tools.map((tool) => tool.label),
  );
  assertEquals(under(TOOL_RUNTIME), ['Permission gate', 'MCP sessions', 'Authentication']);

  assertEquals(from(GUARDRAIL_RUNTIME), ['Guardrails']);
  assertEquals(under(GUARDRAIL_RUNTIME), [
    'Input guard',
    'Reply guard',
    'Network guard',
    'Tool result guard',
  ]);
  assertEquals(under(PROVIDER_STREAM), [
    'geminiInteractions',
    'openRouterOpenAi',
    'openRouterDecisions',
  ]);
  assertEquals(from('telemetry'), ['Trace destinations']);
  assertEquals(
    TURN_STEPS.map((step) => step.label).filter((label) => label === 'Trace exporter'),
    ['Trace exporter'],
  );

  assertEquals(subagent?.label, 'travel.concierge');
  // Every line runs from a column left of the feed it draws into, or from a feed in its own column.
  for (const each of feeds) {
    for (const source of each.from) {
      const sourceFeed = feed(source);
      if (sourceFeed && sourceFeed.column !== each.column)
        assert(sourceFeed.column < each.column, `${source} runs to ${each.id}`);
    }
  }
});

Deno.test('closed the tree map is as it was, and grown every node growing adds has drawn', () => {
  const layout = picture(BOX);
  for (const [id, { x, y }] of layout.closed) assertEquals(placeAt(layout, id, 0), { x, y });
  // Closed, the models with a line from a row and the tools show; the providers come out over them.
  const added = layout.feeds.filter((feed) => !layout.few.has(feed.id));
  assertEquals(added.length, 23);
  for (const feed of layout.feeds.filter((each) => each.kind === 'provider'))
    assert(!layout.few.has(feed.id), feed.id);
  for (const feed of added) {
    assertEquals(drawnAt(layout, feed.id, 0), 0);
    assertEquals(drawnAt(layout, feed.id, 1), 1);
  }
});

Deno.test('grown, the rows into the turn loop, the tool runner and the guards stand level with them', () => {
  const layout = picture(BOX);
  const at = (id: string) => placeAt(layout, id, 1).y;
  const [agent] = layout.rows;
  const row = (facet: string) => {
    const found = layout.rows.find(
      (each) => each.agent === agent?.agent && each.node.ref.facet === facet,
    );
    assert(found, facet);
    return rowId(found);
  };
  assertEquals(at(row('guardrails')), at(GUARDRAIL_RUNTIME));
  assertEquals(at(row('inputs')), at(`${GUARDRAIL_RUNTIME}/sanitize`));
  assertEquals(at(row('outputs')), at(`${GUARDRAIL_RUNTIME}/egress`));
  const tools = layout.feeds.filter((feed) => feed.kind === 'tool' && feed.column === 1);
  assertEquals(at(TOOL_RUNTIME), Math.min(...tools.map((tool) => at(tool.id))));
  assertEquals(at(row('turnBehaviour')), at(TURN_LOOP));
});

Deno.test('grown into a box, the tree map fills it', () => {
  const layout = picture(BOX);
  const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
  const ends = ids.map((id) => ({ id, ...placeAt(layout, id, 1) }));
  const right = Math.max(...ends.map((end) => end.x + width(layout, end.id)));
  const bottom = Math.max(...ends.map((end) => end.y)) + HALF;
  const top = Math.min(...ends.map((end) => end.y)) - HALF;
  assert(Math.abs(BOX.height - 32 - bottom) <= 1, `the map ends at ${bottom}`);
  assert(top >= 32 + HEADING - 1 && top <= 32 + HEADING + 1, `the map starts at ${top}`);
  for (const heading of layout.headings) assertEquals(heading.y, 32);
  assert(BOX.width - 32 - right <= 2, `the map ends ${BOX.width - 32 - right} short of the box`);
});

Deno.test('grown into a box, each line runs level clear of every token, lines sharing an end down one lane', () => {
  const layout = picture(BOX);
  const at = (id: string) => placeAt(layout, id, 1);
  const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
  const railOf = (source: string, feed: string) => {
    const lane = layout.lanes.get(lineKey(source, feed));
    assert(lane, `${source} to ${feed} has no lane`);
    return at(lane.of).x - lane.by;
  };
  const rails = new Map<number, { source: string; feed: string }[]>();
  for (const feed of layout.feeds) {
    for (const source of [...feed.from, ...(feed.late ?? [])]) {
      if (beside(layout, source, feed)) continue;
      // A line level with its feed runs straight across, with no lane.
      if (at(source).y === at(feed.id).y) {
        assertEquals(layout.lanes.get(lineKey(source, feed.id)), undefined);
        const [left, right] = [at(source).x + width(layout, source), at(feed.id).x];
        for (const id of ids.filter((each) => each !== source && each !== feed.id)) {
          const token = at(id);
          const behind =
            token.x < right &&
            token.x + width(layout, id) > left &&
            Math.abs(token.y - at(source).y) < HALF;
          assert(!behind, `${source} to ${feed.id} runs behind ${id}`);
        }
        continue;
      }
      const rail = railOf(source, feed.id);
      rails.set(rail, [...(rails.get(rail) ?? []), { source, feed: feed.id }]);
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
  for (const [rail, lines] of rails) {
    const one = (pick: (line: { source: string; feed: string }) => string) =>
      new Set(lines.map(pick)).size === 1;
    assert(
      one((line) => line.source) || one((line) => line.feed),
      `the lines at ${rail} share no end`,
    );
  }
  const tools = layout.feeds.filter((feed) => feed.kind === 'tool' && feed.from.length > 0);
  const [source = ''] = tools[0]?.from ?? [];
  const fromTools = tools.filter(
    (tool) => tool.from.includes(source) && at(tool.id).y !== at(source).y,
  );
  assert(fromTools.length > 1);
  assertEquals(new Set(fromTools.map((tool) => railOf(source, tool.id))).size, 1);
});

/**
 * The architect with its narrator, and the decision example the architect calls as make_decision:
 * closed, all three with their models and tools; grown, the architect alone.
 */
function stillPicture(): TreeMapLayout {
  const base = createArchitectWorkspace();
  const narrate = base.toolSpecs.find((tool) => tool.toolType === 'agent');
  const trimmed: StudioWorkspace = {
    ...base,
    agents: base.agents.map((agent) => ({
      ...agent,
      tools: { ...agent.tools, allow: agent.tools.allow.filter((key) => key !== narrate?.key) },
    })),
    toolSpecs: base.toolSpecs.filter((tool) => tool !== narrate),
  };
  // As on the site, the decision agent runs through OpenRouter, the architect's provider.
  const jev = decisionExampleDraft();
  const added = addAgent(trimmed, {
    ...jev,
    modelBindings: jev.modelBindings.map((binding) => ({ ...binding, provider: 'openrouter' })),
  });
  const [architect, narrator, decision] = added.agents;
  const ask = defaultToolSpec({
    toolName: 'make_decision',
    toolType: 'agent',
    agentKey: decision?.key ?? '',
    description: 'Asks the decision agent to make a call.',
    category: 'demo',
  });
  const workspace: StudioWorkspace = {
    ...added,
    agents: added.agents.map((agent) =>
      agent === architect
        ? { ...agent, tools: { ...agent.tools, allow: [...agent.tools.allow, ask.key] } }
        : agent,
    ),
    toolSpecs: [...added.toolSpecs, ask],
  };
  const still = [architect?.key ?? '', narrator?.key ?? '', decision?.key ?? ''];
  const agents = [architect?.key ?? ''];
  const named = treeMapLayout(workspace, agents, () => 0, undefined, still);
  const labels = new Map<string, string>([
    ...[...named.rows, ...named.leaving.rows].map((row) => [rowId(row), row.node.label] as const),
    ...[...named.feeds, ...named.leaving.feeds].map((feed) => [feed.id, feed.label] as const),
  ]);
  const wide = (id: string) => 40 + 7 * (labels.get(id) ?? '').length;
  return treeMapLayout(workspace, agents, wide, BOX, still);
}

Deno.test('closed, the still shows each of its agents whole; grown, the tree alone', () => {
  const layout = stillPicture();
  const roots = layout.rows.filter((row) => row.parent === undefined);
  assertEquals(roots.length, 1);
  // The narrator's rows go, and the decision agent's root glides into make_decision's agent.
  const [[jev, feed] = ['', '']] = [...layout.becomes];
  assert(feed.endsWith('/agent'));
  const { x, y } = layout.closed.get(jev) ?? { x: -1, y: -1 };
  assertEquals(placeAt(layout, feed, 0), { x, y });
  const grown = placeAt(layout, feed, 1);
  const holder = layout.slots.get(feed)?.holder ?? '';
  assert(grown.x > placeAt(layout, holder, 1).x && grown.y > placeAt(layout, holder, 1).y);
  assert(layout.leaving.rows.length > 0);
  for (const row of layout.leaving.rows) assert(layout.closed.has(rowId(row)));
  assert(layout.leaving.rows.some((row) => row.node.label === 'Models'));
  assertEquals(goneAt(0), 0);
  assertEquals(goneAt(LEAVE_TO), 1);
  // Closed, every agent shows its whole profile: the architect's rows all stand in the still, and
  // the others' go with them.
  for (const row of layout.rows)
    assert(layout.closed.has(rowId(row)) && !layout.starts.has(rowId(row)));
  const going = new Set(layout.leaving.rows.map((row) => row.node.label));
  for (const label of ['Speech', 'Guardrails', 'Labels', 'Observability', 'Decision'])
    assert(going.has(label), label);
  // The line into the decision agent draws in.
  assertEquals(drawnAt(layout, underKey(feed), 0), 0);
  assertEquals(drawnAt(layout, underKey(feed), 1), 1);
  // Growing, no two tokens at rest meet.
  const leavingIds = new Set([
    ...layout.leaving.rows.map(rowId),
    ...layout.leaving.feeds.map((each) => each.id),
  ]);
  const ids = [...layout.rows.map(rowId), ...layout.feeds.map((each) => each.id), ...leavingIds];
  const label = (id: string) =>
    [...layout.rows, ...layout.leaving.rows].find((row) => rowId(row) === id)?.node.label ??
    [...layout.feeds, ...layout.leaving.feeds].find((each) => each.id === id)?.label ??
    '';
  const wide = (id: string) => 40 + 7 * label(id).length;
  assertApartAtRest(layout, ids, wide);
});
