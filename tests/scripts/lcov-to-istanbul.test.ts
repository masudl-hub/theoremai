import { assertEquals } from '@std/assert';

Deno.test('LCOV source ranges include nested functions without changing recorded hit counts', async () => {
  const directory = await Deno.makeTempDir();
  try {
    const source = `${directory}/nested.ts`;
    const input = `${directory}/input.lcov`;
    const output = `${directory}/output.json`;
    await Deno.writeTextFile(
      source,
      'export function outer() {\n  const inner = () => 1;\n  return inner();\n}\n',
    );
    await Deno.writeTextFile(
      input,
      `SF:${source}\nFN:1,outer\nFN:2,inner\nFNDA:7,outer\nFNDA:7,inner\nDA:1,7\nDA:2,7\nDA:3,7\nDA:4,7\nend_of_record\n`,
    );
    const result = await new Deno.Command('node', {
      args: ['scripts/lcov-to-istanbul.mjs', input, output],
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const data = JSON.parse(await Deno.readTextFile(output))[source];
    assertEquals(data.fnMap['0'].loc.end.line, 4);
    assertEquals(data.fnMap['1'].loc.end.line, 2);
    assertEquals(data.f, { '0': 7, '1': 7 });
    assertEquals(Object.values(data.s), [7, 7, 7, 7]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('a file recorded by several runs has its hits summed', async () => {
  const directory = await Deno.makeTempDir();
  try {
    const source = `${directory}/shared.ts`;
    const input = `${directory}/input.lcov`;
    const output = `${directory}/output.json`;
    await Deno.writeTextFile(source, 'export function shared() {\n  return 1;\n}\n');
    const run = (hits: number) =>
      `SF:${source}\nFN:1,shared\nFNDA:${hits},shared\nDA:1,${hits}\nDA:2,${hits}\nend_of_record\n`;
    await Deno.writeTextFile(input, run(2) + run(0) + run(3));
    const result = await new Deno.Command('node', {
      args: ['scripts/lcov-to-istanbul.mjs', input, output],
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const data = JSON.parse(await Deno.readTextFile(output))[source];
    assertEquals(data.f, { '0': 5 });
    assertEquals(Object.values(data.s), [5, 5]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
