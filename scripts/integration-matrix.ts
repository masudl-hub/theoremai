/**
 * Live integration matrix — exercises every registered profile against the real
 * Gemini API using free-tier keys from the host app's .env.
 *
 * Reads keys from env vars (set them directly or via a .env loader):
 *   GEMINI_API_KEY_PORTFOLIO  → slotA
 *   GEMINI_API_KEY_STUDIO     → slotB
 *   GEMINI_API_KEY_CRUCIBLE   → slotC
 *   GEMINI_API_KEY            → paid (overflow)
 *
 * Or point THEORUM_ENV_FILE at a .env file to load from there.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net --allow-sys --allow-env scripts/integration-matrix.ts
 */

import '../tests/fixtures/test-host.ts';
import { testProfileCommand } from '../src/cli/commands/test.ts';
import { listProfiles } from '../src/kernel/registry/profiles.ts';
import { createProvider } from '../src/providers/create-provider.ts';
import type { KeyVault } from '../src/providers/google/keys.ts';

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (Deno.env.get(key) !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    Deno.env.set(key, val);
  }
}

const envFile = Deno.env.get('THEORUM_ENV_FILE');
if (envFile) loadEnvFile(envFile);

const vault: KeyVault = {
  slotA: Deno.env.get('GEMINI_API_KEY_PORTFOLIO') || undefined,
  slotB: Deno.env.get('GEMINI_API_KEY_STUDIO') || undefined,
  slotC: Deno.env.get('GEMINI_API_KEY_CRUCIBLE') || undefined,
  paid: Deno.env.get('GEMINI_API_KEY') || undefined,
};

const missing = Object.entries(vault)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error(`Missing vault keys: ${missing.join(', ')}`);
  Deno.exit(1);
}

console.log('Vault loaded — all slots populated.');

const profiles = listProfiles();
console.log(`Registered profiles: ${profiles.map((p) => p.id).join(', ')}`);

const geminiProfiles = profiles.filter((p) =>
  Object.values(p.models).some(
    (binding) => binding.protocol === 'geminiInteractions' && binding.provider === 'google',
  ),
);

console.log(
  `\nRunning matrix for ${geminiProfiles.length} Gemini profiles: ${geminiProfiles.map((p) => p.id).join(', ')}\n`,
);

const provider = createProvider(geminiProfiles[0], { gemini: { vault } });

const success = await testProfileCommand(undefined, {
  all: true,
  matrix: true,
  provider,
});

Deno.exit(success ? 0 : 1);
