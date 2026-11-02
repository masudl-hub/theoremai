/**
 * What the studio's page is served with, by Vite from the repo (`app/vite.config.ts`) or by the
 * installed package from its built copy (`serve-page.mjs`).
 */

/**
 * Stands for the project's server address in the built page. The installed package's server puts
 * the address of the project it opened in its place; Vite writes the address straight in.
 */
export const PROJECT_PLACEHOLDER = '__THEOREM_STUDIO_PROJECT__';

/**
 * What the page may load and call. Scripts, workers, and fonts are the studio's own. It calls this
 * machine (the project's server, a local model) and the two providers it lists models from. An
 * image or a video in a reply or a tool's result loads from wherever it is, as the project's own
 * app would show it. Styles are written inline by the editor and the design system. A browser
 * takes no IPv6 address in a policy, so this machine is named by `localhost` and `127.0.0.1`.
 */
const LOCAL = ['127.0.0.1', 'localhost'].flatMap((host) =>
  ['http', 'https', 'ws'].map((scheme) => `${scheme}://${host}:*`),
);
const contentPolicy = (workers) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    `worker-src ${workers}`,
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

const pageHeaders = (workers) => ({
  'Content-Security-Policy': contentPolicy(workers),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/** The headers on everything the page's server hands out. */
export const PAGE_HEADERS = pageHeaders("'self'");

/**
 * The same, for Vite serving the repo's sources.
 * why: Vite's client waits for its server in a `blob:` worker, and without one an open tab never
 * reloads after a restart.
 */
export const DEV_PAGE_HEADERS = pageHeaders("'self' blob:");

/** Where the page is served: a run tab's address is the one the screen opens. */
export const PAGE_BASE = '/studio/';

/** The page's own built copy, in an installed package. The repo has none: Vite serves the sources. */
export const BUILT_PAGE = 'page';
