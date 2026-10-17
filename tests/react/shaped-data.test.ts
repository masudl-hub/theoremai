import { assertEquals } from '@std/assert';
import {
  fieldLabel,
  fieldReading,
  humanize,
  json,
  plainReading,
  rowHeading,
  shapeOf,
  shownEntries,
  splitFields,
  unpacked,
  withUnit,
} from '../../react/src/client/shaped-data.ts';

Deno.test('json writes what JSON.stringify cannot: cycles, bigints, throwing reads, toJSON', () => {
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = cycle;
  assertEquals(JSON.parse(json(cycle)), { a: 1, self: '[Circular]' });
  assertEquals(JSON.parse(json({ big: 10n, list: [1n] })), { big: '10', list: ['1'] });
  const throwing = {
    ok: 1,
    get bad(): unknown {
      throw new Error('secret');
    },
    big: 2n,
  };
  assertEquals(JSON.parse(json(throwing)), { ok: 1, bad: '[Unreadable]', big: '2' });
  const own = { big: 1n, toJSON: () => ({ n: 3n }) };
  assertEquals(JSON.parse(json(own)), { n: '3' });
  const broken = {
    big: 1n,
    toJSON: () => {
      throw new Error('no');
    },
  };
  assertEquals(json(broken), '"[Unreadable]"');
  assertEquals(json(undefined), 'undefined');
  assertEquals(json({ a: 1 }), '{\n  "a": 1\n}');
});

Deno.test('unpacked parses JSON held in a string and leaves the rest', () => {
  assertEquals(unpacked(' {"a":1} '), { a: 1 });
  assertEquals(unpacked('[1]'), [1]);
  assertEquals(unpacked('{nope'), '{nope');
  assertEquals(unpacked('text'), 'text');
  assertEquals(unpacked(3), 3);
});

Deno.test('fields read as words, with units from a units object or a key suffix', () => {
  assertEquals(humanize('countryCode'), 'Country code');
  assertEquals(humanize('country_code'), 'Country code');
  assertEquals(fieldLabel('temperature_2m', { temperature_2m: '°C' }), {
    label: 'Temperature 2m',
    unit: '°C',
  });
  assertEquals(fieldLabel('time', { time: 'iso8601' }), { label: 'Time' });
  assertEquals(fieldLabel('code', { code: 'wmo code' }), { label: 'Code' });
  assertEquals(fieldLabel('distance_m'), { label: 'Distance', unit: 'm' });
  assertEquals(fieldLabel('share_pct'), { label: 'Share', unit: '%' });
  assertEquals(fieldLabel('country_code'), { label: 'Country code' });
  assertEquals(fieldLabel('name'), { label: 'Name' });
  assertEquals(fieldReading('distance_m', 12), { label: 'Distance', unit: 'm' });
  assertEquals(fieldReading('distance_m', 'far'), { label: 'Distance m' });
});

Deno.test('plain values read as none, yes/no, numbers, links, dates or text', () => {
  assertEquals(plainReading(null), { kind: 'none' });
  assertEquals(plainReading(undefined), { kind: 'none' });
  assertEquals(plainReading(true), { kind: 'boolean', value: true });
  assertEquals(plainReading(3), { kind: 'number', value: 3 });
  assertEquals(plainReading(3, 'm'), { kind: 'number', value: 3, unit: 'm' });
  assertEquals(plainReading('https://a.b/c'), { kind: 'link', href: 'https://a.b/c' });
  assertEquals(plainReading('2026-09-26'), { kind: 'date', date: new Date('2026-09-26') });
  assertEquals(plainReading('2026-09-26T10:00Z'), {
    kind: 'date-time',
    date: new Date('2026-09-26T10:00Z'),
  });
  assertEquals(plainReading('2026-13-45'), { kind: 'text', text: '2026-13-45' });
  assertEquals(plainReading('hello'), { kind: 'text', text: 'hello' });
  assertEquals(withUnit('21', '°C'), '21°C');
  assertEquals(withUnit('35', '%'), '35%');
  assertEquals(withUnit('320', 'm'), '320 m');
  assertEquals(withUnit('4'), '4');
});

Deno.test('a collapsible row is headed by its title and tags, or left to its place', () => {
  assertEquals(rowHeading({ name: 'Paris', country: 'France', pop: 2 }), {
    title: 'Paris',
    tags: ['France'],
    rest: { country: 'France', pop: 2 },
  });
  assertEquals(rowHeading({ type: 'city', pop: 2 }), {
    tags: ['city'],
    rest: { type: 'city', pop: 2 },
  });
  assertEquals(rowHeading(5), { tags: [], rest: 5 });
});

Deno.test('values take the shape their structure asks for', () => {
  assertEquals(shapeOf({ a: 1 }, 9), { kind: 'json' });
  assertEquals(shapeOf([], 0), { kind: 'none' });
  assertEquals(shapeOf({}, 0), { kind: 'none' });
  assertEquals(shapeOf('x', 0), { kind: 'plain' });
  assertEquals(shapeOf([1, 'a', null], 0), { kind: 'tokens', items: [1, 'a', null] });
  assertEquals(
    shapeOf([{ title: 'T', snippet: 'S', url: 'https://x.y', category: 'news', rank: 1 }], 0),
    {
      kind: 'list',
      rows: [
        {
          title: 'T',
          description: 'S',
          href: 'https://x.y',
          tags: ['news'],
          extras: [['rank', 1]],
        },
      ],
    },
  );
  assertEquals(shapeOf([{ a: 1 }, { b: 2 }], 0), {
    kind: 'table',
    columns: ['a', 'b'],
    rows: [{ a: 1 }, { b: 2 }],
  });
  const nested = [{ a: { b: 1 } }];
  assertEquals(shapeOf(nested, 0), { kind: 'rows', items: nested });
  assertEquals(shapeOf({ time: ['t1', 't2'], temp: [1, 2], time_units: { temp: '°C' } }, 0), {
    kind: 'table',
    columns: ['time', 'temp'],
    rows: [
      { time: 't1', temp: 1 },
      { time: 't2', temp: 2 },
    ],
  });
  assertEquals(shapeOf({ a: [1], b: [1, 2] }, 0), { kind: 'fields', row: { a: [1], b: [1, 2] } });
});

Deno.test('fields split into the plain list and named sections through wrappers', () => {
  const row = {
    lat: 1,
    tags: ['a', 'b'],
    data: { hourly: { t: [1, 2] }, hourly_units: { t: '°C' } },
    empty: [],
  };
  assertEquals(shownEntries({ a: 1, a_units: { a: 'm' }, b_units: { b: 'm' } }), [
    ['a', 1],
    ['b_units', { b: 'm' }],
  ]);
  assertEquals(splitFields(row), {
    plain: [
      ['lat', 1],
      ['tags', ['a', 'b']],
    ],
    sections: [
      { key: 'data', title: 'Data › Hourly › T', value: [1, 2], units: undefined },
      { key: 'empty', title: 'Empty', value: [], units: undefined },
    ],
  });
  assertEquals(splitFields({ wrap: { only: 'plain' } }).sections, [
    { key: 'wrap', title: 'Wrap', value: { only: 'plain' }, units: undefined },
  ]);
});
