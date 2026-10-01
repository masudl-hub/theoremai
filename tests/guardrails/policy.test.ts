import '../fixtures/test-host.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import {
  egressChecksOf,
  resolveEgressChecks,
  standardEgressEnforce,
} from '../../src/guardrails/egress.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { sanitizeText } from '../../src/guardrails/sanitize.ts';
import { resolveSensitive } from '../../src/guardrails/sensitive.ts';
import type { Verdict } from '../../src/guardrails/types.ts';
import { getProfile, registerProfile, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { prepareLiveInboundText } from '../../src/kernel/engine/live-inbound.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const OMITTED_INJECTION = '[omitted - injection]';
const ALL = resolveSensitive(true);
const NONE = resolveSensitive(false);

Deno.test('resolveGuardrailPolicy: sanitize, redact, and canary default on', () => {
  const policy = resolveGuardrailPolicy(undefined);
  assertEquals(policy.sanitizeInput, true);
  assertEquals(policy.redactSensitive, ALL);
  assertEquals(policy.canary, true);
});

Deno.test('resolveGuardrailPolicy: explicit false is preserved', () => {
  const policy = resolveGuardrailPolicy({
    sanitizeInput: false,
    redactSensitive: false,
    canary: false,
  });
  assertEquals(policy.sanitizeInput, false);
  assertEquals(policy.redactSensitive, NONE);
  assertEquals(policy.canary, false);
});

/**
 * Regression: Live ingress resolved `guardrails?.sanitizeInput === true` while the
 * turn path resolved `?? true`, so a profile that omitted the switch was sanitized
 * on one path and not the other. Both now route through `resolveGuardrailPolicy`.
 *
 * The `chat` fixture declares `guardrails` but omits `sanitizeInput`, which is
 * exactly the case that diverged.
 */
Deno.test('Live ingress and the turn path agree when a switch is omitted', () => {
  const profile = getProfile('chat');
  assertEquals(profile.guardrails?.sanitizeInput, undefined);

  const live = prepareLiveInboundText(profile, INJ_IGNORE);
  const turn = sanitizeText(
    INJ_IGNORE,
    detectionForTrust(resolveGuardrailPolicy(profile.guardrails), 'untrusted'),
  );

  assertEquals(live.text.includes(OMITTED_INJECTION), true);
  assertEquals(turn.includes(OMITTED_INJECTION), true);
  assertEquals(live.text.includes(INJ_IGNORE), false);
});

Deno.test('detectionForTrust: trusted text takes no detection at all', () => {
  const options = detectionForTrust(resolveGuardrailPolicy(undefined), 'trusted');
  assertEquals(options.sanitizeInput, false);
  assertEquals(options.redactSensitive, NONE);
});

Deno.test('detectionForTrust: assembled and untrusted text take full detection', () => {
  const policy = resolveGuardrailPolicy(undefined);
  for (const trust of ['assembled', 'untrusted'] as const) {
    const options = detectionForTrust(policy, trust);
    assertEquals(options.sanitizeInput, true);
    assertEquals(options.redactSensitive, ALL);
  }
});

Deno.test('trusted text reaches the provider verbatim', () => {
  const policy = resolveGuardrailPolicy(undefined);
  const system = `${INJ_IGNORE} — never do this. Key format looks like ${TEST_OPENAI_KEY}`;
  assertEquals(sanitizeText(system, detectionForTrust(policy, 'trusted')), system);
});

Deno.test('detectionForTrust: trusted stays verbatim even with every switch on', () => {
  const policy = resolveGuardrailPolicy({ sanitizeInput: true, redactSensitive: true });
  const options = detectionForTrust(policy, 'trusted');
  assertEquals(options.sanitizeInput, false);
  assertEquals(options.redactSensitive, NONE);
});

Deno.test('assembled text loses injection spans that trusted text keeps', () => {
  const policy = resolveGuardrailPolicy(undefined);
  const assembled = sanitizeText(INJ_IGNORE, detectionForTrust(policy, 'assembled'));
  assertEquals(assembled.includes(OMITTED_INJECTION), true);
});

Deno.test('detectionForTrust: redactSensitive: false disables redaction at every trust level', () => {
  const policy = resolveGuardrailPolicy({ redactSensitive: false });
  for (const trust of ['trusted', 'assembled', 'untrusted'] as const) {
    assertEquals(detectionForTrust(policy, trust).redactSensitive, NONE);
  }
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
      guardrails: { quota: { perDay: 50 }, sanitizeInput: true },
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

Deno.test('redactSensitive redacts the groups a profile picks, and only those', () => {
  const text = 'SSN 123-45-6789 at 10.2.3.4, key AKIAIOSFODNN7EXAMPLE';
  const policy = resolveGuardrailPolicy({
    redactSensitive: { network: false, credentials: false },
  });
  assertEquals(policy.redactSensitive, {
    ids: true,
    financial: true,
    network: false,
    credentials: false,
  });
  const redacted = sanitizeText(text, detectionForTrust(policy, 'untrusted'));
  assertEquals(
    ['123-45-6789', '10.2.3.4', 'AKIAIOSFODNN7EXAMPLE'].map((part) => redacted.includes(part)),
    [false, true, true],
  );
});

Deno.test('egress checks resolve to the bundled policy they select, once per spec', () => {
  const egress = { checks: { links: true }, onBlock: 'refuse_to_user' as const };
  const resolved = resolveGuardrailPolicy({ egress }).egress;
  assertEquals(resolved?.onBlock, 'refuse_to_user');
  assertEquals(Object.hasOwn(resolved ?? {}, 'checks'), false);
  assertEquals(egressChecksOf(resolved?.enforce), resolveEgressChecks({ links: true }));
  assertEquals(resolveGuardrailPolicy({ egress }).egress?.enforce, resolved?.enforce);
  const off = resolveGuardrailPolicy({ egress: { checks: false } }).egress?.enforce;
  assertEquals(egressChecksOf(off)?.injection, false);
  const host = () => ({ action: 'allow' as const });
  assertEquals(resolveGuardrailPolicy({ egress: { enforce: host } }).egress?.enforce, host);
  assertEquals(egressChecksOf(host), undefined);
  assertEquals(
    egressChecksOf(
      resolveGuardrailPolicy({ egress: { enforce: standardEgressEnforce } }).egress?.enforce,
    ),
    resolveEgressChecks(),
  );
});
