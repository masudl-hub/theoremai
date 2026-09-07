/**
 * Profile `inputs` → UI affordances and validation.
 *
 * @module
 */

import {
  fileTooLargeMessage,
  maxBytesForMime,
  resolveMediaLimits,
  tooManyFilesMessage,
  turnTooLargeMessage,
} from '../kernel/registry/attachments.ts';
import { mimeAllowed } from '../kernel/registry/catalog.ts';
import type { ProfileInputsSpec, ProfileType } from '../kernel/types.ts';
import type {
  AttachmentValidationIssue,
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

function inputsFromSpec(
  type: ProfileType,
  inputs: ProfileInputsSpec | null | undefined,
): ProfileInputsInterface {
  if (type === 'speech' || type === 'live') {
    return { text: true, attachments: null, voice: null };
  }

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

function issue(
  code: AttachmentValidationIssue['code'],
  message: string,
  fileName?: string,
): AttachmentValidationIssue {
  return { code, message, fileName };
}

function validateMime(
  accept: string[],
  files: PendingAttachment[],
  channelLabel: 'attachment' | 'voice',
): AttachmentValidationIssue[] {
  const issues: AttachmentValidationIssue[] = [];
  for (const file of files) {
    if (!mimeAllowed(accept, file.mimeType)) {
      issues.push(
        issue(
          'mime_not_allowed',
          `${file.name}: MIME '${file.mimeType}' is not accepted for ${channelLabel} input.`,
          file.name,
        ),
      );
    }
  }
  return issues;
}

function validateLimits(
  files: PendingAttachment[],
  limits: NonNullable<ReturnType<typeof resolveMediaLimits>>,
): AttachmentValidationIssue[] {
  const issues: AttachmentValidationIssue[] = [];
  if (files.length > limits.maxFiles) {
    issues.push(issue('too_many_files', tooManyFilesMessage(limits.maxFiles)));
    return issues;
  }

  let total = 0;
  for (const file of files) {
    const maxAllowed = maxBytesForMime(file.mimeType, limits);
    if (file.sizeBytes > maxAllowed) {
      issues.push(issue('file_too_large', fileTooLargeMessage(maxAllowed), file.name));
    }
    total += file.sizeBytes;
  }

  if (total > limits.maxTurnBytes) {
    issues.push(issue('turn_too_large', turnTooLargeMessage(limits.maxTurnBytes)));
  }

  return issues;
}

/** Validate staged files against resolved profile `inputs`. */
function validateProfileInputs(
  inputs: ProfileInputsInterface,
  draft: Pick<UserTurnDraft, 'attachments' | 'voice'>,
): AttachmentValidationResult {
  const attachments = draft.attachments ?? [];
  const voice = draft.voice ?? [];
  if (attachments.length === 0 && voice.length === 0) {
    return { ok: true, issues: [] };
  }

  if (attachments.length > 0 && !inputs.attachments) {
    return {
      ok: false,
      issues: [issue('mime_not_allowed', 'This profile does not accept file attachments.')],
    };
  }
  if (voice.length > 0 && !inputs.voice) {
    return {
      ok: false,
      issues: [issue('mime_not_allowed', 'This profile does not accept voice input.')],
    };
  }

  const spec = toProfileInputsSpec(inputs);
  const issues: AttachmentValidationIssue[] = [];

  if (attachments.length > 0 && inputs.attachments) {
    issues.push(...validateMime(inputs.attachments.accept, attachments, 'attachment'));
  }
  if (voice.length > 0 && inputs.voice) {
    issues.push(...validateMime(inputs.voice.accept, voice, 'voice'));
  }

  const limits = resolveMediaLimits(spec);
  if (!limits) {
    issues.push(
      issue(
        'limits_unconfigured',
        'This profile accepts media but does not define maxFiles, maxBytes, and maxTurnBytes.',
      ),
    );
    return { ok: false, issues };
  }

  issues.push(...validateLimits([...attachments, ...voice], limits));
  return { ok: issues.length === 0, issues };
}

function pickMediaRecorderMime(accept?: string[]): string | undefined {
  const supported = (mime: string) => {
    const recorder = (globalThis as { MediaRecorder?: { isTypeSupported(m: string): boolean } })
      .MediaRecorder;
    return recorder === undefined || recorder.isTypeSupported(mime);
  };
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
