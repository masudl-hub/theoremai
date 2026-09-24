/**
 * MIME allowlist picking — groups the kernel's accepted MIME types by media
 * kind and treats a kind's wildcard (`image/*`, …) as "every type of that
 * kind", since the kernel rejects types it doesn't know at ingress anyway.
 *
 * A draft stores the canonical list: a wildcard stands alone for its kind. A
 * picker shows the expanded list, so every type the wildcard covers reads as
 * selected.
 *
 * @module
 */

import { MEDIA_INPUT_KINDS, type MediaInputKind } from '../src/kernel/schema.ts';

/** One media kind's MIME types, and the wildcard that covers them when there is one. */
export interface AcceptSection {
  kind: MediaInputKind;
  wildcard?: string;
  mimes: string[];
}

/** Group an allowlist's options (e.g. `ATTACHMENT_ACCEPT_MIMES`) by media kind, in list order. */
export function acceptSections(options: readonly string[]): AcceptSection[] {
  const sections = new Map<MediaInputKind, AcceptSection>();
  const section = (kind: MediaInputKind) => {
    const existing = sections.get(kind);
    if (existing) return existing;
    const created: AcceptSection = { kind, mimes: [] };
    sections.set(kind, created);
    return created;
  };
  for (const mime of options) {
    const kind = MEDIA_INPUT_KINDS[mime] ?? wildcardKind(mime);
    if (!kind) continue;
    if (mime.endsWith('/*')) section(kind).wildcard = mime;
    else section(kind).mimes.push(mime);
  }
  return [...sections.values()];
}

/** The picker's selection for a stored list: each wildcard brings every type it covers. */
export function expandAccept(
  accept: readonly string[],
  sections: readonly AcceptSection[],
): string[] {
  const covered = sections.flatMap(({ wildcard, mimes }) =>
    wildcard && accept.includes(wildcard) ? mimes : []
  );
  return [...new Set([...accept, ...covered])];
}

/**
 * The list to store after the picker changes from `expandAccept(previous)` to
 * `selected`. Picking a wildcard takes every type of its kind; unpicking it
 * clears the kind; unpicking one type under a wildcard keeps the rest; picking
 * every type of a kind collapses to its wildcard.
 */
export function nextAccept(
  previous: readonly string[],
  selected: readonly string[],
  sections: readonly AcceptSection[],
): string[] {
  const next: string[] = [];
  for (const { wildcard, mimes } of sections) {
    const picked = mimes.filter((mime) => selected.includes(mime));
    if (!wildcard) {
      next.push(...picked);
      continue;
    }
    const had = previous.includes(wildcard);
    const has = selected.includes(wildcard);
    if (has && !had) next.push(wildcard);
    else if (had && !has) continue;
    else if (picked.length === mimes.length) next.push(wildcard);
    else next.push(...picked);
  }
  const known = new Set(
    sections.flatMap(({ wildcard, mimes }) => wildcard ? [wildcard, ...mimes] : mimes),
  );
  return [...next, ...selected.filter((mime) => !known.has(mime))];
}

function wildcardKind(mime: string): MediaInputKind | undefined {
  if (!mime.endsWith('/*')) return undefined;
  const prefix = mime.slice(0, -1);
  const concrete = Object.keys(MEDIA_INPUT_KINDS).find((mime) => mime.startsWith(prefix));
  return concrete ? MEDIA_INPUT_KINDS[concrete] : undefined;
}
