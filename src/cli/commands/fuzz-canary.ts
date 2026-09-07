/**
 * Adversarial canary egress fuzzer.
 *
 * Pipes synthetic model leak attempts through the real runTurn stream gate
 * and Live batch gate, then reports bypasses — output that still contains
 * the raw per-turn canary token where the gate should have blocked.
 *
 * @module
 */

import { bindCanary, mintCanary, scanTextForCanaryLeak } from '../../guardrails/canary.ts';
import { createCanaryGateSession, filterCanaryGatedEvents } from '../../guardrails/canary-gate.ts';
import {
  buildCanaryEgressAttacks,
  type CanaryEgressAttack,
  FIXED_CANARY,
} from '../../guardrails/corpus/canary-egress-attacks.ts';
import { yieldProviderEvents } from '../../kernel/engine/runner/stream.ts';
import { clearProfiles, registerProfile } from '../../kernel/registry/profiles.ts';
import { resolveTurn } from '../../kernel/registry/resolve.ts';
import type { ResolvedGeneration, TurnEvent } from '../../kernel/types.ts';

const FUZZ_PROFILE_ID = '__fuzz_canary__';

interface ChannelResult {
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

function clientVisibleWire(events: TurnEvent[]): string {
  return JSON.stringify(events.filter((event) => event.type !== 'error'));
}

function literalCanaryReachedClient(events: TurnEvent[], canary: string): boolean {
  return clientVisibleWire(events).includes(canary);
}

function gateBlocked(events: TurnEvent[]): boolean {
  return events.some((event) => event.type === 'error');
}

async function runStreamChannel(
  attack: CanaryEgressAttack,
  generation: ResolvedGeneration,
  canary: string,
): Promise<ChannelResult> {
  async function* mockProvider(): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    for (const event of attack.events) {
      yield event;
    }
  }

  const events = await collectEvents(
    yieldProviderEvents({
      generation,
      system: bindCanary('fuzz system', canary),
      provider: { complete: mockProvider },
      upstream: [],
    }),
  );

  const blocked = gateBlocked(events);
  const bypassed = attack.shouldBlock && literalCanaryReachedClient(events, canary);
  const falseAlarm = !attack.shouldBlock && blocked;
  return {
    attack,
    channel: 'runTurn.stream',
    blocked,
    bypassed,
    falseAlarm,
    clientWire: clientVisibleWire(events),
  };
}

function runLiveBatchChannel(attack: CanaryEgressAttack, canary: string): ChannelResult {
  const session = createCanaryGateSession(canary);
  const filtered = filterCanaryGatedEvents(session, attack.events);

  if (filtered.leaked) {
    return {
      attack,
      channel: 'live.batch',
      blocked: true,
      bypassed: false,
      falseAlarm: !attack.shouldBlock,
      clientWire: '',
    };
  }

  const emitted: TurnEvent[] = [...filtered.events];
  const tail = session.gate.flush();
  if (tail.leak) {
    return {
      attack,
      channel: 'live.batch',
      blocked: true,
      bypassed: false,
      falseAlarm: !attack.shouldBlock,
      clientWire: clientVisibleWire(emitted),
    };
  }
  if (tail.emit) {
    emitted.push({ type: session.lastStreamType ?? 'text', text: tail.emit });
  }

  const bypassed = attack.shouldBlock && literalCanaryReachedClient(emitted, canary);
  const blocked = attack.shouldBlock && !bypassed;
  const falseAlarm = !attack.shouldBlock && filtered.leaked;

  return {
    attack,
    channel: 'live.batch',
    blocked,
    bypassed,
    falseAlarm,
    clientWire: clientVisibleWire(emitted),
  };
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

/** Run adversarial canary fuzz; returns true when no bypasses or false alarms. */
export async function fuzzCanaryCommand(options?: { canary?: string }): Promise<boolean> {
  console.log('\n🔐 Theorum Canary Egress Adversarial Fuzzer\n');

  clearProfiles();
  registerFuzzCanaryProfile();

  const canary = options?.canary ?? FIXED_CANARY;
  if (!/^theo-[0-9a-f]{32}$/.test(canary)) {
    console.error(`Invalid canary shape (expected theo- + 32 hex): ${canary}`);
    return false;
  }

  // Sanity: mint path uses same shape
  const minted = mintCanary();
  if (!/^theo-[0-9a-f]{32}$/.test(minted)) {
    console.error(`mintCanary produced unexpected shape: ${minted}`);
    return false;
  }

  const generation = resolveFuzzGeneration(canary);
  const attacks = buildCanaryEgressAttacks(canary);
  console.log(`Canary: ${canary.slice(0, 12)}… (${attacks.length} attacks × 2 channels)`);

  const results: ChannelResult[] = [];
  for (const attack of attacks) {
    results.push(await runStreamChannel(attack, generation, canary));
    results.push(runLiveBatchChannel(attack, canary));
  }

  // Spot-check scan helper matches expectations
  if (!scanTextForCanaryLeak(canary, canary)) {
    console.error('scanTextForCanaryLeak failed to detect literal canary');
    return false;
  }

  const ok = printResults(results);
  clearProfiles();
  console.log('');
  return ok;
}
