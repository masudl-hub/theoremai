import { assertEquals, assertThrows } from '@std/assert';
import { join } from 'node:path';
import { hostPackage, installedFrom } from '../vite.mjs';

/** A folder with `names` installed in its own `node_modules`. */
async function installed(names: string[]): Promise<string> {
  const root = await Deno.makeTempDir();
  for (const name of names) await Deno.mkdir(join(root, 'node_modules', name), { recursive: true });
  return root;
}

Deno.test('a package is found in the folder itself or the nearest one above, or not at all', async () => {
  const root = await installed(['zod']);
  const inner = join(root, 'apps', 'site');
  await Deno.mkdir(join(inner, 'node_modules', 'react'), { recursive: true });
  assertEquals(installedFrom(root, 'zod'), join(root, 'node_modules', 'zod'));
  assertEquals(installedFrom(inner, 'react'), join(inner, 'node_modules', 'react'));
  assertEquals(installedFrom(inner, 'zod'), join(root, 'node_modules', 'zod'));
  assertEquals(installedFrom(inner, 'a-package-nobody-installed'), undefined);
});

Deno.test("the host's own install of a package is used before the studio's", async () => {
  const host = await installed(['monaco-editor']);
  const studio = await installed(['monaco-editor']);
  assertEquals(hostPackage(host, 'monaco-editor', studio), join(host, 'node_modules', 'monaco-editor'));
});

Deno.test('a host without a package the studio came with uses the copy the studio came with', async () => {
  const host = await installed([]);
  const studio = await installed(['monaco-editor']);
  assertEquals(hostPackage(host, 'monaco-editor', studio), join(studio, 'node_modules', 'monaco-editor'));
});

Deno.test('a package neither has is named, with the host it was wanted for', async () => {
  const host = await installed([]);
  const studio = await installed([]);
  assertThrows(
    () => hostPackage(host, 'a-package-nobody-installed', studio),
    Error,
    `a-package-nobody-installed is not installed for ${host}`,
  );
});
