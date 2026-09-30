import { type LexiconOverrides, lexiconText } from './lexicon.ts';
import { detectionForTrust } from './policy.ts';
import { TOOL_RULES } from './rules.ts';
import { sanitizeText } from './sanitize.ts';
import { textForScan } from './serialize.ts';
import { advisoryLevel, directiveHits } from './tool-directives.ts';
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

const TOOL_CLOSE = '</tool_data>';
const TOOL_OPEN = '<tool_data';

/** Origins whose bytes the host does not author and cannot vouch for. */
const REMOTE_ORIGINS: ReadonlySet<ToolOrigin> = new Set<ToolOrigin>(['http', 'mcp', 'delegated']);

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

export interface GuardedToolText {
  text: string;
  /** Emitted when the guard did anything worth recording. */
  event?: GuardrailEvent;
  /**
   * Reported, never redacted: legitimate tool output is frequently
   * instruction-shaped, so rewriting on this signal would corrupt real data.
   * These raise the turn's taint instead.
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

/**
 * Local host tools are still detected — a host tool reading a database returns
 * data the host did not write — but only remote origins are fenced, because
 * fencing a local tool's output would change prompts hosts have already tuned.
 */
function guardToolResult(
  finding: string,
  data: unknown,
  provenance: Provenance,
  policy: ResolvedGuardrailPolicy,
  callableTools: readonly string[] = [],
  lexicon?: LexiconOverrides,
): GuardedToolText {
  const composed = composeToolText(finding, data);
  const options = detectionForTrust(policy, 'untrusted');
  const redacted = sanitizeText(composed, options);
  const changed = redacted !== composed;
  // Directive detection runs on remote content only: a local tool's output is
  // bytes the host's own code produced.
  const remote = isRemoteOrigin(provenance.origin);
  const suspicious = remote ? directiveHits(composed, callableTools) : [];
  const advisory = advisoryLevel(suspicious);
  const fenced = remote ? wrapToolData(redacted, provenance, advisory, lexicon) : redacted;

  const hits: GuardrailHit[] = [
    ...(changed ? [{ rule: TOOL_RULES.resultRedacted, severity: 'medium' as const }] : []),
    ...suspicious,
  ];
  if (hits.length === 0) {
    return { text: fenced };
  }
  return {
    text: fenced,
    ...(suspicious.length > 0 ? { suspicious } : {}),
    event: {
      stage: 'tool_result',
      trust: 'untrusted',
      // Redaction changed the text; directive signals only annotate it.
      action: changed ? 'redact' : 'flag',
      hits,
      provenance,
    },
  };
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
): GuardedToolText {
  const options = detectionForTrust(policy, 'untrusted');
  const redacted = sanitizeText(stripToolFences(message), options);
  if (redacted === message) {
    return { text: redacted };
  }
  return {
    text: redacted,
    event: {
      stage: 'tool_result',
      trust: 'untrusted',
      action: 'redact',
      hits: [{ rule: TOOL_RULES.failureRedacted, severity: 'medium' }],
      provenance,
    },
  };
}

/**
 * Arguments are model-authored, so the risk is not instruction smuggling but
 * exfiltration: a credential lifted from context and posted outward as a
 * parameter. Detection reports rather than rewrites — silently altering a tool
 * argument would make the call succeed against something the model did not ask
 * for.
 */
function inspectToolArguments(args: unknown, policy: ResolvedGuardrailPolicy): Verdict {
  if (!policy.redactSensitive) {
    return { action: 'allow' };
  }
  const rendered = textForScan(args);
  if (rendered.unscannable) {
    return { action: 'allow' };
  }
  const options = { sanitizeInput: false, redactSensitive: true };
  if (sanitizeText(rendered.text, options) === rendered.text) {
    return { action: 'allow' };
  }
  return {
    action: 'flag',
    hits: [{ rule: TOOL_RULES.sensitiveArgument, severity: 'high' }],
  };
}

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

function isTainted(taint: TurnTaint | undefined): boolean {
  return (taint?.sources.length ?? 0) > 0;
}

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
  // Gated on origin alone. Whether the content looked directive changes the rule
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
