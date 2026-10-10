/**
 * What `tool_leak` reads for: the names of the profile's own tools, each as a word of its own,
 * and the names of their parameters in double quotes, as tool-call JSON writes its keys. A
 * parameter is often a plain word (`city`, `query`), so outside quotes it is left alone.
 *
 * @module
 */

import type { RedactSpan } from '../observability/spans.ts';

/** The names of a profile's own tools, and of their parameters. */
interface OwnTools {
  names: readonly string[];
  params: readonly string[];
}

/** A literal of a name to find, and the pattern that reads a match of it. */
interface NamePattern {
  literal: string;
  regex: RegExp;
}

const WORD = '[A-Za-z0-9_]';

function escaped(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** The pattern of each name of `own`. A tool's name starts and ends where a word does. */
function namePatterns(own: OwnTools): NamePattern[] {
  const after = `(?!${WORD})`;
  const names = [...new Set(own.names)].filter(Boolean).map((name) => ({
    literal: name,
    regex: new RegExp(`(?<!${WORD})${escaped(name)}${after}`, 'g'),
  }));
  const keys = [...new Set(own.params)]
    .filter(Boolean)
    .flatMap((param) => [`"${param}"`, `\\"${param}\\"`])
    .map((literal) => ({ literal, regex: new RegExp(escaped(literal), 'g') }));
  return [...names, ...keys];
}

/** Every match of a name of `own` in `text`. */
function toolLeakSpans(text: string, own: OwnTools | undefined): RedactSpan[] {
  if (!own) return [];
  return namePatterns(own).flatMap(({ literal, regex }) =>
    text.includes(literal)
      ? [...text.matchAll(regex)].map(({ index, 0: match }) => ({
          start: index,
          end: index + match.length,
          kind: 'tool' as const,
        }))
      : [],
  );
}

/** `own` without the names in `innocent`, or `undefined` when none is left. */
function ownToolsWithout(
  own: OwnTools | undefined,
  innocent: readonly string[] = [],
): OwnTools | undefined {
  if (!own) return undefined;
  const names = own.names.filter((name) => !innocent.includes(name));
  const params = own.params.filter((name) => !innocent.includes(name));
  return names.length + params.length > 0 ? { names, params } : undefined;
}

export type { NamePattern, OwnTools };
export { namePatterns, ownToolsWithout, toolLeakSpans };
