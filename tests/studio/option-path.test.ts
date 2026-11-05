import { assertEquals } from '@std/assert';
import { geminiEmbeddings, openRouterOpenAi } from '../../src/providers/mod.ts';
import { optionAt, protocolOptionFields, withOption } from '../../studio/providers.ts';

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

Deno.test('protocolOptionFields keeps the name and description a protocol gives each choice', () => {
  const taskType = protocolOptionFields(geminiEmbeddings).find(
    (field) => field.path === 'taskType',
  );
  assertEquals(taskType?.kind, 'choice');
  assertEquals(taskType?.choices?.[0]?.value, 'RETRIEVAL_QUERY');
  assertEquals(taskType?.choices?.[0]?.label, 'Retrieval query');
  assertEquals(typeof taskType?.choices?.[0]?.description, 'string');
  const dims = protocolOptionFields(geminiEmbeddings).find(
    (field) => field.path === 'outputDimensionality',
  );
  assertEquals(dims?.choices, [{ value: '768' }, { value: '1536' }, { value: '3072' }]);
});

Deno.test('protocolOptionFields leaves out what the model refuses, unless the binding holds it', () => {
  const paths = (apiId: string, options = {}) =>
    protocolOptionFields(geminiEmbeddings, { apiId, options }).map((field) => field.path);
  assertEquals(paths('gemini-embedding-001').includes('taskType'), true);
  assertEquals(paths('gemini-embedding-2-preview').includes('taskType'), false);
  assertEquals(
    paths('gemini-embedding-2-preview', { taskType: 'CLUSTERING' }).includes('taskType'),
    true,
  );
});

Deno.test('a list of names is a row, and a list left empty is unset', () => {
  const fields = protocolOptionFields(openRouterOpenAi);
  const row = (path: string) => fields.find((field) => field.path === path);
  assertEquals(row('provider.only')?.kind, 'names');
  assertEquals(row('provider.quantizations')?.kind, 'names');
  assertEquals(row('provider.allow_fallbacks')?.label, 'Allow fallbacks');
  assertEquals(row('provider.max_price.prompt')?.kind, 'number');
  assertEquals(row('provider.sort'), undefined);
  assertEquals(withOption({}, 'provider.only', ['gmicloud/fp8']), {
    provider: { only: ['gmicloud/fp8'] },
  });
  assertEquals(withOption({ provider: { only: ['a'] } }, 'provider.only', undefined), {});
});
