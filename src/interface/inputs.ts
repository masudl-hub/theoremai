/**
 * Profile `inputs` → UI affordances and validation.
 *
 * @module
 */

import { attachmentIssues, resolveMediaLimits } from '../kernel/registry/attachments.ts';
import { mimeAllowed } from '../kernel/registry/catalog.ts';
import type { ProfileInputsSpec } from '../kernel/types.ts';
import type {
  AttachmentValidationResult,
  PendingAttachment,
  ProfileInputsInterface,
  UserTurnDraft,
} from './types.ts';

const RECORDER_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/wav',
  'audio/mpeg',
] as const;

function attachmentAcceptAttr(accept: string[]): string {
  return accept.join(',');
}

/** `inputs` is null for profile types that declare none (the kernel's `profileInputs`). */
function inputsFromSpec(inputs: ProfileInputsSpec | null | undefined): ProfileInputsInterface {
  const accept = inputs?.attachments?.accept;
  const voiceAccept = inputs?.voice?.accept;

  return {
    text: inputs?.text !== false,
    attachments: accept?.length ? { accept, acceptAttr: attachmentAcceptAttr(accept) } : null,
    voice: voiceAccept?.length ? { accept: voiceAccept } : null,
    maxFiles: inputs?.maxFiles,
    maxBytes: inputs?.maxBytes,
    maxTurnBytes: inputs?.maxTurnBytes,
    limitsByMime: inputs?.limitsByMime,
    slots: inputs?.slots,
  };
}

function toProfileInputsSpec(inputs: ProfileInputsInterface): ProfileInputsSpec {
  return {
    text: inputs.text,
    attachments: inputs.attachments ? { accept: inputs.attachments.accept } : undefined,
    voice: inputs.voice ? { accept: inputs.voice.accept } : undefined,
    maxFiles: inputs.maxFiles,
    maxBytes: inputs.maxBytes,
    maxTurnBytes: inputs.maxTurnBytes,
    limitsByMime: inputs.limitsByMime,
    slots: inputs.slots,
  };
}

/** Validate staged files against resolved profile `inputs`: the kernel's one attachment check. */
function validateProfileInputs(
  inputs: ProfileInputsInterface,
  draft: Pick<UserTurnDraft, 'attachments' | 'voice'>,
): AttachmentValidationResult {
  const facts = (files: PendingAttachment[] | undefined) =>
    (files ?? []).map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes }));
  const issues = attachmentIssues(
    {
      attachments: inputs.attachments?.accept,
      voice: inputs.voice?.accept,
      limits: resolveMediaLimits(toProfileInputsSpec(inputs)),
      maxImages: inputs.maxImages,
    },
    facts(draft.attachments),
    facts(draft.voice),
  );
  return { ok: issues.length === 0, issues };
}

/** The first accepted format this browser can record; undefined when it can record none. */
function pickMediaRecorderMime(accept?: string[]): string | undefined {
  const recorder = (globalThis as { MediaRecorder?: { isTypeSupported(m: string): boolean } })
    .MediaRecorder;
  if (recorder === undefined) return undefined;
  const supported = (mime: string) => recorder.isTypeSupported(mime);
  const fromCandidates = (pool: readonly string[]) => pool.find(supported);
  if (accept?.length) {
    return (
      fromCandidates(RECORDER_CANDIDATES.filter((mime) => mimeAllowed(accept, mime))) ??
      accept.find(supported)
    );
  }
  return fromCandidates(RECORDER_CANDIDATES);
}

export { attachmentAcceptAttr, inputsFromSpec, pickMediaRecorderMime, validateProfileInputs };
