import { labelText } from '../../src/guardrails/labels.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  canDropMedia,
  dropMedia,
  type RefusedMediaTry,
  restoreMedia,
} from '../../src/kernel/engine/runner/refused-media.ts';
import type { StepExecutionState } from '../../src/kernel/engine/runner/state.ts';
import type { InteractionPart, TurnHistoryMessage } from '../../src/kernel/types.ts';

const SEEDS = Number(Deno.env.get('FUZZ_SEEDS') ?? 4000);
const TYPES = [
  'text/plain',
  'Text/Plain',
  ' text/plain ',
  'text/plain; charset=utf-8',
  'TEXT/PLAIN;charset=shift_jis',
  'text/csv; charset=utf-16',
  'text/markdown',
  'text/csv',
  'application/pdf',
  'image/png',
  'video/mp4',
];
const NAMES = [...TYPES, 'image/*', 'video/*', 'audio/*', 'text/*'];
const ROLES = ['user', 'assistant', 'tool'] as const;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, actual }, { label, actual: expected });
}

function stateOf(history: TurnHistoryMessage[], turnStart: number): StepExecutionState {
  return { currentHistory: history, turnStart } as unknown as StepExecutionState;
}

function key(type: string): string {
  return (type.split(';')[0] ?? '').trim().toLowerCase();
}

function matches(mimeType: string, name: string): boolean {
  const type = key(mimeType);
  const named = key(name);
  return named.endsWith('/*') ? type.startsWith(named.slice(0, -1)) : type === named;
}

function anyNamed(mimeType: string, named: ReadonlySet<string>): boolean {
  return [...named].some((name) => matches(mimeType, name));
}

function file(mimeType: string, data = 'AAAA'): InteractionPart {
  return { type: mimeType.startsWith('image/') ? 'image' : 'document', mimeType, data };
}

Deno.test('a file a tool returned gets the tool note, replayed or not, and only its type goes', () => {
  const history: TurnHistoryMessage[] = [
    { role: 'tool', parts: [file('text/plain; charset=utf-8')] },
    { role: 'user', parts: [file('text/plain'), { type: 'text', text: 'read' }] },
    { role: 'tool', parts: [file('text/plain'), file('text/csv')] },
  ];
  const state = stateOf(history, 2);
  assertEquals(canDropMedia(state, ['text/plain'], undefined), true);
  const tried = dropMedia(state, 'said', undefined, ['text/plain'], undefined);
  assertEquals(tried.dropped, [
    { mimeType: 'text/plain; charset=utf-8', from: 'history' },
    { mimeType: 'text/plain', from: 'history' },
    { mimeType: 'text/plain', from: 'tool' },
  ]);
  assertEquals(history[0]?.parts, [
    { type: 'text', text: labelText('turn.media_refused_tool', {}) },
  ]);
  assertEquals(history[1]?.parts?.[0], {
    type: 'text',
    text: labelText('turn.media_refused_file', {}),
  });
  assertEquals(history[2]?.parts, [
    { type: 'text', text: labelText('turn.media_refused_tool', {}) },
    file('text/csv'),
  ]);
  assertEquals(canDropMedia(state, ['text/plain'], tried), false);
  assertEquals(canDropMedia(state, ['text/csv'], tried), true);
  assertEquals(canDropMedia(state, undefined, tried), false);
});

Deno.test('a named kind takes every file of that kind, and a type of it named later finds none', () => {
  const history: TurnHistoryMessage[] = [
    { role: 'user', parts: [file('image/png'), file('Image/SVG+xml'), file('application/pdf')] },
    { role: 'tool', parts: [file('image/x-icon'), file('imagery/x')] },
  ];
  const state = stateOf(history, 0);
  const tried = dropMedia(state, 'said', undefined, ['image/*'], undefined);
  assertEquals(
    tried.dropped.map((d) => d.mimeType),
    ['image/png', 'Image/SVG+xml', 'image/x-icon'],
  );
  assertEquals(history[0]?.parts?.[2], file('application/pdf'));
  assertEquals(history[1]?.parts?.[1], file('imagery/x'));
  assertEquals(canDropMedia(state, ['image/png'], tried), false);
  assertEquals(canDropMedia(state, ['image/*'], tried), false);
  assertEquals(canDropMedia(state, ['application/pdf'], tried), true);
});

Deno.test('fuzz: named drops take out every file of each named type and nothing else', () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const history: TurnHistoryMessage[] = [];
    const count = 1 + Math.floor(next() * 6);
    for (let at = 0; at < count; at += 1) {
      const parts: InteractionPart[] = [];
      const size = Math.floor(next() * 4);
      for (let p = 0; p < size; p += 1) {
        parts.push(
          next() < 0.3 ? { type: 'text', text: `t${p}` } : file(pick(TYPES), `d${at}${p}`),
        );
      }
      history.push({ role: pick(ROLES), ...(next() < 0.1 ? {} : { parts }) } as TurnHistoryMessage);
    }
    const turnStart = Math.floor(next() * (count + 1));
    const before = structuredClone(history);
    const state = stateOf(history, turnStart);
    let tried: RefusedMediaTry | undefined;
    const named = new Set<string>();
    const rounds = 1 + Math.floor(next() * 4);
    for (let round = 0; round < rounds; round += 1) {
      const type = pick(NAMES);
      const fresh = !named.has(key(type));
      const held = history.some((m) =>
        m.parts?.some((part) => part.type !== 'text' && matches(part.mimeType, type)),
      );
      check(canDropMedia(state, [type], tried), fresh && held, `seed ${seed} can`);
      if (!fresh || !held) continue;
      const droppedBefore = tried?.dropped.length ?? 0;
      tried = dropMedia(state, `r${round}`, undefined, [type], tried);
      named.add(key(type));
      check(tried.dropped.length > droppedBefore, true, `seed ${seed} dropped`);
    }
    for (const [at, message] of history.entries()) {
      const original = before[at];
      check(message.role, original?.role, `seed ${seed} role`);
      check(message.parts?.length, original?.parts?.length, `seed ${seed} length`);
      for (const [p, part] of (message.parts ?? []).entries()) {
        const was = original?.parts?.[p];
        if (was && was.type !== 'text' && anyNamed(was.mimeType, named)) {
          check(part.type, 'text', `seed ${seed} gone`);
        } else {
          check(part, was, `seed ${seed} kept`);
        }
      }
    }
    const gone = before.flatMap((m) =>
      (m.parts ?? []).filter((part) => part.type !== 'text' && anyNamed(part.mimeType, named)),
    );
    check(tried?.dropped.length ?? 0, gone.length, `seed ${seed} report`);
  }
});

Deno.test('fuzz: an unnamed drop takes this turn’s files, or the conversation’s, once, and comes back', () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const next = random(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const history: TurnHistoryMessage[] = [];
    const count = 1 + Math.floor(next() * 6);
    for (let at = 0; at < count; at += 1) {
      const parts: InteractionPart[] = [];
      for (let p = 0; p < Math.floor(next() * 3); p += 1) {
        parts.push(next() < 0.4 ? { type: 'text', text: 'x' } : file(pick(TYPES)));
      }
      history.push({ role: pick(ROLES), parts });
    }
    const turnStart = Math.floor(next() * (count + 1));
    const before = structuredClone(history);
    const state = stateOf(history, turnStart);
    const holds = (m: TurnHistoryMessage) => m.parts?.some((part) => part.type !== 'text');
    check(canDropMedia(state, undefined, undefined), before.some(holds), `seed ${seed}`);
    if (!before.some(holds)) continue;
    const thisTurn = before.some((m, at) => at >= turnStart && holds(m));
    const tried = dropMedia(state, 'said', undefined, undefined, undefined);
    for (const [at, message] of history.entries()) {
      const inScope = thisTurn ? at >= turnStart : true;
      const media = message.parts?.filter((part) => part.type !== 'text') ?? [];
      if (inScope) check(media, [], `seed ${seed} out`);
      else check(message, before[at], `seed ${seed} kept`);
    }
    check(canDropMedia(state, undefined, tried), false, `seed ${seed} once`);
    restoreMedia(state, tried);
    check(history, before, `seed ${seed} back`);
  }
});
