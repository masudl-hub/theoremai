import { assertEquals } from '@std/assert';
import { foldTurnEvents } from '../../src/interface/mod.ts';
import type { StructuredBlock } from '../../src/interface/types.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

const draft = (text: string): TurnEvent => ({ type: 'structured_draft', text });

function structuredBlocks(events: TurnEvent[]): StructuredBlock[] {
  return foldTurnEvents(events).filter(
    (block): block is StructuredBlock => block.kind === 'structured',
  );
}

Deno.test('a structured draft folds into one block the reply settles where it stood', () => {
  const events: TurnEvent[] = [draft('{"title":"Gar'), draft('den","tags":["a"')];
  const [drafted] = structuredBlocks(events);
  assertEquals(structuredBlocks(events).length, 1);
  assertEquals(drafted?.draft, '{"title":"Garden","tags":["a"');
  assertEquals(drafted?.value, { title: 'Garden' });

  const settled = structuredBlocks([
    ...events,
    {
      type: 'guardrail',
      guardrail: { stage: 'output_final', trust: 'untrusted', action: 'flag', hits: [] },
    },
    { type: 'structured', structured: { title: 'Garden', tags: ['a', 'b'] } },
  ]);
  assertEquals(settled.length, 1);
  assertEquals(settled[0]?.id, drafted?.id);
  assertEquals(settled[0]?.draft, undefined);
  assertEquals(settled[0]?.value, { title: 'Garden', tags: ['a', 'b'] });
});

Deno.test("a retry drops the first attempt's draft, and the kept reply folds alone", () => {
  const blocks = structuredBlocks([
    draft('{"title":"bad"}'),
    { type: 'attempt', attempt: 1, reason: 'validation' },
    draft('{"title":"go'),
    draft('od"}'),
    { type: 'structured', structured: { title: 'good' } },
  ]);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.value, { title: 'good' });
  assertEquals(blocks[0]?.draft, undefined);
});

Deno.test('a reply with no draft folds as it always did', () => {
  const blocks = structuredBlocks([{ type: 'structured', structured: { n: 1 } }]);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.value, { n: 1 });
  assertEquals('draft' in (blocks[0] ?? {}), false);
});
