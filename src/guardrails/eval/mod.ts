/** lexicon-exempt-file: evaluation runner — not runtime user or model copy (P2) */
import { injectionSpans } from '../injection.ts';
import { sensitiveSpans } from '../sensitive.ts';
import { directiveHits } from '../tool-directives.ts';
import { type CorpusSample, createCorpusCache, SOURCES } from './corpus.ts';
import { type DetectorScore, type EvalDetector, formatScores, scoreAll } from './score.ts';

/** Tool names used for the callable-tool signal when scoring tool-result content. */
const EVAL_TOOLS = ['send_email', 'send_money', 'read_inbox', 'get_channel_messages'];

/**
 * `action` is not decoration: it sets how much a false positive costs. A `redact`
 * silently rewrites a user's message, a `block` withholds a whole turn, and an
 * `annotate` only adds a caution the model may disregard. The first two have to
 * clear a far higher bar.
 */
const DETECTORS: readonly EvalDetector[] = [
  {
    id: 'injection.spans',
    action: 'redact',
    accountableFor: [
      'prompt-injection-prompts',
      'deepset-prompts',
      'spml-chatbot',
      'agent-app-attacks',
      'nvidia-agentic-ipi',
      'llmail-adaptive',
      'llmail-evaded-defense',
      'multilingual-prompts',
      'nvidia-jailbreak',
      'wildjailbreak',
    ],
    fires: (text) => injectionSpans(text).length > 0,
  },
  {
    id: 'sensitive.spans',
    action: 'redact',
    // why: `pii-spans` is the one corpus that labels what this detector hunts.
    accountableFor: ['pii-spans'],
    fires: (text) => sensitiveSpans(text).length > 0,
  },
  {
    id: 'tool-directives',
    // why: Indirect injection inside tool output. The prompt corpora are user-text
    // shaped; the agent-app attacks are the closest available match.
    action: 'annotate',
    accountableFor: [
      'agent-app-attacks',
      'nvidia-agentic-ipi',
      'llmail-adaptive',
      'llmail-evaded-defense',
    ],
    fires: (text) => directiveHits(text, EVAL_TOOLS).length > 0,
  },
];

export interface EvalOptions {
  /** Cache directory for fetched corpora. Gitignored; never published. */
  cacheDir?: string;
  /** Cap samples per source, for a quick local run. */
  limit?: number;
}

export interface EvalReport {
  scores: DetectorScore[];
  sources: {
    id: string;
    license: string;
    attribution: string;
    samples: number;
    /** Rows available upstream, so partial sampling is visible. */
    upstreamRows?: number;
  }[];
  skipped: { id: string; reason: string }[];
}

function corpusSkipReason(
  source: (typeof SOURCES)[number],
  kind: 'error' | 'empty',
  err?: unknown,
): string {
  if (kind === 'error') {
    if (source.requiresToken) return 'gated upstream — set HF_TOKEN to include it';
    return err instanceof Error ? err.message : String(err);
  }
  return source.requiresToken
    ? 'no rows returned — gated, or upstream rate-limited'
    : 'no rows returned — upstream rate-limited or schema changed';
}

async function loadEvalSource(
  source: (typeof SOURCES)[number],
  cache: ReturnType<typeof createCorpusCache>,
  limit: number | undefined,
): Promise<
  | { ok: true; samples: CorpusSample[]; meta: EvalReport['sources'][number] }
  | { ok: false; skip: EvalReport['skipped'][number] }
> {
  let samples: CorpusSample[];
  try {
    samples = await source.load(cache, limit ?? source.sampleLimit);
  } catch (err) {
    return { ok: false, skip: { id: source.id, reason: corpusSkipReason(source, 'error', err) } };
  }
  if (samples.length === 0 && (source.upstreamRows ?? 0) > 0) {
    return { ok: false, skip: { id: source.id, reason: corpusSkipReason(source, 'empty') } };
  }
  return {
    ok: true,
    samples,
    meta: {
      id: source.id,
      license: source.license,
      attribution: source.attribution,
      samples: samples.length,
      ...(source.upstreamRows !== undefined ? { upstreamRows: source.upstreamRows } : {}),
    },
  };
}

async function runGuardrailEval(options: EvalOptions = {}): Promise<EvalReport> {
  const cache = createCorpusCache(options.cacheDir ?? '.guardrail-corpus');
  const bySource = new Map<string, CorpusSample[]>();
  const sources: EvalReport['sources'] = [];
  const skipped: EvalReport['skipped'] = [];

  for (const source of SOURCES) {
    const loaded = await loadEvalSource(source, cache, options.limit);
    if (!loaded.ok) {
      skipped.push(loaded.skip);
      continue;
    }
    bySource.set(source.id, loaded.samples);
    sources.push(loaded.meta);
  }

  return { scores: scoreAll(DETECTORS, bySource), sources, skipped };
}

/** Includes the attribution the corpus licenses require. */
function formatReport(report: EvalReport): string {
  const header = report.sources
    .map((s) => {
      // why: Say plainly when a figure rests on a slice of a much larger corpus.
      const of =
        s.upstreamRows !== undefined && s.samples < s.upstreamRows ? ` of ${s.upstreamRows}` : '';
      return `  ${s.id.padEnd(24)} ${String(s.samples).padStart(6)}${of.padEnd(12)} samples  ${s.license}  ${s.attribution}`;
    })
    .join('\n');
  const skipped =
    report.skipped.length === 0
      ? ''
      : `\n\nNot loaded\n${report.skipped.map((s) => `  ${s.id.padEnd(24)} ${s.reason}`).join('\n')}`;
  return `Corpora\n${header}${skipped}\n${formatScores(report.scores)}`;
}

export { DETECTORS, formatReport, runGuardrailEval };
