/**
 * Guardrail evaluation — measured detector quality, not asserted.
 *
 * Every detector in this facet is a pattern matcher, and pattern matchers fail on
 * content nobody thought to write down. The point of this module is to make that
 * failure visible against corpora the authors did not choose, rather than against
 * hand-picked examples that flatter whatever was just built.
 *
 * Reached from `theorum/guardrails/testing`; never from the production entry.
 *
 * @command `deno task guardrails:eval`
 * @module
 */

import { injectionSpans } from '../injection.ts';
import { sensitiveSpans } from '../sensitive.ts';
import { directiveHits } from '../tool-directives.ts';
import { type CorpusSample, createCorpusCache, SOURCES } from './corpus.ts';
import { type DetectorScore, type EvalDetector, formatScores, scoreAll } from './score.ts';

/** Tool names used for the callable-tool signal when scoring tool-result content. */
const EVAL_TOOLS = ['send_email', 'send_money', 'read_inbox', 'get_channel_messages'];

/**
 * The detectors under evaluation, with what they do when they fire.
 *
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
    // `pii-spans` is the one corpus that labels what this detector hunts.
    accountableFor: ['pii-spans'],
    fires: (text) => sensitiveSpans(text).length > 0,
  },
  {
    id: 'tool-directives',
    // Indirect injection inside tool output. The prompt corpora are user-text
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
  /** Attribution for every corpus actually loaded. */
  sources: {
    id: string;
    licence: string;
    attribution: string;
    samples: number;
    /** Rows available upstream, so partial sampling is visible. */
    upstreamRows?: number;
  }[];
  /** Corpora that could not be loaded, and why. */
  skipped: { id: string; reason: string }[];
}

/** Fetch the corpora and score every detector against each source separately. */
async function runGuardrailEval(options: EvalOptions = {}): Promise<EvalReport> {
  const cache = createCorpusCache(options.cacheDir ?? '.guardrail-corpus');
  const bySource = new Map<string, CorpusSample[]>();
  const sources: EvalReport['sources'] = [];

  const skipped: EvalReport['skipped'] = [];
  for (const source of SOURCES) {
    const limit = options.limit ?? source.sampleLimit;
    let samples: CorpusSample[];
    try {
      samples = await source.load(cache, limit);
    } catch (err) {
      // A corpus that cannot be reached narrows the report; it never breaks it.
      skipped.push({
        id: source.id,
        reason: source.requiresToken
          ? 'gated upstream — set HF_TOKEN to include it'
          : err instanceof Error
            ? err.message
            : String(err),
      });
      continue;
    }
    // An empty load from a corpus known to have rows is a failure wearing the
    // costume of a success. Report it as skipped rather than scoring against
    // nothing and printing a confident `0 of 370724`.
    if (samples.length === 0 && (source.upstreamRows ?? 0) > 0) {
      skipped.push({
        id: source.id,
        reason: source.requiresToken
          ? 'no rows returned — gated, or upstream rate-limited'
          : 'no rows returned — upstream rate-limited or schema changed',
      });
      continue;
    }
    bySource.set(source.id, samples);
    sources.push({
      id: source.id,
      licence: source.licence,
      attribution: source.attribution,
      samples: samples.length,
      ...(source.upstreamRows !== undefined ? { upstreamRows: source.upstreamRows } : {}),
    });
  }

  return { scores: scoreAll(DETECTORS, bySource), sources, skipped };
}

/** Human-readable report, including the attribution the licences require. */
function formatReport(report: EvalReport): string {
  const header = report.sources
    .map((s) => {
      // Say plainly when a figure rests on a slice of a much larger corpus.
      const of =
        s.upstreamRows !== undefined && s.samples < s.upstreamRows ? ` of ${s.upstreamRows}` : '';
      return `  ${s.id.padEnd(24)} ${String(s.samples).padStart(6)}${of.padEnd(12)} samples  ${s.licence}  ${s.attribution}`;
    })
    .join('\n');
  const skipped =
    report.skipped.length === 0
      ? ''
      : `\n\nNot loaded\n${report.skipped.map((s) => `  ${s.id.padEnd(24)} ${s.reason}`).join('\n')}`;
  return `Corpora\n${header}${skipped}\n${formatScores(report.scores)}`;
}

export { DETECTORS, formatReport, runGuardrailEval };
