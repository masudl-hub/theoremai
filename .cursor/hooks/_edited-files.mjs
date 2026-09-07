import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = path.join(os.tmpdir(), 'cursor-lint-turn-edits');

function statePath(conversationId) {
	const safe = String(conversationId ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
	return path.join(STATE_DIR, `${safe}.json`);
}

function readState(conversationId) {
	const file = statePath(conversationId);
	if (!existsSync(file)) return { files: [] };
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		const files = Array.isArray(parsed.files)
			? parsed.files.filter((entry) => typeof entry === 'string')
			: [];
		return { files: [...new Set(files.map((entry) => path.resolve(entry)))] };
	} catch {
		return { files: [] };
	}
}

function writeState(conversationId, files) {
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(
		statePath(conversationId),
		JSON.stringify({ files: [...new Set(files.map((entry) => path.resolve(entry)))] }, null, 0),
	);
}

/** Record a file edit for this conversation. */
export function recordEditedFile(conversationId, filePath) {
	if (!conversationId || !filePath) return;
	const absolute = path.resolve(filePath);
	const state = readState(conversationId);
	if (!state.files.includes(absolute)) {
		state.files.push(absolute);
		writeState(conversationId, state.files);
	}
}

/** Return absolute paths edited by this conversation. */
export function getEditedFiles(conversationId) {
	return readState(conversationId).files;
}

/** Clear tracked edits after a clean verification (or abort). */
export function clearEditedFiles(conversationId) {
	if (!conversationId) return;
	const file = statePath(conversationId);
	try {
		unlinkSync(file);
	} catch {
		// Missing state is fine.
	}
}

/** Group absolute file paths under workspace roots. */
export function groupFilesByRoot(files, roots) {
	const resolvedRoots = roots.map((root) => path.resolve(root));
	const groups = new Map(resolvedRoots.map((root) => [root, []]));

	for (const file of files) {
		const absolute = path.resolve(file);
		let bestRoot = null;
		let bestLen = -1;
		for (const root of resolvedRoots) {
			const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
			if ((absolute === root || absolute.startsWith(prefix)) && root.length > bestLen) {
				bestRoot = root;
				bestLen = root.length;
			}
		}
		if (bestRoot) {
			groups.get(bestRoot)?.push(absolute);
		}
	}

	return groups;
}

export function toRelativeFiles(root, files) {
	return files.map((file) => path.relative(root, file)).filter((rel) => rel && !rel.startsWith('..'));
}
