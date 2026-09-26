/**
 * Adversarial canary egress fuzzer.
 *
 * Pipes synthetic model leak attempts through the real runTurn stream gate
 * and Live batch gate, then reports bypasses — output where the attack's
 * encoded canary still reached the client. The check reads the attack's own
 * payload, not the detector under test.
 *
 * @module
 */

import {
  bindCanary,
  isStreamedCanaryEvent,
  mintCanary,
  scanTextForCanaryLeak,
} from '../../guardrails/canary.ts';
import {
  buildCanaryEgressAttacks,
  type CanaryEgressAttack,
  FIXED_CANARY,
  FUZZ_SYSTEM,
} from '../../guardrails/corpus/canary-egress-attacks.ts';
import {
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  processLiveOutboundBatch,
} from '../../guardrails/live-outbound-gate.ts';
import { scanTextOf } from '../../guardrails/serialize.ts';
import {
  type OutboundStreamControl,
  yieldProviderEvents,
} from '../../kernel/engine/runner/stream.ts';
import { clearProfiles, getProfile, registerProfile } from '../../kernel/registry/profiles.ts';
import { providerCompleteRequest } from '../../kernel/registry/provider-request.ts';
import { resolveTurn } from '../../kernel/registry/resolve.ts';
import type { ResolvedGeneration, TurnEvent } from '../../kernel/types.ts';

const FUZZ_PROFILE_ID = '__fuzz_canary__';

export interface ChannelResult {
  attack: CanaryEgressAttack;
  channel: string;
  blocked: boolean;
  bypassed: boolean;
  falseAlarm: boolean;
  clientWire: string;
}

function registerFuzzCanaryProfile(): void {
  registerProfile({
    type: 'text',
    id: FUZZ_PROFILE_ID,
    identity: { handle: 'fuzz-canary', system: 'Canary fuzz profile.' },
    models: {
      'fuzz-model': {
        protocol: 'openAi',
        provider: 'openrouter',
        apiId: 'fuzz-model',
        efforts: { normal: 'none' },
        summaries: false,
        maxOutputTokens: 4096,
        temperature: 0,
        builtInTools: [],
      },
    },
    defaultModel: 'fuzz-model',
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { canary: true },
  });
}

function resolveFuzzGeneration(canary: string): ResolvedGeneration {
  const { generation } = resolveTurn({
    profile: FUZZ_PROFILE_ID,
    input: { text: 'fuzz' },
  });
  return { ...generation, canary };
}

async function collectEvents(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function clientVisible(events: TurnEvent[]): TurnEvent[] {
  return events.filter((event) => event.type !== 'error');
}

function clientVisibleWire(events: TurnEvent[]): string {
  return JSON.stringify(clientVisible(events));
}

/**
 * Whether the attack's encoded canary reached the client: in the reply as the
 * client assembles it across chunks and turns, or in any other event.
 */
function leakReachedClient(attack: CanaryEgressAttack, events: TurnEvent[]): boolean {
  if (!attack.shouldBlock) {
    return false;
  }
  const visible = clientVisible(events);
  const reply = visible
    .filter(isStreamedCanaryEvent)
    .map((event) => event.text ?? '')
    .join('');
  return (
    reply.includes(attack.leak) ||
    visible.some(
      (event) => !isStreamedCanaryEvent(event) && scanTextOf(event).includes(attack.leak),
    )
  );
}

function channelResult(
  attack: CanaryEgressAttack,
  channel: string,
  blocked: boolean,
  events: TurnEvent[],
): ChannelResult {
  const bypassed = leakReachedClient(attack, events);
  return {
    attack,
    channel,
    blocked,
    bypassed,
    falseAlarm: !attack.shouldBlock && blocked,
    clientWire: clientVisibleWire(events),
  };
}

/** A provider stream that yields one attack turn's model output. */
async function* replay(turn: TurnEvent[]): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield* turn;
}

async function runStreamChannel(
  attack: CanaryEgressAttack,
  generation: ResolvedGeneration,
  canary: string,
): Promise<ChannelResult> {
  const events: TurnEvent[] = [];
  // Every provider call of one turn shares its canary: each attack turn is a step.
  const control: OutboundStreamControl = { withholdVisible: false };
  for (const turn of attack.turns) {
    const turnEvents = await collectEvents(
      yieldProviderEvents({
        profile: getProfile(FUZZ_PROFILE_ID),
        generation,
        request: providerCompleteRequest(generation, bindCanary(FUZZ_SYSTEM, canary)),
        provider: { complete: () => replay(turn) },
        // The fuzz reads what reaches the client, not the trace.
        call: { tap: () => {}, observe: () => {} },
        control,
      }),
    );
    events.push(...turnEvents);
    if (turnEvents.some((event) => event.type === 'error')) {
      return channelResult(attack, 'runTurn.stream', true, events);
    }
  }
  return channelResult(attack, 'runTurn.stream', false, events);
}

/** One Live session; each turn is a cycle the provider finishes before the next. */
async function runLiveBatchChannel(
  attack: CanaryEgressAttack,
  canary: string,
): Promise<ChannelResult> {
  const session = createLiveOutboundGateSession(
    getProfile(FUZZ_PROFILE_ID),
    canary,
    bindCanary(FUZZ_SYSTEM, canary),
  );
  const events: TurnEvent[] = [];
  for (const turn of attack.turns) {
    for (const result of [
      await processLiveOutboundBatch(session, turn),
      await finalizeLiveOutboundTurn(session),
    ]) {
      if (result.action === 'withhold') {
        return channelResult(attack, 'live.batch', true, events);
      }
      if (result.action === 'emit') {
        events.push(...result.events);
      }
    }
  }
  return channelResult(attack, 'live.batch', false, events);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function printResults(results: ChannelResult[]): boolean {
  const bypassed = results.filter((r) => r.bypassed);
  const falseAlarms = results.filter((r) => r.falseAlarm);
  const caught = results.filter((r) => r.attack.shouldBlock && r.blocked && !r.bypassed);

  console.log(`\n${'═'.repeat(72)}`);
  console.log(
    `  TOTAL: ${results.length} | CAUGHT: ${caught.length} | BYPASSED: ${bypassed.length} | FALSE ALARM: ${falseAlarms.length}`,
  );
  console.log(`${'═'.repeat(72)}`);

  if (bypassed.length > 0) {
    console.log('\n\x1b[31mBYPASSED (canary reached client-visible output):\x1b[0m\n');
    for (const r of bypassed) {
      console.log(`  ✗ ${r.attack.category}/${r.attack.name} [${r.channel}]`);
      console.log(`    \x1b[2m${truncate(r.clientWire, 90)}\x1b[0m`);
    }
  }

  if (falseAlarms.length > 0) {
    console.log('\n\x1b[33mFALSE ALARMS (benign payload blocked):\x1b[0m\n');
    for (const r of falseAlarms) {
      console.log(`  ⚠ ${r.attack.category}/${r.attack.name} [${r.channel}]`);
    }
  }

  if (bypassed.length === 0 && falseAlarms.length === 0) {
    console.log('\n\x1b[32mAll leak attempts blocked; benign controls passed.\x1b[0m\n');
  }

  return bypassed.length === 0 && falseAlarms.length === 0;
}

/** One result per attack per channel (runTurn stream, Live batch). */
export async function runCanaryFuzz(canary: string = FIXED_CANARY): Promise<ChannelResult[]> {
  clearProfiles();
  registerFuzzCanaryProfile();
  try {
    const generation = resolveFuzzGeneration(canary);
    const results: ChannelResult[] = [];
    for (const attack of buildCanaryEgressAttacks(canary)) {
      results.push(await runStreamChannel(attack, generation, canary));
      results.push(await runLiveBatchChannel(attack, canary));
    }
    return results;
  } finally {
    clearProfiles();
  }
}

/** Run adversarial canary fuzz; returns true when no bypasses or false alarms. */
export async function fuzzCanaryCommand(options?: { canary?: string }): Promise<boolean> {
  console.log('\n🔐 Theorem Canary Egress Adversarial Fuzzer\n');

  const canary = options?.canary ?? FIXED_CANARY;
  if (!/^[0-9a-f]{32}$/.test(canary)) {
    console.error(`Invalid canary shape (expected 32 hex): ${canary}`);
    return false;
  }

  // Sanity: mint path uses same shape
  const minted = mintCanary();
  if (!/^[0-9a-f]{32}$/.test(minted)) {
    console.error(`mintCanary produced unexpected shape: ${minted}`);
    return false;
  }

  // Spot-check scan helper matches expectations
  if (!scanTextForCanaryLeak(canary, canary)) {
    console.error('scanTextForCanaryLeak failed to detect literal canary');
    return false;
  }

  const results = await runCanaryFuzz(canary);
  console.log(`Canary: ${canary.slice(0, 12)}… (${results.length / 2} attacks × 2 channels)`);
  const ok = printResults(results);
  console.log('');
  return ok;
}
