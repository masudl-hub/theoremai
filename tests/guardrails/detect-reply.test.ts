import '../fixtures/test-host.ts';
import { TEST_OPENAI_KEY, TEST_SSN } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { readReply } from '../../src/guardrails/detect-reply.ts';
import { type DetectSpec, resolveDetect } from '../../src/guardrails/detectors.ts';
import {
  createLiveOutboundGateSession,
  finalizeLiveOutboundTurn,
  type LiveOutboundBatchResult,
  processLiveOutboundBatch,
} from '../../src/guardrails/live-outbound-gate.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import {
  createOutboundProgressiveGate,
  type ReplyBoundary,
} from '../../src/guardrails/progressive-yield.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import { thoughtGuardFor } from '../../src/guardrails/thought-guard.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { getProfile, registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { readAt } from '../fixtures/detect.ts';
import { eventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

const CONTEXT: GuardrailContext = { stage: 'output_delta', trust: 'untrusted', profileId: 'chat' };
const KEY = TEST_OPENAI_KEY;
const TEXT = `Sure. The key is ${KEY} and that is all I have for you today.`;
/** One character at a time, a few words, and the reply whole. */
const SIZES = [1, 7, 64, 4096];

function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/** `text` streamed through the gate a profile with `detect` gets at `boundary`. */
async function streamed(detect: DetectSpec, text: string, size: number, boundary = 'reply') {
  const policy = resolveGuardrailPolicy({ detect });
  const gate = createOutboundProgressiveGate(policy, CONTEXT, boundary as ReplyBoundary);
  if (!gate) throw new Error('no gate');
  let shown = '';
  const found: string[] = [];
  for (const result of [
    ...(await Array.fromAsync(pieces(text, size), (piece) => gate.process(piece))),
    await gate.flush(),
  ]) {
    if (result.blocked) return { shown, found, blocked: result };
    shown += result.emit;
    if (result.found) found.push(`${result.found.action} ${result.found.hits[0]?.rule}`);
  }
  return { shown, found };
}

Deno.test('a reply has no gate when no detector reads it and nothing else judges it', () => {
  assertEquals(createOutboundProgressiveGate(resolveGuardrailPolicy({}), CONTEXT, 'reply'), null);
});

Deno.test('flag at reply shows the reply as written and reports the match once', async () => {
  for (const size of SIZES) {
    const result = await streamed({ credentials: { at: { reply: 'flag' } } }, TEXT, size);
    assertEquals(result, { shown: TEXT, found: [`flag ${DETECT_RULES.credentials}`] });
  }
});

Deno.test('redact at reply shows the placeholder in place of the match, however the reply is cut', async () => {
  const detect: DetectSpec = { credentials: { at: { reply: 'redact' } } };
  const expected = readAt(TEXT, 'reply', detect).text;
  assertEquals(expected?.includes(KEY), false);
  for (const size of SIZES) {
    const result = await streamed(detect, TEXT, size);
    assertEquals(result, { shown: expected, found: [`redact ${DETECT_RULES.credentials}`] });
  }
});

Deno.test('block at reply stops the reply before the match and names the boundary', async () => {
  for (const size of SIZES) {
    const { shown, blocked } = await streamed(
      { credentials: { at: { reply: 'block' } } },
      TEXT,
      size,
    );
    assertEquals(TEXT.startsWith(shown) && shown.length <= TEXT.indexOf(KEY), true);
    assertEquals(blocked?.boundary, 'reply');
    assertEquals(
      blocked?.hits.map((hit) => hit.rule),
      [DETECT_RULES.credentials],
    );
  }
});

Deno.test('a Live reply is spoken, so redact stops it as block does', async () => {
  const detect: DetectSpec = { credentials: { at: { live_reply: 'redact' } } };
  const { shown, blocked } = await streamed(detect, TEXT, 7, 'live_reply');
  assertEquals(shown.includes(KEY), false);
  assertEquals(blocked?.boundary, 'live_reply');
});

Deno.test('the stream replaces exactly what reading the whole reply replaces', async () => {
  const detect: DetectSpec = Object.fromEntries(
    ['ids', 'financial', 'credentials', 'injection'].map((detector) => [
      detector,
      { at: { reply: 'redact' } },
    ]),
  );
  const replies = [
    `SSN ${TEST_SSN}, card 4111 1111 1111 1111, key ${KEY}.`,
    `${KEY}${KEY} then ${TEST_SSN}`,
    `He said: ${INJ_IGNORE} That was the email.`,
    `${TEST_SSN}`,
    'Nothing to see in this one at all.',
  ];
  const drift: string[] = [];
  for (const reply of replies) {
    const whole = readAt(reply, 'reply', detect).text;
    for (const size of SIZES) {
      const { shown } = await streamed(detect, reply, size);
      if (shown !== whole) drift.push(`@${size}: ${JSON.stringify([shown, whole])}`);
    }
  }
  assertEquals(drift, []);
});

const AT_END = { boundary: 'reply', withheld: false } as const;

Deno.test('a reply read whole has its matches replaced, in text and in each structured string', () => {
  const detect = resolveDetect({
    credentials: { at: { reply: 'redact', reply_structured: 'redact' } },
  });
  const structured = { answer: `the key is ${KEY}`, steps: [`use ${KEY}`, 'done'], count: 2 };
  const read = readReply({ text: TEXT, structured }, detect, AT_END);
  const placeholder = readAt(KEY, 'reply', { credentials: 'redact' }).text;
  assertEquals(read.blocked, undefined);
  assertEquals(read.rewritten, true);
  assertEquals(read.payload.text, TEXT.replace(KEY, placeholder ?? ''));
  assertEquals(read.payload.structured, {
    answer: `the key is ${placeholder}`,
    steps: [`use ${placeholder}`, 'done'],
    count: 2,
  });
  assertEquals(
    read.events.map(({ boundary, action, stage }) => [boundary, action, stage]),
    [
      ['reply', 'redact', 'output_final'],
      ['reply_structured', 'redact', 'output_final'],
    ],
  );
});

Deno.test('a match with no string to replace stops the structured output', () => {
  const detect = resolveDetect({ credentials: { at: { reply_structured: 'redact' } } });
  const read = readReply({ text: 'ok', structured: { [KEY]: 1 } }, detect, AT_END);
  assertEquals(
    read.blocked?.map((hit) => hit.rule),
    [DETECT_RULES.credentials],
  );
});

Deno.test('structured output that cannot be read does not cross a boundary a detector reads', () => {
  const unreadable = {
    toJSON() {
      throw new Error('no');
    },
  };
  const payload = { text: 'ok', structured: unreadable };
  const reading = resolveDetect({ ids: { at: { reply_structured: 'flag' } } });
  assertEquals(readReply(payload, reading, AT_END).blocked, [
    { rule: EGRESS_RULES.unscannable, severity: 'high' },
  ]);
  assertEquals(readReply(payload, resolveDetect(), AT_END).blocked, undefined);
});

Deno.test('a flag is reported at the end only when the stream withheld the reply', () => {
  const detect = resolveDetect({ credentials: { at: { reply: 'flag' } } });
  assertEquals(readReply({ text: TEXT }, detect, AT_END).events, []);
  const [event] = readReply({ text: TEXT }, detect, { boundary: 'reply', withheld: true }).events;
  assertEquals([event?.boundary, event?.action], ['reply', 'flag']);
});

Deno.test('block at the end names every match and lets nothing through', () => {
  const detect = resolveDetect({
    credentials: { at: { reply: 'block' } },
    ids: { at: { reply: 'redact' } },
  });
  const read = readReply({ text: `${TEXT} ${TEST_SSN}` }, detect, AT_END);
  assertEquals(read.blocked?.map((hit) => hit.rule).sort(), [
    DETECT_RULES.credentials,
    DETECT_RULES.ids,
  ]);
  assertEquals(read.events[0]?.action, 'block');
});

/** A thought streamed through the guard a profile with `detect` gets. */
function thought(detect: DetectSpec, text: string, size: number) {
  const guard = thoughtGuardFor({ detect: resolveDetect(detect) }, CONTEXT);
  if (!guard) throw new Error('no guard');
  const releases = [...pieces(text, size).map((piece) => guard.push(piece)), guard.flush()];
  return {
    guard,
    shown: releases.map((release) => release.text).join(''),
    found: releases.flatMap(({ found }) =>
      found ? [`${found.action} ${found.hits[0]?.rule}`] : [],
    ),
  };
}

Deno.test('a thought has no guard when nothing reads it', () => {
  assertEquals(thoughtGuardFor({ detect: resolveDetect() }, CONTEXT), undefined);
});

Deno.test('a detector at thought flags, replaces or ends what is shown of the thought', () => {
  const placeholder = readAt(KEY, 'thought', { credentials: 'redact' }).text ?? '';
  for (const size of SIZES) {
    const flagged = thought({ credentials: { at: { thought: 'flag' } } }, TEXT, size);
    assertEquals([flagged.shown, flagged.found], [TEXT, [`flag ${DETECT_RULES.credentials}`]]);
    const replaced = thought({ credentials: { at: { thought: 'redact' } } }, TEXT, size);
    assertEquals(
      [replaced.shown, replaced.found],
      [TEXT.replace(KEY, placeholder), [`redact ${DETECT_RULES.credentials}`]],
    );
    const ended = thought({ credentials: { at: { thought: 'block' } } }, TEXT, size);
    assertEquals(TEXT.startsWith(ended.shown) && ended.shown.length <= TEXT.indexOf(KEY), true);
    assertEquals(ended.found, [`block ${DETECT_RULES.credentials}`]);
    // The next thought starts clean.
    assertEquals(ended.guard.push('Next step: ').text + ended.guard.flush().text, 'Next step: ');
  }
});

function liveProfile(id: string, detect: DetectSpec) {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      tools: { allow: [] },
      id,
      ...geminiModels('gemini35FlashLite'),
      inputs: { text: true },
      guardrails: { quota: { perDay: 100 }, canary: false, detect },
    }),
  );
  return getProfile(id);
}

/** A Live cycle that says `TEXT`: what the host got, and how the cycle ended. */
async function spoken(id: string, detect: DetectSpec) {
  const session = createLiveOutboundGateSession(liveProfile(id, detect));
  const results: LiveOutboundBatchResult[] = [];
  for (const piece of pieces(TEXT, 16)) {
    results.push(await processLiveOutboundBatch(session, [{ type: 'text', text: piece }]));
  }
  const final = await finalizeLiveOutboundTurn(session);
  const events: TurnEvent[] = [...results, final].flatMap((result) =>
    result.action === 'idle' ? [] : (result.events ?? []),
  );
  return {
    final: final.action,
    text: replyText(events),
    guardrails: eventsOf(events, 'guardrail').map(
      ({ guardrail }) => `${guardrail.boundary} ${guardrail.action}`,
    ),
  };
}

Deno.test('a Live reply is not gated when no detector reads live_reply', () => {
  assertEquals(createLiveOutboundGateSession(liveProfile('live_detect_none', {})).gate, null);
});

Deno.test('flag at live_reply lets the reply through and reports it', async () => {
  const result = await spoken('live_detect_flag', { credentials: { at: { live_reply: 'flag' } } });
  assertEquals(result, { final: result.final, text: TEXT, guardrails: ['live_reply flag'] });
});

Deno.test('block at live_reply withholds the cycle from the match on and reports it once', async () => {
  const result = await spoken('live_detect_block', {
    credentials: { at: { live_reply: 'block' } },
  });
  assertEquals(result.final, 'withhold');
  assertEquals(result.text.includes(KEY), false);
  assertEquals(result.guardrails, ['live_reply block']);
});

Deno.test('redact at live_reply stops the spoken reply and releases the text with its placeholder', async () => {
  const detect: DetectSpec = { credentials: { at: { live_reply: 'redact' } } };
  const result = await spoken('live_detect_redact', detect);
  assertEquals(result.text.includes(KEY), false);
  assertEquals(result.guardrails, ['live_reply redact']);
});
