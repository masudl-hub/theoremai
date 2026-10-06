import { assertEquals } from '@std/assert';
import {
  compilePlayground,
  createBlankDraft,
  createExampleDraft,
  type PlaygroundDraft,
} from '../../playground/mod.ts';

type Guardrails = PlaygroundDraft['guardrails'];

/** The guardrails the example compiles to with a blank draft's guardrails and `change` made to them. */
function guardrailsOf(change: (guardrails: Guardrails) => Partial<Guardrails>) {
  const { guardrails } = createBlankDraft();
  const result = compilePlayground({
    ...createExampleDraft(),
    guardrails: { ...guardrails, ...change(guardrails) },
  });
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  if (result.profile.type !== 'text') throw new Error('expected a text profile');
  return result.profile.guardrails;
}

/** `detect` with the detectors that read a reply by default set to `ignore` at `reply`. */
function replyUnread(detect: Guardrails['detect']): Guardrails['detect'] {
  return {
    ...detect,
    marker_leak: { ...detect.marker_leak, reply: 'ignore' },
    ungiven_images: { ...detect.ungiven_images, reply: 'ignore' },
  };
}

Deno.test('blank guardrails keep the kernel defaults: no detect, blockedReply or egress is set', () => {
  const guardrails = guardrailsOf(() => ({}));
  assertEquals(
    [guardrails?.detect, guardrails?.blockedReply, guardrails?.egress],
    [undefined, undefined, undefined],
  );
});

Deno.test('what a blocked reply does is kept with the reply detectors off', () => {
  assertEquals(
    guardrailsOf(({ detect }) => ({ detect: replyUnread(detect), blockedReplyOnBlock: 'refuse' }))
      ?.blockedReply,
    { onBlock: 'refuse' },
  );
  assertEquals(
    guardrailsOf(({ detect }) => ({ detect: replyUnread(detect), blockedReplyMaxRetries: 2 }))
      ?.blockedReply,
    { maxRetries: 2 },
  );
});

Deno.test('one reply detector off sets detect with that detector alone', () => {
  const guardrails = guardrailsOf(({ detect }) => ({
    detect: { ...detect, ungiven_images: { ...detect.ungiven_images, reply: 'ignore' } },
  }));
  assertEquals(guardrails?.detect, { ungiven_images: { at: { reply: 'ignore' } } });
  assertEquals(guardrails?.egress, undefined);
});
