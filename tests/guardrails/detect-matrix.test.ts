import { BOUNDARIES, type Boundary } from '../../src/guardrails/boundaries.ts';
import { mintCanary } from '../../src/guardrails/canary.ts';
import { TEST_AWS_KEY, TEST_SSN, TEST_VISA } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { TOOL_INGRESS_TOOLS } from '../../src/guardrails/corpus/tool-ingress.ts';
import { detectAt, detectRelease, scopeOf } from '../../src/guardrails/detect-at.ts';
import { readReply } from '../../src/guardrails/detect-reply.ts';
import {
  DETECT_ACTIONS,
  DETECT_DEFAULTS,
  DETECTOR_BOUNDARIES,
  DETECTOR_META,
  DETECTORS,
  type DetectAction,
  type Detector,
  type DetectSpec,
  detectProblem,
  resolveDetect,
} from '../../src/guardrails/detectors.ts';
import { loadEgressAutomata } from '../../src/guardrails/egress-stream.ts';
import { givenUrlSets } from '../../src/guardrails/egress-urls.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { createOutboundProgressiveGate } from '../../src/guardrails/progressive-yield.ts';
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

/** A stretch of text the detector matches, and what is around it, so a redact is seen to keep the rest. */
const MATCH: Record<Detector, string> = {
  ids: TEST_SSN,
  financial: TEST_VISA,
  network: '203.0.113.9',
  credentials: TEST_AWS_KEY,
  email: 'ana.reyes@northwind.example',
  phone: '+1 415 867 5309',
  bank_account: 'account number 12345678',
  injection: INJ_IGNORE,
  canary_leak: canary,
  prompt_leak: ECHO,
  marker_leak: '<user_data>',
  ungiven_images: '![a](https://attacker.io/p?d=1)',
  ungiven_links: 'https://attacker.io/x',
  tool_leak: 'get_weather',
};

const OWN = { names: ['get_weather'], params: ['city'] };

/** Every detector at `ignore` but `detector`, which takes `action` at `boundary`. */
function only(
  detector: Detector,
  boundary: Boundary,
  action: DetectAction,
): Exclude<DetectSpec, DetectAction> {
  const spec: Record<string, unknown> = {};
  for (const other of DETECTORS) spec[other] = 'ignore';
  spec[detector] = { at: { [boundary]: action } };
  return spec as Exclude<DetectSpec, DetectAction>;
}

function read(detector: Detector, boundary: Boundary, action: DetectAction, text: string) {
  const policy = resolveGuardrailPolicy({ detect: only(detector, boundary, action) });
  const scope = scopeOf(policy, {
    canary,
    privateSystem: [SYSTEM],
    givenUrls: givenUrlSets(),
    ownTools: OWN,
  });
  return detectAt(text, boundary, policy.detect, {
    ...scope,
    callable: [...TOOL_INGRESS_TOOLS],
  });
}

const BEFORE = 'Before. ';
const AFTER = ' After.';

for (const detector of DETECTORS) {
  const applies = DETECTOR_BOUNDARIES[detector];
  for (const boundary of applies) {
    for (const action of DETECT_ACTIONS) {
      Deno.test(`${detector}@${boundary}:${action}`, () => {
        const text = `${BEFORE}${MATCH[detector]}${AFTER}`;
        const found = read(detector, boundary, action, text);
        const rules = found.hits.map((hit) => hit.rule);
        if (action === 'ignore') {
          assertEquals(found.action, 'allow');
          assertEquals(found.hits, []);
          assertEquals(found.text, text);
          return;
        }
        assertEquals(rules.length > 0, true);
        assertEquals(new Set(rules).size, 1);
        if (action === 'flag') {
          assertEquals(found.action, 'flag');
          assertEquals(found.text, text);
        } else if (action === 'redact') {
          assertEquals(found.action, 'redact');
          assertEquals(found.text?.includes(MATCH[detector]), false);
          assertEquals(found.text?.startsWith(BEFORE), true);
          assertEquals(found.text?.endsWith(AFTER), true);
        } else {
          assertEquals(found.action, 'block');
          assertEquals(found.text, undefined);
        }
      });
    }
  }
}

/** The turn the stream gates read against. */
function turn(): GuardrailContext {
  return {
    stage: 'output_delta',
    trust: 'untrusted',
    profileId: 'chat',
    canary,
    privateSystem: [SYSTEM],
    givenUrls: givenUrlSets(),
    ownTools: OWN,
  };
}

/** The detectors the stream reads itself, as the text grows: a redact there holds the reply for the end-of-attempt read. */
const SCOPED_LEAKS: readonly Detector[] = ['canary_leak', 'prompt_leak'];

/** `text` through the gate a profile with `detect` gets at `boundary`, `size` characters at a time. */
async function streamed(
  detector: Detector,
  boundary: 'reply' | 'live_reply',
  action: DetectAction,
  text: string,
  size: number,
) {
  const policy = resolveGuardrailPolicy({ detect: only(detector, boundary, action) });
  const gate = await createOutboundProgressiveGate(policy, turn(), boundary);
  let shown = '';
  let blocked = false;
  const found: string[] = [];
  if (!gate) return { shown: text, blocked, found, gated: false };
  const pieces = text.match(new RegExp(`[^]{1,${size}}`, 'g')) ?? [];
  for (const result of [...(await Array.fromAsync(pieces, (piece) => gate.process(piece)))]) {
    if (result.blocked) {
      blocked = true;
      break;
    }
    shown += result.emit;
    if (result.found) found.push(result.found.action);
  }
  if (!blocked) {
    const end = await gate.flush();
    if (end.blocked) blocked = true;
    else {
      shown += end.emit;
      if (end.found) found.push(end.found.action);
    }
  }
  return { shown, blocked, found, gated: true };
}

for (const detector of DETECTORS) {
  for (const boundary of ['reply', 'live_reply'] as const) {
    if (!DETECTOR_BOUNDARIES[detector].includes(boundary)) continue;
    for (const action of DETECT_ACTIONS) {
      for (const size of [1, 4096]) {
        Deno.test(`${detector}@${boundary}:${action} streamed ${size} at a time`, async () => {
          const match = MATCH[detector];
          const text = `${BEFORE}${match}${AFTER}`;
          const got = await streamed(detector, boundary, action, text, size);
          if (action === 'ignore') {
            assertEquals(got.blocked, false);
            assertEquals(got.shown, text);
            assertEquals(got.found, []);
            return;
          }
          if (action === 'flag') {
            assertEquals(got.blocked, false);
            assertEquals(got.shown, text);
            assertEquals(got.found, ['flag']);
            return;
          }
          const inline =
            action === 'redact' && boundary === 'reply' && !SCOPED_LEAKS.includes(detector);
          if (inline) {
            assertEquals(got.blocked, false);
            assertEquals(got.shown.includes(match), false);
            assertEquals(got.shown.startsWith(BEFORE), true);
            assertEquals(got.shown.endsWith(AFTER), true);
            assertEquals(got.found, ['redact']);
            return;
          }
          // Stopped: only the text before the match was shown, but for a canary, whose hold keeps
          // an opening of CANARY_OPENING_MIN (4) characters, so up to 3 of its characters.
          assertEquals(got.blocked, true);
          const opening = detector === 'canary_leak' ? 3 : 0;
          assertEquals(text.startsWith(got.shown), true);
          assertEquals(got.shown.length <= BEFORE.length + opening, true);
        });
      }
    }
  }
}

for (const detector of DETECTORS) {
  if (!SCOPED_LEAKS.includes(detector) || !DETECTOR_BOUNDARIES[detector].includes('reply'))
    continue;
  Deno.test(`${detector}@reply:redact is held in the stream and replaced when the attempt ends`, () => {
    const policy = resolveGuardrailPolicy({ detect: only(detector, 'reply', 'redact') });
    const text = `${BEFORE}${MATCH[detector]}${AFTER}`;
    const read = readReply({ text }, policy.detect, {
      boundary: 'reply',
      scope: scopeOf(policy, turn()),
    });
    assertEquals(read.rewritten, true);
    assertEquals(read.payload.text.includes(MATCH[detector]), false);
    assertEquals(read.payload.text.startsWith(BEFORE), true);
    assertEquals(read.payload.text.endsWith(AFTER), true);
    assertEquals(read.blocked, undefined);
  });
}

for (const detector of DETECTORS) {
  if (!DETECTOR_BOUNDARIES[detector].includes('reply_structured')) continue;
  for (const action of DETECT_ACTIONS) {
    Deno.test(`${detector}@reply_structured:${action} reads each string of the output`, () => {
      const policy = resolveGuardrailPolicy({ detect: only(detector, 'reply_structured', action) });
      const value = { note: `${BEFORE}${MATCH[detector]}${AFTER}`, count: 2 };
      const read = readReply({ text: '', structured: value }, policy.detect, {
        boundary: 'reply',
        scope: scopeOf(policy, turn()),
      });
      const event = read.events.find((found) => found.boundary === 'reply_structured');
      const structured = read.payload.structured as typeof value;
      if (action === 'ignore') {
        assertEquals(event, undefined);
        assertEquals(structured, value);
      } else if (action === 'flag') {
        assertEquals(event?.action, 'flag');
        assertEquals(structured, value);
      } else if (action === 'redact') {
        assertEquals(event?.action, 'redact');
        assertEquals(structured.note.includes(MATCH[detector]), false);
        assertEquals(structured.note.startsWith(BEFORE), true);
        assertEquals(structured.note.endsWith(AFTER), true);
        assertEquals(structured.count, 2);
      } else {
        assertEquals(event?.action, 'block');
        assertEquals((read.blocked ?? []).length > 0, true);
      }
    });
  }
}

/** A thought streamed through the guard a profile with the cell set gets: what is shown, and what was found. */
async function thought(detector: Detector, action: DetectAction, text: string) {
  const policy = resolveGuardrailPolicy({ detect: only(detector, 'thought', action) });
  const guard = await thoughtGuardFor(policy, turn());
  if (!guard) return { shown: text, found: [] as string[] };
  const released = [guard.push(text), guard.flush()];
  return {
    shown: released.map((release) => release.text).join(''),
    found: released.flatMap((release) => (release.found ? [release.found.action] : [])),
  };
}

for (const detector of DETECTORS) {
  if (!DETECTOR_BOUNDARIES[detector].includes('thought')) continue;
  for (const action of DETECT_ACTIONS) {
    Deno.test(`${detector}@thought:${action} omits from the thought and never stops it`, async () => {
      const match = MATCH[detector];
      const text = `${BEFORE}${match}${AFTER}`;
      const got = await thought(detector, action, text);
      if (action === 'ignore') {
        assertEquals(got.shown, text);
        assertEquals(got.found, []);
      } else if (action === 'flag') {
        assertEquals(got.shown, text);
        assertEquals(got.found, ['flag']);
      } else if (action === 'redact') {
        assertEquals(got.shown.includes(match), false);
        assertEquals(got.shown.startsWith(BEFORE), true);
        assertEquals(got.shown.endsWith(AFTER), true);
        assertEquals(got.found, ['redact']);
      } else {
        // The rest of the thought is not shown: nothing from the match on.
        assertEquals(got.shown.includes(match), false);
        assertEquals(got.shown.includes(AFTER), false);
        assertEquals(BEFORE.startsWith(got.shown) || got.shown.startsWith(BEFORE), true);
        assertEquals(got.found, ['block']);
      }
    });
  }
}

/** A matrix of the defaults, for `detector` alone. */
function defaultsOf(detector: Detector) {
  const base = resolveDetect('ignore');
  return { ...base, [detector]: DETECT_DEFAULTS[detector] };
}

for (const detector of DETECTORS) {
  for (const boundary of DETECTOR_BOUNDARIES[detector]) {
    Deno.test(`${detector}@${boundary} does what DETECTOR_META says when the profile sets nothing`, () => {
      const expected = DETECTOR_META[detector].defaults[boundary] as DetectAction;
      const text = `${BEFORE}${MATCH[detector]}${AFTER}`;
      const policy = resolveGuardrailPolicy({});
      const found = detectAt(text, boundary, defaultsOf(detector) as typeof policy.detect, {
        ...scopeOf(policy, turn()),
        callable: [...TOOL_INGRESS_TOOLS],
      });
      assertEquals(found.action, expected === 'ignore' ? 'allow' : expected);
      if (expected === 'ignore') assertEquals(found.hits, []);
      else assertEquals(found.hits.length > 0, true);
    });
  }
  for (const boundary of BOUNDARIES) {
    if (DETECTOR_BOUNDARIES[detector].includes(boundary)) continue;
    Deno.test(`${detector}@${boundary} does not apply: it cannot be set, and it reads nothing`, () => {
      assertEquals(
        typeof detectProblem('detect', { [detector]: { at: { [boundary]: 'flag' } } }),
        'string',
      );
      const text = `${BEFORE}${MATCH[detector]}${AFTER}`;
      const policy = resolveGuardrailPolicy({});
      const found = detectAt(text, boundary, defaultsOf(detector) as typeof policy.detect, {
        ...scopeOf(policy, turn()),
        callable: [...TOOL_INGRESS_TOOLS],
      });
      assertEquals(found.hits, []);
      assertEquals(found.text, text);
    });
  }
}

const RECORD = 'MRN-20481234';

/** A host detector, by patterns or by its own `find`, taking `action` at `boundary`; Theorem's detectors off. */
function hostSpec(kind: 'patterns' | 'find', boundary: Boundary, action: DetectAction): DetectSpec {
  const spec: Record<string, unknown> = {};
  for (const other of DETECTORS) spec[other] = 'ignore';
  spec['acme.record'] =
    kind === 'patterns'
      ? {
          label: 'Records',
          patterns: [{ name: 'record', pattern: 'MRN-\\d{8}' }],
          at: { [boundary]: action },
        }
      : {
          label: 'Records',
          find: (text: string) => {
            const start = text.indexOf(RECORD);
            return start < 0 ? [] : [{ start, end: start + RECORD.length }];
          },
          at: { [boundary]: action },
        };
  return spec as DetectSpec;
}

for (const kind of ['patterns', 'find'] as const) {
  for (const boundary of BOUNDARIES) {
    for (const action of DETECT_ACTIONS) {
      Deno.test(`acme.record (${kind})@${boundary}:${action}`, () => {
        const policy = resolveGuardrailPolicy({ detect: hostSpec(kind, boundary, action) });
        const text = `${BEFORE}${RECORD}${AFTER}`;
        const found = detectAt(text, boundary, policy.detect);
        if (action === 'ignore') {
          assertEquals(found.action, 'allow');
          assertEquals(found.hits, []);
          assertEquals(found.text, text);
          return;
        }
        assertEquals(
          found.hits.map((hit) => hit.rule),
          ['detect.acme.record'],
        );
        assertEquals(found.hits[0].label, 'Records');
        if (action === 'flag') {
          assertEquals(found.action, 'flag');
          assertEquals(found.text, text);
        } else if (action === 'redact') {
          assertEquals(found.action, 'redact');
          assertEquals(found.text?.includes(RECORD), false);
          assertEquals(found.text?.startsWith(BEFORE), true);
          assertEquals(found.text?.endsWith(AFTER), true);
        } else {
          assertEquals(found.action, 'block');
          assertEquals(found.text, undefined);
        }
      });
    }
  }
}

for (const boundary of BOUNDARIES) {
  for (const [name, find] of [
    [
      'throws',
      () => {
        throw new Error('x');
      },
    ],
    ['returns not a list', () => 'no'],
    ['returns a stretch outside the text', () => [{ start: 0, end: 10_000 }]],
    ['returns an empty stretch', () => [{ start: 3, end: 3 }]],
    ['returns a negative start', () => [{ start: -1, end: 2 }]],
    ['returns a fractional end', () => [{ start: 0, end: 1.5 }]],
  ] as const) {
    Deno.test(`acme.record find ${name} blocks at ${boundary}`, () => {
      const spec: Record<string, unknown> = {};
      for (const other of DETECTORS) spec[other] = 'ignore';
      spec['acme.record'] = { label: 'Records', find, at: { [boundary]: 'flag' } };
      const policy = resolveGuardrailPolicy({ detect: spec as DetectSpec });
      const found = detectAt('Some text here.', boundary, policy.detect);
      assertEquals(found.action, 'block');
      assertEquals(found.hits.length, 1);
      assertEquals(found.hits[0].rule, 'detect.acme.record');
      assertEquals(found.hits[0].label, 'Records');
      assertEquals(found.hits[0].signal, name === 'throws' ? 'find_threw' : 'find_result');
    });
  }
}

Deno.test('a host find that returns the whole text, from its first character to its last, is read', () => {
  const spec: Record<string, unknown> = {};
  for (const other of DETECTORS) spec[other] = 'ignore';
  spec['acme.record'] = {
    label: 'Records',
    find: (text: string) => (text === 'Some text here.' ? [{ start: 0, end: text.length }] : []),
    at: { user: 'redact' },
  };
  const policy = resolveGuardrailPolicy({ detect: spec as DetectSpec });
  const found = detectAt('Some text here.', 'user', policy.detect);
  assertEquals(found.action, 'redact');
  assertEquals(found.hits.length, 1);
  assertEquals(found.text?.includes('Some'), false);
});

Deno.test('an image whose address no link check reads belongs to ungiven_images alone while it reads', () => {
  const image = 'Look: ![a](//attacker.io/p) there.';
  const both = resolveGuardrailPolicy({
    detect: {
      ...only('ungiven_images', 'reply', 'flag'),
      ungiven_links: { at: { reply: 'flag' } },
    } as DetectSpec,
  });
  const rules = (policy: typeof both) =>
    detectAt(image, 'reply', policy.detect, scopeOf(policy, turn())).hits.map((hit) => hit.rule);
  assertEquals(rules(both).includes(DETECT_RULES.ungiven_links), false);
  const links = resolveGuardrailPolicy({ detect: only('ungiven_links', 'reply', 'flag') });
  assertEquals(rules(links), [DETECT_RULES.ungiven_links]);
});

Deno.test('a stream release reads only the detectors its stream settled', () => {
  const policy = resolveGuardrailPolicy({
    detect: { ...only('ids', 'reply', 'block'), email: { at: { reply: 'block' } } } as DetectSpec,
  });
  const text = `Mail ${MATCH.email} now`;
  const stretch = { from: 0, to: text.length, settled: [] };
  const scope = scopeOf(policy, turn());
  assertEquals(
    detectRelease(text, stretch, 'reply', policy.detect, { detectors: ['ids'], scope }).action,
    'allow',
  );
  assertEquals(
    detectRelease(text, stretch, 'reply', policy.detect, { detectors: ['email'], scope }).action,
    'block',
  );
});

Deno.test('a host detector with patterns and a find reads with both', () => {
  const spec: Record<string, unknown> = {};
  for (const other of DETECTORS) spec[other] = 'ignore';
  spec['acme.record'] = {
    label: 'Records',
    patterns: [{ name: 'record', pattern: 'MRN-\\d{8}' }],
    find: (text: string) => {
      const start = text.indexOf('ZED-1');
      return start < 0 ? [] : [{ start, end: start + 5 }];
    },
    at: { user: 'redact' },
  };
  const policy = resolveGuardrailPolicy({ detect: spec as DetectSpec });
  const found = detectAt(`One ${RECORD} two ZED-1 three`, 'user', policy.detect);
  assertEquals(found.text, 'One [omitted] two [omitted] three');
  assertEquals(found.hits.length, 2);
});

Deno.test('a failed host find reports no label when the host gave none, and no signal when the stream settled the block', () => {
  const spec: Record<string, unknown> = {};
  for (const other of DETECTORS) spec[other] = 'ignore';
  spec['acme.record'] = {
    find: () => {
      throw new Error('x');
    },
    at: { user: 'flag' },
  };
  const policy = resolveGuardrailPolicy({ detect: spec as DetectSpec });
  const failed = detectAt('Some text.', 'user', policy.detect).hits[0];
  assertEquals('label' in failed, false);
  assertEquals(failed.signal, 'find_threw');
  const blocking: Record<string, unknown> = {
    ...spec,
    'acme.record': {
      label: 'Records',
      patterns: [{ name: 'record', pattern: 'MRN-\\d{8}' }],
      at: { reply: 'block' },
    },
  };
  const stream = resolveGuardrailPolicy({ detect: blocking as DetectSpec });
  const unread = detectRelease(
    'Nothing.',
    { from: 0, to: 8, settled: ['acme.record'] },
    'reply',
    stream.detect,
    {
      detectors: [],
      scope: {},
    },
  );
  assertEquals(unread.action, 'block');
  assertEquals('signal' in unread.hits[0], false);
  assertEquals(unread.hits[0].label, 'Records');
});

const ZWSP = '​';
const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  i: 'і',
};

/** The detectors that read a normalised view of the text, so a rewrite that keeps the payload readable still matches. */
const NORMALISING: readonly Detector[] = ['injection', 'canary_leak', 'prompt_leak'];

interface Evasion {
  name: string;
  rewrite: (match: string) => string;
  /** Where the kernel claims to see through the rewrite. Absent: every detector. */
  only?: readonly Detector[];
  except?: readonly Detector[];
}

/** Ways an attacker rewrites a payload so a pattern written for plain text would miss it. */
const EVASIONS: readonly Evasion[] = [
  { name: 'inside a code fence', rewrite: (m) => `\`\`\`\n${m}\n\`\`\`` },
  { name: 'inside a quote', rewrite: (m) => `> ${m}` },
  { name: 'after a long run of filler', rewrite: (m) => `${'lorem ipsum '.repeat(2000)}${m}` },
  { name: 'on its own line between blank lines', rewrite: (m) => `\n\n\n${m}\n\n\n` },
  {
    name: 'zero-width characters inside every word',
    rewrite: (m) =>
      m
        .split(' ')
        .map((word) => (word.length > 2 ? `${word.slice(0, 2)}${ZWSP}${word.slice(2)}` : word))
        .join(' '),
    only: NORMALISING,
    except: ['prompt_leak'],
  },
  {
    name: 'Cyrillic look-alike letters',
    rewrite: (m) => [...m].map((char) => HOMOGLYPHS[char] ?? char).join(''),
    only: NORMALISING,
    except: ['prompt_leak'],
  },
  {
    name: 'full-width characters',
    rewrite: (m) =>
      [...m]
        .map((char) =>
          /[!-~]/.test(char) ? String.fromCharCode(char.charCodeAt(0) + 0xfee0) : char,
        )
        .join(''),
    only: NORMALISING,
  },
  {
    name: 'no-break spaces for spaces',
    rewrite: (m) => m.replaceAll(' ', '\u00a0'),
    except: ['phone'],
  },
];

/** Each evasion is tried at every cell the kernel claims to see through it. A failure names the cell and the rewrite. */
for (const detector of DETECTORS) {
  for (const boundary of DETECTOR_BOUNDARIES[detector]) {
    for (const action of ['flag', 'redact', 'block'] as const) {
      for (const evasion of EVASIONS) {
        if (evasion.only && !evasion.only.includes(detector)) continue;
        if (evasion.except?.includes(detector)) continue;
        Deno.test(`${detector}@${boundary}:${action} survives ${evasion.name}`, () => {
          const found = read(
            detector,
            boundary,
            action,
            `Before. ${evasion.rewrite(MATCH[detector])} After.`,
          );
          assertEquals(found.action, action);
        });
      }
    }
  }
}
