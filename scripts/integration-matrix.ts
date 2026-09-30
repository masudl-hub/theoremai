/** Profile ids on the command line narrow the run; default: every Gemini fixture profile. */

import '../tests/fixtures/test-host.ts';
import { testProfileCommand } from '../src/cli/commands/test.ts';
import { listProfiles } from '../src/kernel/default-scope.ts';
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

const provider = createProvider(geminiProfiles[0], { vault });

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
