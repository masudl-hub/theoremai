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
 * Keys load from THEOREM_ENV_FILE or ../theoremai-frontend/.env.local.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net --allow-sys --allow-env scripts/integration-matrix.ts
 */

import '../tests/fixtures/test-host.ts';
import { testProfileCommand } from '../src/cli/commands/test.ts';
import { listProfiles } from '../src/kernel/registry/profiles.ts';
import { isModelProfile } from '../src/kernel/registry/resolve.ts';
import type { KeyVault } from '../src/kernel/types.ts';
import { createProvider } from '../src/providers/create-provider.ts';
import { loadHostEnv } from './host-env.ts';

loadHostEnv();

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

const geminiProfiles = profiles
  .filter(isModelProfile)
  .filter((p) =>
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
