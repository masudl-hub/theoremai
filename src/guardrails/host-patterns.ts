// invariant: Leaf module. Imports nothing from `src/guardrails/types.ts` or `src/kernel/`, so
// `detectors.ts` can read a host's patterns without a cycle.

/** lexicon-exempt-file: profile-registration diagnostics for a host's patterns — not runtime user or model copy (P2) */

/**
 * A pattern of the host's own, as data: a regular expression, or words. Words match whole and
 * without regard to case, and a space in one matches any run of whitespace.
 */
type HostPattern =
  | {
      /** What a match is called in the trace. */
      name: string;
      /** The source of a regular expression. */
      pattern: string;
      /** Any of `i`, `m`, `s` and `u`. Every match is found, so `g` is implied; `y` is refused. */
      flags?: string;
    }
  | {
      /** What a match is called in the trace. */
      name: string;
      words: readonly string[];
    };

/**
 * An automaton over UTF-16 code units, as tables.
 *
 * - `classStarts`: first code unit of each character class; class k covers
 *   `[classStarts[k], classStarts[k+1])`.
 * - `charsets`: each charset as the sorted class ids it contains.
 * - `initials`: the initial node of each pattern.
 * - `leads`: per pattern, the charset an optional repeat opening it reads, or
 *   -1. The pattern's nodes are of what follows the repeat.
 * - `nodes`: each node as `[pattern, final (0/1), target, charset, target, charset, ...]`.
 */
interface AutomatonData {
  classStarts: readonly number[];
  charsets: readonly (readonly number[])[];
  initials: readonly number[];
  leads: readonly number[];
  nodes: readonly (readonly number[])[];
}

/**
 * What compiling a list of patterns writes (`compilePatterns`, `agents detect-compile`): the
 * patterns it read and checked, and their automaton. A stream holds exactly the text a match
 * could still be under way in by it.
 */
interface CompiledPatterns {
  /** `PATTERN_COMPILER_VERSION` of the compiler that wrote it. */
  compiler: number;
  /** Each pattern as compiled, in order: a table that no longer matches its patterns is refused. */
  patterns: readonly PatternSource[];
  automaton: AutomatonData;
}

/** A pattern as the kernel runs it: the source and flags of its regular expression. */
interface PatternSource {
  name: string;
  source: string;
  flags: string;
}

/** A host pattern ready to run. */
interface HostMatcher {
  name: string;
  /** Global, so every match is found. */
  regex: RegExp;
}

/** Bumped whenever the compiled table's layout or meaning changes. */
const PATTERN_COMPILER_VERSION = 3;

/** The most patterns one detector takes, and the longest each may be once written as a regular expression. */
const MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 1024;

const PATTERN_FLAGS = 'imsu';
/** A letter, digit or underscore in any script: what a word may not touch on either side. */
const WORD_UNIT = '[\\p{L}\\p{N}_]';

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `words` as one alternation, longest first so a word is not cut short by one it starts with. */
function wordsSource(words: readonly string[]): string {
  const alternatives = [...new Set(words.map((word) => word.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((word) => word.split(/\s+/).map(escaped).join('\\s+'));
  return `(?<!${WORD_UNIT})(?:${alternatives.join('|')})(?!${WORD_UNIT})`;
}

/** The regular expression `pattern` runs as. */
function patternSource(pattern: HostPattern): PatternSource {
  if ('words' in pattern) {
    return { name: pattern.name, source: wordsSource(pattern.words), flags: 'iu' };
  }
  return { name: pattern.name, source: pattern.pattern, flags: pattern.flags ?? '' };
}

/** The patterns as a compiled table records them. */
function patternSources(patterns: readonly HostPattern[]): PatternSource[] {
  return patterns.map(patternSource);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** What is wrong with the shape of one pattern, before it is compiled. */
function shapeProblem(path: string, pattern: unknown): string | undefined {
  if (!isRecord(pattern)) return `${path} must be an object`;
  const { name, words, flags } = pattern;
  if (typeof name !== 'string' || !name.trim()) return `${path}.name must be a non-empty string`;
  const kinds = ['pattern', 'words'].filter((key) => pattern[key] !== undefined);
  if (kinds.length !== 1) return `${path} takes one of pattern and words`;
  const unknown = Object.keys(pattern).find(
    (key) => !['name', 'pattern', 'flags', 'words'].includes(key),
  );
  if (unknown !== undefined) {
    return `${path}.${unknown} is not a setting of a pattern (name, pattern, flags, words)`;
  }
  if (words !== undefined) {
    if (flags !== undefined) return `${path}.flags is a setting of pattern, not of words`;
    if (!isStrings(words) || !words.some((word) => word.trim())) {
      return `${path}.words must be a list with at least one word`;
    }
    return undefined;
  }
  if (typeof pattern.pattern !== 'string' || !pattern.pattern) {
    return `${path}.pattern must be a non-empty string`;
  }
  if (flags === undefined) return undefined;
  if (typeof flags !== 'string') return `${path}.flags must be a string`;
  const bad = [...flags].find(
    (flag, at) => !PATTERN_FLAGS.includes(flag) || flags.indexOf(flag) < at,
  );
  if (bad === 'y')
    return `${path}.flags: a sticky (y) pattern only matches where the last one ended`;
  if (bad === 'g') return `${path}.flags: g is implied, every match is found`;
  return bad === undefined
    ? undefined
    : `${path}.flags takes each of ${[...PATTERN_FLAGS].join(', ')} once, not ${JSON.stringify(bad)}`;
}

/** What is wrong with one pattern, or `undefined` when it runs. */
function patternProblem(path: string, pattern: unknown): string | undefined {
  const shape = shapeProblem(path, pattern);
  if (shape !== undefined) return shape;
  const { source, flags } = patternSource(pattern as HostPattern);
  if (source.length > MAX_PATTERN_LENGTH) {
    return `${path} is ${source.length} characters as a regular expression; the most is ${MAX_PATTERN_LENGTH}`;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(source, `${flags}g`);
  } catch (err) {
    return `${path} does not compile (${err instanceof Error ? err.message : String(err)})`;
  }
  // why: A pattern the empty text matches matches between every two characters: it names nothing.
  return regex.test('') ? `${path} matches the empty text` : undefined;
}

/** Whether `compiled` was written for `sources` by this compiler. */
function compiledProblem(
  path: string,
  compiled: unknown,
  sources: readonly PatternSource[],
): string | undefined {
  const again = 'run `agents detect-compile` or compilePatterns again';
  if (!isRecord(compiled) || !isRecord(compiled.automaton) || !Array.isArray(compiled.patterns)) {
    return `${path} must be the table compilePatterns or \`agents detect-compile\` writes`;
  }
  if (compiled.compiler !== PATTERN_COMPILER_VERSION) {
    return `${path} comes from compiler ${String(compiled.compiler)}, this one is ${PATTERN_COMPILER_VERSION}; ${again}`;
  }
  return JSON.stringify(compiled.patterns) === JSON.stringify(sources)
    ? undefined
    : `${path} was compiled from other patterns; ${again}`;
}

/**
 * What is wrong with a detector's `patterns` and the table `compiled` for them, or `undefined`
 * when both are sound. Patterns need their table: compiling is where a pattern that could take
 * more than linear time on hostile text is refused.
 */
function patternsProblem(path: string, patterns: unknown, compiled: unknown): string | undefined {
  if (patterns === undefined) {
    return compiled === undefined ? undefined : `${path}.compiled is set without patterns`;
  }
  if (!Array.isArray(patterns)) return `${path}.patterns must be a list`;
  if (patterns.length > MAX_PATTERNS) {
    return `${path}.patterns lists ${patterns.length} patterns; the most is ${MAX_PATTERNS}`;
  }
  const names = new Set<string>();
  for (const [index, pattern] of patterns.entries()) {
    const at = `${path}.patterns[${index}]`;
    const problem = patternProblem(at, pattern);
    if (problem !== undefined) return problem;
    const { name } = pattern as HostPattern;
    if (names.has(name)) return `${at}.name ${JSON.stringify(name)} is listed twice`;
    names.add(name);
  }
  if (patterns.length === 0) {
    return compiled === undefined ? undefined : `${path}.compiled is set without patterns`;
  }
  if (compiled === undefined) {
    return `${path}.patterns need their compiled table: set ${path}.compiled from \`agents detect-compile\`, or wrap the detect setting in compileDetect from @theoremjs/agents/guardrails/compile`;
  }
  return compiledProblem(`${path}.compiled`, compiled, patternSources(patterns as HostPattern[]));
}

/** The matchers of each list of patterns, built once: a profile's patterns are resolved every turn. */
const MATCHERS = new WeakMap<readonly HostPattern[], readonly HostMatcher[]>();

/** `patterns`, valid, ready to run. */
function matchersOf(patterns: readonly HostPattern[]): readonly HostMatcher[] {
  let matchers = MATCHERS.get(patterns);
  if (!matchers) {
    matchers = patternSources(patterns).map(({ name, source, flags }) => ({
      name,
      regex: new RegExp(source, `${flags}g`),
    }));
    MATCHERS.set(patterns, matchers);
  }
  return matchers;
}

export type { AutomatonData, CompiledPatterns, HostMatcher, HostPattern, PatternSource };
export {
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS,
  matchersOf,
  PATTERN_COMPILER_VERSION,
  patternProblem,
  patternSources,
  patternsProblem,
};
