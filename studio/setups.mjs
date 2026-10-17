/**
 * The setups a project has, and choosing one of them.
 *
 * A setup is a file named `studio.setup.ts`, or `<name>.studio.setup.ts` when a project keeps more
 * than one. The first is named for the folder it sits in.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';

const SETUP_FILE = /^(?:(.+)\.)?studio\.setup\.(?:ts|tsx|mts|js|mjs)$/;
/** Folders that hold installed or built files, never a setup. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', 'tmp', 'test-results']);
/** How many folders down from the project a setup is looked for. */
const DEPTH = 4;

/**
 * @typedef {{ name: string, file: string }} Setup `file` is relative to the project, with `/`.
 * @typedef {{ setups: readonly Setup[], at: number, chosen?: Setup, left?: true }} Picker
 * @typedef {'up' | 'down' | 'choose' | 'leave'} PickerKey
 */

/**
 * The setup a file is, or nothing when its name is not a setup's.
 * @param {string} file relative to the project, with `/`
 * @param {string} project the project folder's name
 * @returns {Setup | undefined}
 */
export function setupOf(file, project) {
	const parts = file.split('/');
	const match = SETUP_FILE.exec(parts[parts.length - 1]);
	if (!match) return undefined;
	return { name: match[1] ?? parts[parts.length - 2] ?? project, file };
}

/**
 * Every setup among these files, by name and then by path.
 * @param {readonly string[]} files relative to the project, with `/`
 * @param {string} project the project folder's name
 * @returns {Setup[]}
 */
export function setupsAmong(files, project) {
	return files
		.flatMap((file) => setupOf(file, project) ?? [])
		.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

/**
 * The files of a project that could be a setup: everything a few folders down, outside installed,
 * built and hidden folders.
 * @param {string} root
 * @returns {string[]}
 */
function projectFiles(root) {
	const files = [];
	const walk = (folder, depth) => {
		for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
			const at = folder ? `${folder}/${entry.name}` : entry.name;
			if (entry.isFile()) files.push(at);
			else if (entry.isDirectory() && depth < DEPTH && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)) {
				walk(at, depth + 1);
			}
		}
	};
	walk('', 0);
	return files;
}

/** @param {string} root @returns {Setup[]} */
export const findSetups = (root) => setupsAmong(projectFiles(root), path.basename(root));

/**
 * The setups a builder means by a word: the one at that path, else every one with that name.
 * @param {readonly Setup[]} setups
 * @param {string} wanted
 * @returns {Setup[]}
 */
export function setupsNamed(setups, wanted) {
	const file = path.posix.normalize(wanted.split(path.sep).join('/'));
	const at = setups.filter((setup) => setup.file === file);
	return at.length > 0 ? at : setups.filter((setup) => setup.name === wanted);
}

/** @param {readonly Setup[]} setups @returns {Picker} */
export const picker = (setups) => ({ setups, at: 0 });

/**
 * The picker after a key. Up and down stop at the ends.
 * @param {Picker} state
 * @param {PickerKey} key
 * @returns {Picker}
 */
export function pick(state, key) {
	if (key === 'up') return { ...state, at: Math.max(0, state.at - 1) };
	if (key === 'down') return { ...state, at: Math.min(state.setups.length - 1, state.at + 1) };
	if (key === 'choose') return { ...state, chosen: state.setups[state.at] };
	return { ...state, left: true };
}

/**
 * The key a keypress is, or nothing when the picker has no use for it.
 * @param {{ name?: string, ctrl?: boolean }} press
 * @returns {PickerKey | undefined}
 */
export function pickerKey(press) {
	if (press.ctrl) return press.name === 'c' || press.name === 'd' ? 'leave' : undefined;
	if (press.name === 'up' || press.name === 'k') return 'up';
	if (press.name === 'down' || press.name === 'j') return 'down';
	if (press.name === 'return') return 'choose';
	if (press.name === 'escape' || press.name === 'q') return 'leave';
	return undefined;
}

/**
 * The list as lines: each setup's name and file, the names in one column.
 * @param {readonly Setup[]} setups
 * @param {number} [at] the one the cursor is on
 * @returns {string[]}
 */
export function setupLines(setups, at) {
	const wide = Math.max(...setups.map((setup) => setup.name.length));
	return setups.map((setup, row) => `${row === at ? '›' : ' '} ${setup.name.padEnd(wide)}  ${setup.file}`);
}

/**
 * Asks which setup to open, with the arrow keys. Nothing when the builder leaves.
 * @param {readonly Setup[]} setups
 * @param {NodeJS.ReadStream} input a terminal
 * @param {NodeJS.WriteStream} output
 * @returns {Promise<Setup | undefined>}
 */
export async function chooseSetup(setups, input, output) {
	const { emitKeypressEvents } = await import('node:readline');
	const bold = (text) => `\x1b[1m${text}\x1b[22m`;
	const dim = (text) => `\x1b[2m${text}\x1b[22m`;
	let state = picker(setups);
	const draw = (again) => {
		const lines = setupLines(setups, state.at).map((line, row) => (row === state.at ? bold(line) : line));
		// Back to the top of the list, then over it.
		output.write(`${again ? `\x1b[${String(lines.length + 1)}A` : ''}${lines.join('\n')}\n${dim('↑ ↓ to move, enter to open')}\n`);
	};
	output.write('Which setup?\n');
	draw(false);
	emitKeypressEvents(input);
	input.setRawMode(true);
	input.resume();
	return new Promise((resolve) => {
		const onPress = (_text, press) => {
			const key = pickerKey(press ?? {});
			if (!key) return;
			state = pick(state, key);
			if (!state.chosen && !state.left) return draw(true);
			input.off('keypress', onPress);
			input.setRawMode(false);
			input.pause();
			resolve(state.chosen);
		};
		input.on('keypress', onPress);
	});
}
