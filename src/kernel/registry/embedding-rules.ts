import type { EmbeddingModelLimits } from '../protocols/protocol.ts';
import type { AttachmentValidationIssue, MimeInputs } from '../types.ts';
import { mimeEssence } from '../util/mime.ts';
import { type AttachmentFacts, attachmentIssues, resolveMediaLimits } from './attachments.ts';
import { mimeAllowed } from './catalog.ts';

/**
 * What one embedding request may carry: the profile's inputs held to its model's limits. File
 * counts are per input, sizes per file and across the request.
 */
export interface EmbeddingRules {
  text: boolean;
  attachments?: { accept: string[] };
  maxFiles?: number;
  maxBytes?: number;
  maxTurnBytes?: number;
  limitsByMime?: Record<string, number>;
  /** Inputs one request may carry. */
  maxInputs?: number;
  /** The model's caps on one kind of media in one input. */
  perInput?: { accept: string[]; max: number }[];
}

/** The types both lists take, each as narrow as the narrower list names it. */
function bothAccept(profile: readonly string[], model: readonly string[]): string[] {
  return [
    ...new Set([
      ...model.filter((mime) => mimeAllowed(profile, mime)),
      ...profile.filter((mime) => mimeAllowed(model, mime)),
    ]),
  ];
}

/** The profile's inputs held to what its model takes; without the model's limits, the profile's alone. */
export function embeddingRules(inputs: MimeInputs, model?: EmbeddingModelLimits): EmbeddingRules {
  const accept = inputs.attachments
    ? model
      ? bothAccept(
          inputs.attachments.accept,
          model.media.flatMap((kind) => kind.accept),
        )
      : [...inputs.attachments.accept]
    : [];
  const perInput = (model?.media ?? []).flatMap((kind) =>
    kind.maxPerInput === undefined ? [] : [{ accept: [...kind.accept], max: kind.maxPerInput }],
  );
  return {
    text: inputs.text !== false,
    ...(accept.length > 0 ? { attachments: { accept } } : {}),
    ...(inputs.maxFiles === undefined ? {} : { maxFiles: inputs.maxFiles }),
    ...(inputs.maxBytes === undefined ? {} : { maxBytes: inputs.maxBytes }),
    ...(inputs.maxTurnBytes === undefined ? {} : { maxTurnBytes: inputs.maxTurnBytes }),
    ...(inputs.limitsByMime === undefined ? {} : { limitsByMime: { ...inputs.limitsByMime } }),
    ...(model?.maxInputs === undefined ? {} : { maxInputs: model.maxInputs }),
    ...(perInput.length > 0 ? { perInput } : {}),
  };
}

/** How the user reads a kind of media: PDF, or its top-level type. */
function kindName(accept: readonly string[]): string {
  const first = mimeEssence(accept[0] ?? '');
  return first === 'application/pdf' ? 'PDF' : (first.split('/')[0] ?? first);
}

/** The one embedding media check, input by input: the kernel throws on it and the client runs it before a send. */
export function embeddingMediaIssues(
  rules: EmbeddingRules,
  media: readonly (readonly AttachmentFacts[])[],
): AttachmentValidationIssue[] {
  const limits = resolveMediaLimits(rules);
  const issues = attachmentIssues(
    {
      attachments: rules.attachments?.accept,
      ...(limits ? { limits: { ...limits, maxFiles: Number.MAX_SAFE_INTEGER } } : {}),
    },
    media.flat(),
    [],
  );
  if (limits) {
    for (const files of media) {
      if (files.length > limits.maxFiles)
        issues.push({ code: 'too_many_files', params: { maxFiles: limits.maxFiles } });
      for (const kind of rules.perInput ?? []) {
        const count = files.filter((file) => mimeAllowed(kind.accept, file.mimeType)).length;
        if (count > kind.max)
          issues.push({
            code: 'too_many_of_kind',
            params: { maxFiles: kind.max, kind: kindName(kind.accept) },
          });
      }
    }
  }
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
