import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

/**
 * Serves the studio's page while it is developed. The page's source is in the
 * React package (`react/src/studio`), so it shares that package's one copy of
 * React and the design library. Calls to `/api/studio` go to `studio/server/serve.ts`.
 */
export default defineConfig({
  root: path.join(repo, 'react/src/studio'),
  server: {
    // Only this machine.
    host: '127.0.0.1',
    port: 4984,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: {
      '/api/studio': { target: 'http://127.0.0.1:4983', changeOrigin: true },
    },
  },
});
