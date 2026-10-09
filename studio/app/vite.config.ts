import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { studioVite } from '../vite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..');

/**
 * Serves the studio as a page of its own, at `/studio/` so a run tab's address is the one the
 * screen opens. The screen's packages are the studio's own install (`studio/node_modules`).
 * The page calls the project's local server (`studio/server/serve.ts`) directly.
 */
export default defineConfig({
  root: here,
  base: '/studio/',
  plugins: [studioVite({ hostRoot: studio })],
  oxc: { jsx: { runtime: 'automatic' } },
  optimizeDeps: {
    // Scan every source up front, lazy chunks included, so a package first reached mid-session
    // never forces a re-optimize that leaves the open tab with two copies of React.
    entries: ['main.tsx', '../ui/**/*.{ts,tsx}', '../../react/src/**/*.tsx'],
  },
  server: {
    // Only this machine.
    host: '127.0.0.1',
    port: 4984,
    strictPort: true,
    fs: { allow: [path.resolve(studio, '..')] },
  },
});
