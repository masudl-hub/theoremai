import { detectAt } from '../guardrails/detect-at.ts';
import { DETECT_DEFAULTS } from '../guardrails/detectors.ts';
import type { AttachmentValidationIssue } from '../kernel/types.ts';
import { buildUserTurnBlocks } from './blocks.ts';
import { validateProfileInputs } from './inputs.ts';
import type {
  ProfileGuardrailsView,
  ProfileInputsInterface,
  TranscriptBlock,
  UserTurnDraft,
} from './types.ts';

/** Reads a draft's text at the `user` boundary, as the kernel will: a match set to redact shows as its placeholder. A match set to block leaves the draft as typed; the kernel refuses the turn. */
function sanitizeUserDraft(
  draft: UserTurnDraft,
  guardrails?: ProfileGuardrailsView,
): UserTurnDraft {
  if (draft.text === undefined) {
    return draft;
  }
  const detected = detectAt(draft.text, 'user', guardrails?.detect ?? DETECT_DEFAULTS);
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
