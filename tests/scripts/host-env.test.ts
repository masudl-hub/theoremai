import { assertEquals, assertThrows } from '@std/assert';
import {
  hostOpenRouterKey,
  hostVault,
  loadHostEnv,
  OPENROUTER_ENV,
  vaultEnv,
} from '../../scripts/host-env.ts';

const KEYS = ['THEOREM_ENV_FILE', 'HOST_ENV_PLAIN', 'HOST_ENV_QUOTED', 'HOST_ENV_SHELL'];

async function withEnvFile(text: string, run: () => void): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: '.env' });
  await Deno.writeTextFile(path, text);
  const saved = KEYS.map((key) => [key, Deno.env.get(key)] as const);
  Deno.env.set('THEOREM_ENV_FILE', path);
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(path);
  }
}

Deno.test('loadHostEnv sets file keys, unquotes values and lets the shell win', async () => {
  await withEnvFile(
    '# comment\n\nHOST_ENV_PLAIN=one\nHOST_ENV_QUOTED="two"\nHOST_ENV_SHELL=file\nno_equals\n',
    () => {
      Deno.env.set('HOST_ENV_SHELL', 'shell');
      loadHostEnv();
      assertEquals(Deno.env.get('HOST_ENV_PLAIN'), 'one');
      assertEquals(Deno.env.get('HOST_ENV_QUOTED'), 'two');
      assertEquals(Deno.env.get('HOST_ENV_SHELL'), 'shell');
    },
  );
});

Deno.test('loadHostEnv throws when THEOREM_ENV_FILE names a missing file', () => {
  const saved = Deno.env.get('THEOREM_ENV_FILE');
  Deno.env.set('THEOREM_ENV_FILE', '/nonexistent/host-env-test.env');
  try {
    assertThrows(() => loadHostEnv(), Deno.errors.NotFound);
  } finally {
    if (saved === undefined) Deno.env.delete('THEOREM_ENV_FILE');
    else Deno.env.set('THEOREM_ENV_FILE', saved);
  }
});

Deno.test('hostVault reads every THEOREM_VAULT_ variable as a slot and skips empty ones', () => {
  const names = ['THEOREM_VAULT_MAIN', 'THEOREM_VAULT_TEAM_7', 'THEOREM_VAULT_EMPTY'];
  const saved = Object.entries(Deno.env.toObject()).filter(([name]) =>
    name.startsWith('THEOREM_VAULT_'),
  );
  try {
    for (const [name] of saved) Deno.env.delete(name);
    Deno.env.set('THEOREM_VAULT_MAIN', 'key-main');
    Deno.env.set('THEOREM_VAULT_TEAM_7', ' key-team ');
    Deno.env.set('THEOREM_VAULT_EMPTY', '');
    assertEquals(hostVault(), { main: 'key-main', team_7: 'key-team' });
    assertEquals(vaultEnv('team_7'), 'THEOREM_VAULT_TEAM_7');
  } finally {
    for (const name of names) Deno.env.delete(name);
    for (const [name, value] of saved) Deno.env.set(name, value);
  }
});

Deno.test('hostOpenRouterKey trims its variable and treats unset or empty as undefined', () => {
  const saved = Deno.env.get(OPENROUTER_ENV);
  try {
    Deno.env.delete(OPENROUTER_ENV);
    assertEquals(hostOpenRouterKey(), undefined);
    Deno.env.set(OPENROUTER_ENV, '');
    assertEquals(hostOpenRouterKey(), undefined);
    Deno.env.set(OPENROUTER_ENV, ' key-or ');
    assertEquals(hostOpenRouterKey(), 'key-or');
  } finally {
    if (saved === undefined) Deno.env.delete(OPENROUTER_ENV);
    else Deno.env.set(OPENROUTER_ENV, saved);
  }
});
