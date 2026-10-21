/**
 * The workspace's tree, every row open, drawn as the map draws: each row a map token, and a line
 * from each row down and across to each of its children. It changes nothing and opens nothing: a
 * picture of what a workspace holds, for a page that is not the studio.
 */
import {
  createBlankDraft,
  libraryDraft,
  type StudioTreeNode,
  type StudioWorkspace,
  workspaceTree,
} from '../mod.ts';
import { MapToken } from './map-token.tsx';
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

interface Row {
  node: StudioTreeNode;
  agent: string;
  x: number;
  y: number;
  parent?: { x: number; y: number };
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

/** Down from under the parent's icon, then a turn across to the child. */
function linePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const x = from.x + TRUNK;
  return `M ${x} ${from.y + HALF} V ${to.y - TURN} Q ${x} ${to.y} ${x + TURN} ${to.y} H ${to.x - 4}`;
}

export function StudioTreeMap({ workspace }: { workspace: StudioWorkspace }) {
  const rows = rowsOf(workspace);
  const drafts = new Map(
    workspace.agents.map((agent) => [
      agent.key,
      libraryDraft(workspace, agent.key) ?? createBlankDraft(),
    ]),
  );
  const height = PAD * 2 + rows.length * ROW;
  const width = PAD + Math.max(0, ...rows.map((row) => row.x)) + 240;
  return (
    <div className="studio-tree-map" style={{ width, height }}>
      <svg className="studio-tree-map-lines" width={width} height={height} aria-hidden="true">
        {rows.map(
          (row) =>
            row.parent && (
              <path key={row.node.id} className="map-line" d={linePath(row.parent, row)} />
            ),
        )}
      </svg>
      {rows.map((row) => {
        const draft = drafts.get(row.agent) ?? createBlankDraft();
        return (
          <MapToken
            key={row.node.id}
            id={row.node.id}
            label={row.node.label}
            icon={nodeIcon(draft, row.node.ref)}
            x={row.x}
            y={row.y}
          />
        );
      })}
    </div>
  );
}
