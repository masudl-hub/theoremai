/**
 * User turn draft — validate, sanitize, and project to transcript blocks.
 *
 * @module
 */

import { resolveGuardrailPolicy } from '../guardrails/policy.ts';
import { sanitizeText } from '../guardrails/sanitize.ts';
import type { AttachmentValidationIssue } from '../kernel/types.ts';
import { buildUserTurnBlocks } from './blocks.ts';
import { validateProfileInputs } from './inputs.ts';
import type {
  ProfileGuardrailsView,
  ProfileInputsInterface,
  TranscriptBlock,
  UserTurnDraft,
} from './types.ts';

/** Sanitize user-authored text in a draft using profile guardrail flags. */
function sanitizeUserDraft(
  draft: UserTurnDraft,
  guardrails?: ProfileGuardrailsView,
): UserTurnDraft {
  const options = guardrails ?? resolveGuardrailPolicy(undefined);
  if (!options.sanitizeInput && !options.redactSensitive) {
    return draft;
  }
  if (draft.text === undefined) {
    return draft;
  }
  return {
    ...draft,
    text: sanitizeText(draft.text, options),
  };
}

export type PrepareUserTurnResult =
  | { ok: true; draft: UserTurnDraft; blocks: TranscriptBlock[] }
  | { ok: false; issues: AttachmentValidationIssue[] };

/**
 * Validate attachments, sanitize text, and build user transcript blocks.
 * Call before appending to the thread and before `runTurn` ingress.
 */
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
