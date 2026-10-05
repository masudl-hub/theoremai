/**
 * Build-time compiler for egress rules, behind `@theoremjs/agents/guardrails/compile`.
 *
 * The streaming egress hold reads each pattern as an automaton that accepts
 * every match of it and more, so it can hold exactly the text a match could
 * still be under way in. Building those automata takes a regex engine (refa)
 * and time a Worker cold start cannot spare, so it runs here, at build time:
 * `agents egress-compile` writes the table, and `egressPolicy` loads it.
 *
 * An automaton drops its pattern's assertions: a lookbehind, `\b`, `^` and `$`
 * match nothing, and a lookahead is skipped, with its text read after what
 * precedes it wherever the match may end before that text does. A bounded
 * repeat over `COUNT_LIMIT` is unbounded. An optional repeat of one character
 * class that opens the pattern is left out and its class named in `leads`:
 * the stream reads a match as starting where the run of that class it is in
 * started. An inline modifier's flags are set on the whole pattern. Each
 * change only widens what it accepts, so the hold can only hold more than it
 * must. A backreference to text that varies has no automaton;
 * compiling it fails.
 *
 * @module
 */

import { type AST, RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';
import { type CharSet, type Concatenation, type Element, JS, NFA, type NoParent } from 'refa';
import { EGRESS_PATTERNS } from './egress-patterns.ts';
import {
  assertEgressRules,
  type CompiledEgressRules,
  EGRESS_COMPILER_VERSION,
  type EgressAutomatonData,
  type EgressRule,
  ruleFingerprint,
} from './egress-rules.ts';
import { TheoremError } from './error.ts';

const MAX_CHAR = 0xffff;
/**
 * A bounded repeat longer than this is read as unbounded: the hold cannot
 * tell the bound is reached without counting, and holding on is the safe side.
 */
const COUNT_LIMIT = 256;

type Alternatives = NoParent<Concatenation>[];

/** The pattern read right to left: `P` on reversed text matches where this matches on the text. */
function reversed(alternatives: Alternatives): Alternatives {
  return alternatives.map((concat) => ({
    type: 'Concatenation',
    elements: concat.elements.map(reversedElement).reverse(),
  }));
}

function reversedElement(element: NoParent<Element>): NoParent<Element> {
  switch (element.type) {
    case 'Alternation':
    case 'Quantifier':
      return { ...element, alternatives: reversed(element.alternatives) };
    case 'Assertion':
      return {
        ...element,
        kind: element.kind === 'ahead' ? 'behind' : 'ahead',
        alternatives: reversed(element.alternatives),
      };
    case 'CharacterClass':
      return element;
    default:
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      throw new Error(`cannot reverse a ${element.type} element`);
  }
}

/** How many characters follow an element in a match, at least and at most. */
interface Length {
  min: number;
  max: number;
}

/** Where lookaheads that end their own alternative are written: `out`, each after what precedes it, `before`. */
interface Ends {
  before: NoParent<Element>[];
  out: Alternatives;
}

/**
 * The pattern with its assertions loosened and a long bounded repeat
 * unbounded. A lookbehind (and `\b`, `^`, `$`, which parse to lookarounds)
 * matches the empty string. A lookahead:
 *
 * - no longer than what must follow it is skipped: the match has read its text;
 * - with nothing after it is read or skipped;
 * - otherwise is skipped, and what precedes it followed by its text is an
 *   alternative of the pattern (in `ends`), so the automaton is still under
 *   way, and then at a match, while the text that settles it arrives.
 */
function loosened(alternatives: Alternatives, after: Length, ends?: Ends): Alternatives {
  return alternatives.map((concat) => {
    const elements: NoParent<Element>[] = [];
    concat.elements.forEach((element, i) => {
      const rest = lengthOf(concat.elements.slice(i + 1));
      elements.push(
        ...loosenedElement(
          element,
          { min: after.min + rest.min, max: after.max + rest.max },
          ends && { before: [...ends.before, ...elements], out: ends.out },
        ),
      );
    });
    return { type: 'Concatenation', elements };
  });
}

/** The fewest and the most characters a match of the elements, one after another, reads. */
function lengthOf(elements: readonly NoParent<Element>[]): Length {
  let min = 0;
  let max = 0;
  for (const element of elements) {
    if (element.type === 'Assertion') continue;
    if (element.type === 'CharacterClass') {
      min++;
      max++;
      continue;
    }
    if (element.type === 'Unknown') {
      max = Number.POSITIVE_INFINITY;
      continue;
    }
    const each = element.alternatives.map((concat) => lengthOf(concat.elements));
    const times = element.type === 'Quantifier' ? element : { min: 1, max: 1 };
    const most = Math.max(...each.map((length) => length.max));
    min += times.min * Math.min(...each.map((length) => length.min));
    max += most === 0 ? 0 : times.max * most;
  }
  return { min, max };
}

/** `element` loosened, where `after` characters follow it in a match. */
function loosenedElement(
  element: NoParent<Element>,
  after: Length,
  ends?: Ends,
): NoParent<Element>[] {
  switch (element.type) {
    case 'Alternation':
      return [{ ...element, alternatives: loosened(element.alternatives, after, ends) }];
    case 'Quantifier': {
      const max = element.max > COUNT_LIMIT ? Number.POSITIVE_INFINITY : element.max;
      const inside = max > 1 ? { min: after.min, max: Number.POSITIVE_INFINITY } : after;
      const repeat = { ...element, max, alternatives: loosened(element.alternatives, inside) };
      if (ends) {
        const earlier = { ...repeat, min: 0, max: Number.POSITIVE_INFINITY };
        loosened(element.alternatives, inside, {
          before: max > 1 ? [...ends.before, earlier] : ends.before,
          out: ends.out,
        });
      }
      return [repeat];
    }
    case 'Assertion': {
      if (element.kind === 'behind') return [];
      const text = loosened(element.alternatives, { min: 0, max: 0 }, ends);
      const { max } = lengthOf([{ type: 'Alternation', alternatives: text }]);
      if (max <= after.min) return [];
      const read: NoParent<Element> = { type: 'Alternation', alternatives: text };
      if (after.max > 0) {
        ends?.out.push({ type: 'Concatenation', elements: [...ends.before, read] });
        return [];
      }
      return [
        {
          type: 'Alternation',
          alternatives: [{ type: 'Concatenation', elements: [] }, ...text],
        },
      ];
    }
    case 'CharacterClass':
      return [element];
    default:
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      throw new Error(`cannot loosen a ${element.type} element`);
  }
}

/**
 * `literal` as current JavaScript reads it: refa's own parser stops at ES2024,
 * and refa ignores an inline modifier group, so its flags go on the pattern.
 */
function literalAst(literal: string): AST.RegExpLiteral {
  const ast = new RegExpParser().parseLiteral(literal);
  visitRegExpAST(ast, {
    onModifiersEnter({ add }) {
      ast.flags.ignoreCase ||= add.ignoreCase;
      ast.flags.dotAll ||= add.dotAll;
      ast.flags.multiline ||= add.multiline;
    },
  });
  return ast;
}

/**
 * The pattern over UTF-16 code units. A `u` or `v` pattern reads code points;
 * it is rewritten to the equivalent pattern on the units that spell them.
 */
function parsed(pattern: RegExp): Alternatives {
  const ast = literalAst(String(pattern));
  const { expression } = JS.Parser.fromAst(ast).parse({ assertions: 'parse' });
  if (!ast.flags.unicode && !ast.flags.unicodeSets) {
    return expression.alternatives;
  }
  const units = JS.toLiteral(expression, { flags: { unicode: false, unicodeSets: false } });
  return JS.Parser.fromLiteral(units).parse({ assertions: 'parse' }).expression.alternatives;
}

/**
 * The pattern's source spelled so no lint rule has anything to say about it: `[\s\S]` for any
 * character (not `[^]`) and `\v` for the vertical tab (not `\x0b`). Each pair matches the same text.
 */
function plainSource(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (char === '\\') {
      const next = source.slice(i, i + 4);
      if (next === '\\x0b') {
        out += '\\v';
        i += 3;
      } else {
        out += source.slice(i, i + 2);
        i++;
      }
    } else if (!inClass && source.startsWith('[^]', i)) {
      out += '[\\s\\S]';
      i += 2;
    } else {
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      out += char;
    }
  }
  return out;
}

/** A regex literal for the reversed pattern, with the original's flags. */
function reversedLiteral(pattern: RegExp): RegExp {
  const literal = JS.toLiteral(reversed(parsed(pattern)), {
    flags: { global: true, unicode: false, sticky: false },
  });
  return new RegExp(plainSource(literal.source), literal.flags);
}

interface PatternNfa {
  initial: NFA.ReadonlyNode;
  nodes: NFA.ReadonlyNode[];
  finals: ReadonlySet<NFA.ReadonlyNode>;
  /** The class an optional repeat opening the pattern reads; the automaton is of what follows it. */
  lead?: CharSet;
}

/**
 * The pattern split at an optional repeat of one character class that opens
 * it: the class, and the rest. Counted in the automaton, the repeat would keep
 * a state per repeat alive at every character of a run of the class.
 */
function led(alternatives: Alternatives): { lead?: CharSet; rest: Alternatives } {
  const [concat] = alternatives;
  if (alternatives.length !== 1 || !concat) return { rest: alternatives };
  const [first, ...after] = concat.elements;
  if (first?.type === 'Alternation' && first.alternatives.length === 1) {
    const [inner] = first.alternatives;
    return led([{ type: 'Concatenation', elements: [...(inner?.elements ?? []), ...after] }]);
  }
  if (first?.type !== 'Quantifier' || first.min !== 0 || first.max < 2) {
    return { rest: alternatives };
  }
  const [repeated] = first.alternatives;
  const [only] = repeated?.elements ?? [];
  if (first.alternatives.length !== 1 || repeated?.elements.length !== 1) {
    return { rest: alternatives };
  }
  return only?.type === 'CharacterClass'
    ? { lead: only.characters, rest: [{ type: 'Concatenation', elements: after }] }
    : { rest: alternatives };
}

function nfaOf(alternatives: Alternatives): PatternNfa {
  const ends: Alternatives = [];
  const whole = [...loosened(alternatives, { min: 0, max: 0 }, { before: [], out: ends }), ...ends];
  const { lead, rest } = led(whole);
  const build = (from: Alternatives) => {
    const nfa = NFA.fromRegex(from, { maxCharacter: MAX_CHAR });
    nfa.removeUnreachable();
    return { initial: nfa.initial, nodes: [...nfa.nodes()], finals: nfa.finals };
  };
  const nfa = build(rest);
  if (!lead) return nfa;
  return nfa.finals.has(nfa.initial) ? build(whole) : { ...nfa, lead };
}

/** The union of the patterns' automata as tables, nodes tagged with their pattern. */
function automatonData(patterns: Alternatives[]): EgressAutomatonData {
  const nfas = patterns.map(nfaOf);
  const bounds = new Set<number>([0]);
  for (const nfa of nfas) {
    const sets = nfa.nodes.flatMap((node) => [...node.out.values()]);
    for (const set of nfa.lead ? [...sets, nfa.lead] : sets) {
      for (const range of set.ranges) {
        bounds.add(range.min);
        if (range.max < MAX_CHAR) bounds.add(range.max + 1);
      }
    }
  }
  const classStarts = [...bounds].sort((a, b) => a - b);
  const classOf = (code: number): number => {
    let lo = 0;
    let hi = classStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((classStarts[mid] as number) <= code) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const charsets: number[][] = [];
  const charsetIds = new Map<string, number>();
  const charsetId = (ranges: readonly { min: number; max: number }[]): number => {
    const classes: number[] = [];
    for (const { min, max } of ranges) {
      for (let k = classOf(min); k < classStarts.length && (classStarts[k] as number) <= max; k++) {
        classes.push(k);
      }
    }
    const key = classes.join(',');
    let id = charsetIds.get(key);
    if (id === undefined) {
      id = charsets.length;
      charsets.push(classes);
      charsetIds.set(key, id);
    }
    return id;
  };

  const nodes: number[][] = [];
  const initials: number[] = [];
  nfas.forEach((nfa, pattern) => {
    const ids = new Map<NFA.ReadonlyNode, number>();
    for (const node of nfa.nodes) ids.set(node, nodes.length + ids.size);
    initials.push(ids.get(nfa.initial) as number);
    for (const node of nfa.nodes) {
      const row = [pattern, nfa.finals.has(node) ? 1 : 0];
      for (const [to, set] of node.out) row.push(ids.get(to) as number, charsetId(set.ranges));
      nodes.push(row);
    }
  });
  const leads = nfas.map(({ lead }) => (lead ? charsetId(lead.ranges) : -1));
  return { classStarts, charsets, initials, leads, nodes };
}

/** The table `egressPolicy` needs to hold exactly for `rules`. */
function compileEgressRules(rules: readonly EgressRule[]): CompiledEgressRules {
  assertEgressRules(rules);
  const alternatives = rules.map(({ rule, pattern }) => {
    try {
      const units = parsed(pattern);
      nfaOf(units);
      return units;
    } catch (err) {
      throw new TheoremError(
        'config',
        `egress rule ${rule}: ${pattern} has no automaton the stream can hold for (${err instanceof Error ? err.message : String(err)})`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
  });
  return {
    compiler: EGRESS_COMPILER_VERSION,
    rules: ruleFingerprint(rules),
    automaton: automatonData(alternatives),
  };
}

/** `compiled` as a module exporting it as `compiledEgressRules`. */
function compiledEgressModule(compiled: CompiledEgressRules): string {
  // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  return `// Generated by \`agents egress-compile\`. Do not edit: change the rules and compile again.
export const compiledEgressRules = ${JSON.stringify(compiled)};
`;
}

/**
 * Everything `egress-automata.ts` holds, from the bundled patterns as they are
 * now: the injection patterns reversed, and the forward and reversed automata.
 */
function bundledEgressAutomata(): {
  reversedPatterns: RegExp[];
  forward: EgressAutomatonData;
  reversed: EgressAutomatonData;
} {
  const injection = EGRESS_PATTERNS.filter((entry) => entry.kind === 'injection');
  return {
    reversedPatterns: injection.map(({ pattern }) => reversedLiteral(pattern)),
    forward: automatonData(EGRESS_PATTERNS.map(({ pattern }) => parsed(pattern))),
    reversed: automatonData(injection.map(({ pattern }) => reversed(parsed(pattern)))),
  };
}

export { bundledEgressAutomata, compiledEgressModule, compileEgressRules };
