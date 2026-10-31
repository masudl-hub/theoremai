import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const MINUTE = 60_000;
const SECOND = 1000;
const here = path.dirname(fileURLToPath(import.meta.url));

process.env.FAKE_MODEL_PORT ??= '4971';
process.env.STUDIO_E2E_PROJECT ??= path.join(tmpdir(), 'theorem-studio-e2e');

// The studio on a copy of `project/`, driven in a browser on the fake model (`serve.mjs`).
export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 2 * MINUTE,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    actionTimeout: 20 * SECOND,
    // A live call asks for a microphone: Chromium's own fake one, granted.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  expect: { timeout: 20 * SECOND },
  webServer: {
    command: `node ${path.join(here, 'serve.mjs')}`,
    wait: { stdout: /theorem studio: (?<STUDIO_URL>http\S+)/ },
    timeout: 3 * MINUTE,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 950 } },
    },
  ],
});
