/**
 * The inverse of `studioSource`: the file it prints, read back into the draft
 * the form stores. Plain values come back as themselves. The printer's own
 * wrappers (`z.fromJSONSchema`, a canned `handler`, `compileDetect`, `.join('\\n')`)
 * come back through the same shapes that printer writes. Anything else is an
 * error at that spot, and the draft is left alone.
 */

import {
  DEFAULT_ALLOW_CONTINUE,
  DEFAULT_AUTO_CONTINUE,
  type LabelKey,
  liveIngressChannelDefault,
} from '@theoremjs/agents';
import {
  BOUNDARIES,
  DETECTORS,
  type Detector,
  type DetectSpec,
  recordOf,
  resolveDetect,
} from '@theoremjs/agents/guardrails';
import { type JsonObject, PROFILE_GRAPH } from '@theoremjs/agents/kernel';
import {
  CONTEXT_SENDERS,
  type ContextSender,
  fieldMeta,
  type ProfileType,
} from '@theoremjs/agents/schema';
import { canonical } from './canonical.ts';
import {
  createBlankDraft,
  type DecisionImageDraft,
  type DecisionQuestionDraft,
  defaultModelBinding,
  defaultToolSpec,
  draftKey,
  type SystemLineDraft,
  type GuardrailsDraft,
  type ImageReferenceDraft,
  INLINE_LABELS,
  MODEL_LIMITS,
  type ModelBindingDraft,
  type PatternDraft,
  type SlotDraft,
  STUDIO_PROFILE_TYPES,
  type StudioDraft,
  type StudioProfileType,
  type ToolSpecDraft,
} from './draft.ts';
import {
  definitionFactory,
  definitionOfFactory,
  kernelDefinitions,
  type StudioProvider,
} from './providers.ts';
import { stubOutputFromSchema } from './stub.ts';
import { STUDIO_TOOL_TYPE_MESSAGE, STUDIO_TOOL_TYPES } from './types.ts';

/** Where a read stopped, one-based, on the file the visitor is editing. */
export interface StudioSourceError {
  message: string;
  line: number;
  column: number;
}

/** Where a field was written, so a later issue can mark that spot. */
export interface StudioSourceSpan {
  path: string;
  line: number;
  column: number;
}

export type StudioSourceRead =
  | {
      ok: true;
      draft: StudioDraft;
      spans: StudioSourceSpan[];
      /** Every `registerTool` in the file, including one `tools.allow` leaves out. */
      registered: ToolSpecDraft[];
    }
  | { ok: false; errors: StudioSourceError[] };

export type ProviderSourceRead =
  | { ok: true; provider: StudioProvider; spans: StudioSourceSpan[] }
  | { ok: false; errors: StudioSourceError[] };

/** `agentId` is the id an agent tool or a compactor names; the workspace knows its key. */
export type AgentKeyOf = (agentId: string) => string | undefined;

class ReadFail extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

class Src {
  private i = 0;
  private line = 1;
  private column = 1;

  /** A provider's file holds its definition and nothing else; an agent's file holds no provider. */
  constructor(
    private readonly text: string,
    readonly of: 'profile' | 'provider' = 'profile',
  ) {}

  get done(): boolean {
    return this.i >= this.text.length;
  }

  pos(): { line: number; column: number } {
    return { line: this.line, column: this.column };
  }

  fail(message: string): never {
    throw new ReadFail(message, this.line, this.column);
  }

  peek(n = 0): string {
    return this.text[this.i + n] ?? '';
  }

  bump(): string {
    const ch = this.text[this.i] ?? '';
    this.i += 1;
    if (ch === '\n') {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  skip(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\ufeff') {
        this.bump();
        continue;
      }
      if (ch === '/' && this.peek(1) === '/') {
        while (!this.done && this.peek() !== '\n') this.bump();
        continue;
      }
      if (ch === '/' && this.peek(1) === '*') {
        this.bump();
        this.bump();
        while (!this.done && !(this.peek() === '*' && this.peek(1) === '/')) this.bump();
        if (this.done) this.fail('This comment never closes.');
        this.bump();
        this.bump();
        continue;
      }
      return;
    }
  }

  starts(token: string): boolean {
    this.skip();
    return this.text.startsWith(token, this.i);
  }

  eat(token: string): boolean {
    if (!this.starts(token)) return false;
    for (let n = 0; n < token.length; n += 1) this.bump();
    return true;
  }

  expect(token: string): void {
    if (!this.eat(token)) this.fail(`Expected '${token}'.`);
  }

  /** The next identifier, or `undefined` when the next token is something else. */
  ident(): string | undefined {
    this.skip();
    const ch = this.peek();
    if (!/^[A-Za-z_$]/.test(ch)) return undefined;
    let name = '';
    while (/^[A-Za-z0-9_$]/.test(this.peek())) name += this.bump();
    return name;
  }

  expectIdent(): string {
    const name = this.ident();
    if (name === undefined) this.fail('Expected a name.');
    return name;
  }

  /** The next identifier, without consuming it. */
  peekIdent(): string | undefined {
    this.skip();
    return /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(this.i))?.[0];
  }

  /** The text from the next token, for a short lookahead. */
  rest(): string {
    this.skip();
    return this.text.slice(this.i);
  }
}

interface ParsedModule {
  tools: Record<string, unknown>[];
  structured?: { id: string; spec: Record<string, unknown> };
  profile?: Record<string, unknown>;
  provider?: { definition: string; spec: Record<string, unknown> };
  questions?: Record<string, unknown>;
  images?: Record<string, unknown>;
  spans: StudioSourceSpan[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseString(src: Src): string {
  src.skip();
  const quote = src.peek();
  if (quote !== "'" && quote !== '"') src.fail('Expected a string.');
  src.bump();
  let out = '';
  while (!src.done && src.peek() !== quote) {
    const ch = src.bump();
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = src.bump();
    const simple: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    if (esc in simple) {
      out += simple[esc];
      continue;
    }
    if (esc === 'u') {
      let hex = '';
      for (let n = 0; n < 4; n += 1) hex += src.bump();
      out += String.fromCharCode(Number.parseInt(hex, 16));
      continue;
    }
    out += esc;
  }
  if (src.peek() !== quote) src.fail('This string never closes.');
  src.bump();
  return out;
}

function parseNumber(src: Src): number {
  src.skip();
  const start = src.pos();
  let raw = '';
  if (src.peek() === '-') raw += src.bump();
  while (/^[0-9.eE+-]/.test(src.peek()) && raw.length < 64) raw += src.bump();
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ReadFail(`'${raw}' is not a number.`, start.line, start.column);
  }
  return value;
}

/** Skip `satisfies …` or `as …` up to the end of the statement. */
/** Skips to where `ended` says so, outside every bracket. A string is skipped whole. */
function skipBalanced(src: Src, open: string, close: string, ended: () => boolean): void {
  let depth = 0;
  while (!src.done) {
    const end = ended();
    if (end && depth === 0) return;
    const ch = src.peek();
    if (ch === "'" || ch === '"') {
      parseString(src);
      continue;
    }
    if (ch !== '' && open.includes(ch)) depth += 1;
    else if (ch !== '' && close.includes(ch)) depth -= 1;
    src.bump();
  }
}

function skipTypeClause(src: Src): void {
  skipBalanced(src, '<([{', '>)]}', () => {
    src.skip();
    return src.peek() === ';' || src.peek() === '\n';
  });
}

function skipImport(src: Src): void {
  skipBalanced(src, '{([', '})]', () => src.peek() === ';');
  if (src.peek() === ';') src.bump();
}

function parseObject(src: Src, path: string, spans: StudioSourceSpan[]): Record<string, unknown> {
  src.expect('{');
  const out: Record<string, unknown> = {};
  while (!src.eat('}')) {
    if (src.eat('...')) src.fail("This file doesn't use spreads.");
    const at = src.pos();
    let key: string;
    if (src.peek() === "'" || src.peek() === '"') key = parseString(src);
    else key = src.expectIdent();
    // JavaScript sets an object's prototype from `__proto__`, and TypeScript refuses a key set twice.
    if (key === '__proto__') {
      throw new ReadFail(
        "'__proto__' sets what an object inherits, not a setting.",
        at.line,
        at.column,
      );
    }
    if (Object.hasOwn(out, key)) throw new ReadFail(`'${key}' is set twice.`, at.line, at.column);
    const next = path ? `${path}.${key}` : key;
    spans.push({ path: next, line: at.line, column: at.column });
    src.expect(':');
    out[key] = parseValue(src, next, spans);
    src.eat(',');
    if (src.done) src.fail('This object never closes.');
  }
  return out;
}

function parseArray(src: Src, path: string, spans: StudioSourceSpan[]): unknown[] {
  src.expect('[');
  const out: unknown[] = [];
  let index = 0;
  while (!src.eat(']')) {
    if (src.eat('...')) src.fail("This file doesn't use spreads.");
    src.skip();
    const at = src.pos();
    const itemPath = path ? `${path}.${String(index)}` : String(index);
    spans.push({ path: itemPath, line: at.line, column: at.column });
    out.push(parseValue(src, itemPath, spans));
    index += 1;
    src.eat(',');
    if (src.done) src.fail('This array never closes.');
  }
  return out;
}

function zodSchema(head: string, args: unknown[], src: Src): Record<string, unknown> {
  const [schema] = args;
  if (head !== 'z.fromJSONSchema') {
    src.fail(`The studio reads a schema as JSON Schema: z.fromJSONSchema({ ... }), not '${head}'.`);
  }
  if (!isRecord(schema)) src.fail('z.fromJSONSchema() needs a schema.');
  return schema;
}

interface Member {
  kind: 'member';
  object: unknown;
  name: string;
}

function isMember(value: unknown): value is Member {
  return isRecord(value) && value.kind === 'member';
}

function asMember(object: unknown, name: string): Member {
  return { kind: 'member', object, name };
}

function memberHead(value: Member): string | undefined {
  if (typeof value.object === 'string') return `${value.object}.${value.name}`;
  if (isMember(value.object)) {
    const parent = memberHead(value.object);
    return parent ? `${parent}.${value.name}` : undefined;
  }
  return undefined;
}

function objectArg(args: unknown[], src: Src, message: string): Record<string, unknown> {
  const value = args[0];
  if (!isRecord(value)) src.fail(message);
  return value;
}

function registerToolCall(args: unknown[], src: Src, spans: readonly StudioSourceSpan[]): unknown {
  const tool = objectArg(args, src, 'registerTool() needs the tool object.');
  const type = tool.type;
  const known = typeof type === 'string' && (STUDIO_TOOL_TYPES as readonly string[]).includes(type);
  if (type !== undefined && !known) {
    const at = spans.findLast((span) => span.path === 'type') ?? src.pos();
    throw new ReadFail(STUDIO_TOOL_TYPE_MESSAGE, at.line, at.column);
  }
  return { kind: 'registerTool', tool };
}

function namedCall(
  callee: string,
  args: unknown[],
  src: Src,
  spans: readonly StudioSourceSpan[],
): unknown {
  if (src.of === 'provider') {
    if (callee !== 'registerProvider')
      return src.fail(`'${callee}' isn't part of a provider's code.`);
    const [definition, spec = {}] = args;
    if (typeof definition !== 'string')
      src.fail('registerProvider() needs the definition it registers from.');
    if (!isRecord(spec) || args.length > 2)
      src.fail('registerProvider() takes the definition and its settings.');
    return { kind: 'provider', definition, spec };
  }
  if (callee === 'compileDetect') {
    return objectArg(args, src, 'compileDetect() needs the detect object.');
  }
  if (callee === 'defineProfile') {
    return objectArg(args, src, 'defineProfile() needs the profile object.');
  }
  if (callee === 'registerTool') return registerToolCall(args, src, spans);
  if (callee === 'registerStructured') return { kind: 'registerStructured', args };
  if (callee === 'registerProfile' || callee === 'registerProvider') return { kind: callee };
  return src.fail(`'${callee}' isn't part of this file.`);
}

function joinedLines(parts: unknown[], sep: unknown, src: Src): string {
  if (typeof sep !== 'string' || parts.some((part) => typeof part !== 'string')) {
    src.fail('.join() here joins lines of one string.');
  }
  return parts.join(sep);
}

function memberCall(callee: Member, args: unknown[], src: Src): unknown {
  if (callee.name === 'join' && Array.isArray(callee.object)) {
    return joinedLines(callee.object, args[0], src);
  }
  if (callee.name === 'resolve' && callee.object === 'Promise') return args[0];
  const head = memberHead(callee);
  if (head?.startsWith('z.')) return zodSchema(head, args, src);
  return src.fail("This call isn't part of this file.");
}

function callExpr(
  callee: unknown,
  args: unknown[],
  src: Src,
  spans: readonly StudioSourceSpan[],
): unknown {
  if (typeof callee === 'string') return namedCall(callee, args, src, spans);
  if (!isMember(callee)) src.fail("This call isn't part of this file.");
  return memberCall(callee, args, src);
}

function looksLikeArrow(src: Src): boolean {
  return /^(async\s*)?\(\s*\)\s*=>/.test(src.rest());
}

function parseArrow(src: Src, path: string, spans: StudioSourceSpan[]): unknown {
  if (src.peekIdent() === 'async') src.expectIdent();
  src.expect('(');
  if (!src.eat(')')) src.fail('A handler here takes no arguments. It returns a fixed value.');
  src.expect('=>');
  return parseValue(src, path, spans);
}

/** A name as written: what is called or read from, or, standing alone, a value set elsewhere. */
class Name {
  constructor(readonly name: string) {}
}

/** `value`, with a name in it read as the text of the name. */
function named(value: unknown): unknown {
  return value instanceof Name ? value.name : value;
}

function parseExpr(src: Src, path: string, spans: StudioSourceSpan[]): unknown {
  if (looksLikeArrow(src)) return parseArrow(src, path, spans);
  return parsePostfix(parseAtom(src, path, spans), src, path, spans);
}

function parseAtom(src: Src, path: string, spans: StudioSourceSpan[]): unknown {
  src.skip();
  const ch = src.peek();
  if (ch === "'" || ch === '"') return parseString(src);
  if (ch === '`') src.fail("This file doesn't use template strings.");
  if (ch === '-' || /^[0-9]/.test(ch)) return parseNumber(src);
  if (ch === '{') return parseObject(src, path, spans);
  if (ch === '[') return parseArray(src, path, spans);
  if (ch === '(') {
    src.bump();
    const inner = parseExpr(src, path, spans);
    src.expect(')');
    return inner;
  }
  const name = src.ident();
  if (name === 'true') return true;
  if (name === 'false') return false;
  if (name === 'null') return null;
  if (name === undefined) src.fail('Expected a value.');
  return new Name(name);
}

/**
 * A setting's value, as written in an object or a list. A name standing alone there is a value
 * written somewhere else, which this file does not show; `undefined` is no value.
 */
function parseValue(src: Src, path: string, spans: StudioSourceSpan[]): unknown {
  src.skip();
  const at = src.pos();
  const value = parseExpr(src, path, spans);
  if (!(value instanceof Name)) return value;
  if (value.name === 'undefined') return undefined;
  throw new ReadFail(
    `'${value.name}' is set somewhere else. Write its value here.`,
    at.line,
    at.column,
  );
}

function parsePostfix(value: unknown, src: Src, path: string, spans: StudioSourceSpan[]): unknown {
  let current = value;
  for (;;) {
    if (src.eat('.')) {
      const name = src.expectIdent();
      current = asMember(named(current), name);
      continue;
    }
    if (src.eat('(')) {
      const from = spans.length;
      const args: unknown[] = [];
      while (!src.eat(')')) {
        args.push(named(parseExpr(src, path, spans)));
        src.eat(',');
        if (src.done) src.fail('This call never closes.');
      }
      current = callExpr(named(current), args, src, spans.slice(from));
      continue;
    }
    if (isMember(current)) src.fail("This file doesn't stop on a property.");
    return current;
  }
}

function readConst(src: Src, parsed: ParsedModule): void {
  src.expectIdent();
  const name = src.expectIdent();
  src.expect('=');
  const value = parseExpr(src, '', parsed.spans);
  if (src.eat('satisfies') || src.eat('as')) skipTypeClause(src);
  src.eat(';');
  if (src.of === 'provider') {
    src.fail("A provider's code is its registerProvider() call and nothing else.");
  } else if (name === 'profile') {
    if (!isRecord(value)) src.fail('profile has to be the defineProfile() object.');
    if (parsed.profile) src.fail('This file defines two profiles.');
    parsed.profile = value;
  } else if (name === 'questions') {
    if (!isRecord(value)) src.fail('questions has to be an object.');
    parsed.questions = value;
  } else if (name === 'images') {
    if (!isRecord(value)) src.fail('images has to be an object.');
    parsed.images = value;
  }
}

function readCall(src: Src, parsed: ParsedModule): void {
  const value = parseExpr(src, '', parsed.spans);
  src.eat(';');
  if (!isRecord(value)) return;
  if (value.kind === 'provider' && typeof value.definition === 'string' && isRecord(value.spec)) {
    if (parsed.provider) src.fail('This code registers two providers.');
    parsed.provider = { definition: value.definition, spec: value.spec };
    return;
  }
  if (value.kind === 'registerTool') {
    const tool = value.tool;
    if (!isRecord(tool)) src.fail('registerTool() needs the tool object.');
    parsed.tools.push(tool);
  } else if (value.kind === 'registerStructured') {
    const args: unknown[] = Array.isArray(value.args) ? value.args : [];
    const [id, spec] = args;
    if (typeof id !== 'string' || !isRecord(spec)) {
      src.fail('registerStructured() needs an id and a spec.');
    }
    parsed.structured = { id, spec };
  }
}

function parseModule(text: string, of: Src['of'] = 'profile'): ParsedModule {
  const src = new Src(text, of);
  const parsed: ParsedModule = { tools: [], spans: [] };
  for (src.skip(); !src.done; src.skip()) {
    if (src.peekIdent() === 'import') {
      src.expectIdent();
      skipImport(src);
      continue;
    }
    if (src.peekIdent() === 'export') src.expectIdent();
    if (src.peekIdent() === 'const') readConst(src, parsed);
    else readCall(src, parsed);
  }
  if (of === 'provider') {
    if (!parsed.provider) src.fail('This code needs registerProvider().');
  } else if (!parsed.profile) src.fail('This file needs defineProfile().');
  return parsed;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function whole(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function markup(value: unknown, srcMessage: string): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new ReadFail(srcMessage, 1, 1);
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (Array.isArray(part)) return markup(part, srcMessage);
      if (isRecord(part) && typeof part.private === 'string') return `{private: ${part.private}}`;
      throw new ReadFail(srcMessage, 1, 1);
    })
    .join('');
}

/** A prompt as the draft holds it: one entry per line, and a bare `{ private }` is no line. */
function promptLines(value: unknown, current: readonly SystemLineDraft[]): SystemLineDraft[] {
  const srcMessage = 'The system prompt has to be text.';
  const lines = Array.isArray(value) ? value : [value];
  const texts = lines.map((line: unknown) => {
    if (Array.isArray(value) && typeof line !== 'string' && !Array.isArray(line)) {
      throw new ReadFail(srcMessage, 1, 1);
    }
    return markup(line, srcMessage);
  });
  return (texts.length ? texts : ['']).map((text, at) => ({
    key: current[at]?.key ?? draftKey('line'),
    text,
  }));
}

function jsonText(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function schemaText(schema: unknown): string {
  return isRecord(schema) ? JSON.stringify(schema, null, 2) : JSON.stringify(schema);
}

function patternsOf(value: unknown): PatternDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((pattern) => {
    if (!isRecord(pattern) || typeof pattern.name !== 'string') {
      throw new ReadFail('A pattern needs a name.', 1, 1);
    }
    if (Array.isArray(pattern.words)) {
      return {
        name: pattern.name,
        kind: 'words',
        pattern: '',
        flags: '',
        words: pattern.words.filter((word): word is string => typeof word === 'string'),
      };
    }
    return {
      name: pattern.name,
      kind: 'pattern',
      pattern: text(pattern.pattern),
      flags: text(pattern.flags),
      words: [],
    };
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** The strings of a list the file wrote, or `undefined` when it wrote none. */
function listed(value: unknown): string[] | undefined {
  return Array.isArray(value) ? strings(value) : undefined;
}

function filled(value: unknown): string | undefined {
  return text(value) || undefined;
}

/** A label as its box holds it: a list the file wrote has a line each. */
function labelText(value: unknown): string | undefined {
  return Array.isArray(value) ? strings(value).join('\n') || undefined : filled(value);
}

/** A section of the profile, read when the file has it and kept as it was when not. */
function section<T>(value: unknown, read: (spec: Record<string, unknown>) => T, kept: T): T {
  return isRecord(value) ? read(value) : kept;
}

type DetectDraft = Pick<GuardrailsDraft, 'detect' | 'sources' | 'allow' | 'innocentNames'>;

function readAllow(into: DetectDraft, detector: Detector, spec: unknown): void {
  if (!isRecord(spec)) return;
  if (Array.isArray(spec.names)) {
    into.innocentNames = strings(spec.names);
    return;
  }
  if (!(detector in into.allow)) return;
  const url = into.allow[detector as keyof GuardrailsDraft['allow']];
  url.hosts = strings(spec.hosts);
  url.fromTools = spec.fromTools !== false;
}

function readDetector(into: DetectDraft, detector: Detector, rule: Record<string, unknown>): void {
  const source = into.sources[detector];
  if (source) {
    if (rule.theorem === false) source.theorem = false;
    source.patterns = patternsOf(rule.patterns);
    source.hint = text(rule.hint);
  }
  readAllow(into, detector, rule.allow);
}

function ownDetector(key: string, rule: Record<string, unknown>): GuardrailsDraft['own'][number] {
  const at = recordOf(BOUNDARIES, () => 'ignore' as const);
  if (isRecord(rule.at)) Object.assign(at, rule.at);
  return {
    key,
    label: text(rule.label),
    at,
    patterns: patternsOf(rule.patterns),
    hint: text(rule.hint),
  };
}

function guardrailsOf(spec: unknown): GuardrailsDraft {
  const blank = createBlankDraft().guardrails;
  if (!isRecord(spec)) return blank;
  // The actions are the kernel's own reading, so one action for every detector, one for a
  // detector, and a detector's `action` under its `at` all open as the kernel runs them.
  const actions = resolveDetect(spec.detect as DetectSpec | undefined);
  const read: DetectDraft = {
    detect: recordOf(DETECTORS, (detector) => ({ ...actions[detector] })),
    sources: structuredClone(blank.sources),
    allow: structuredClone(blank.allow),
    innocentNames: [...blank.innocentNames],
  };
  const own: GuardrailsDraft['own'] = [];
  const known = new Set<string>(DETECTORS);
  for (const [key, rule] of Object.entries(record(spec.detect) ?? {})) {
    if (!isRecord(rule)) continue;
    if (known.has(key)) readDetector(read, key as Detector, rule);
    else own.push(ownDetector(key, rule));
  }
  const quota = record(spec.quota);
  const blocked = record(spec.blockedReply);
  const network = record(spec.network);
  const taint = record(spec.taint);
  return {
    ...blank,
    ...read,
    own,
    quotaEnabled: quota !== undefined,
    quotaPerDay: whole(quota?.perDay),
    blockedReplyOnBlock: text(blocked?.onBlock) as GuardrailsDraft['blockedReplyOnBlock'],
    blockedReplyMaxRetries: whole(blocked?.maxRetries),
    allowPrivateNetworks: network?.allowPrivateNetworks === true,
    allowedHosts: strings(network?.allowedHosts),
    allowedSchemes: strings(network?.allowedSchemes),
    taintAfterRemoteRead: text(taint?.afterRemoteRead) as GuardrailsDraft['taintAfterRemoteRead'],
    taintRemoteDestination: text(
      taint?.remoteDestination,
    ) as GuardrailsDraft['taintRemoteDestination'],
  };
}

/** The wording a section's own field holds, and the field it goes back into. */
const LABEL_FIELDS: Partial<Record<string, (draft: StudioDraft, value: string) => void>> = {
  'continue.instruction': (draft, value) => {
    draft.turnBehaviour.continueInstruction = value;
  },
  'canary.bind_note': (draft, value) => {
    draft.guardrails.canaryBindNote = value;
  },
  'quota.exhausted': (draft, value) => {
    draft.guardrails.quotaMessage = value;
  },
  'repair.default_guidance': (draft, value) => {
    draft.outputs.repairGuidance = value;
  },
  'egress.default_repair_guidance': (draft, value) => {
    draft.guardrails.egressRepairGuidance = value;
  },
  'egress.refusal': (draft, value) => {
    draft.guardrails.egressRefusal = value;
  },
};

function applyLabels(draft: StudioDraft, labels: unknown): void {
  if (!isRecord(labels)) return;
  const entries: StudioDraft['labels'] = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value !== 'string') continue;
    const field = LABEL_FIELDS[key];
    if (field) field(draft, value);
    else if (!INLINE_LABELS[key as LabelKey]) entries[key as LabelKey] = value;
  }
  draft.labels = entries;
}

function limitsOf(value: unknown): ModelBindingDraft['limits'] {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(MODEL_LIMITS.map(({ name }) => [name, whole(value[name])]));
}

function bindingOf(
  modelId: string,
  spec: unknown,
  current: ModelBindingDraft | undefined,
  agentKeyOf: AgentKeyOf | undefined,
  spans: readonly StudioSourceSpan[],
): ModelBindingDraft {
  const base = current ?? defaultModelBinding({ modelId });
  if (!isRecord(spec)) return { ...base, modelId };
  const efforts = isRecord(spec.efforts)
    ? Object.entries(spec.efforts).map(([alias, level]) => ({
        alias,
        level: level as ModelBindingDraft['efforts'][number]['level'],
      }))
    : [];
  const compaction = isRecord(spec.compaction) ? spec.compaction : undefined;
  const compactWith = text(compaction?.profile);
  const timeout = whole(spec.timeoutMs);
  return {
    ...base,
    modelId,
    protocol: text(spec.protocol, base.protocol),
    provider: text(spec.provider, base.provider),
    apiId: text(spec.apiId),
    options: (record(spec.options) ?? {}) as JsonObject,
    timeoutMs: timeout,
    limits: limitsOf(spec.limits),
    efforts,
    defaultEffort: text(spec.defaultEffort),
    allowEffortSelect: spec.allowEffortSelect === true,
    summaries: typeof spec.summaries === 'boolean' ? spec.summaries : null,
    maxOutputTokens: whole(spec.maxOutputTokens),
    temperature: typeof spec.temperature === 'number' ? spec.temperature : null,
    builtInTools: Array.isArray(spec.builtInTools)
      ? spec.builtInTools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    keySlot: text(spec.keySlot),
    fallbackKeySlot: text(spec.fallbackKeySlot),
    compactTiming: text(compaction?.timing) as ModelBindingDraft['compactTiming'],
    compactMaxTokens: whole(compaction?.maxTokens),
    compactAt: typeof compaction?.compactAt === 'number' ? compaction.compactAt : undefined,
    compactKeep: whole(compaction?.previousExchanges),
    compactMeter: text(compaction?.meter) as ModelBindingDraft['compactMeter'],
    compactWith: compactWith
      ? compactorKey(compactWith, agentKeyOf, `models.${modelId}.compaction.profile`, spans)
      : '',
  };
}

/**
 * The key of the agent `id` names to write a model's summaries. Without `agentKeyOf` the caller
 * links it once every agent is read, so it is left blank here; with it, an id no agent has is
 * refused where it is written, since a blank one means the agent itself.
 */
function compactorKey(
  id: string,
  agentKeyOf: AgentKeyOf | undefined,
  path: string,
  spans: readonly StudioSourceSpan[],
): string {
  if (!agentKeyOf) return '';
  return (
    agentKeyOf(id) ??
    failAt(spans, path, `'${id}' is not an agent here, so it can't write this model's summaries.`)
  );
}

/** The canned reply a function tool returns, when the file wrote its own. */
function stubOf(type: string, spec: Record<string, unknown>): string | undefined {
  const schema = spec.output;
  if (type !== 'function' || !isRecord(spec.handler) || !isRecord(schema)) return undefined;
  if (sameValue(spec.handler, stubOutputFromSchema(schema))) return undefined;
  return jsonText(spec.handler);
}

function toolRoute(spec: Record<string, unknown>) {
  const mapping = record(spec.mapping) ?? {};
  return {
    endpoint: filled(spec.endpoint),
    method: filled(spec.method) as ToolSpecDraft['method'],
    headersJson: isRecord(spec.headers) ? jsonText(spec.headers) : undefined,
    pathParams: listed(mapping.pathParams),
    queryParams: listed(mapping.queryParams),
    bodyParam: filled(mapping.bodyParam),
    serverUrl: filled(spec.serverUrl),
    mcpToolName: filled(spec.mcpToolName),
    maxResponseBytes: whole(spec.maxResponseBytes),
    sessionIdleMs: whole(record(spec.session)?.idleMs),
    sessionMax: whole(record(spec.session)?.max),
  } satisfies Partial<ToolSpecDraft>;
}

function toolAuth(spec: Record<string, unknown>) {
  const auth = record(spec.auth) ?? {};
  return {
    authType: text(auth.type) as ToolSpecDraft['authType'],
    authSlot: filled(auth.slot),
    authService: filled(auth.service),
    authHeaderName: filled(auth.headerName),
    authHeaderPrefix: typeof auth.headerPrefix === 'string' ? auth.headerPrefix : undefined,
    authQueryParam: filled(auth.queryParam),
    authUnauthenticated: text(auth.onUnauthenticated) as ToolSpecDraft['authUnauthenticated'],
    authScopes: listed(auth.scopes),
    authClientId: filled(auth.clientId),
    authRedirectUri: filled(auth.redirectUri),
  } satisfies Partial<ToolSpecDraft>;
}

function toolOf(
  spec: Record<string, unknown>,
  current: ToolSpecDraft | undefined,
  agentKeyOf: AgentKeyOf | undefined,
): ToolSpecDraft {
  const base = current ?? defaultToolSpec();
  const type = text(spec.type, base.toolType) as ToolSpecDraft['toolType'];
  const labels = record(spec.labels) ?? {};
  const agentId = text(spec.profile);
  const page = spec.answeredBy === 'page';
  return {
    ...base,
    key: current?.key ?? draftKey('tool'),
    toolName: text(spec.name, base.toolName),
    toolType: type,
    description: text(spec.description),
    category: text(spec.category, 'studio'),
    access: text(spec.access, base.access) as ToolSpecDraft['access'],
    permission: text(spec.permission, base.permission) as ToolSpecDraft['permission'],
    loadTier: text(spec.loadTier, base.loadTier) as ToolSpecDraft['loadTier'],
    paths: listed(spec.paths) ?? ['*'],
    inputJson: spec.input === undefined ? base.inputJson : schemaText(spec.input),
    outputJson: spec.output === undefined ? base.outputJson : schemaText(spec.output),
    activity: labelText(labels.activity),
    activityPast: labelText(labels.activityPast),
    activityFailed: labelText(labels.activityFailed),
    request: labelText(labels.request),
    // A page tool's source has no handler: its stub is the studio's own, so it is kept.
    stubOutputJson: page ? current?.stubOutputJson : stubOf(type, spec),
    answeredBy: page ? 'page' : undefined,
    ...toolRoute(spec),
    agentKey: agentId ? agentKeyOf?.(agentId) : undefined,
    maxCallsPerTurn: whole(spec.maxCallsPerTurn),
    ...toolAuth(spec),
  };
}

function questionsOf(
  spec: Record<string, unknown>,
  current: DecisionQuestionDraft[],
): DecisionQuestionDraft[] {
  const byId = new Map(current.map((question) => [question.id, question]));
  return Object.entries(spec).map(([id, value]) => {
    const previous = byId.get(id);
    const question = isRecord(value) ? value : {};
    const type = text(question.type, 'choice') as DecisionQuestionDraft['type'];
    const criteria = question.criteria;
    const rows = Array.isArray(criteria)
      ? criteria.map((entry, index) => ({
          key: previous?.criteria[index]?.key ?? draftKey('criterion'),
          label: '',
          text: text(entry),
        }))
      : isRecord(criteria)
        ? Object.entries(criteria).map(([label, entry], index) => ({
            key: previous?.criteria[index]?.key ?? draftKey('criterion'),
            label,
            text: text(entry),
          }))
        : [];
    return {
      key: previous?.key ?? draftKey('question'),
      id,
      type,
      instructions: text(question.instructions),
      criteria: rows,
      ...(type === 'box' && text(question.image) ? { image: text(question.image) } : {}),
    };
  });
}

function referencesOf(value: unknown): ImageReferenceDraft[] {
  if (!Array.isArray(value)) return [];
  const references: ImageReferenceDraft[] = [];
  for (const reference of value) {
    if (!isRecord(reference)) continue;
    if (typeof reference.uri === 'string') {
      const name = text(reference.name);
      references.push({
        key: draftKey('reference'),
        uri: reference.uri,
        ...(name ? { name } : {}),
      });
    } else if (typeof reference.data === 'string') {
      references.push({
        key: draftKey('reference'),
        name: text(reference.name),
        mimeType: text(reference.mimeType),
        data: reference.data,
      });
    }
  }
  return references;
}

function includedOf(
  type: StudioProfileType | '',
  profile: Record<string, unknown>,
): StudioDraft['included'] {
  if (!type) return createBlankDraft().included;
  return PROFILE_GRAPH.filter((facet) => {
    if (!facet.optional || facet.role === 'branch') return false;
    if (!facet.profileTypes.includes(type as ProfileType)) return false;
    return facet.profilePath in profile;
  }).map((facet) => facet.id);
}

/**
 * `registerTool` calls define the tools. `tools.allow` chooses which of those
 * this agent uses. A call left out of `allow` stays defined and is not used.
 * A name in `allow` with no call is an error at that name: the file would be
 * allowing a tool it does not define.
 */
function registerTools(
  calls: Record<string, unknown>[],
  byToolName: Map<string, ToolSpecDraft>,
  agentKeyOf: AgentKeyOf | undefined,
  spans: readonly StudioSourceSpan[],
): ToolSpecDraft[] {
  const registered: ToolSpecDraft[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const tool = toolOf(call, byToolName.get(text(call.name)), agentKeyOf);
    if (tool.toolName && seen.has(tool.toolName)) {
      const names = spans.filter((span) => span.path === 'name');
      const at = names[registered.length] ?? { line: 1, column: 1 };
      throw new ReadFail(`'${tool.toolName}' is registered twice.`, at.line, at.column);
    }
    if (tool.toolName) seen.add(tool.toolName);
    registered.push(tool);
  }
  return registered;
}

function allowTools(
  registered: readonly ToolSpecDraft[],
  allow: unknown,
  spans: readonly StudioSourceSpan[],
): ToolSpecDraft[] {
  // A profile with no `tools` allows none: the kernel reads it so.
  if (allow === undefined) return [];
  const atAllow = spans.findLast((span) => span.path === 'tools.allow') ?? { line: 1, column: 1 };
  if (!Array.isArray(allow)) {
    throw new ReadFail('tools.allow has to be a list of tool names.', atAllow.line, atAllow.column);
  }
  const byName = new Map(registered.map((tool) => [tool.toolName, tool]));
  const allowed: ToolSpecDraft[] = [];
  const seen = new Set<string>();
  for (const [index, name] of allow.entries()) {
    const at = spans.find((span) => span.path === `tools.allow.${String(index)}`) ?? atAllow;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ReadFail('tools.allow names tools.', at.line, at.column);
    }
    if (seen.has(name))
      throw new ReadFail(`'${name}' is listed twice in tools.allow.`, at.line, at.column);
    seen.add(name);
    const tool = byName.get(name);
    if (!tool) {
      throw new ReadFail(
        `'${name}' is in tools.allow, and this file has no registerTool for it.`,
        at.line,
        at.column,
      );
    }
    allowed.push(tool);
  }
  return allowed;
}

function identityOf(
  current: StudioDraft['identity'],
  profile: Record<string, unknown>,
  type: StudioProfileType | '',
): StudioDraft['identity'] {
  const identity = record(profile.identity) ?? {};
  const byRole = identity.systemByRole;
  return {
    ...current,
    agentId: text(profile.id),
    profileType: type,
    handle: text(identity.handle),
    system: promptLines(identity.system, current.system),
    conditionsJson: isRecord(identity.conditions) ? jsonText(identity.conditions) : '',
    systemByRoleJson: isRecord(byRole) || Array.isArray(byRole) ? jsonText(byRole) : '',
  };
}

function modelsOf(profile: Record<string, unknown>): StudioDraft['models'] {
  return {
    ...(isRecord(profile.providerContinuation) &&
    (profile.providerContinuation.history === 'provider' ||
      profile.providerContinuation.history === 'stateless')
      ? { providerHistory: profile.providerContinuation.history }
      : {}),
    defaultModel: text(profile.defaultModel),
    allowModelSelect: profile.allowModelSelect === true,
    maxSteps: whole(profile.maxSteps),
    key: text(profile.key),
    fallbackKey: text(profile.fallbackKey),
  };
}

function isContextSender(value: string): value is ContextSender {
  return (CONTEXT_SENDERS as readonly string[]).includes(value);
}

/** The byte counts a file wrote by type; anything else is left out. */
function limitsByMimeOf(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(value) ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/** A file's slots as rows, each keeping the key the slot of its name had. */
function slotsOf(value: unknown, current: readonly SlotDraft[]): SlotDraft[] {
  const byName = new Map(current.map((slot) => [slot.name, slot]));
  return Object.entries(record(value) ?? {}).map(([name, decl]) => {
    const previous = byName.get(name);
    const rich = record(decl);
    const entries: unknown[] = Array.isArray(decl)
      ? decl
      : Array.isArray(rich?.choices)
        ? rich.choices
        : [];
    const choices = entries.map((entry, index) => {
      const choice = record(entry);
      return {
        key: previous?.choices[index]?.key ?? draftKey('choice'),
        value: choice ? text(choice.value) : text(entry),
        description: text(choice?.description),
      };
    });
    return { key: previous?.key ?? draftKey('slot'), name, label: text(rich?.label), choices };
  });
}

function inputsOf(
  inputs: Record<string, unknown>,
  current: StudioDraft['inputs'],
): StudioDraft['inputs'] {
  const context = record(inputs.context);
  return {
    text: inputs.text !== false,
    attachmentsAccept: strings(record(inputs.attachments)?.accept),
    voiceAccept: strings(record(inputs.voice)?.accept),
    maxFiles: whole(inputs.maxFiles),
    maxBytes: whole(inputs.maxBytes),
    maxTurnBytes: whole(inputs.maxTurnBytes),
    limitsByMime: limitsByMimeOf(inputs.limitsByMime),
    slots: slotsOf(inputs.slots, current.slots),
    contextFrom: strings(context?.from).filter(isContextSender),
    contextMaxChars: whole(context?.maxChars),
  };
}

function itemRulesOf(
  items: Record<string, unknown> | undefined,
): StudioDraft['outputs']['itemRules'] {
  return Object.fromEntries(
    Object.entries(items ?? {}).map(([list, rule]) => [
      list,
      record(rule)?.onFail === 'fix' ? 'fix' : 'drop',
    ]),
  );
}

function outputsOf(
  outputs: Record<string, unknown> | undefined,
  structured: ParsedModule['structured'],
): StudioDraft['outputs'] {
  const schemaId = structured?.id ?? text(outputs?.structured);
  const streaming = record(outputs?.streaming);
  const validation = record(outputs?.validation);
  return {
    mode: schemaId ? 'structured' : 'text',
    schemaId,
    schemaJson: jsonText(structured?.spec.jsonSchema),
    streamMode: text(streaming?.mode) as StudioDraft['outputs']['streamMode'],
    streamThoughts: streaming?.streamThoughts !== false,
    validationEnabled: validation !== undefined,
    maxRetries: whole(validation?.maxRetries),
    itemRules: itemRulesOf(record(validation?.items)),
    repairGuidance: '',
  };
}

function turnOf(turn: Record<string, unknown>): StudioDraft['turnBehaviour'] {
  const resumption = record(turn.resumption);
  // A list left out is the kernel's own, not none.
  const allowContinue = Array.isArray(resumption?.allowContinue)
    ? resumption.allowContinue
    : [...DEFAULT_ALLOW_CONTINUE];
  const autoContinue = Array.isArray(resumption?.autoContinue)
    ? resumption.autoContinue
    : [...DEFAULT_AUTO_CONTINUE];
  return {
    resumeEnabled: allowContinue.length > 0 || autoContinue.length > 0,
    allowContinue: allowContinue as StudioDraft['turnBehaviour']['allowContinue'],
    autoContinue: autoContinue as StudioDraft['turnBehaviour']['autoContinue'],
    maxContinues: whole(resumption?.maxContinues),
    continueInstruction: '',
    allowSteering: turn.allowSteering !== false,
    atStepLimit: turn.atStepLimit === 'answer' ? 'answer' : 'stop',
  };
}

function observabilityOf(spec: Record<string, unknown>): StudioDraft['observability'] {
  const blank = createBlankDraft().observability;
  // A project's profile names its own store. It stays the one traces go to when they are on.
  const destination =
    typeof spec.writeTo === 'string' && spec.writeTo ? spec.writeTo : blank.destination;
  return {
    ...blank,
    writeTo: spec.writeTo === false ? false : destination,
    destination,
    sampleRate: typeof spec.sampleRate === 'number' ? spec.sampleRate : blank.sampleRate,
    include: { ...blank.include, ...record(spec.include) },
    scrub: { ...blank.scrub, ...record(spec.scrub) },
    retainForDays: whole(spec.retainForDays),
    rotateAfterMiB: whole(spec.rotateAfterMiB),
    resourceJson: jsonText(spec.resource),
  };
}

function imageOf(image: Record<string, unknown>): StudioDraft['image'] {
  return {
    aspectRatio: text(image.aspectRatio),
    resolution: text(image.resolution),
    mimeType: text(image.mimeType),
    quality: text(image.quality),
    background: text(image.background),
    n: whole(image.n),
    seed: whole(image.seed),
    outputCompression: whole(image.outputCompression),
    includeText: image.includeText === true,
    references: referencesOf(image.references),
  };
}

function speechOf(speech: Record<string, unknown>): StudioDraft['speech'] {
  return {
    voice: text(speech.voice),
    style: text(speech.style),
    speed: whole(speech.speed),
    format: text(speech.format) as StudioDraft['speech']['format'],
  };
}

function ingressOf(
  ingress: Record<string, unknown>,
  channel: Parameters<typeof liveIngressChannelDefault>[0],
): boolean {
  const value = ingress[channel];
  return typeof value === 'boolean' ? value : liveIngressChannelDefault(channel);
}

function liveOf(live: Record<string, unknown>): StudioDraft['live'] {
  type Live = StudioDraft['live'];
  const ingress = record(live.ingress) ?? {};
  const vad = record(live.vad) ?? {};
  const compression = record(live.contextCompression);
  const sliding = record(compression?.slidingWindow);
  const transcription = record(live.transcription);
  return {
    ingressAudio: ingressOf(ingress, 'audio'),
    ingressVideo: ingressOf(ingress, 'video'),
    ingressText: ingressOf(ingress, 'text'),
    voice: text(live.voice),
    sessionResumption: live.sessionResumption === true,
    greeting: text(live.greeting),
    resumedPrompt: text(record(live.resumed)?.prompt),
    resumedAfterMs: whole(record(live.resumed)?.afterMs),
    contextCompression: compression !== undefined,
    compressionTriggerTokens: whole(compression?.triggerTokens),
    compressionTargetTokens: whole(sliding?.targetTokens),
    transcriptionInput: transcription?.input === true,
    transcriptionOutput: transcription?.output === true,
    vadActivityHandling: text(vad.activityHandling) as Live['vadActivityHandling'],
    vadStartSensitivity: text(vad.startSensitivity) as Live['vadStartSensitivity'],
    vadEndSensitivity: text(vad.endSensitivity) as Live['vadEndSensitivity'],
    vadPrefixPaddingMs: whole(vad.prefixPaddingMs),
    vadSilenceDurationMs: whole(vad.silenceDurationMs),
  };
}

function decisionOf(
  decision: Record<string, unknown>,
  parsed: ParsedModule,
  current: StudioDraft['decision'],
): StudioDraft['decision'] {
  const maxState = whole(record(parsed.profile?.inputs)?.maxStateBytes);
  return {
    contract: text(decision.contract),
    maxStateBytes: maxState,
    questions: parsed.questions ? questionsOf(parsed.questions, current.questions) : [],
    images: parsed.images ? decisionImagesOf(parsed.images, current.images) : [],
  };
}

/** The module's pictures, each keeping the key of the one it replaces by name. */
function decisionImagesOf(
  spec: Record<string, unknown>,
  current: DecisionImageDraft[],
): DecisionImageDraft[] {
  const byName = new Map(current.map((image) => [image.name, image]));
  return Object.entries(spec).map(([reference, value]) => {
    const name = reference.replace(/^<|>$/g, '');
    const image = isRecord(value) ? value : {};
    return {
      key: byName.get(name)?.key ?? draftKey('image'),
      name,
      mimeType: text(image.mimeType),
      data: text(image.data),
    };
  });
}

function profileTypeOf(profile: Record<string, unknown>): StudioProfileType | '' {
  const type = text(profile.type);
  if (type && !(STUDIO_PROFILE_TYPES as readonly string[]).includes(type)) {
    throw new ReadFail(`'${type}' is not a profile type.`, 1, 1);
  }
  return type as StudioProfileType | '';
}

/** The settings a reader below would otherwise take as their default when set to anything else. */
const LISTED_SETTINGS = ['turnBehaviour.atStepLimit', 'outputs.validation.items.*.onFail'] as const;

/** Refuses, where it is written, a listed setting set to a value the kernel's table does not list. */
function refuseUnlisted(
  profile: Record<string, unknown>,
  spans: readonly StudioSourceSpan[],
): void {
  for (const setting of LISTED_SETTINGS) {
    const options = fieldMeta(setting)?.options ?? [];
    for (const [path, value] of valuesAt(profile, setting.split('.'), [])) {
      if (value !== undefined && !options.includes(value as string)) {
        failAt(
          spans,
          path,
          `${JSON.stringify(value)} is not one of ${options.map((option) => `'${option}'`).join(', ')}.`,
        );
      }
    }
  }
}

/** Each value at `keys` in `value`, `*` standing for every key, with its path as written. */
function valuesAt(
  value: unknown,
  keys: readonly string[],
  at: readonly string[],
): [string, unknown][] {
  const [key, ...rest] = keys;
  if (key === undefined) return [[at.join('.'), value]];
  if (!isRecord(value)) return [];
  const next = key === '*' ? Object.keys(value) : [key];
  return next.flatMap((each) => valuesAt(value[each], rest, [...at, each]));
}

function draftFrom(
  parsed: ParsedModule,
  current: StudioDraft,
  agentKeyOf: AgentKeyOf | undefined,
): {
  draft: StudioDraft;
  registered: ToolSpecDraft[];
} {
  const profile = parsed.profile ?? {};
  const type = profileTypeOf(profile);
  refuseUnlisted(profile, parsed.spans);
  const byModelId = new Map(current.modelBindings.map((binding) => [binding.modelId, binding]));
  const byToolName = new Map(current.toolSpecs.map((tool) => [tool.toolName, tool]));
  const tools = record(profile.tools) ?? {};
  const inputs = record(profile.inputs);
  const outputs = record(profile.outputs);
  const draft: StudioDraft = {
    ...current,
    identity: identityOf(current.identity, profile, type),
    included: includedOf(type, profile),
    models: modelsOf(profile),
    modelBindings: Object.entries(record(profile.models) ?? {}).map(([modelId, spec]) =>
      bindingOf(modelId, spec, byModelId.get(modelId), agentKeyOf, parsed.spans),
    ),
    tools: { t2Loader: text(tools.t2Loader), parallel: tools.parallel === true },
    toolSpecs: [],
    inputs: inputs && type !== 'decision' ? inputsOf(inputs, current.inputs) : current.inputs,
    outputs: outputs || parsed.structured ? outputsOf(outputs, parsed.structured) : current.outputs,
    turnBehaviour: section(profile.turnBehaviour, turnOf, current.turnBehaviour),
    guardrails: section(profile.guardrails, guardrailsOf, current.guardrails),
    observability: section(profile.observability, observabilityOf, current.observability),
    image: section(profile.image, imageOf, current.image),
    speech: section(profile.speech, speechOf, current.speech),
    live: section(profile.live, liveOf, current.live),
    decision: section(
      profile.decision,
      (spec) => decisionOf(spec, parsed, current.decision),
      current.decision,
    ),
    labels: {},
  };
  const registered = registerTools(parsed.tools, byToolName, agentKeyOf, parsed.spans);
  const allowed = allowTools(registered, tools.allow, parsed.spans);
  draft.toolSpecs = allowed;
  const allowedNames = new Set(allowed.map((tool) => tool.toolName));
  if (draft.tools.t2Loader && !allowedNames.has(draft.tools.t2Loader)) {
    draft.tools = { ...draft.tools, t2Loader: '' };
  }
  applyLabels(draft, profile.labels);
  return { draft, registered };
}

/**
 * The open agent's file, as a draft. `current` keeps the row keys of models and
 * tools the file still has. `agentKeyOf` resolves an agent id named in the file.
 */
export function readStudioSource(
  source: string,
  current: StudioDraft,
  agentKeyOf?: AgentKeyOf,
): StudioSourceRead {
  try {
    const parsed = parseModule(source);
    const { draft, registered } = draftFrom(parsed, current, agentKeyOf);
    return { ok: true, draft, spans: parsed.spans, registered };
  } catch (error) {
    if (error instanceof ReadFail) {
      return {
        ok: false,
        errors: [{ message: error.message, line: error.line, column: error.column }],
      };
    }
    throw error;
  }
}

/** Fails at where `path` was written, or at the file's start. */
function failAt(spans: readonly StudioSourceSpan[], path: string, message: string): never {
  const at = spans.findLast((span) => span.path === path) ?? { line: 1, column: 1 };
  throw new ReadFail(message, at.line, at.column);
}

const PROVIDER_SETTINGS = new Set(['id', 'connection', 'keySlot', 'fallbackKeySlot']);

function providerFrom(
  written: { definition: string; spec: Record<string, unknown> },
  current: StudioProvider,
  spans: readonly StudioSourceSpan[],
): StudioProvider {
  const { spec } = written;
  for (const key of Object.keys(spec)) {
    if (!PROVIDER_SETTINGS.has(key))
      failAt(spans, key, `'${key}' isn't a provider setting the studio holds.`);
  }
  if (spec.id !== current.id) {
    failAt(spans, 'id', `The id stays '${current.id}': models and code name the provider by it.`);
  }
  const definition = definitionOfFactory(written.definition);
  if (!definition) {
    const named = kernelDefinitions()
      .flatMap((id) => definitionFactory(id) ?? [])
      .join(', ');
    failAt(spans, '', `'${written.definition}' isn't one of the kernel's providers: ${named}.`);
  }
  const held = spec.connection === undefined ? {} : connectionFrom(spec.connection, spans);
  // An empty connection is what the code has to say for one that opened with none.
  const empty = Object.keys(held).length === 0 && current.connection === undefined;
  const provider: StudioProvider = {
    id: current.id,
    definition,
    ...(empty ? {} : { connection: held }),
  };
  for (const slot of ['keySlot', 'fallbackKeySlot'] as const) {
    const value = spec[slot];
    if (value === undefined) continue;
    if (typeof value !== 'string') failAt(spans, slot, `${slot} names a key slot.`);
    provider[slot] = value;
  }
  return provider;
}

/** A provider's connection: text settings, by name. */
function connectionFrom(
  connection: unknown,
  spans: readonly StudioSourceSpan[],
): Record<string, string> {
  const wrong = 'connection holds text settings here.';
  const held: Record<string, string> = {};
  if (!isRecord(connection)) failAt(spans, 'connection', wrong);
  for (const [name, value] of Object.entries(connection)) {
    if (typeof value !== 'string') failAt(spans, 'connection', wrong);
    held[name] = value;
  }
  return held;
}

/** A provider's file, as the provider it defines. Its id has to stay `current`'s. */
export function readProviderSource(source: string, current: StudioProvider): ProviderSourceRead {
  try {
    const parsed = parseModule(source, 'provider');
    if (!parsed.provider) throw new ReadFail('This code needs registerProvider().', 1, 1);
    return {
      ok: true,
      provider: providerFrom(parsed.provider, current, parsed.spans),
      spans: parsed.spans,
    };
  } catch (error) {
    if (error instanceof ReadFail) {
      return {
        ok: false,
        errors: [{ message: error.message, line: error.line, column: error.column }],
      };
    }
    throw error;
  }
}
