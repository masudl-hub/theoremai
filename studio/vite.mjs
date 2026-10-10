import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package repo: this file is `studio/vite.mjs` in it. */
const theoremaiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the screen imports that has to come from the host's one install. */
const HOST_PACKAGES = [
	'react',
	'react-dom',
	'@astryxdesign/core',
	'@fontsource/figtree',
	'@tabler/icons-react',
	'monaco-editor',
	'fflate',
];

const CODICONS = 'virtual:studio-codicons/';

/** Bump when the declaration shape changes, so a warm cache is not reused. */
const CACHE_VERSION = 1;

/**
 * What a Vite build needs to show the studio screen (`@theoremjs/studio/ui`). `hostRoot` is the
 * app that shows it; its install holds React, the design library, Monaco and zod.
 *
 * - The screen's packages resolve to the host's install, so there is one copy of each.
 * - `virtual:studio-codicons/*` is Monaco's icon sheets.
 * - `virtual:studio-type-sources` is the declarations for the open agent's file. The Monaco
 *   worker typechecks that one file. It does not typecheck the kernel: these are the
 *   declarations the package's own compiler emits for `@theoremjs/agents`, plus the zod
 *   declarations that entry imports. Locale files and anything the entries do not reach are
 *   left out. The worker resolves a `.js` import in a declaration to the `.d.ts` beside it.
 */
export function studioVite({ hostRoot }) {
	const virtual = '\0virtual:studio-type-sources';
	const codicons = path.join(hostPackage(hostRoot, 'monaco-editor'), 'esm/vs/base/browser/ui/codicons/codicon');
	return {
		name: 'theorem-studio',
		config() {
			return { resolve: { dedupe: HOST_PACKAGES } };
		},
		resolveId(source) {
			if (source === 'virtual:studio-type-sources') return virtual;
			if (source.startsWith(CODICONS)) return path.join(codicons, source.slice(CODICONS.length));
		},
		load(source) {
			if (source !== virtual) return;
			const files = loadDeclarations(hostRoot);
			addTree(files, hostPackage(hostRoot, 'zod'), 'file:///node_modules/zod', '.d.ts');
			const reached = reachableDeclarations(files);
			return `export const typeSources = ${JSON.stringify(reached)};\n`;
		},
	};
}

function loadDeclarations(hostRoot) {
	const cacheFile = path.join(hostRoot, 'node_modules/.vite/studio-declarations.json');
	const stamp = sourceStamp();
	const cached = readCache(cacheFile);
	if (cached?.stamp === stamp) return cached.files;
	const files = emitDeclarations(hostRoot);
	mkdirSync(path.dirname(cacheFile), { recursive: true });
	writeFileSync(cacheFile, JSON.stringify({ stamp, files }));
	return files;
}

function readCache(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** Changes when the kernel sources the declarations are emitted from change. */
function sourceStamp() {
	let newest = 0;
	let count = 0;
	const note = (file) => {
		const stat = statSync(file);
		count += 1;
		if (stat.mtimeMs > newest) newest = stat.mtimeMs;
	};
	note(path.join(theoremaiRoot, 'mod.ts'));
	walk(path.join(theoremaiRoot, 'src'), (full) => {
		if (full.endsWith('.ts') && !full.endsWith('.test.ts')) note(full);
	});
	const zod = path.join(theoremaiRoot, 'node_modules/zod/index.d.ts');
	note(zod);
	return `${CACHE_VERSION}:${count}:${Math.round(newest)}`;
}

function walk(dir, visit) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules') continue;
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) walk(full, visit);
		else visit(full);
	}
}

/**
 * `dir`'s files of one extension, keyed by `prefix` plus their path.
 * Skips tests.
 */
function addTree(files, dir, prefix, extension) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.endsWith('.test.ts')) continue;
		const full = path.join(dir, name);
		const key = `${prefix}/${name}`;
		if (statSync(full).isDirectory()) addTree(files, full, key, extension);
		else if (name.endsWith(extension)) files[key] = readFileSync(full, 'utf8');
	}
}

/** The public entry and the guardrails compiler, as `.d.ts`, under the paths the file imports. */
function emitDeclarations(hostRoot) {
	const ts = loadTypeScript(hostRoot);
	const options = {
		declaration: true,
		emitDeclarationOnly: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		rewriteRelativeImportExtensions: true,
		jsx: ts.JsxEmit.ReactJSX,
	};
	const host = ts.createCompilerHost(options);
	const written = new Map();
	host.writeFile = (fileName, contents) => {
		written.set(fileName, contents);
	};
	const program = ts.createProgram(
		[
			path.join(theoremaiRoot, 'mod.ts'),
			path.join(theoremaiRoot, 'src/guardrails/compile-egress.ts'),
		],
		options,
		host,
	);
	const diagnostics = [
		...ts.getPreEmitDiagnostics(program),
		...program.emit().diagnostics,
	];
	const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	if (errors.length > 0) {
		const text = errors
			.slice(0, 8)
			.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
			.join('\n');
		throw new Error(`Studio declarations failed to emit.\n${text}`);
	}
	const prefix = 'file:///node_modules/@theoremjs/agents';
	const files = {};
	for (const [fileName, contents] of written) {
		const relative = path.relative(theoremaiRoot, fileName).split(path.sep).join('/');
		files[`${prefix}/${relative}`] = rewriteTypeSpecifiers(contents);
	}
	return files;
}

/** Relative `.ts` specifiers become `.js`, which resolution reads as the `.d.ts`. */
function rewriteTypeSpecifiers(contents) {
	return contents.replaceAll(
		/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g,
		'$1$2.js$3',
	);
}

/** A package's folder as the host resolves it: in its own `node_modules`, or the nearest one above. */
function hostPackage(hostRoot, name) {
	let dir = hostRoot;
	for (;;) {
		const found = path.join(dir, 'node_modules', name);
		if (existsSync(found)) return found;
		const up = path.dirname(dir);
		if (up === dir) throw new Error(`studio: ${name} is not installed for ${hostRoot}`);
		dir = up;
	}
}

/** The host's TypeScript: the compiler its own build uses. */
function loadTypeScript(hostRoot) {
	return createRequire(path.join(hostRoot, 'package.json'))('typescript');
}

const ENTRY_FILES = [
	'file:///node_modules/@theoremjs/agents/mod.d.ts',
	'file:///node_modules/@theoremjs/agents/src/guardrails/compile-egress.d.ts',
	'file:///node_modules/zod/index.d.ts',
];

const SPECIFIER =
	/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]|\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/g;

/** The entries and every declaration they import. Nothing else is sent to the worker. */
function reachableDeclarations(files) {
	const reached = {};
	const pending = [...ENTRY_FILES];
	const seen = new Set();
	while (pending.length > 0) {
		const key = pending.pop();
		if (seen.has(key)) continue;
		seen.add(key);
		const contents = files[key];
		if (contents === undefined) {
			throw new Error(`Studio declarations are missing ${key}.`);
		}
		reached[key] = contents;
		for (const specifier of specifiersIn(contents)) {
			const next = resolveSpecifier(key, specifier, files);
			if (next === undefined) continue;
			if (next === null) {
				throw new Error(
					`Studio declarations: ${key} imports ${specifier}, which is not emitted.`,
				);
			}
			pending.push(next);
		}
	}
	return reached;
}

function specifiersIn(contents) {
	return [...contents.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2]);
}

/**
 * A relative import, or an import of the two packages these files are allowed
 * to name. Other packages are not part of this file's types.
 * `null` means the specifier should have been in `files` and was not.
 */
function resolveSpecifier(fromKey, specifier, files) {
	// Error-message catalogues. The schema API does not need them, and each one
	// would be parsed into the program through `export * as locales`.
	if (specifier.includes('/locales/') || specifier.endsWith('/locales')) return undefined;
	if (specifier.startsWith('.')) return resolveFile(new URL(specifier, fromKey).href, files);
	if (specifier === 'zod' || specifier.startsWith('zod/')) {
		const rest = specifier === 'zod' ? 'index.d.ts' : specifier.slice('zod/'.length);
		return resolveFile(`file:///node_modules/zod/${rest}`, files);
	}
	if (specifier === '@theoremjs/agents' || specifier.startsWith('@theoremjs/agents/')) {
		const rest =
			specifier === '@theoremjs/agents' ? 'mod.d.ts' : specifier.slice('@theoremjs/agents/'.length);
		return resolveFile(`file:///node_modules/@theoremjs/agents/${rest}`, files);
	}
	return undefined;
}

function resolveFile(href, files) {
	const candidates = [href];
	if (href.endsWith('.js')) candidates.push(`${href.slice(0, -3)}.d.ts`);
	if (!href.endsWith('.d.ts')) {
		candidates.push(`${href}.d.ts`);
		candidates.push(`${href}/index.d.ts`);
	}
	return candidates.find((candidate) => candidate in files) ?? null;
}
