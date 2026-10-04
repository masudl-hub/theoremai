import { resolveGuardrailPolicy } from '../guardrails/policy.ts';
import { sanitizeText } from '../guardrails/sanitize.ts';
import { anySensitive } from '../guardrails/sensitive.ts';
import type { AttachmentValidationIssue } from '../kernel/types.ts';
import { buildUserTurnBlocks } from './blocks.ts';
import { validateProfileInputs } from './inputs.ts';
import type {
  ProfileGuardrailsView,
  ProfileInputsInterface,
  TranscriptBlock,
  UserTurnDraft,
} from './types.ts';

/** Applies a profile's input guardrails to a draft's text, redacting sensitive values and sanitizing as its policy asks; returns the draft as it is when neither applies. */
function sanitizeUserDraft(
  draft: UserTurnDraft,
  guardrails?: ProfileGuardrailsView,
): UserTurnDraft {
  const options = guardrails ?? resolveGuardrailPolicy(undefined);
  if (!options.sanitizeInput && !anySensitive(options.redactSensitive)) {
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
