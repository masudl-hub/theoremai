import { join } from 'node:path';
import { assertEquals } from '@std/assert';
import { BUILT_PAGE, PAGE_BASE } from '../../studio/page.mjs';

const STUDIO = join(import.meta.dirname ?? '.', '..', '..', 'studio');

Deno.test('a file the build held still serves after a reinstall took it away', async () => {
  const dir = await Deno.makeTempDir();
  const built = join(dir, BUILT_PAGE);
  await Deno.mkdir(join(built, 'assets'), { recursive: true });
  await Deno.writeTextFile(join(built, 'index.html'), '<title>studio</title>');
  await Deno.writeTextFile(join(built, 'assets', 'index-old.js'), 'old();');
  for (const file of ['serve-page.mjs', 'page.mjs'])
    await Deno.copyFile(join(STUDIO, file), join(dir, file));

  const free = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = free.addr;
  free.close();
  const server = new Deno.Command('node', {
    args: [
      join(dir, 'serve-page.mjs'),
      '--port',
      String(port),
      '--project',
      'http://127.0.0.1:1/api/studio',
    ],
    stdout: 'null',
    stderr: 'null',
  }).spawn();
  const address = `http://127.0.0.1:${port}${PAGE_BASE}assets/index-old.js`;
  try {
    let first: Response | undefined;
    while (!first) first = await fetch(address).catch(() => undefined);
    assertEquals(await first.text(), 'old();');

    await Deno.remove(join(built, 'assets'), { recursive: true });

    const after = await fetch(address);
    assertEquals(await after.text(), 'old();');
  } finally {
    server.kill();
    await server.status;
    await Deno.remove(dir, { recursive: true });
  }
});
