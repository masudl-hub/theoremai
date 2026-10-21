/**
 * The workspace's tree, every row open, drawn as the map draws: each row a map token, and a line
 * from each row down and across to each of its children. Beside the tree, what feeds it: the
 * providers that serve each agent's models, and the tools each agent may call, each with a line
 * into its row. It changes nothing and opens nothing: a picture of what a workspace holds, for a
 * page that is not the studio.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import { IconCloud } from '@tabler/icons-react';
import { useRef } from 'react';
import { mapCurve } from '../map-line.ts';
import {
  createBlankDraft,
  libraryDraft,
  type StudioTreeNode,
  type StudioWorkspace,
  workspaceTree,
} from '../mod.ts';
import { toolTypeIcon } from './lib/type-icons.ts';
import { MapToken, useTokenWidths } from './map-token.tsx';
import { nodeIcon } from './node-icon.ts';
import './tree-map.css';

/** A row's height, and how far in each level of the tree starts. */
const ROW = 32;
const INDENT = 28;
/** Where under a token its children's line runs: the middle of its icon. */
const TRUNK = 13;
/** A token's half height, and the radius of the line's turn. */
const HALF = 11;
const TURN = 8;
const PAD = 16;
/** Between the tree's widest row and the feeds, and between a token's side and its line. */
const GAP = 56;
const LINE_GAP = 4;
/** A token's width until it is measured. */
const GUESS = 120;

interface Place {
  x: number;
  y: number;
}

interface Row extends Place {
  node: StudioTreeNode;
  agent: string;
  parent?: Place;
}

/** A provider or a tool beside the tree, and the rows it feeds. */
interface Feed {
  id: string;
  label: string;
  icon: IconType;
  y: number;
  into: string[];
}

function rowsOf(workspace: StudioWorkspace): Row[] {
  const rows: Row[] = [];
  const walk = (node: StudioTreeNode, agent: string, depth: number, parent?: Row) => {
    const row: Row = {
      node,
      agent,
      x: PAD + depth * INDENT,
      y: PAD + HALF + rows.length * ROW,
      ...(parent ? { parent: { x: parent.x, y: parent.y } } : {}),
    };
    rows.push(row);
    for (const child of node.children) walk(child, agent, depth + 1, row);
  };
  workspaceTree(workspace).agents.forEach((root, index) => {
    walk(root, workspace.agents[index]?.key ?? '', 0);
  });
  return rows;
}

/** A row's token id: the tree's ids repeat from one agent to the next. */
function rowId(row: Row): string {
  return `${row.agent}/${row.node.id}`;
}

/**
 * Each agent's providers, beside its models, and the tools it may call, beside its Tools row. A feed
 * sits level with the middle of the rows it feeds, or under the feed before it when that is lower.
 */
function feedsOf(workspace: StudioWorkspace, rows: Row[]): Feed[] {
  const feeds: Feed[] = [];
  const add = (id: string, label: string, icon: IconType, into: Row[]) => {
    const middle = into.reduce((sum, row) => sum + row.y, 0) / into.length;
    const below = (feeds.at(-1)?.y ?? Number.NEGATIVE_INFINITY) + ROW;
    feeds.push({ id, label, icon, y: Math.max(middle, below), into: into.map(rowId) });
  };
  for (const agent of workspace.agents) {
    const mine = rows.filter((row) => row.agent === agent.key);
    const providers = new Map<string, Row[]>();
    for (const binding of agent.modelBindings) {
      const row = mine.find(
        (each) => each.node.ref.facet === 'modelBinding' && each.node.ref.key === binding.key,
      );
      if (row) providers.set(binding.provider, [...(providers.get(binding.provider) ?? []), row]);
    }
    for (const [provider, into] of providers) {
      add(`${agent.key}/provider:${provider}`, provider, IconCloud, into);
    }
    const tools = mine.find((row) => row.node.ref.facet === 'tools');
    if (!tools) continue;
    for (const key of agent.tools.allow) {
      const tool = workspace.toolSpecs.find((spec) => spec.key === key);
      if (tool) {
        add(`${agent.key}/tool:${key}`, tool.toolName, toolTypeIcon(tool.toolType), [tools]);
      }
    }
  }
  return feeds;
}

/** Down from under the parent's icon, then a turn across to the child. */
function linePath(from: Place, to: Place): string {
  const x = from.x + TRUNK;
  return `M ${x} ${from.y + HALF} V ${to.y - TURN} Q ${x} ${to.y} ${x + TURN} ${to.y} H ${to.x - LINE_GAP}`;
}

export function StudioTreeMap({ workspace }: { workspace: StudioWorkspace }) {
  const root = useRef<HTMLDivElement>(null);
  const rows = rowsOf(workspace);
  const feeds = feedsOf(workspace, rows);
  const widths = useTokenWidths(root, workspace);
  const drafts = new Map(
    workspace.agents.map((agent) => [
      agent.key,
      libraryDraft(workspace, agent.key) ?? createBlankDraft(),
    ]),
  );
  const right = (row: Row) => row.x + (widths[rowId(row)] ?? GUESS);
  const feedX = Math.max(0, ...rows.map(right)) + GAP;
  const byId = new Map(rows.map((row) => [rowId(row), row]));
  const height = PAD * 2 + Math.max(rows.length * ROW, ...feeds.map((feed) => feed.y + HALF - PAD));
  const width = feedX + Math.max(GUESS, ...feeds.map((feed) => widths[feed.id] ?? GUESS)) + PAD;
  return (
    <div ref={root} className="studio-tree-map" style={{ width, height }}>
      <svg className="studio-tree-map-lines" width={width} height={height} aria-hidden="true">
        {rows.map(
          (row) =>
            row.parent && (
              <path key={rowId(row)} className="map-line" d={linePath(row.parent, row)} />
            ),
        )}
        {feeds.flatMap((feed) =>
          feed.into.map((id) => {
            const row = byId.get(id);
            if (!row) return null;
            const { d } = mapCurve(
              { x: feedX - LINE_GAP, y: feed.y },
              { x: right(row) + LINE_GAP, y: row.y },
            );
            return <path key={`${feed.id}>${id}`} className="map-line" d={d} />;
          }),
        )}
      </svg>
      {rows.map((row) => {
        const draft = drafts.get(row.agent) ?? createBlankDraft();
        return (
          <MapToken
            key={rowId(row)}
            id={rowId(row)}
            label={row.node.label}
            icon={nodeIcon(draft, row.node.ref)}
            x={row.x}
            y={row.y}
          />
        );
      })}
      {feeds.map((feed) => (
        <MapToken
          key={feed.id}
          id={feed.id}
          label={feed.label}
          icon={feed.icon}
          x={feedX}
          y={feed.y}
        />
      ))}
    </div>
  );
}
