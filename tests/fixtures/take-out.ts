import {
  INBOUND_BOUNDARIES,
  recordOf,
  TOOL_KINDS,
  toolBoundary,
} from '../../src/guardrails/boundaries.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';

const COMING_IN = {
  ...recordOf(INBOUND_BOUNDARIES, () => 'redact' as const),
  ...Object.fromEntries(
    TOOL_KINDS.flatMap((kind) => [
      [toolBoundary('tool_output', kind), 'redact' as const],
      [toolBoundary('tool_failure', kind), 'redact' as const],
    ]),
  ),
};

/**
 * What a profile that takes out data and injection on the way in sets: what reaches the model is
 * redacted, and a credential also in a reply and in what a tool shows the person.
 */
export const TAKE_OUT_INBOUND = {
  ids: { at: COMING_IN },
  financial: { at: COMING_IN },
  network: { at: COMING_IN },
  credentials: {
    at: {
      ...COMING_IN,
      ...Object.fromEntries(
        TOOL_KINDS.map((kind) => [toolBoundary('tool_shown', kind), 'redact' as const]),
      ),
      reply: 'redact',
      reply_structured: 'redact',
    },
  },
  injection: { at: COMING_IN },
} as const satisfies DetectSpec;
