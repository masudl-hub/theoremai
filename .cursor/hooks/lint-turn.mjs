#!/usr/bin/env node
/**
 * Cursor stop / subagentStop hook.
 * Lints only files this conversation edited, then runs theorum tests when src/tests changed.
 */
import { readFileSync, constants, existsSync } from 'node:fs';
import { access, mkdir, open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {
	clearEditedFiles,
	getEditedFiles,
	groupFilesByRoot,
	toRelativeFiles,
} from './_edited-files.mjs';

/** Must match loop_limit in hooks.json */
const LOOP_LIMIT = 12;

const MAX_OUTPUT_CHARS = 16_000;
const LOCK_DIR = path.join(os.tmpdir(), 'cursor-lint-turn-locks');

function sanitizePath() {
	const skip = ['.cursor-server', '.vscode-server'];
	process.env.PATH = (process.env.PATH ?? '')
		.split(':')
		.filter((entry) => entry && !skip.some((fragment) => entry.includes(fragment)))
		.join(':');
}

async function readStdinJson() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (!text) return {};
	return JSON.parse(text);
}

async function readPackageJson(root) {
	const pkgPath = path.join(root, 'package.json');
	try {
		await access(pkgPath, constants.R_OK);
	} catch {
		return null;
	}
	try {
		return JSON.parse(readFileSync(pkgPath, 'utf8'));
	} catch {
		return null;
	}
}

async function isTheorumTestRoot(root) {
	const pkg = await readPackageJson(root);
	if (!pkg || typeof pkg.scripts?.test !== 'string') return false;
	if (pkg.name === 'theorum') return true;
	try {
		await access(path.join(root, 'deno.json'), constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function runCommand(root, command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: root,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let output = '';
		child.stdout.on('data', (chunk) => {
			output += chunk;
		});
		child.stderr.on('data', (chunk) => {
			output += chunk;
		});
		child.on('error', (error) => {
			resolve({ code: 1, output: String(error) });
		});
		child.on('close', (code) => {
			resolve({ code: code ?? 1, output });
		});
	});
}

function truncate(text) {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[… output truncated …]`;
}

function focusDiagnostics(output, editedRelFiles = []) {
	const lines = output.split('\n');
	const pathHints = editedRelFiles.map((file) => file.replaceAll('\\', '/'));
	const focused = lines.filter((line) => {
		if (/npm warn|deprecated/i.test(line)) return false;
		const looksLikeDiag =
			/(?:^|\s)(?:error|warning|×|✖|FAIL|FAILED)\b|:\d+:\d+|:\d+\s/.test(line);
		if (!looksLikeDiag) return false;
		if (pathHints.length === 0) return true;
		const normalized = line.replaceAll('\\', '/');
		return pathHints.some((hint) => normalized.includes(hint) || normalized.includes(path.basename(hint)));
	});
	return focused.length > 0 ? focused.join('\n') : output;
}

async function tryAcquireRunLock(payload) {
	const conversationId = payload.conversation_id ?? 'unknown';
	const generationId = payload.generation_id ?? 'unknown';
	await mkdir(LOCK_DIR, { recursive: true });
	const lockPath = path.join(LOCK_DIR, `${conversationId}-${generationId}.lock`);

	try {
		const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
		await handle.writeFile(String(process.pid));
		await handle.close();
		return { acquired: true, lockPath };
	} catch {
		return { acquired: false, lockPath: null };
	}
}

async function releaseRunLock(lockPath) {
	if (!lockPath) return;
	try {
		await unlink(lockPath);
	} catch {
		// Another hook instance owns cleanup.
	}
}

function buildFollowup(failures, loopCount, editedFiles) {
	const finalAttempt = loopCount >= LOOP_LIMIT - 1;
	const fileList = editedFiles.map((file) => `- \`${file}\``).join('\n');
	const sections = failures.map(({ root, step, code, output, relFiles }) => {
		const label = path.basename(root);
		return `### \`${label}\` — ${step} (exit ${code})\n\`\`\`text\n${truncate(focusDiagnostics(output, relFiles))}\n\`\`\``;
	});

	const body = [
		'**Verification hook failed** after your last turn.',
		`Automatic fix loop: ${loopCount + 1} of ${LOOP_LIMIT}.`,
		'',
		'Scope: **only files this conversation edited** (not other agents / pre-existing failures).',
		fileList ? `Edited files:\n${fileList}` : '',
		'',
		finalAttempt
			? '**Last automatic attempt.** Fix every cited file:line, or ask the user — lint/tests are still failing and auto-fix is exhausted.'
			: 'Fix every reported file:line in the edited set. Do **not** ignore, suppress, or reconfigure linters to pass.',
		'If a failure is genuinely wrong, ask the user — do not bypass the rule.',
		'When behavior or APIs change, update relevant documentation references before finishing.',
		'',
		...sections,
		'',
		finalAttempt
			? '**Required:** ask the user for help if you cannot fix these failures at the root cause.'
			: '**Required next step:** fix root causes at each cited location among your edited files, then continue.',
	]
		.filter((line) => line !== '')
		.join('\n');

	return { followup_message: body };
}

function isDocsPath(relPath) {
	const normalized = relPath.replaceAll('\\', '/');
	return (
		normalized.startsWith('docs/') ||
		normalized === 'README.md' ||
		normalized.startsWith('scripts/docs-truth/') ||
		normalized === 'package.json' ||
		normalized === 'deno.json' ||
		normalized === 'mod.ts'
	);
}

/** Minimal glob match for biome `files.includes` entries (`*` / `**` only). */
function matchIncludeGlob(file, pattern) {
	const normalizedFile = file.replaceAll('\\', '/');
	const normalizedPattern = pattern.replaceAll('\\', '/');
	if (normalizedPattern.startsWith('!')) return false;
	const escaped = normalizedPattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '§§')
		.replace(/\*/g, '[^/]*')
		.replace(/§§/g, '.*');
	return new RegExp(`^${escaped}$`).test(normalizedFile);
}

function readBiomeIncludes(root) {
	for (const name of ['biome.json', 'biome.jsonc']) {
		const configPath = path.join(root, name);
		if (!existsSync(configPath)) continue;
		try {
			const config = JSON.parse(readFileSync(configPath, 'utf8'));
			const includes = config?.files?.includes;
			return Array.isArray(includes) ? includes.filter((entry) => typeof entry === 'string') : null;
		} catch {
			return null;
		}
	}
	return null;
}

function filterBiomeTargets(root, relFiles) {
	const includes = readBiomeIncludes(root);
	if (!includes) return relFiles;
	const positives = includes.filter((entry) => !entry.startsWith('!'));
	const negatives = includes.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
	return relFiles.filter((file) => {
		const normalized = file.replaceAll('\\', '/');
		if (!positives.some((pattern) => matchIncludeGlob(normalized, pattern))) return false;
		if (negatives.some((pattern) => matchIncludeGlob(normalized, pattern))) return false;
		return true;
	});
}

function isAllPathsIgnoredByBiome(output) {
	return /No files were processed in the specified paths/i.test(output);
}

function collectConversationFiles(payload) {
	const conversationId = payload.conversation_id ?? payload.session_id;
	const tracked = getEditedFiles(conversationId);
	const fromPayload = Array.isArray(payload.modified_files)
		? payload.modified_files.filter((entry) => typeof entry === 'string')
		: [];
	return {
		conversationId,
		files: [...new Set([...tracked, ...fromPayload].map((file) => path.resolve(file)))],
	};
}

async function lintEditedFiles(root, relFiles, pkg) {
	const failures = [];
	const scripts = pkg?.scripts ?? {};

	const biomeCandidates = relFiles.filter((file) =>
		/\.(?:[cm]?[jt]s|tsx|jsx|json|jsonc|css|svelte|md|mdx)$/i.test(file),
	);
	const biomeTargets = filterBiomeTargets(root, biomeCandidates);
	if (
		biomeTargets.length > 0 &&
		(existsSync(path.join(root, 'biome.json')) || existsSync(path.join(root, 'biome.jsonc')))
	) {
		console.error(`[lint-turn] biome check (${biomeTargets.length} files) in ${root}`);
		const result = await runCommand(root, 'npx', ['biome', 'check', ...biomeTargets]);
		if (result.code !== 0 && !isAllPathsIgnoredByBiome(result.output)) {
			failures.push({
				root,
				step: 'biome (edited files)',
				code: result.code,
				output: result.output,
				relFiles: biomeTargets,
			});
		} else if (result.code !== 0) {
			console.error('[lint-turn] biome skipped — provided paths are outside biome includes');
		}
	} else if (biomeCandidates.length > 0) {
		console.error(
			`[lint-turn] biome skipped — ${biomeCandidates.length} edited file(s) outside biome includes`,
		);
	}

	const eslintTargets = relFiles.filter((file) =>
		/\.(?:[cm]?[jt]s|tsx|jsx|svelte)$/i.test(file),
	);
	const hasEslint =
		existsSync(path.join(root, 'eslint.config.js')) ||
		existsSync(path.join(root, 'eslint.config.mjs')) ||
		existsSync(path.join(root, 'eslint.config.cjs'));
	if (eslintTargets.length > 0 && hasEslint) {
		console.error(`[lint-turn] eslint (${eslintTargets.length} files) in ${root}`);
		const result = await runCommand(root, 'npx', ['eslint', ...eslintTargets]);
		if (result.code !== 0) {
			failures.push({
				root,
				step: 'eslint (edited files)',
				code: result.code,
				output: result.output,
				relFiles: eslintTargets,
			});
		}
	}

	if (typeof scripts['lint:docs'] === 'string' && relFiles.some(isDocsPath)) {
		console.error(`[lint-turn] lint:docs (docs-related edit) in ${root}`);
		const result = await runCommand(root, 'npm', ['run', 'lint:docs']);
		if (result.code !== 0) {
			failures.push({
				root,
				step: 'lint:docs',
				code: result.code,
				output: result.output,
				relFiles,
			});
		}
	}

	// ast-grep must be scoped to edited files so concurrent agents' dirty files do not
	// poison this conversation's verification loop. `npm run lint:ast-grep` is intentionally
	// left repo-wide for full CI / manual use; the hook narrows it to `ast-grep scan <paths>`.
	if (typeof scripts['lint:ast-grep'] === 'string') {
		const astGrepTargets = relFiles.filter((file) =>
			/\.(?:ts|tsx|mjs|cjs|js)$/i.test(file),
		);
		if (astGrepTargets.length > 0) {
			console.error(`[lint-turn] ast-grep (${astGrepTargets.length} edited files) in ${root}`);
			const result = await runCommand(root, 'npx', ['ast-grep', 'scan', ...astGrepTargets]);
			if (result.code !== 0) {
				failures.push({
					root,
					step: 'ast-grep (edited files)',
					code: result.code,
					output: result.output,
					relFiles: astGrepTargets,
				});
			}
		}
	}

	return failures;
}

async function main() {
	sanitizePath();

	let payload;
	try {
		payload = await readStdinJson();
	} catch (error) {
		console.error('[lint-turn] invalid stdin JSON:', error);
		process.stdout.write('{}\n');
		return;
	}

	const status = payload.status ?? 'completed';
	const { conversationId, files: editedFiles } = collectConversationFiles(payload);

	if (status === 'aborted') {
		clearEditedFiles(conversationId);
		process.stdout.write('{}\n');
		return;
	}

	const loopCount = payload.loop_count ?? 0;
	if (loopCount >= LOOP_LIMIT) {
		console.error(`[lint-turn] loop_limit (${LOOP_LIMIT}) reached — not emitting followup`);
		process.stdout.write('{}\n');
		return;
	}

	const { acquired, lockPath } = await tryAcquireRunLock(payload);
	if (!acquired) {
		console.error('[lint-turn] duplicate hook invocation skipped (multi-root)');
		process.stdout.write('{}\n');
		return;
	}

	try {
		if (editedFiles.length === 0) {
			console.error('[lint-turn] no edited files for this conversation — skipping');
			process.stdout.write('{}\n');
			return;
		}

		const roots = payload.workspace_roots?.length
			? payload.workspace_roots.map((root) => path.resolve(root))
			: [process.cwd()];

		const grouped = groupFilesByRoot(editedFiles, roots);
		const failures = [];
		const displayFiles = [];

		for (const [root, files] of grouped) {
			if (files.length === 0) continue;
			const relFiles = toRelativeFiles(root, files);
			if (relFiles.length === 0) continue;
			displayFiles.push(...relFiles.map((file) => path.join(path.basename(root), file)));

			const pkg = await readPackageJson(root);
			failures.push(...(await lintEditedFiles(root, relFiles, pkg)));

		// Run only the test files this conversation edited. Full-suite runs are for CI;
		// the hook must not block on another agent's churning test files.
		const testTargets = relFiles.filter((file) => file.startsWith('tests/') && file.endsWith('.test.ts'));
		if (failures.length === 0 && (await isTheorumTestRoot(root)) && testTargets.length > 0) {
			console.error(`[lint-turn] deno test (${testTargets.length} edited test file(s)) in ${root}`);
			const result = await runCommand(root, 'deno', [
				'test',
				'--allow-read',
				'--allow-write',
				'--allow-net',
				'--allow-env',
				'--allow-sys',
				'--allow-run',
				'--ignore=npm/',
				...testTargets,
			]);
			if (result.code !== 0) {
				failures.push({
					root,
					step: 'test (edited test files)',
					code: result.code,
					output: result.output,
					relFiles: testTargets,
				});
			}
		}
		}

		if (failures.length === 0) {
			clearEditedFiles(conversationId);
			process.stdout.write('{}\n');
			return;
		}

		process.stdout.write(
			`${JSON.stringify(buildFollowup(failures, loopCount, displayFiles))}\n`,
		);
	} finally {
		await releaseRunLock(lockPath);
	}
}

main().catch((error) => {
	console.error('[lint-turn] hook crashed:', error);
	process.stdout.write('{}\n');
});
