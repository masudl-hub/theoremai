import { assertEquals } from '@std/assert';
import { optionAt, withOption } from '../../studio/providers.ts';

Deno.test('optionAt reads a dotted path, and nothing past a value that is not an object', () => {
  const options = { thinking: { level: 'high' }, dims: 768, list: [1] };
  assertEquals(optionAt(options, 'thinking.level'), 'high');
  assertEquals(optionAt(options, 'dims'), 768);
  assertEquals(optionAt(options, 'dims.more'), undefined);
  assertEquals(optionAt(options, 'list.0'), undefined);
  assertEquals(optionAt(options, 'missing.level'), undefined);
});

Deno.test('withOption sets a dotted path, making the objects on the way', () => {
  assertEquals(withOption({}, 'thinking.level', 'low'), { thinking: { level: 'low' } });
  assertEquals(withOption({ dims: 768 }, 'dims', 1536), { dims: 1536 });
  assertEquals(withOption({ a: 'flat' }, 'a.b', true), { a: { b: true } });
  assertEquals(withOption({ a: [1] }, 'a.b', true), { a: { b: true } });
});

Deno.test('withOption leaves out an undefined value, and an object it leaves empty', () => {
  assertEquals(withOption({ dims: 768, keep: 1 }, 'dims', undefined), { keep: 1 });
  assertEquals(withOption({ thinking: { level: 'low' }, keep: 1 }, 'thinking.level', undefined), {
    keep: 1,
  });
  assertEquals(withOption({ thinking: { level: 'low', budget: 9 } }, 'thinking.level', undefined), {
    thinking: { budget: 9 },
  });
  assertEquals(withOption({ keep: 1 }, 'empty', {}), { keep: 1 });
  assertEquals(withOption({}, 'list', []), { list: [] });
  assertEquals(withOption({}, 'nothing', null), { nothing: null });
});
