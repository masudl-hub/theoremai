import { assertEquals } from '@std/assert';
import {
  compilePlayground,
  createBlankDraft,
  createExampleDraft,
  type PlaygroundDraft,
} from '../../playground/mod.ts';

type Guardrails = PlaygroundDraft['guardrails'];

/** The `egress` the example compiles to with a blank draft's guardrails and `change` made to them. */
function egressOf(change: (guardrails: Guardrails) => Partial<Guardrails>) {
  const { guardrails } = createBlankDraft();
  const result = compilePlayground({
    ...createExampleDraft(),
    guardrails: { ...guardrails, ...change(guardrails) },
  });
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  if (result.profile.type !== 'text') throw new Error('expected a text profile');
  return result.profile.guardrails?.egress;
}

Deno.test('blank guardrails run no reply check and set no egress', () => {
  assertEquals(
    egressOf(() => ({})),
    undefined,
  );
});

Deno.test('what a stopped reply does is kept with every reply check off', () => {
  assertEquals(
    egressOf(() => ({ egressOnBlock: 'refuse_to_user' })),
    {
      checks: false,
      onBlock: 'refuse_to_user',
    },
  );
  assertEquals(
    egressOf(() => ({ egressMaxRetries: 2 })),
    { checks: false, maxRetries: 2 },
  );
});

Deno.test('one reply check on sets egress with that check alone', () => {
  const egress = egressOf(({ egressChecks }) => ({
    egressChecks: { ...egressChecks, boundary: true },
  }));
  assertEquals(egress, { checks: { images: false } });
});
