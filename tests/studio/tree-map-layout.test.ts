import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  createArchitectWorkspace,
  createLiveExampleDraft,
  decisionExampleDraft,
} from '../../studio/mod.ts';
import {
  drawnAt,
  HALF,
  placeAt,
  rowId,
  type TreeMapLayout,
  treeMapLayout,
} from '../../studio/ui/lib/tree-map-layout.ts';

/** The architect, the decision example and the concierge: three runners, a turn's steps and every tool type. */
function picture(): TreeMapLayout {
  const base = createArchitectWorkspace();
  const workspace = addAgent(addAgent(base, decisionExampleDraft()), createLiveExampleDraft());
  const added = workspace.agents.slice(base.agents.length).map((agent) => agent.key);
  const agents = [base.agents[0]?.key ?? '', ...added];
  const named = treeMapLayout(workspace, agents, () => 0);
  const labels = new Map<string, string>([
    ...named.rows.map((row) => [rowId(row), row.node.label] as const),
    ...named.feeds.map((feed) => [feed.id, feed.label] as const),
  ]);
  return treeMapLayout(workspace, agents, (id) => 40 + 7 * (labels.get(id) ?? '').length);
}

const width = (layout: TreeMapLayout, id: string) => {
  const label =
    layout.feeds.find((feed) => feed.id === id)?.label ??
    layout.rows.find((row) => rowId(row) === id)?.node.label ??
    '';
  return 40 + 7 * label.length;
};

Deno.test('growing, no token of the tree map stands on another', () => {
  const layout = picture();
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

Deno.test('closed the tree map is as it was, and grown every node growing adds has drawn', () => {
  const layout = picture();
  for (const [id, { x, y }] of layout.closed) assertEquals(placeAt(layout, id, 0), { x, y });
  const added = layout.feeds.filter((feed) => !layout.few.has(feed.id));
  assert(added.length > 30);
  for (const feed of added) {
    assertEquals(drawnAt(layout, feed.id, 0), 0);
    assertEquals(drawnAt(layout, feed.id, 1), 1);
  }
});
