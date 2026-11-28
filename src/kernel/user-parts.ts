import { z } from 'zod';

/**
 * One piece of a person's message, in the order they wrote it: words, or a reference to one of the
 * host's own objects. `kind` and `id` are the host's strings; Theorem lists and checks neither. They
 * come from the client, so the host checks that the person may use what they name.
 */
export type UserPart = { type: 'text'; text: string } | { type: 'ref'; kind: string; id: string };

/** A {@linkcode UserPart} that references one of the host's objects. */
export type UserRef = Extract<UserPart, { type: 'ref' }>;

/** How the host writes a ref into the message's plain text, which the model reads. */
export type RefText = (ref: UserRef) => string;

/** The {@linkcode RefText} used when the host gives none: the ref's id. */
export const refIdText: RefText = (ref) => ref.id;

export const userPartSchema: z.ZodType<UserPart> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('ref'), kind: z.string(), id: z.string() }),
]);

/** The plain text of `parts`: their words, with each ref written by `refText`. */
export function textOfParts(parts: readonly UserPart[], refText: RefText = refIdText): string {
  return parts.map((part) => (part.type === 'text' ? part.text : refText(part))).join('');
}

/** Whether any of `parts` is a ref. */
export function hasRef(parts: readonly UserPart[] | undefined): parts is UserPart[] {
  return parts?.some((part) => part.type === 'ref') ?? false;
}

/**
 * `parts` as a message keeps them: neighbouring words joined, empty words dropped, and the space at
 * both ends trimmed. `undefined` when they name no ref, as the plain text then says everything.
 */
export function messageParts(parts: readonly UserPart[] | undefined): UserPart[] | undefined {
  if (!hasRef(parts)) return undefined;
  const joined: UserPart[] = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if (part.type === 'text' && last?.type === 'text') {
      joined[joined.length - 1] = { type: 'text', text: last.text + part.text };
    } else joined.push({ ...part });
  }
  const end = joined.length - 1;
  return joined.flatMap((part, at): UserPart[] => {
    if (part.type === 'ref') return [part];
    const head = at === 0 ? part.text.trimStart() : part.text;
    const text = at === end ? head.trimEnd() : head;
    return text ? [{ type: 'text', text }] : [];
  });
}
