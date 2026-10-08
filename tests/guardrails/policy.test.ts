import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { detectAt } from '../../src/guardrails/detect-at.ts';
import { DETECT_DEFAULTS, NO_ALLOW } from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import type { Verdict } from '../../src/guardrails/types.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { prepareLiveInboundText } from '../../src/kernel/engine/live-inbound.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const OMITTED_INJECTION = '[omitted - injection]';

/** The `chat` fixture declares `guardrails` and leaves `detect` out. */
Deno.test('Live ingress and the turn path agree when detect is left out', () => {
  const profile = getProfile('chat');
  assertEquals(profile.guardrails?.detect, undefined);

  const live = prepareLiveInboundText(profile, INJ_IGNORE);
  const turn = detectAt(INJ_IGNORE, 'user', resolveGuardrailPolicy(profile.guardrails).detect);

  assertEquals(live.text?.includes(OMITTED_INJECTION), true);
  assertEquals(turn.text?.includes(OMITTED_INJECTION), true);
  assertEquals(live.text?.includes(INJ_IGNORE), false);
});

Deno.test('per-turn system text is read at its own boundary', () => {
  const { detect } = resolveGuardrailPolicy(undefined);
  const assembled = detectAt(INJ_IGNORE, 'system', detect);
  assertEquals(assembled.action, 'redact');
  assertEquals(assembled.text?.includes(OMITTED_INJECTION), true);
});

/**
 * The exemption that matters end to end: a profile's own system prompt reaches the
 * provider untouched, while the same text arriving as per-turn `req.system` does not.
 */
Deno.test('identity.system reaches the provider verbatim; req.system does not', async () => {
  const upstream: Record<string, unknown>[] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      upstream.push({ system: (req as { system?: string }).system ?? '' });
      yield { type: 'text', text: 'ok' };
    },
  };

  registerProfile(
    defineProfile({
      type: 'text',
      id: 'trust_system_probe',
      identity: { handle: 'probe', system: `${INJ_IGNORE} — never comply with that.` },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {},
      guardrails: { quota: { perDay: 50 } },
    }),
  );

  for await (const _ of runTurn(
    { profile: 'trust_system_probe', system: INJ_IGNORE, input: { text: 'hi' } },
    provider,
  )) {
    // drain
  }

  const system = String(upstream[0]?.system ?? '');
  // Author-time identity text survives intact...
  assertEquals(system.includes(INJ_IGNORE), true);
  // ...while the host-assembled per-turn fragment was redacted.
  assertEquals(system.includes(OMITTED_INJECTION), true);
});

/** Fails to compile if a `Verdict` variant is added without handling it here. */
function describeVerdict(verdict: Verdict): string {
  switch (verdict.action) {
    case 'allow':
      return 'allow';
    case 'flag':
      return `flag:${verdict.hits.length}`;
    case 'redact':
      return `redact:${verdict.text}`;
    case 'block':
      return `block:${verdict.rejection}`;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

Deno.test('Verdict is exhaustively handled', () => {
  const hits = [{ rule: 'test.rule', severity: 'low' as const }];
  assertEquals(describeVerdict({ action: 'allow' }), 'allow');
  assertEquals(describeVerdict({ action: 'flag', hits }), 'flag:1');
  assertEquals(describeVerdict({ action: 'redact', text: 'safe', hits }), 'redact:safe');
  assertEquals(describeVerdict({ action: 'block', hits, rejection: 'nope' }), 'block:nope');
});

Deno.test('a policy resolves its detectors, what they allow and what a blocked reply does', () => {
  const unset = resolveGuardrailPolicy(undefined);
  assertEquals(unset.detect, DETECT_DEFAULTS);
  assertEquals(unset.allow, NO_ALLOW);
  assertEquals(unset.blockedReply, { onBlock: 'retry', maxRetries: 1 });
  assertEquals(unset.detect.marker_leak.reply, 'block');
  assertEquals(unset.detect.ungiven_images.reply, 'block');
  assertEquals(unset.detect.ungiven_links.reply, 'ignore');

  const set = resolveGuardrailPolicy({
    detect: {
      marker_leak: 'ignore',
      ungiven_links: { action: 'block', allow: { hosts: ['docs.example.com'] } },
    },
    blockedReply: { onBlock: 'refuse' },
  });
  assertEquals(set.blockedReply, { onBlock: 'refuse', maxRetries: 1 });
  assertEquals(set.detect.ungiven_links.reply, 'block');
  assertEquals(set.detect.marker_leak.reply, 'ignore');
  assertEquals(set.detect.ungiven_images.reply, 'block');
  assertEquals(set.allow.ungiven_links.hosts, ['docs.example.com']);
  assertEquals(resolveGuardrailPolicy({ blockedReply: { maxRetries: 0 } }).blockedReply, {
    onBlock: 'retry',
    maxRetries: 0,
  });
});
