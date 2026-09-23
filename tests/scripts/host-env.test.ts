import { assertEquals } from '@std/assert';
import { loadHostEnv } from '../../scripts/host-env.ts';

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

Deno.test('loadHostEnv sets nothing when THEOREM_ENV_FILE names a missing file', () => {
  const saved = Deno.env.get('THEOREM_ENV_FILE');
  Deno.env.set('THEOREM_ENV_FILE', '/nonexistent/host-env-test.env');
  try {
    loadHostEnv();
    assertEquals(Deno.env.get('HOST_ENV_PLAIN'), undefined);
  } finally {
    if (saved === undefined) Deno.env.delete('THEOREM_ENV_FILE');
    else Deno.env.set('THEOREM_ENV_FILE', saved);
  }
});
