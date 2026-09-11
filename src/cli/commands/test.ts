import { runTurn } from '../../kernel/engine/runner.ts';
import { getProfile, listProfiles } from '../../kernel/registry/profiles.ts';
import { requireModelProfile } from '../../kernel/registry/resolve.ts';
import type { ModelProfile, ModelProvider, TurnRequest } from '../../kernel/types.ts';
import { createCliTraceCapture, printTestEvent, printTraceRecord } from '../event-log.ts';
import {
  buildCustomTurnRequest,
  type MatrixOptions,
  synthesizeMatrixCombos,
} from '../matrix/synthesizer.ts';

export interface TestRunResult {
  passed: boolean;
  name: string;
  durationSec: number;
  tokensTotal?: number;
  error?: string;
}

interface TestExecutionAccumulator {
  totalTokens: number;
  hasError: boolean;
  errorMessage: string;
}

function printTestHeader(req: TurnRequest, testName: string): void {
  const profile = requireModelProfile(getProfile(req.profile), 'theorum test');
  const modelId =
    req.model && profile.models[req.model] ? req.model : (Object.keys(profile.models)[0] ?? '');
  const customs = profile.type === 'speech' ? 'none' : profile.tools.allow.join(', ') || 'none';
  const builtins = (profile.models[modelId]?.builtInTools ?? []).join(', ') || 'none';

  console.log(`\n▶ [THEORUM TEST] ${testName}`);
  console.log(`  Profile:     ${req.profile} (Model: ${req.model ?? 'default'})`);
  console.log(`  Custom:      ${customs}`);
  console.log(`  Builtins:    ${builtins}`);
  console.log(
    `  Attachments: ${req.input?.attachments?.length ?? 0} file(s) | Voice: ${req.input?.voice?.length ? 'yes' : 'no'}`,
  );
  console.log(`  ${'-'.repeat(60)}`);
}

interface CliTestOptions {
  verbose?: boolean;
  trace?: boolean;
  traceDir?: string;
}

function processTestEvent(
  event: Parameters<typeof printTestEvent>[0],
  acc: TestExecutionAccumulator,
  options: CliTestOptions,
): void {
  if (event.type === 'tokens' && event.tokens) {
    acc.totalTokens = event.tokens.total;
  }
  if (event.type === 'error' && event.error) {
    acc.hasError = true;
    acc.errorMessage = event.error;
  }
  printTestEvent(event, { verbose: options.verbose });
}

function printTestResult(
  passed: boolean,
  durationSec: number,
  acc: TestExecutionAccumulator,
): void {
  if (passed) {
    console.log(
      `\n  ✓ STATUS: PASSED (took ${durationSec.toFixed(2)}s, ${acc.totalTokens ? `${acc.totalTokens} tokens` : 'ok'})`,
    );
  } else {
    console.log(`\n  ✗ STATUS: FAILED: ${acc.errorMessage} (${durationSec.toFixed(2)}s)`);
  }
}

export async function executeSingleTest(
  req: TurnRequest,
  testName: string,
  provider?: ModelProvider,
  cliOptions: CliTestOptions = {},
): Promise<TestRunResult> {
  const start = Date.now();
  getProfile(req.profile);
  printTestHeader(req, testName);

  const acc: TestExecutionAccumulator = {
    totalTokens: 0,
    hasError: false,
    errorMessage: '',
  };

  try {
    if (!provider) {
      throw new Error(
        'Theorum CLI does not create providers or read keys. Pass an explicit ModelProvider from the host app.',
      );
    }
    const traceCapture = cliOptions.trace ? createCliTraceCapture(cliOptions.traceDir) : undefined;
    for await (const event of runTurn(req, provider, traceCapture?.sink)) {
      processTestEvent(event, acc, cliOptions);
    }
    if (cliOptions.trace) {
      printTraceRecord(traceCapture?.records.at(-1), cliOptions.verbose === true);
    }
  } catch (err) {
    acc.hasError = true;
    acc.errorMessage = err instanceof Error ? err.message : String(err);
  }

  const durationSec = (Date.now() - start) / 1000;
  const passed = !acc.hasError;
  printTestResult(passed, durationSec, acc);

  return {
    passed,
    name: testName,
    durationSec,
    tokensTotal: acc.totalTokens,
    error: acc.errorMessage,
  };
}

function resolveTargetProfiles(
  profileId: string | undefined,
  all: boolean | undefined,
): ModelProfile[] | null {
  if (all) {
    // Host profiles never run a model, so there is no turn matrix to execute.
    return listProfiles().filter((profile): profile is ModelProfile => profile.type !== 'host');
  }
  if (profileId) {
    try {
      return [requireModelProfile(getProfile(profileId), 'theorum test')];
    } catch (err) {
      console.error(`\n Error: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }
  console.error(
    'Error: Please specify a profile ID (e.g. `theorum test --profile your-profile`) or `--all`.',
  );
  return null;
}

async function runProfileMatrix(
  profile: ModelProfile,
  provider?: ModelProvider,
  cliOptions: CliTestOptions = {},
): Promise<TestRunResult[]> {
  const results: TestRunResult[] = [];
  const combos = synthesizeMatrixCombos(profile);
  for (const combo of combos) {
    const res = await executeSingleTest(
      combo.req,
      `${profile.id} [${combo.name}]`,
      provider,
      cliOptions,
    );
    results.push(res);
  }
  return results;
}

async function runProfileSingle(
  profile: ModelProfile,
  options: MatrixOptions,
  provider?: ModelProvider,
  cliOptions: CliTestOptions = {},
): Promise<TestRunResult> {
  const req = buildCustomTurnRequest(profile, options);
  const testName = options.lite ? `${profile.id} [Lite]` : `${profile.id} [Stress Combo]`;
  return await executeSingleTest(req, testName, provider, cliOptions);
}

function printSummaryReport(results: TestRunResult[]): boolean {
  console.log(`\n${'='.repeat(70)}`);
  console.log(' TEST SUMMARY:');
  console.log('='.repeat(70));
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? '✓ PASSED' : '✗ FAILED';
    console.log(`  ${status.padEnd(10)} ${r.name.padEnd(45)} (${r.durationSec.toFixed(2)}s)`);
    if (!r.passed) {
      allPassed = false;
      if (r.error) console.log(`             Reason: ${r.error}`);
    }
  }
  console.log(`${'='.repeat(70)}\n`);
  return allPassed;
}

export async function testProfileCommand(
  profileId?: string,
  options: MatrixOptions & {
    all?: boolean;
    matrix?: boolean;
    provider?: ModelProvider;
    verbose?: boolean;
    trace?: boolean;
    traceDir?: string;
  } = {},
): Promise<boolean> {
  const targetProfiles = resolveTargetProfiles(profileId, options.all);
  if (!targetProfiles || targetProfiles.length === 0) {
    return false;
  }

  const cliOptions: CliTestOptions = {
    verbose: options.verbose,
    trace: options.trace,
    traceDir: options.traceDir,
  };
  const results: TestRunResult[] = [];
  for (const profile of targetProfiles) {
    if (options.matrix) {
      results.push(...(await runProfileMatrix(profile, options.provider, cliOptions)));
    } else {
      results.push(await runProfileSingle(profile, options, options.provider, cliOptions));
    }
  }

  return printSummaryReport(results);
}
