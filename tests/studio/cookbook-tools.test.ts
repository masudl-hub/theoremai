import { assert, assertEquals, assertThrows } from '@std/assert';
import { COOKBOOK_TOOL_HANDLERS } from '../../studio/cookbooks/tools.ts';

const convertUnits = COOKBOOK_TOOL_HANDLERS.convert_units;
assert(convertUnits);
const convert = (value: unknown, from: string, to: string) =>
  (convertUnits({ value, from, to }) as { result: number }).result;

Deno.test('convert_units converts within temperature and within distance, rounded to three places', () => {
  assertEquals(convert(212, 'F', 'c'), 100);
  assertEquals(convert(0, 'c', 'k'), 273.15);
  assertEquals(convert(300, 'k', 'f'), 80.33);
  assertEquals(convert(-40, 'c', 'f'), -40);
  assertEquals(convert(10, 'km', 'mi'), 6.214);
  assertEquals(convert(1, 'mi', 'km'), 1.609);
  assertEquals(convert('7', 'km', 'km'), 7);
});

Deno.test('convert_units refuses a unit it does not know and a pair across families', () => {
  for (const [from, to] of [
    ['km', 'c'],
    ['f', 'mi'],
    ['mi', 'lb'],
    ['toString', 'valueOf'],
  ] as const) {
    assertThrows(
      () => convert(5, from, to),
      Error,
      `Unsupported conversion: ${from.toLowerCase()} → ${to.toLowerCase()}`,
    );
  }
  assertThrows(() => convert('warm', 'c', 'f'), Error, 'Missing or invalid number field: value');
  assertThrows(() => convert(1, ' ', 'f'), Error, 'Missing or invalid string field: from');
});
