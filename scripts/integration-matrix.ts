/**
 * Live integration matrix — exercises every registered fixture profile against
 * the real Gemini API. The dev fills the vault slots (THEOREM_VAULT_*, see
 * scripts/host-env.ts) with whichever keys they choose.
 *
 * Usage (profile ids narrow the run; default: every profile):
 *   deno run --allow-read --allow-write --allow-net --allow-sys --allow-env scripts/integration-matrix.ts [profile...]
 */

import '../tests/fixtures/test-host.ts';
import { testProfileCommand } from '../src/cli/commands/test.ts';
import { listProfiles } from '../src/kernel/registry/profiles.ts';
import { isModelProfile } from '../src/kernel/registry/resolve.ts';
import { createProvider } from '../src/providers/create-provider.ts';
import { hostVault, loadHostEnv } from './host-env.ts';

loadHostEnv();

const vault = hostVault();

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

let success = true;
if (Deno.args.length === 0) {
  success = await testProfileCommand(undefined, {
    all: true,
    matrix: true,
    provider,
    verbose: true,
  });
} else {
  for (const profileId of Deno.args) {
    success =
      (await testProfileCommand(profileId, { matrix: true, provider, verbose: true })) && success;
  }
}

Deno.exit(success ? 0 : 1);
