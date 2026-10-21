import { mintCanary } from '../../src/guardrails/canary.ts';
import {
  DETECTORS,
  type Detector,
  type DetectorRule,
  type DetectSpec,
} from '../../src/guardrails/detectors.ts';
import { loadEgressAutomata } from '../../src/guardrails/egress-stream.ts';
import { labelDefault } from '../../src/guardrails/labels.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import { thoughtGuardFor } from '../../src/guardrails/thought-guard.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

await loadEgressAutomata();

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
  'Escalate refunds above 200 dollars to a human and apologise once, briefly.',
].join(' ');
const ECHO = SYSTEM.split(' ').slice(3, 16).join(' ');
const canary = mintCanary();
const CONTEXT: GuardrailContext = {
  stage: 'output_delta',
  trust: 'untrusted',
  profileId: 'chat',
  canary,
  privateSystem: [SYSTEM],
};

type Leaked = 'canary_leak' | 'prompt_leak' | 'marker_leak' | 'ungiven_images' | 'ungiven_links';
/** What each detector reads in a thought, and a stretch of text it matches. */
const LEAKS: Record<Leaked, { text: string; omitted?: string }> = {
  canary_leak: { text: `the token is ${canary} here` },
  prompt_leak: { text: `Sure: ${ECHO} and so on` },
  marker_leak: { text: 'see <user_data> there' },
  ungiven_images: {
    text: 'look ![a](https://attacker.io/p?d=1) there',
    omitted: labelDefault('thought.omitted_image'),
  },
  ungiven_links: {
    text: 'go to https://attacker.io/x now',
    omitted: labelDefault('thought.omitted_link'),
  },
};

/** A matrix that reads only `detector` at `thought`, at `action`. */
function only(
  detector: Detector,
  action: 'ignore' | 'flag' | 'redact' | 'block',
): Partial<Record<Detector, DetectorRule>> {
  const spec: Partial<Record<Detector, DetectorRule>> = {};
  for (const other of DETECTORS) spec[other] = { at: { thought: 'ignore' } };
  spec[detector] = { at: { thought: action } };
  return spec;
}

/** A thought streamed through the guard a profile with `detect` gets: what is shown, the rules found, and the guard. */
async function think(detect: DetectSpec, pieces: string[], context: GuardrailContext = CONTEXT) {
  const guard = await thoughtGuardFor(resolveGuardrailPolicy({ detect }), context);
  if (!guard) return { guard, shown: pieces.join(''), rules: [] as string[], actions: [] };
  let shown = '';
  const rules: string[] = [];
  const actions: string[] = [];
  for (const release of [...pieces.map((piece) => guard.push(piece)), guard.flush()]) {
    shown += release.text;
    for (const hit of release.hits) rules.push(hit.rule);
    if (release.found) {
      actions.push(release.found.action);
      for (const hit of release.found.hits) rules.push(hit.rule);
    }
  }
  return { guard, shown, rules: [...new Set(rules)], actions };
}

const chunks = (text: string, size: number) => text.match(new RegExp(`[^]{1,${size}}`, 'g')) ?? [];
const SIZES = [1, 5, 4096];
const LEAKED = Object.keys(LEAKS) as Leaked[];

Deno.test('each leak detector reads a thought, and leaves a detector set to ignore unread', async () => {
  for (const detector of LEAKED) {
    for (const size of SIZES) {
      const { text } = LEAKS[detector];
      const read = await think(only(detector, 'ignore'), chunks(text, size));
      assertEquals([detector, size, read.guard], [detector, size, undefined]);
    }
  }
});

Deno.test('a leak set to redact is omitted from the thought and reported', async () => {
  for (const detector of LEAKED) {
    const { text, omitted } = LEAKS[detector];
    for (const size of SIZES) {
      const read = await think(only(detector, 'redact'), chunks(text, size));
      assertEquals([detector, size, read.rules], [detector, size, [DETECT_RULES[detector]]]);
      assertEquals([detector, read.shown === text], [detector, false]);
      assertEquals([detector, read.shown.includes('attacker.io')], [detector, false]);
      assertEquals([detector, read.shown.includes(canary)], [detector, false]);
      assertEquals([detector, read.shown.includes(ECHO)], [detector, false]);
      assertEquals([detector, read.shown.includes('<user_data>')], [detector, false]);
      if (omitted) assertEquals([detector, read.shown.includes(omitted)], [detector, true]);
    }
  }
});

Deno.test('a leak set to flag is reported and the thought is shown as written', async () => {
  for (const detector of LEAKED) {
    const { text } = LEAKS[detector];
    for (const size of SIZES) {
      const read = await think(only(detector, 'flag'), chunks(text, size));
      assertEquals([detector, size, read.shown], [detector, size, text]);
      assertEquals([detector, size, read.rules], [detector, size, [DETECT_RULES[detector]]]);
      assertEquals(
        [detector, size, read.actions.length > 0 && read.actions.every((a) => a === 'flag')],
        [detector, size, true],
      );
    }
  }
});

Deno.test('the canary and the prompt echo set to flag are reported once a thought', async () => {
  for (const detector of ['canary_leak', 'prompt_leak'] as const) {
    const { text } = LEAKS[detector];
    for (const size of SIZES) {
      const read = await think(only(detector, 'flag'), chunks(`${text} and ${text}`, size));
      assertEquals([detector, size, read.actions], [detector, size, ['flag']]);
    }
  }
});

Deno.test('a leak set to block ends what is shown of the thought', async () => {
  for (const detector of LEAKED) {
    const { text } = LEAKS[detector];
    for (const size of SIZES) {
      const after = ' and what follows the leak';
      const read = await think(only(detector, 'block'), chunks(`start ${text}${after}`, size));
      assertEquals([detector, size, read.rules], [detector, size, [DETECT_RULES[detector]]]);
      assertEquals([detector, size, read.shown.includes('what follows')], [detector, size, false]);
      assertEquals([detector, size, read.shown.startsWith('start')], [detector, size, true]);
      const next = await read.guard?.push('Next thought: ');
      const clean = (next?.text ?? '') + (read.guard?.flush().text ?? '');
      assertEquals([detector, size, clean], [detector, size, 'Next thought: ']);
    }
  }
});

Deno.test('a canary the turn was given is not read in a thought', async () => {
  const given = { ...CONTEXT, canaryGiven: true };
  const text = LEAKS.canary_leak.text;
  const read = await think(only('canary_leak', 'block'), [text], given);
  assertEquals([read.shown, read.rules], [text, []]);
});

Deno.test('a thought is not read for the canary or the prompt a turn does not have', async () => {
  const bare = { ...CONTEXT };
  delete bare.canary;
  delete bare.privateSystem;
  for (const detector of ['canary_leak', 'prompt_leak'] as const) {
    const { text } = LEAKS[detector];
    const read = await think(only(detector, 'block'), chunks(text, 4096), bare);
    assertEquals([detector, read.shown, read.rules], [detector, text, []]);
  }
});

Deno.test('a thought reads each of the canary and the prompt echo on its own', async () => {
  const both = `${LEAKS.canary_leak.text} then ${LEAKS.prompt_leak.text}`;
  const canaryOnly = await think(only('canary_leak', 'redact'), [both]);
  assertEquals([canaryOnly.shown.includes(canary), canaryOnly.shown.includes(ECHO)], [false, true]);
  const promptOnly = await think(only('prompt_leak', 'redact'), [both]);
  assertEquals([promptOnly.shown.includes(canary), promptOnly.shown.includes(ECHO)], [true, false]);
});

Deno.test('a link detector leaves an image to the image detector when that one reads the thought', async () => {
  const image = 'see ![a](https://attacker.io/p?d=1) then';
  const both = await think(
    { ...only('ungiven_links', 'redact'), ungiven_images: { at: { thought: 'redact' } } },
    [image],
  );
  assertEquals(both.rules, [DETECT_RULES.ungiven_images]);
  assertEquals(both.shown.includes(labelDefault('thought.omitted_image')), true);
  const linksOnly = await think(only('ungiven_links', 'redact'), [image]);
  assertEquals(linksOnly.rules, [DETECT_RULES.ungiven_links]);
  assertEquals(linksOnly.shown.includes(labelDefault('thought.omitted_link')), true);
});

Deno.test('a block ends the thought at its own detector only', async () => {
  const text = `a ${LEAKS.ungiven_links.text} b ${LEAKS.marker_leak.text} c`;
  const read = await think(
    { ...only('ungiven_links', 'redact'), marker_leak: { at: { thought: 'redact' } } },
    [text],
  );
  assertEquals(read.shown.endsWith(' c'), true);
  const ended = await think(
    { ...only('ungiven_links', 'block'), marker_leak: { at: { thought: 'redact' } } },
    [text],
  );
  assertEquals(ended.shown.endsWith(' c'), false);
});
