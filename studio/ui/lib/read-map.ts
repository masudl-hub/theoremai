/**
 * The map the loader draws while the studio command reads a project: the setup file on the left,
 * the folders its imports reach as branches, and the agents and tools found in them on the right.
 * Laid out from the steps the command has said so far, to fit a number of rows.
 */
import type { ReadStep } from '../../read-steps.ts';

export type ReadNodeKind = 'entry' | 'folder' | 'profile' | 'tool' | 'more';

export interface ReadNode {
	id: string;
	kind: ReadNodeKind;
	label: string;
	/** The column, the setup file's being 0. */
	col: number;
	/** The row, which may fall between two when the node sits beside several. */
	row: number;
	parent?: string;
	/** The step that first reaches the node: it is drawn once that step is. */
	first: number;
	/** The steps that read a file of the node's own, in order. Each is a dot on the line into it. */
	own: number[];
}

export interface ReadMap {
	nodes: ReadNode[];
	cols: number;
	rows: number;
}

/** How deep folders are told apart before the rows run out. */
const DEPTH = 3;

interface Folder {
	path: string;
	parent?: Folder;
	folders: Map<string, Folder>;
	own: number[];
	found: { kind: 'profile' | 'tool'; name: string; step: number }[];
	/** Folders folded into this one because the rows ran out. */
	folded: number;
}

function folder(path: string, parent?: Folder): Folder {
	return { path, parent, folders: new Map(), own: [], found: [], folded: 0 };
}

function dirOf(file: string): string[] {
	const parts = file.split(/[\\/]/);
	parts.pop();
	return parts;
}

/** The folders the files are in, no deeper than `depth`, each holding the steps that read its files. */
function foldersOf(steps: readonly ReadStep[], depth: number): Folder {
	const root = folder('');
	const at = (file: string): Folder => {
		let here = root;
		for (const part of dirOf(file).slice(0, depth)) {
			let next = here.folders.get(part);
			if (!next) {
				next = folder(here.path ? `${here.path}/${part}` : part, here);
				here.folders.set(part, next);
			}
			here = next;
		}
		return here;
	};
	steps.forEach((step, index) => {
		if ('file' in step && !('found' in step)) at(step.file).own.push(index);
		else if ('found' in step) at(step.file).found.push({ kind: step.found, name: step.name, step: index });
	});
	return root;
}

/** A folder that only holds one other is drawn as that one, named by the whole path. */
function shortened(here: Folder): Folder {
	for (const [name, child] of here.folders) here.folders.set(name, shortened(child));
	const [only] = here.folders.values();
	if (here.parent && here.folders.size === 1 && only && !here.own.length && !here.found.length) {
		only.parent = here.parent;
		return only;
	}
	for (const child of here.folders.values()) child.parent = here;
	return here;
}

function ends(here: Folder): Folder[] {
	if (!here.folders.size) return [here];
	return [...here.folders.values()].flatMap(ends);
}

function firstOf(here: Folder): number {
	const firsts = [...here.own.slice(0, 1), ...here.found.map((found) => found.step)];
	for (const child of here.folders.values()) firsts.push(firstOf(child));
	return Math.min(...firsts);
}

/** Keeps the first folders that fit under the top and folds the rest into the last one kept. */
function folded(root: Folder, rows: number): void {
	const kept = [...root.folders.entries()];
	if (kept.length <= rows) return;
	const [, last] = kept[rows - 1] ?? [];
	if (!last) return;
	for (const [name, extra] of kept.slice(rows)) {
		root.folders.delete(name);
		last.folded += 1;
		const take = (from: Folder) => {
			last.own.push(...from.own);
			last.found.push(...from.found);
			for (const child of from.folders.values()) take(child);
		};
		take(extra);
	}
	last.own.sort((a, b) => a - b);
}

/** The folders as deep as the rows allow. */
function fitted(steps: readonly ReadStep[], rows: number): Folder {
	for (let depth = DEPTH; depth > 1; depth -= 1) {
		const root = shortened(foldersOf(steps, depth));
		if (ends(root).length <= rows) return root;
	}
	const root = shortened(foldersOf(steps, 1));
	folded(root, rows);
	return root;
}

function depthOf(here: Folder): number {
	return Math.max(0, ...[...here.folders.values()].map((child) => 1 + depthOf(child)));
}

/** The map of `steps`, in at most `rows` rows when the project allows it. */
export function readMap(steps: readonly ReadStep[], rows: number): ReadMap {
	const room = Math.max(1, rows);
	const root = fitted(steps, room);
	const all: Folder[] = [];
	const collect = (here: Folder) => {
		all.push(here);
		for (const child of here.folders.values()) collect(child);
	};
	collect(root);
	// Each folder that ends a branch takes a row, with or without anything found in it.
	const holding = all.filter((each) => each.found.length);
	const bare = ends(root).filter((each) => !each.found.length && each !== root).length;
	const each = Math.max(1, Math.floor((room - bare) / Math.max(1, holding.length)));
	const foundCol = depthOf(root) + 1;
	const nodes: ReadNode[] = [];
	let row = 0;

	const place = (here: Folder, col: number, parent?: string): [number, number] => {
		const id = here === root ? 'entry' : `folder:${here.path}`;
		const from = row;
		for (const child of here.folders.values()) place(child, col + 1, id);
		const shown = here.found.length > each ? here.found.slice(0, each - 1) : here.found;
		for (const found of shown) {
			nodes.push({ id: `${found.kind}:${found.name}`, kind: found.kind, label: found.name, col: foundCol, row, parent: id, first: found.step, own: [] });
			row += 1;
		}
		const rest = here.found.slice(shown.length);
		if (rest.length) {
			const label = `${String(rest.length)} ${shown.length ? 'more' : 'agents and tools'}`;
			nodes.push({ id: `more:${here.path}`, kind: 'more', label, col: foundCol, row, parent: id, first: rest[0]?.step ?? 0, own: [] });
			row += 1;
		}
		if (row === from) row += 1;
		const span: [number, number] = [from, row - 1];
		const name = here.path.slice(here.parent && here.parent !== root ? here.parent.path.length + 1 : 0);
		nodes.push({
			id,
			kind: here === root ? 'entry' : 'folder',
			label: here.folded ? `${name} and ${String(here.folded)} more` : name,
			col,
			row: (span[0] + span[1]) / 2,
			...(parent === undefined ? {} : { parent }),
			first: here === root ? 0 : firstOf(here),
			own: here.own,
		});
		return span;
	};
	place(root, 0);
	const entry = steps.find((step): step is { file: string } => 'file' in step && !('found' in step));
	const top = nodes.find((node) => node.id === 'entry');
	if (top) top.label = entry?.file.split(/[\\/]/).pop() ?? '';
	return { nodes, cols: foundCol + 1, rows: row };
}
