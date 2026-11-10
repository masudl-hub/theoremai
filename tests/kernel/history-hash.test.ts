import { historyHash } from '../../src/kernel/checkpoint.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('historyHash reads a user message the same with or without its fence and id', async () => {
  const bare = await historyHash([{ role: 'user', content: 'hi' }]);
  const fenced = await historyHash([{ role: 'user', content: '<user_data>\nhi\n</user_data>' }]);
  const withId = await historyHash([
    { role: 'user', content: '<user_data id="msg.7k">\nhi\n</user_data>' },
  ]);
  assertEquals([fenced, withId], [bare, bare]);
});
