import { detectAt } from '../guardrails/detect-at.ts';
import { DETECT_DEFAULTS, type ResolvedDetect } from '../guardrails/detectors.ts';
import type { AttachmentValidationIssue } from '../kernel/types.ts';
import { buildUserTurnBlocks } from './blocks.ts';
import { validateProfileInputs } from './inputs.ts';
import type {
  ProfileGuardrailsView,
  ProfileInputsInterface,
  TranscriptBlock,
  UserTurnDraft,
} from './types.ts';

/** The view's matrix with Theorem's patterns off where the profile turned them off. The host's own patterns stay with the kernel. */
function detectOf(guardrails?: ProfileGuardrailsView): ResolvedDetect {
  if (!guardrails) return DETECT_DEFAULTS;
  const { detect, patterns } = guardrails;
  if (!patterns) return detect;
  const sources = Object.fromEntries(
    Object.entries(patterns).map(([detector, { theorem }]) => [
      detector,
      { theorem, matchers: [] },
    ]),
  );
  return { ...detect, sources };
}

/**
 * Reads a draft's text at the `user` boundary with Theorem's patterns, as the kernel will: a
 * match set to redact shows as its placeholder. A match set to block leaves the draft as typed;
 * the kernel refuses the turn. A match of the host's own patterns is the kernel's to find.
 */
function sanitizeUserDraft(
  draft: UserTurnDraft,
  guardrails?: ProfileGuardrailsView,
): UserTurnDraft {
  if (draft.text === undefined) {
    return draft;
  }
  const detected = detectAt(draft.text, 'user', detectOf(guardrails));
  return { ...draft, text: detected.text ?? draft.text };
}

/** The result of preparing a user turn: the sanitized draft with its transcript blocks, or the attachment issues that rejected it. */
export type PrepareUserTurnResult =
  | { ok: true; draft: UserTurnDraft; blocks: TranscriptBlock[] }
  | { ok: false; issues: AttachmentValidationIssue[] };

/** Call before appending to the thread and before `runTurn` ingress. */
function prepareUserTurn(
  inputs: ProfileInputsInterface,
  draft: UserTurnDraft,
  guardrails?: ProfileGuardrailsView,
): PrepareUserTurnResult {
  const validation = validateProfileInputs(inputs, draft);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }
  const safe = sanitizeUserDraft(draft, guardrails);
  return { ok: true, draft: safe, blocks: buildUserTurnBlocks(safe) };
}

export { prepareUserTurn, sanitizeUserDraft };
