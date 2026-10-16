/**
 * Serves the installed package's built page, as Vite serves the sources in the repo:
 *
 *   node serve-page.mjs --port <port> --project <the project server's /api/studio address>
 *
 * Only this machine reaches it. Every response carries the page's headers (`page.mjs`). A path
 * that names no file is the page itself, so a run tab's address opens the screen.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_PAGE, PAGE_BASE, PAGE_HEADERS, PROJECT_PLACEHOLDER } from './page.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), BUILT_PAGE);

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.wasm': 'application/wasm',
};

const args = process.argv.slice(2);
const flag = (name) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? undefined : args[at + 1];
};
const port = Number(flag('port'));
const project = flag('project');
if (!Number.isInteger(port) || !project) {
	console.error('usage: node serve-page.mjs --port <port> --project <address>');
	process.exit(2);
}

const page = readFileSync(path.join(root, 'index.html'), 'utf8').replaceAll(PROJECT_PLACEHOLDER, project);

/** The built file a request names, or undefined for the page itself. Nothing outside the build is read. */
function fileFor(pathname) {
	const relative = decodeURIComponent(pathname.slice(PAGE_BASE.length));
	const file = path.resolve(root, relative);
	if (relative === '' || !file.startsWith(root + path.sep)) return undefined;
	try {
		return readFileSync(file);
	} catch {
		return undefined;
	}
}

/** What a request is answered: the way to the page, nothing, or a built file or the page. */
function answerFor(method, pathname) {
	if (pathname === '/' || `${pathname}/` === PAGE_BASE) {
		return { status: 302, headers: { ...PAGE_HEADERS, Location: PAGE_BASE } };
	}
	const reads = method === 'GET' || method === 'HEAD';
	if (!reads || !pathname.startsWith(PAGE_BASE)) return { status: 404, headers: PAGE_HEADERS };
	const file = fileFor(pathname);
	const type = file ? (TYPES[path.extname(pathname)] ?? 'application/octet-stream') : TYPES['.html'];
	const body = method === 'HEAD' ? undefined : (file ?? page);
	return { status: 200, headers: { ...PAGE_HEADERS, 'Content-Type': type }, body };
}

createServer((request, response) => {
	const { pathname } = new URL(request.url ?? '/', 'http://localhost');
	const { status, headers, body } = answerFor(request.method, pathname);
	response.writeHead(status, headers).end(body);
}).listen(port, '127.0.0.1');
