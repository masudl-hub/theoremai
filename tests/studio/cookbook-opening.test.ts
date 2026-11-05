import { assert, assertEquals } from '@std/assert';
import { RESEARCH_FIRST_TURN_PROMPT } from '../../studio/cookbooks/catalog.ts';
import { cookbookOpening, cookbookTraceRecords } from '../../studio/cookbooks/exchanges.ts';
import { judgeResearchOpening } from '../../studio/cookbooks/research-opening.ts';

Deno.test('the research cookbook opens on a recorded exchange for the first-turn prompt', () => {
  const opening = cookbookOpening('research');
  assert(opening, 'research fixture missing');
  assertEquals(
    opening.find((block) => block.kind === 'user-text')?.text,
    RESEARCH_FIRST_TURN_PROMPT,
  );
  for (const block of opening) {
    if (block.kind !== 'tool') continue;
    const phase = block.tool.state?.phase;
    assert(
      (phase === 'complete' || phase === 'error') && typeof block.tool.state?.readBack === 'string',
      `${block.tool.name} needs readBack so startConversation can seal the exchange`,
    );
    assert(
      typeof block.tool.startedAt === 'number' &&
        typeof block.tool.endedAt === 'number' &&
        block.tool.endedAt > block.tool.startedAt,
      `${block.tool.name} needs startedAt/endedAt from its execute_tool span`,
    );
  }
  const done = opening.findLast((block) => block.kind === 'turn-done');
  assert(done?.kind === 'turn-done', 'opening needs a turn-done');
  assert(
    typeof done.workedMs === 'number' && done.workedMs > 0,
    'opening turn-done needs workedMs from the root span',
  );
  assert(typeof done.endedAt === 'number' && done.endedAt > 0, 'opening turn-done needs endedAt');
});

Deno.test('the research cookbook exposes its trace records for View Trace', () => {
  const records = cookbookTraceRecords('research');
  assert(records && records.length > 0, 'research fixture missing');
  assertEquals(cookbookTraceRecords('concierge'), undefined);
});

Deno.test('the research fixture meets the Goals opener bar', () => {
  const opening = cookbookOpening('research');
  assert(opening, 'research fixture missing');
  const verdict = judgeResearchOpening(opening);
  if (!verdict.ok) {
    assert(false, `research fixture refused: ${verdict.why}`);
  } else {
    assert(verdict.complete >= 3);
    assert(verdict.complete / (verdict.complete + verdict.failed) >= 0.75);
  }
});

Deno.test('cookbooks without a recording have no opening', () => {
  assertEquals(cookbookOpening('concierge'), undefined);
});
