/**
 * The translator suite, live, against a real Gemini provider.
 *
 *   deno task evals:example [--trials k] [--trace-dir dir] [--json]
 *   deno task evals:example --judge text|jev|both [--max-cost-usd n]
 *   deno task evals:example --recorded ~/.theorem/traces/evals [--judge text|jev|both]
 *
 * `--judge jev` reads `TYPESAFE_API_KEY` into vault slot `jev`; `both` is Jev handing what it is unsure of to the text
 * judge. `--phoenix` also sends the run to a local Phoenix (`deno task phoenix:up`).
 */

import { evalCommand } from '../src/cli/commands/eval.ts';
import { readTraceRecords } from '../src/evals/suite.ts';
import { getProfile } from '../src/kernel/default-scope.ts';
import { withOpenInference } from '../src/observability/openinference.ts';
import { toOtlpJson } from '../src/observability/otlp.ts';
import { phoenixAnnotations } from '../src/observability/phoenix.ts';
import type { TraceRecord } from '../src/observability/trace-record.ts';
import { createProvider } from '../src/providers/create-provider.ts';
import { JUDGE } from '../tests/evals/judge/profile.ts';
import { TRANSLATOR } from '../tests/evals/translator/profile.ts';
import { hostVault, loadHostEnv } from './host-env.ts';

const SUITES = {
  none: 'tests/evals/translator/suite.ts',
  text: 'tests/evals/judge/suite.ts',
  jev: 'tests/evals/judge/jev.ts',
  both: 'tests/evals/judge/both.ts',
} as const;

/** Where `deno task phoenix:up` listens: the Collector takes OTLP/JSON, Phoenix takes annotations. */
const COLLECTOR = 'http://localhost:4318/v1/traces';
const PHOENIX = 'http://localhost:6006';

/** Phoenix stores spans a moment after the Collector forwards them, and refuses annotations on spans it lacks (404). */
const ANNOTATION_TRIES = 20;
const ANNOTATION_WAIT_MS = 500;

function flag(name: string): string | undefined {
  const at = Deno.args.indexOf(`--${name}`);
  const value = at === -1 ? undefined : Deno.args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function judgeFlag(): keyof typeof SUITES {
  const value = flag('judge') ?? 'none';
  if (value in SUITES) return value as keyof typeof SUITES;
  console.error(`--judge takes text, jev or both, not ${value}`);
  Deno.exit(2);
}

/** Where records go without `--trace-dir`: under the home directory, outside any checkout. */
function defaultTraceDir(): string {
  const home = Deno.env.get('HOME');
  if (!home) {
    console.error('HOME is not set; name a directory outside the checkout with --trace-dir');
    Deno.exit(2);
  }
  return `${home}/.theorem/traces/evals`;
}

loadHostEnv();
const recorded = flag('recorded');
const judge = judgeFlag();
const trials = flag('trials');
const maxCostUsd = flag('max-cost-usd');
const options = {
  suite: SUITES[judge],
  ...(recorded ? { recorded } : {}),
  ...(trials ? { trials: Number(trials) } : {}),
  ...(maxCostUsd ? { maxCostUsd: Number(maxCostUsd) } : {}),
  // The sink wants an absolute directory; the flag may be relative to where the task ran.
  traceDir: new URL(flag('trace-dir') ?? defaultTraceDir(), `file://${Deno.cwd()}/`).pathname,
  json: Deno.args.includes('--json'),
};

// Recorded mode still judges live: the judge reads traces, it does not need the agent.
const vault = hostVault();
const textJudge = judge === 'text' || judge === 'both';
const jevJudge = judge === 'jev' || judge === 'both';
const jevKey = jevJudge ? Deno.env.get('TYPESAFE_API_KEY')?.trim() : undefined;
if (jevJudge && !jevKey) {
  console.error('--judge jev and --judge both read the Jev key from TYPESAFE_API_KEY');
  Deno.exit(2);
}

async function post(url: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Post the annotations, again while Phoenix has yet to store the spans they name. */
async function annotate(data: unknown[]): Promise<Response> {
  for (let tries = 1; ; tries++) {
    const response = await post(`${PHOENIX}/v1/span_annotations?sync=true`, { data });
    if (response.status !== 404 || tries === ANNOTATION_TRIES) return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, ANNOTATION_WAIT_MS));
  }
}

/** Send the records this run wrote (a span started at or after `since`) and their results to Phoenix. */
async function sendToPhoenix(traceDir: string, since: bigint): Promise<boolean> {
  let written: TraceRecord[];
  try {
    written = await readTraceRecords(traceDir);
  } catch (error) {
    console.error(
      `Phoenix: nothing sent; the run's records could not be read from ${traceDir} (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
  const records = written.filter((record) =>
    record.spans.some((span) => BigInt(span.startTimeUnixNano ?? '0') >= since),
  );
  const data = phoenixAnnotations(records);
  try {
    const traces = await post(COLLECTOR, toOtlpJson(withOpenInference(records)));
    await traces.body?.cancel();
    if (!traces.ok) throw new Error(`the Collector answered ${traces.status}`);
    if (data.length > 0) {
      const annotated = await annotate(data);
      if (!annotated.ok)
        throw new Error(`Phoenix answered ${annotated.status}: ${await annotated.text()}`);
    }
  } catch (error) {
    console.error(
      `Phoenix: ${error instanceof Error ? error.message : String(error)} (Collector ${COLLECTOR}, Phoenix ${PHOENIX}); is \`deno task phoenix:up\` running?`,
    );
    return false;
  }
  console.log(
    `Phoenix: ${records.length} records and ${data.length} annotations sent; open ${PHOENIX}`,
  );
  return true;
}

const since = BigInt(Date.now()) * 1_000_000n;
const ok = await evalCommand(options, {
  ...(recorded ? {} : { provider: createProvider(getProfile(TRANSLATOR), { vault }) }),
  ...(textJudge ? { judgeProvider: createProvider(getProfile(JUDGE), { vault }) } : {}),
  ...(jevKey ? { judgeDecision: { vault: { ...vault, jev: jevKey } } } : {}),
});
const sent = Deno.args.includes('--phoenix') ? await sendToPhoenix(options.traceDir, since) : true;
Deno.exit(ok && sent ? 0 : 1);
