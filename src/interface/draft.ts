/**
 * User turn draft — validate, sanitize, and project to transcript blocks.
 *
 * @module
 */

import { sanitizeText } from '../guardrails/sanitize.ts';
import { buildUserTurnBlocks } from './blocks.ts';
import { validateProfileInputs } from './inputs.ts';
import type {
  AttachmentValidationIssue,
  ProfileGuardrailsView,
  ProfileInputsInterface,
  TranscriptBlock,
  UserTurnDraft,
} from './types.ts';

function guardrailTextOptions(guardrails?: ProfileGuardrailsView): {
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
} {
  return {
    sanitizeInput: guardrails?.sanitizeInput ?? true,
    redactSensitive: guardrails?.redactSensitive ?? true,
  };
}

/** Sanitize user-authored text in a draft using profile guardrail flags. */
function sanitizeUserDraft(
  draft: UserTurnDraft,
  guardrails?: ProfileGuardrailsView,
): UserTurnDraft {
  const options = guardrailTextOptions(guardrails);
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
