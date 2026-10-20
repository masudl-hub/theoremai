import { assertEquals } from '@std/assert';
import { localBindingViolation, ollamaModelThinks } from '../../src/presets/local.ts';

// `capabilities` as Ollama 0.34.0 reports them from /api/show (04/10/2026): qwen2.5 lists
// completion and tools; a thinking model adds `thinking`.
Deno.test('local preset: an Ollama model thinks when its capabilities list thinking', () => {
  assertEquals(ollamaModelThinks({ capabilities: ['completion', 'tools', 'thinking'] }), true);
  assertEquals(ollamaModelThinks({ capabilities: ['completion', 'tools'] }), false);
  assertEquals(ollamaModelThinks({}), false);
  assertEquals(ollamaModelThinks({ capabilities: 'thinking' }), false);
  assertEquals(ollamaModelThinks(null), false);
});

Deno.test('local preset: a model that does not think refuses efforts', () => {
  const binding = { apiId: 'qwen2.5:3b-instruct' };
  const pinned = { ...binding, efforts: { normal: 'low' as const } };
  assertEquals(localBindingViolation(pinned, { thinks: false }), {
    field: 'efforts',
    message: 'qwen2.5:3b-instruct does not think; leave efforts unset.',
  });
  assertEquals(localBindingViolation(pinned, { thinks: true }), undefined);
  assertEquals(localBindingViolation(binding, { thinks: false }), undefined);
  assertEquals(localBindingViolation({ ...binding, efforts: {} }, { thinks: false }), undefined);
});
