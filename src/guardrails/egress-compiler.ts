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
 * match nothing, and a lookahead may be read or skipped. A bounded repeat over
 * `COUNT_LIMIT` is unbounded. Each change only widens what it accepts, so the
 * hold can only hold more than it must. A backreference to text that varies
 * has no automaton; compiling it fails.
 *
 * @module
 */

import { type Concatenation, type Element, JS, NFA, type NoParent } from 'refa';
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

/**
 * The pattern with its assertions loosened: a lookbehind (and `\b`, `^`, `$`,
 * which parse to lookarounds) matches the empty string, a lookahead is either
 * skipped or read as part of the match, and a long bounded repeat is unbounded.
 */
function loosened(alternatives: Alternatives): Alternatives {
  return alternatives.map((concat) => ({
    type: 'Concatenation',
    elements: concat.elements.flatMap(loosenedElement),
  }));
}

function loosenedElement(element: NoParent<Element>): NoParent<Element>[] {
  switch (element.type) {
    case 'Alternation':
      return [{ ...element, alternatives: loosened(element.alternatives) }];
    case 'Quantifier':
      return [
        {
          ...element,
          max: element.max > COUNT_LIMIT ? Number.POSITIVE_INFINITY : element.max,
          alternatives: loosened(element.alternatives),
        },
      ];
    case 'Assertion':
      if (element.kind === 'behind') return [];
      return [
        {
          type: 'Alternation',
          alternatives: [
            { type: 'Concatenation', elements: [] },
            ...loosened(element.alternatives),
          ],
        },
      ];
    case 'CharacterClass':
      return [element];
    default:
      // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      throw new Error(`cannot loosen a ${element.type} element`);
  }
}

/**
 * The pattern over UTF-16 code units. A `u` or `v` pattern reads code points;
 * it is rewritten to the equivalent pattern on the units that spell them.
 */
function parsed(pattern: RegExp): Alternatives {
  const { expression } = JS.Parser.fromLiteral(pattern).parse({ assertions: 'parse' });
  if (!pattern.unicode && !pattern.unicodeSets) {
    return expression.alternatives;
  }
  const units = JS.toLiteral(expression, { flags: { unicode: false, unicodeSets: false } });
  return JS.Parser.fromLiteral(units).parse({ assertions: 'parse' }).expression.alternatives;
}

/** A regex literal for the reversed pattern, with the original's flags. */
function reversedLiteral(pattern: RegExp): RegExp {
  const literal = JS.toLiteral(reversed(parsed(pattern)), {
    flags: { global: true, unicode: false, sticky: false },
  });
  return new RegExp(literal.source, literal.flags);
}

interface PatternNfa {
  initial: NFA.ReadonlyNode;
  nodes: NFA.ReadonlyNode[];
  finals: ReadonlySet<NFA.ReadonlyNode>;
}

function nfaOf(alternatives: Alternatives): PatternNfa {
  const nfa = NFA.fromRegex(loosened(alternatives), { maxCharacter: MAX_CHAR });
  nfa.removeUnreachable();
  return { initial: nfa.initial, nodes: [...nfa.nodes()], finals: nfa.finals };
}

/** The union of the patterns' automata as tables, nodes tagged with their pattern. */
function automatonData(patterns: Alternatives[]): EgressAutomatonData {
  const nfas = patterns.map(nfaOf);
  const bounds = new Set<number>([0]);
  for (const nfa of nfas) {
    for (const node of nfa.nodes) {
      for (const set of node.out.values()) {
        for (const range of set.ranges) {
          bounds.add(range.min);
          if (range.max < MAX_CHAR) bounds.add(range.max + 1);
        }
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
  return { classStarts, charsets, initials, nodes };
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
