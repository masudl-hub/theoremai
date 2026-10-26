import { assert, assertEquals } from '@std/assert';
import { RESEARCH_FIRST_TURN_PROMPT } from '../../studio/cookbooks/catalog.ts';
import { cookbookOpening } from '../../studio/cookbooks/exchanges.ts';
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
  }
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
