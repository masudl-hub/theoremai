import { getProfile, listProfiles } from '../../kernel/registry/profiles.ts';
import type { Profile } from '../../kernel/types.ts';

function formatProfileInputs(p: Profile): string {
  if (p.type === 'speech') {
    return 'text (speech)';
  }
  const inputs: string[] = [];
  const { inputs: spec } = p;
  if (!spec) {
    return 'none';
  }
  if (spec.text !== false) inputs.push('text');
  if (spec.voice) inputs.push('voice');
  if (spec.attachments) {
    inputs.push(`attachments [${spec.attachments.accept?.join(', ')}]`);
  }
  return inputs.join(' | ') || 'none';
}

function formatProfileTools(p: Profile): string {
  if (p.type === 'speech') {
    return 'none';
  }
  return p.tools.allow?.length ? p.tools.allow.join(', ') : 'none';
}

function printProfileCard(p: Profile): void {
  const tools = formatProfileTools(p);
  const models = p.model.allow?.join(', ') || 'default';
  const structured = p.outputs?.structured;
  const structuredLabel =
    typeof structured === 'string' ? structured : structured ? 'custom' : 'none';

  console.log(` • Profile: ${p.id.padEnd(16)} (handle: ${p.identity.handle}) [${p.type}]`);
  console.log(`   - Models:     ${models}`);
  console.log(`   - Inputs:     ${formatProfileInputs(p)}`);
  console.log(`   - Tools:      ${tools}`);
  console.log(`   - Structured: ${structuredLabel}`);
  console.log(`   - Key Bucket: ${p.model.key ?? 'freeA'}`);
  console.log('-'.repeat(70));
}

export function listProfilesCommand(): void {
  const profiles = listProfiles();
  console.log('\n Registered Theorum Profiles:');
  console.log('='.repeat(70));
  if (profiles.length === 0) {
    console.log('  (No profiles registered in runtime)');
    console.log(`${'='.repeat(70)}\n`);
    return;
  }

  for (const p of profiles) {
    printProfileCard(p);
  }
  console.log(`Total: ${profiles.length} profiles registered.\n`);
}

export function showProfileCommand(profileId: string): void {
  try {
    const profile = getProfile(profileId);
    console.log(`\n Profile Details: ${profileId}`);
    console.log('='.repeat(70));
    console.log(JSON.stringify(profile, null, 2));
    console.log(`${'='.repeat(70)}\n`);
  } catch (err) {
    console.error(`\n Error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
