import { join } from 'node:path';
import { assertEquals } from '@std/assert';
import { installedStudio, STUDIO_MISSING, studioCommand } from '../../src/cli/commands/studio.ts';

Deno.test('the studio is found where the project installed it, from any folder below', async () => {
  const project = await Deno.makeTempDir();
  const folder = join(project, 'node_modules', '@theoremjs', 'studio');
  await Deno.mkdir(folder, { recursive: true });
  await Deno.mkdir(join(project, 'src', 'agents'), { recursive: true });
  await Deno.writeTextFile(
    join(folder, 'package.json'),
    JSON.stringify({ name: '@theoremjs/studio', bin: { 'theorem-studio': 'start.mjs' } }),
  );
  assertEquals(installedStudio(join(project, 'src', 'agents')), join(folder, 'start.mjs'));
  await Deno.remove(project, { recursive: true });
});

Deno.test('a project with no studio is told how to install it, and nothing runs', async () => {
  const project = await Deno.makeTempDir();
  assertEquals(installedStudio(project), undefined);
  const said: unknown[] = [];
  const error = console.error;
  console.error = (...line: unknown[]) => said.push(...line);
  try {
    assertEquals(await studioCommand(['status'], project), 1);
  } finally {
    console.error = error;
  }
  assertEquals(said, [STUDIO_MISSING]);
  await Deno.remove(project, { recursive: true });
});

Deno.test("the studio's command runs in the project with the arguments given, and its exit is the command's", async () => {
  const project = await Deno.makeTempDir();
  const folder = join(project, 'node_modules', '@theoremjs', 'studio');
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(
    join(folder, 'package.json'),
    JSON.stringify({ name: '@theoremjs/studio', bin: { 'theorem-studio': 'start.mjs' } }),
  );
  await Deno.writeTextFile(
    join(folder, 'start.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n",
  );
  assertEquals(await studioCommand(['errors', '--follow'], project), 3);
  assertEquals(JSON.parse(await Deno.readTextFile(join(project, 'ran.json'))), [
    'errors',
    '--follow',
  ]);
  await Deno.remove(project, { recursive: true });
});
