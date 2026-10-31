import type { StudioDraft, SystemLineDraft } from '../../studio/draft.ts';

/** The draft's prompt with its first line reading `text`: the one edit most tests make. */
export function firstLine(draft: StudioDraft, text: string): SystemLineDraft[] {
  const [line, ...rest] = draft.identity.system;
  return line ? [{ ...line, text }, ...rest] : [{ key: 'line-00000000', text }];
}
