import { sha256Base64 } from '../../kernel/engine/hash.ts';
import type { TurnBlob, TurnMediaRef } from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';
import { attachmentData } from '../attachments.ts';
import type { EvalAttachment, EvalGradeContext, Trial } from '../types.ts';
import { modelCalls } from './shared.ts';

interface TrialMedia {
  label: string;
  mimeType: string;
  from: 'input' | 'output';
  sha256?: string;
  uri?: string;
}

function mediaKey(part: Record<string, unknown>): string | undefined {
  if (part.type === 'blob' && typeof part.content_sha256 === 'string') return part.content_sha256;
  if (part.type === 'uri' && typeof part.uri === 'string') return part.uri;
  return undefined;
}

function messageParts(messages: unknown): Record<string, unknown>[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) =>
    isRecord(message) && Array.isArray(message.parts) ? message.parts.filter(isRecord) : [],
  );
}

function trialMedia(trial: Trial): TrialMedia[] {
  const parts = [
    ...messageParts(trial.content(trial.root.attributes['gen_ai.input.messages'])).map((part) => ({
      part,
      from: 'input' as const,
    })),
    ...modelCalls(trial).flatMap((span) =>
      messageParts(trial.content(span.attributes['gen_ai.output.messages'])).map((part) => ({
        part,
        from: 'output' as const,
      })),
    ),
  ];
  const media = new Map<string, TrialMedia>();
  for (const { part, from } of parts) {
    const key = mediaKey(part);
    if (key === undefined || media.has(key)) continue;
    const mimeType =
      typeof part.mime_type === 'string' ? part.mime_type : 'application/octet-stream';
    const kind = typeof part.modality === 'string' ? part.modality : 'file';
    media.set(key, {
      label: `[${kind} ${media.size + 1}: ${mimeType}]`,
      mimeType,
      from,
      ...(part.type === 'blob' ? { sha256: key } : { uri: key }),
    });
  }
  return [...media.values()];
}

function mediaLabeler(trial: Trial): (part: Record<string, unknown>) => string {
  const byKey = new Map(
    trialMedia(trial).map((media) => [media.sha256 ?? media.uri ?? '', media.label]),
  );
  return (part) => byKey.get(mediaKey(part) ?? '') ?? `[${String(part.type)}]`;
}

async function caseAttachments(trial: Trial): Promise<Map<string, EvalAttachment>> {
  const byHash = new Map<string, EvalAttachment>();
  const input = trial.case?.input;
  const attachments = input && 'attachments' in input ? (input.attachments ?? []) : [];
  for (const attachment of attachments) {
    if (!('data' in attachment)) {
      byHash.set(attachment.sha256, attachment);
      continue;
    }
    const digest = await sha256Base64(attachment.data);
    if (digest) byHash.set(digest.hash, attachment);
  }
  return byHash;
}

// why: The host's bytes for a hash, only when they are the bytes the trace hashed.
async function fromHost(
  sha256: string,
  mimeType: string,
  context: EvalGradeContext,
): Promise<string | undefined> {
  const data = await context.media?.({ sha256, mimeType });
  if (data === undefined) return undefined;
  return (await sha256Base64(data))?.hash === sha256 ? data : undefined;
}

async function resolveMedia(
  trial: Trial,
  media: readonly TrialMedia[],
  context: EvalGradeContext,
): Promise<{ attachments: Array<TurnBlob | TurnMediaRef> } | { missing: string[] }> {
  const fromCase = await caseAttachments(trial);
  const attachments: Array<TurnBlob | TurnMediaRef> = [];
  const missing: string[] = [];
  for (const item of media) {
    if (item.uri !== undefined) {
      attachments.push({ mimeType: item.mimeType, uri: item.uri });
      continue;
    }
    const sha256 = item.sha256 ?? '';
    const attachment = fromCase.get(sha256);
    const data = attachment
      ? await attachmentData(attachment)
      : await fromHost(sha256, item.mimeType, context);
    if (data === undefined) missing.push(item.label);
    else attachments.push({ mimeType: item.mimeType, data });
  }
  return missing.length > 0 ? { missing } : { attachments };
}

export type { TrialMedia };
export { mediaLabeler, resolveMedia, trialMedia };
