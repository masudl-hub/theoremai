import '../fixtures/test-host.ts';
import {
  BOUNDARIES,
  BOUNDARY_META,
  type Boundary,
  TOOL_BOUNDARIES,
} from '../../src/guardrails/boundaries.ts';
import {
  DETECT_ACTION_META,
  DETECT_ACTIONS,
  DETECT_DEFAULTS,
  DETECTOR_BOUNDARIES,
  DETECTOR_GROUP_META,
  DETECTOR_GROUPS,
  DETECTOR_META,
  DETECTORS,
  type DetectAction,
  type Detector,
  detectProblem,
} from '../../src/guardrails/detectors.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import type { ProfileGuardrailsSpec } from '../../src/guardrails/types.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { PROFILE_FIELDS } from '../../src/kernel/schema.ts';
import { geminiModels } from '../fixtures/models.ts';

/** Fails unless `value` is truthy. */
function ok(value: unknown): void {
  assertEquals(Boolean(value), true);
}

const INBOUND: readonly Boundary[] = [
  'user',
  'attachment',
  'voice',
  'slots',
  'history',
  'injected',
  'system',
  'repair',
  'live_user',
];

/** Every boundary where `detector` resolves to `action`. */
function where(
  spec: ProfileGuardrailsSpec | undefined,
  detector: Detector,
  action: DetectAction,
): Boundary[] {
  const resolved = resolveGuardrailPolicy(spec).detect[detector];
  return BOUNDARIES.filter((boundary) => resolved[boundary] === action);
}

Deno.test('every boundary is named once, and each kind of tool has its three', () => {
  assertEquals(new Set(BOUNDARIES).size, BOUNDARIES.length);
  assertEquals(BOUNDARIES.length, 25);
  assertEquals(TOOL_BOUNDARIES.length, 12);
  for (const kind of ['function', 'http', 'mcp', 'agent']) {
    for (const crossing of ['tool_arguments', 'tool_output', 'tool_failure']) {
      ok(TOOL_BOUNDARIES.some((boundary) => boundary === `${crossing}_${kind}`));
    }
  }
});

Deno.test('every detector, action and boundary has a label and a description', () => {
  const metas = [
    ...DETECTORS.map((detector) => DETECTOR_META[detector]),
    ...DETECT_ACTIONS.map((action) => DETECT_ACTION_META[action]),
    ...BOUNDARIES.map((boundary) => BOUNDARY_META[boundary]),
  ];
  for (const meta of metas) {
    ok(meta.label.length > 0);
    ok(meta.doc.length > 0);
  }
});

Deno.test('every detector is in a group, and its defaults name the boundaries it applies at', () => {
  for (const detector of DETECTORS) {
    const { group, defaults } = DETECTOR_META[detector];
    ok(DETECTOR_GROUP_META[group].label.length > 0);
    ok(DETECTOR_BOUNDARIES[detector].length > 0);
    assertEquals(
      DETECTOR_BOUNDARIES[detector],
      BOUNDARIES.filter((boundary) => boundary in defaults),
    );
    for (const boundary of BOUNDARIES) {
      assertEquals(DETECT_DEFAULTS[detector][boundary], defaults[boundary] ?? 'ignore');
    }
  }
  assertEquals(
    DETECTOR_GROUPS.flatMap((group) => DETECTORS.filter((d) => DETECTOR_META[d].group === group)),
    [...DETECTORS],
  );
});

/** The detectors of what the profile itself must not give away: they read only what the model writes. */
const LEAKS: readonly Detector[] = ['canary_leak', 'prompt_leak'];

Deno.test('what comes in is redacted by default, and nothing the model writes is read for it', () => {
  for (const detector of DETECTORS.filter((d) => !LEAKS.includes(d))) {
    assertEquals(where(undefined, detector, 'block'), []);
    assertEquals(where(undefined, detector, 'ignore').includes('reply'), true);
    assertEquals(where(undefined, detector, 'ignore').includes('thought'), true);
    for (const boundary of INBOUND) assertEquals(DETECT_DEFAULTS[detector][boundary], 'redact');
  }
});

Deno.test('a leak stops the reply by default and is taken out of a thought', () => {
  const calls = TOOL_BOUNDARIES.filter((boundary) => boundary.startsWith('tool_arguments_'));
  const replies: Boundary[] = ['reply', 'reply_structured', 'live_reply'];
  assertEquals(where(undefined, 'canary_leak', 'block'), [...calls, ...replies]);
  assertEquals(where(undefined, 'prompt_leak', 'block'), replies);
  assertEquals(where(undefined, 'prompt_leak', 'flag'), calls);
  for (const detector of LEAKS) {
    assertEquals(where(undefined, detector, 'redact'), ['thought']);
    for (const boundary of INBOUND) assertEquals(DETECT_DEFAULTS[detector][boundary], 'ignore');
  }
});

Deno.test('a tool call is flagged for data by default and not read for injection', () => {
  const calls = TOOL_BOUNDARIES.filter((boundary) => boundary.startsWith('tool_arguments_'));
  assertEquals(where(undefined, 'credentials', 'flag'), calls);
  assertEquals(where(undefined, 'injection', 'flag'), []);
  for (const boundary of calls) assertEquals(DETECT_DEFAULTS.injection[boundary], 'ignore');
});

Deno.test('one action sets every detector at every boundary it applies at', () => {
  for (const action of DETECT_ACTIONS.filter((each) => each !== 'ignore')) {
    for (const detector of DETECTORS) {
      assertEquals(where({ detect: action }, detector, action), [...DETECTOR_BOUNDARIES[detector]]);
    }
  }
  for (const detector of DETECTORS) {
    assertEquals(where({ detect: 'ignore' }, detector, 'ignore'), [...BOUNDARIES]);
  }
});

Deno.test('a detector takes one action everywhere or an action per boundary', () => {
  const spec: ProfileGuardrailsSpec = {
    detect: { credentials: 'block', ids: { at: { reply: 'block', tool_arguments_mcp: 'block' } } },
  };
  assertEquals(where(spec, 'credentials', 'block'), [...BOUNDARIES]);
  assertEquals(where(spec, 'ids', 'block'), ['tool_arguments_mcp', 'reply']);
  assertEquals(resolveGuardrailPolicy(spec).detect.ids.user, 'redact');
  assertEquals(resolveGuardrailPolicy(spec).detect.network, DETECT_DEFAULTS.network);
});

Deno.test('at names the boundaries that differ from action', () => {
  const spec: ProfileGuardrailsSpec = {
    detect: { ids: { action: 'flag', at: { reply: 'block' } } },
  };
  assertEquals(where(spec, 'ids', 'block'), ['reply']);
  assertEquals(where(spec, 'ids', 'flag').length, BOUNDARIES.length - 1);
});

Deno.test('detectProblem names a misspelt detector, boundary or action', () => {
  assertEquals(detectProblem('guardrails.detect', undefined), undefined);
  assertEquals(detectProblem('guardrails.detect', 'redact'), undefined);
  assertEquals(detectProblem('guardrails.detect', { ids: { at: { reply: 'block' } } }), undefined);
  const problems: [unknown, string][] = [
    ['mask', 'guardrails.detect must be one of'],
    [{ id: 'block' }, 'guardrails.detect.id is not a detector'],
    [{ ids: 'mask' }, 'guardrails.detect.ids must be one of'],
    [{ ids: { at: { replies: 'block' } } }, 'guardrails.detect.ids.at.replies is not a boundary'],
    [{ ids: { at: { reply: true } } }, 'guardrails.detect.ids.at.reply must be one of'],
    [{ ids: { reply: 'block' } }, 'guardrails.detect.ids.reply is not a setting of a detector'],
    [{ ids: { action: 'mask' } }, 'guardrails.detect.ids.action must be one of'],
    [{ ids: { at: 'block' } }, 'guardrails.detect.ids.at must be an object of boundaries'],
  ];
  for (const [spec, expected] of problems) {
    ok(detectProblem('guardrails.detect', spec)?.startsWith(expected));
  }
});

Deno.test('defineProfile rejects a bad detect rule, and a boundary a host profile lacks', () => {
  const text = {
    id: 'detect-text',
    type: 'text' as const,
    identity: { handle: 'detect' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
  };
  defineProfile({ ...text, guardrails: { detect: { ids: { at: { reply: 'block' } } } } });
  assertThrows(
    () => defineProfile({ ...text, guardrails: { detect: { ids: 'mask' as 'block' } } }),
    Error,
    'guardrails.detect.ids must be one of',
  );
  const host = { id: 'detect-host', type: 'host' as const, tools: { allow: [] } };
  defineProfile({ ...host, guardrails: { detect: { ids: { at: { tool_output_mcp: 'block' } } } } });
  defineProfile({ ...host, guardrails: { detect: 'flag' } });
  assertThrows(
    () => defineProfile({ ...host, guardrails: { detect: { ids: { at: { reply: 'block' } } } } }),
    Error,
    'guardrails.detect.ids.at.reply is not a boundary this profile has',
  );
});

Deno.test('the catalog has a row for the setting, each detector and each boundary it applies at', () => {
  ok('guardrails.detect' in PROFILE_FIELDS);
  for (const detector of DETECTORS) {
    ok(PROFILE_FIELDS[`guardrails.detect.${detector}`]?.doc.includes(DETECTOR_META[detector].doc));
    for (const boundary of BOUNDARIES) {
      const row = PROFILE_FIELDS[`guardrails.detect.${detector}.at.${boundary}`];
      if (!DETECTOR_BOUNDARIES[detector].includes(boundary)) {
        assertEquals(row, undefined);
        continue;
      }
      assertEquals(row?.doc, BOUNDARY_META[boundary].doc);
      assertEquals(row?.options, DETECT_ACTIONS);
      assertEquals(row?.unset, DETECT_ACTION_META[DETECT_DEFAULTS[detector][boundary]].label);
    }
  }
});
