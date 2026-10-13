import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { BOOT_PAINT, BOOT_PAINT_NOSCRIPT } from '../ui/boot-paint.ts';
import { PROJECT_META } from '../ui/lib/project-address.ts';
import { studioVite } from '../vite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..');

/** The first frame is inline in the document, so the mark's panel is there before any stylesheet. */
const bootPaint: Plugin = {
  name: 'theorem-studio-boot-paint',
  transformIndexHtml: () => [
    { tag: 'style', children: BOOT_PAINT, injectTo: 'head' },
    { tag: 'noscript', children: [{ tag: 'style', children: BOOT_PAINT_NOSCRIPT }], injectTo: 'head' },
  ],
};

/** The project's server, as the command that started this page beside it names it. */
const project = process.env.THEOREM_STUDIO_PROJECT;
const projectAddress: Plugin = {
  name: 'theorem-studio-project-address',
  transformIndexHtml: () => (project ? [{ tag: 'meta', attrs: { name: PROJECT_META, content: project }, injectTo: 'head' }] : []),
};

/**
 * What the page may load and call. Scripts, workers and fonts are the studio's own. It calls this
 * machine (the project's server, a local model) and the two providers it lists models from. An
 * image or a video in a reply or a tool's result loads from wherever it is, as the project's own
 * app would show it. Styles are written inline by the editor and the design system. A browser
 * takes no IPv6 address in a policy, so this machine is named by `localhost` and `127.0.0.1`.
 */
const LOCAL = ['127.0.0.1', 'localhost'].flatMap((host) => ['http', 'https', 'ws'].map((scheme) => `${scheme}://${host}:*`));
const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  `connect-src 'self' ${LOCAL.join(' ')} https://generativelanguage.googleapis.com https://openrouter.ai`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * What of the package the page's code is made of, and so all this server hands out: its sources
 * and the packages they import. Nothing else in a checkout (its traces, its scratch files, its
 * tests) is the page's to read, and the project's own files never come through here: they are
 * the project's server's (`studio/server/serve.ts`).
 */
const SERVED = ['studio', 'react', 'src', 'mod.ts', 'package.json', 'node_modules'];

/**
 * Serves the studio as a page of its own, at `/studio/` so a run tab's address is the one the
 * screen opens. The screen's packages are the studio's own install (`studio/node_modules`).
 * The page calls the project's local server (`studio/server/serve.ts`) directly.
 */
export default defineConfig({
  root: here,
  base: '/studio/',
  plugins: [studioVite({ hostRoot: studio }), bootPaint, projectAddress],
  oxc: { jsx: { runtime: 'automatic' } },
  optimizeDeps: {
    // Scan every source up front, lazy chunks included, so a package first reached mid-session
    // never forces a re-optimize that leaves the open tab with two copies of React.
    entries: ['main.tsx', '../ui/**/*.{ts,tsx}', '../../react/src/**/*.tsx'],
  },
  server: {
    // Only this machine, and only this page: no other page may read what this serves.
    host: '127.0.0.1',
    cors: false,
    headers: { 'Content-Security-Policy': CONTENT_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
    // The command that starts this names the port; it is never moved to another.
    port: 4984,
    strictPort: true,
    fs: { allow: SERVED.map((name) => path.resolve(studio, '..', name)) },
  },
});
