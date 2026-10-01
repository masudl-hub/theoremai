// P1: import and construction perform no env, net, fs, run, ffi or sys I/O. Deno loads the static
// module graph without consulting permissions, so only construction itself is under test.
import { createProvider, defineProfile, overrideLexicon, runTurn } from '../../mod.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';

const REPO_ROOT = new URL('../..', import.meta.url);

const ZERO_PERMS = {
  env: false,
  net: false,
  read: false,
  write: false,
  run: false,
  ffi: false,
  sys: false,
} as const;

/** Explicit denies so a future Deno default change cannot silently weaken P1. */
const DENY_ALL_FLAGS = [
  '--deny-read',
  '--deny-write',
  '--deny-net',
  '--deny-env',
  '--deny-run',
  '--deny-ffi',
  '--deny-sys',
] as const;

function sampleProfile() {
  return defineProfile({
    type: 'text',
    id: `zero-perm-bot-${crypto.randomUUID()}`,
    identity: { handle: 'z', system: 'ping' },
    tools: { allow: [] },
    inputs: { text: true },
    models: {
      local: {
        protocol: 'openAi',
        provider: 'local',
        apiId: 'local-model',
        efforts: { normal: 'minimal' },
        summaries: false,
        maxOutputTokens: 128,
        temperature: 1,
        builtInTools: [],
      },
    },
    defaultModel: 'local',
  });
}

Deno.test({
  name: 'after module load, createProvider runs with all permissions revoked',
  permissions: ZERO_PERMS,
  fn() {
    assertEquals(typeof runTurn, 'function');
    assertEquals(typeof overrideLexicon, 'function');
    const profile = sampleProfile();
    const provider = createProvider(profile, {
      local: { baseUrl: 'http://127.0.0.1:9' },
    });
    assertEquals(typeof provider.complete, 'function');
  },
});

Deno.test({
  name: 'fresh isolate import + createProvider succeeds with every permission denied',
  permissions: {
    read: true,
    run: true,
    env: true, // only to forward a minimal PATH into the child
    net: false,
    write: false,
    ffi: false,
    sys: false,
  },
  async fn() {
    const script = new URL('../fixtures/probes/zero-permission-import.ts', import.meta.url);
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ['run', ...DENY_ALL_FLAGS, script.pathname],
      cwd: REPO_ROOT.pathname,
      clearEnv: true,
      env: {
        PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
      },
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    if (code !== 0) {
      throw new Error(`zero-permission probe failed (${code}):\n${err}\n${out}`);
    }
    assertStringIncludes(out, 'ZERO_PERM_OK');
    assertEquals(err.includes('Requires '), false);
  },
});
