import { mapStrings } from '../kernel/engine/tree.ts';
import type { ToolBoundary } from './boundaries.ts';
import {
  type Detection,
  type DetectScope,
  detectAt,
  detectEvent,
  detectReads,
} from './detect-at.ts';
import type { ResolvedDetect } from './detectors.ts';
import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { DETECT_RULES, EGRESS_RULES, TOOL_RULES } from './rules.ts';
import { textForScan } from './serialize.ts';
import { advisoryLevel } from './tool-directives.ts';
import type {
  AdvisoryLevel,
  GuardrailEvent,
  GuardrailHit,
  Provenance,
  ResolvedGuardrailPolicy,
  TaintGate,
  ToolOrigin,
  TurnTaint,
  Verdict,
} from './types.ts';

/** The closing tag of the fence a tool result is wrapped in. */
const TOOL_CLOSE = '</tool_data>';
const TOOL_OPEN = '<tool_data';

/** Origins whose bytes the host does not author and cannot vouch for. */
const REMOTE_ORIGINS: ReadonlySet<ToolOrigin> = new Set<ToolOrigin>(['http', 'mcp', 'delegated']);

/** True when the tool's bytes come from outside the host. */
function isRemoteOrigin(origin: ToolOrigin): boolean {
  return REMOTE_ORIGINS.has(origin);
}

/**
 * Strip fence markers a tool result tried to forge before wrapping it.
 * Linear scan — avoids polynomial regex on forged `<tool_data…>` runs.
 */
function stripToolFences(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let i = 0;
  while (i < text.length) {
    const openAt = lower.indexOf(TOOL_OPEN, i);
    const closeAt = lower.indexOf(TOOL_CLOSE, i);
    let next = -1;
    let kind: 'open' | 'close' | null = null;
    if (openAt >= 0 && (closeAt < 0 || openAt <= closeAt)) {
      next = openAt;
      kind = 'open';
    } else if (closeAt >= 0) {
      next = closeAt;
      kind = 'close';
    }
    if (next < 0 || kind === null) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, next);
    if (kind === 'close') {
      i = next + TOOL_CLOSE.length;
      continue;
    }
    const gt = text.indexOf('>', next + TOOL_OPEN.length);
    if (gt < 0) {
      out += text.slice(next);
      break;
    }
    i = gt + 1;
  }
  return out;
}

/**
 * The origin is on the tag rather than in prose so a result cannot claim a
 * friendlier provenance than it has by writing one into its own body.
 */
function wrapToolData(
  text: string,
  provenance: Provenance,
  advisory: AdvisoryLevel = 'none',
  lexicon?: LexiconOverrides,
): string {
  const guidance = lexiconText('advisory.guidance', {}, lexicon).trim();
  const attrs =
    `tool="${provenance.tool}" origin="${provenance.origin}"` +
    (advisory === 'none' ? '' : ` advisory="${advisory}"`);
  const notice =
    advisory === 'none'
      ? ''
      : `${advisoryNotice(advisory, lexicon)}${guidance ? ` ${guidance}` : ''}\n`;
  return `<${'tool_data'} ${attrs}>\n${notice}${stripToolFences(text)}\n${TOOL_CLOSE}`;
}

/**
 * Deliberately an observation, not an instruction: what the agent should do about
 * it is product behaviour, supplied by the host as lexicon `advisory.guidance`. Emitted
 * only when signals fired, so it stays rare enough to carry weight — a warning on
 * every fetch is one the model learns to skip.
 */
function advisoryNotice(advisory: AdvisoryLevel, lexicon: LexiconOverrides | undefined): string {
  const key = advisory === 'high' ? 'advisory.notice_high' : 'advisory.notice_elevated';
  return lexiconText(key, {}, lexicon);
}

/** A tool result after the guard: the text the model sees, any event and the suspicious hits. */
export interface GuardedToolText {
  /** Absent when a match blocks: the model does not read the text. */
  text?: string;
  /** Emitted when the guard did anything worth recording. */
  event?: GuardrailEvent;
  /**
   * What `tool_instructions` found. Legitimate tool output is frequently
   * instruction-shaped, so the detector starts at `flag`; whatever its action,
   * these raise the turn's taint.
   */
  suspicious?: GuardrailHit[];
}

/**
 * `finding` is the tool's summary and `data` its structured payload; both reach
 * the model, so both are guarded together rather than only the prose half.
 */
function composeToolText(finding: string, data: unknown): string {
  if (data === undefined) {
    return finding;
  }
  const rendered = textForScan(data);
  if (rendered.unscannable) {
    return finding;
  }
  return `${finding}\n${rendered.text}`;
}

const NOTHING_FOUND: Detection = { action: 'allow', hits: [] };

/** `text` read at `boundary`, or passed as it is when the text crosses none. */
function readAt(
  text: string,
  boundary: ToolBoundary | undefined,
  detect: ResolvedDetect,
  scope?: DetectScope,
) {
  return boundary ? detectAt(text, boundary, detect, scope) : { ...NOTHING_FOUND, text };
}

/**
 * Local host tools are still detected — a host tool reading a database returns
 * data the host did not write — but only remote origins are fenced, because
 * fencing a local tool's output would change prompts hosts have already tuned.
 * `boundary` is absent for text that crosses none: a provider builtin's, or a
 * failure already read at its own boundary.
 */
function guardToolResult(
  finding: string,
  data: unknown,
  provenance: Provenance,
  policy: ResolvedGuardrailPolicy,
  boundary: ToolBoundary | undefined,
  callableTools: readonly string[] = [],
  lexicon?: LexiconOverrides,
): GuardedToolText {
  const composed = composeToolText(finding, data);
  const detected = readAt(composed, boundary, policy.detect, { callable: callableTools });
  const suspicious = detected.hits.filter(({ rule }) => rule === DETECT_RULES.tool_instructions);
  const remote = isRemoteOrigin(provenance.origin);
  const event: GuardrailEvent | undefined =
    detected.action === 'allow'
      ? undefined
      : {
          stage: 'tool_result',
          ...(boundary ? { boundary } : {}),
          trust: 'untrusted',
          action: detected.action,
          hits: detected.hits,
          provenance,
        };
  const found = {
    ...(suspicious.length > 0 ? { suspicious } : {}),
    ...(event ? { event } : {}),
  };
  if (detected.text === undefined) return found;
  const fenced = remote
    ? wrapToolData(
        detected.text,
        provenance,
        advisoryLevel(suspicious.map(({ signal }) => signal)),
        lexicon,
      )
    : detected.text;
  return { text: fenced, ...found };
}

/**
 * A remote server authors its own error strings, so an unguarded failure message
 * is the cleanest injection path across this boundary: it reaches the model
 * verbatim and is framed by the kernel as a system report.
 */
function guardToolFailureText(
  message: string,
  provenance: Provenance,
  policy: ResolvedGuardrailPolicy,
  boundary: ToolBoundary | undefined,
): GuardedToolText {
  const detected = readAt(stripToolFences(message), boundary, policy.detect);
  const event = boundary ? detectEvent(boundary, detected, provenance) : undefined;
  return {
    ...(detected.text === undefined ? {} : { text: detected.text }),
    ...(event ? { event } : {}),
  };
}

/** A tool call's arguments after they were read at their boundary. */
export interface InspectedToolArguments {
  /** The arguments to call the tool with. Absent when a match blocks: the tool is not called. */
  args?: unknown;
  event?: GuardrailEvent;
}

/**
 * Arguments are model-authored, so the risk is not instruction smuggling but
 * exfiltration: a credential lifted from context and posted outward as a
 * parameter. The whole call is read as it will be sent; `redact` then replaces
 * the match inside each string it sits in, so the tool is called with the
 * placeholder. `scope` is what the detectors of what is the profile's own
 * read of the turn: the canary, and its system instruction.
 */
function inspectToolArguments(
  args: unknown,
  provenance: Provenance,
  policy: ResolvedGuardrailPolicy,
  boundary: ToolBoundary | undefined,
  scope: DetectScope = {},
): InspectedToolArguments {
  if (!(boundary && detectReads([boundary], policy.detect))) {
    return { args };
  }
  const stopped = (hits: GuardrailHit[]): InspectedToolArguments => {
    const event = detectEvent(boundary, { action: 'block', hits }, provenance);
    return event ? { event } : {};
  };
  const rendered = textForScan(args);
  if (rendered.unscannable) {
    // why: Cannot inspect it, so cannot vouch for it. Fail closed.
    return stopped([{ rule: EGRESS_RULES.unscannable, severity: 'high' }]);
  }
  const detected = detectAt(rendered.text, boundary, policy.detect, scope);
  if (detected.action === 'block') return stopped(detected.hits);
  const event = detectEvent(boundary, detected, provenance);
  if (detected.action !== 'redact') return { args, ...(event ? { event } : {}) };
  const safe = mapStrings(
    args,
    (text) => detectAt(text, boundary, policy.detect, scope).text ?? '',
  );
  const left = detectAt(textForScan(safe).text, boundary, policy.detect, scope).action;
  // why: A match in a key, or one that runs across values, has no string to replace: the tool is not called.
  if (left === 'redact' || left === 'block') return stopped(detected.hits);
  return { args: safe, ...(event ? { event } : {}) };
}

/** The guardrail event for a tool call verdict, or `undefined` when it was allowed. */
function toolCallEvent(verdict: Verdict, provenance: Provenance): GuardrailEvent | undefined {
  if (verdict.action === 'allow') {
    return undefined;
  }
  return {
    stage: 'tool_call',
    trust: 'untrusted',
    action: verdict.action,
    hits: verdict.hits,
    provenance,
  };
}

/**
 * Only remote origins taint: a local host tool returns bytes the host's own code
 * produced, and treating those as attacker-influenceable would make the gate
 * useless in practice.
 */
function recordTaint(
  taint: TurnTaint | undefined,
  provenance: Provenance,
  suspicious: GuardrailHit[] = [],
): TurnTaint {
  const sources = taint?.sources ?? [];
  const prior = taint?.suspicious ?? [];
  if (!isRemoteOrigin(provenance.origin)) {
    return { sources, suspicious: prior };
  }
  return { sources: [...sources, provenance], suspicious: [...prior, ...suspicious] };
}

/** True when the turn has read content from outside the host. */
function isTainted(taint: TurnTaint | undefined): boolean {
  return (taint?.sources.length ?? 0) > 0;
}

/** True when something the turn read looked like instructions. */
function isSuspicious(taint: TurnTaint | undefined): boolean {
  return (taint?.suspicious.length ?? 0) > 0;
}

/** Capability rank, so a single threshold can express "this and anything worse". */
const CAPABILITY_RANK: Record<string, number> = {
  'read-only': 0,
  'read-write': 1,
  destructive: 2,
};

const GATE_RANK: Record<TaintGate, number> = {
  off: Number.POSITIVE_INFINITY,
  destructive: 2,
  write: 1,
};

/**
 * A `flag` says the call is happening on a tainted turn and is worth recording; a
 * `block` says the profile asked for it to be refused. Reporting happens whether
 * or not enforcement is configured, so the risk is visible before a host opts in.
 */
function checkTaintGate(
  taint: TurnTaint | undefined,
  access: string,
  policy: ResolvedGuardrailPolicy,
  lexicon?: LexiconOverrides,
): Verdict {
  if (!isTainted(taint)) {
    return { action: 'allow' };
  }
  const rank = CAPABILITY_RANK[access] ?? 0;
  if (rank === 0) {
    return { action: 'allow' };
  }
  const suspicious = isSuspicious(taint);
  const hits = [
    {
      rule: suspicious ? TOOL_RULES.steeredTurn : TOOL_RULES.taintedTurn,
      severity: 'high' as const,
    },
  ];
  // why: Gated on origin alone. Whether the content looked directive changes the rule
  // reported, never whether the call is refused.
  if (rank < GATE_RANK[policy.taint?.afterRemoteRead ?? 'off']) {
    return { action: 'flag', hits };
  }
  const read = taint?.sources.map((s) => s.tool).join(', ') ?? '';
  const reason = lexiconText(
    suspicious ? 'taint.reason_steered' : 'taint.reason_tainted',
    {},
    lexicon,
  );
  return {
    action: 'block',
    hits,
    rejection: lexiconText('taint.blocked', { access, sources: read, reason }, lexicon),
  };
}

export {
  checkTaintGate,
  composeToolText,
  guardToolFailureText,
  guardToolResult,
  inspectToolArguments,
  isRemoteOrigin,
  isSuspicious,
  isTainted,
  recordTaint,
  TOOL_CLOSE,
  toolCallEvent,
  wrapToolData,
};
