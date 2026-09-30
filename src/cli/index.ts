/**
 * Command-line entrypoint for inspecting registered profiles, running turns, and
 * exercising the kernel's guardrail and performance tools. It reads profiles
 * registered by the embedding host; it does not supply application profiles.
 *
 * @module
 */

import { argv, exit } from 'node:process';
import { benchCommand } from './commands/bench.ts';
import { evalCommand } from './commands/eval.ts';
import { fuzzCanaryCommand } from './commands/fuzz-canary.ts';
import { fuzzGuardrailsCommand } from './commands/fuzz-guardrails.ts';
import { listProfilesCommand, showProfileCommand } from './commands/profile.ts';
import { runCommand } from './commands/run.ts';
import { testProfileCommand } from './commands/test.ts';

function printHelp(): void {
  console.log(`
Theorem CLI - Profile Testing and Profile Inspection

USAGE:
  agents <command> [options]

COMMANDS:
  bench                Synthetic kernel performance benchmark
    --chunks <n>       Text chunks per mock turn (default: 200)
    --iterations <n>   Measurement iterations (default: 50)
    --warmup <n>       Warmup iterations (default: 5)

  eval <suite>         Run an eval suite live or over recorded traces
    --recorded <path>  Grade a JSONL file or directory of trace records instead of running
    --trials <k>       Trials per case, overriding the suite
    --concurrency <n>  Trials in flight at once (default: 1)
    --max-cost-usd <n> Stop starting trials once the run's cost passes this
    --threshold <f>    Fraction of cases that must pass for exit 0 (default 1)
    --trace-dir <path> Append trial and run records as JSONL under this directory
    --json             Print the run as one JSON document

  fuzz                 Adversarial inbound sanitization fuzzer
  fuzz-canary          Adversarial canary egress fuzzer (stream + Live gates)

  run                  Execute a turn with real-time streaming output
    --profile, -p <id> Target profile ID
    --prompt <text>    User prompt string
    --mode <fast|smart> Reasoning mode
    --search           Requires googleSearch on the selected model's builtInTools
    --map              Requires googleMaps on the selected model's builtInTools
    --verbose, -v      Print errorInternal and evidence.raw while running
    --trace            Capture a TraceRecord and print it after the turn
    --trace-dir <path> Also append trace JSONL under this directory

  test                 Run stress matrix or custom profile tests
    --profile, -p <id> Target profile ID registered by your host app
    --all, -a          Test all registered profiles
    --lite             Minimal fast-path connectivity ping
    --matrix           Run all valid permutations for the profile
    --mode <fast|smart> Reasoning mode override
    --search           Requires googleSearch on the selected model's builtInTools
    --map              Requires googleMaps on the selected model's builtInTools
    --verbose, -v      Print errorInternal and evidence.raw while running
    --trace            Capture a TraceRecord and print it after each turn
    --trace-dir <path> Also append trace JSONL under this directory

  profile              Inspect registered profile blueprints
    list               List all registered profiles
    show <id>          Show detailed JSON profile specification

  help, --help, -h     Show this help message
`);
}

interface ParsedFlags {
  _: string[];
  profile?: string;
  p?: string;
  prompt?: string;
  mode?: string;
  all?: boolean;
  a?: boolean;
  lite?: boolean;
  matrix?: boolean;
  search?: boolean;
  map?: boolean;
  verbose?: boolean;
  v?: boolean;
  trace?: boolean;
  'trace-dir'?: string;
  help?: boolean;
  [key: string]: unknown;
}

function cliDiagnostics(flags: ParsedFlags): {
  verbose: boolean;
  trace: boolean;
  traceDir?: string;
} {
  return {
    verbose: Boolean(flags.verbose || flags.v),
    trace: Boolean(flags.trace),
    traceDir: typeof flags['trace-dir'] === 'string' ? flags['trace-dir'] : undefined,
  };
}

function parseLongFlag(arg: string, nextArg: string | undefined, flags: ParsedFlags): number {
  const key = arg.slice(2);
  if (nextArg && !nextArg.startsWith('-')) {
    flags[key] = nextArg;
    return 1;
  }
  flags[key] = true;
  return 0;
}

function parseShortFlag(arg: string, nextArg: string | undefined, flags: ParsedFlags): number {
  const key = arg.slice(1);
  if (key === 'p' && nextArg) {
    flags.profile = nextArg;
    return 1;
  }
  if (key === 'a') flags.all = true;
  else if (key === 'h') flags.help = true;
  else if (key === 'v') flags.verbose = true;
  else flags[key] = true;
  return 0;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { _: [] };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg.startsWith('--')) {
      i += 1 + parseLongFlag(arg, next, flags);
    } else if (arg.startsWith('-')) {
      i += 1 + parseShortFlag(arg, next, flags);
    } else {
      flags._.push(arg);
      i += 1;
    }
  }
  return flags;
}

function extractProfileId(flags: ParsedFlags): string | undefined {
  if (typeof flags.profile === 'string') return flags.profile;
  if (typeof flags.p === 'string') return flags.p;
  return undefined;
}

async function handleTest(flags: ParsedFlags): Promise<void> {
  const profile = extractProfileId(flags);
  const diagnostics = cliDiagnostics(flags);
  const success = await testProfileCommand(profile, {
    all: Boolean(flags.all || flags.a),
    lite: Boolean(flags.lite),
    matrix: Boolean(flags.matrix),
    mode: typeof flags.mode === 'string' ? flags.mode : undefined,
    search: flags.search ? true : undefined,
    map: flags.map ? true : undefined,
    verbose: diagnostics.verbose,
    trace: diagnostics.trace,
    traceDir: diagnostics.traceDir,
  });
  if (!success) {
    exit(1);
  }
}

async function handleRun(flags: ParsedFlags): Promise<void> {
  const profile = extractProfileId(flags);
  if (!profile) {
    console.error('Error: Profile ID required (e.g. `agents run --profile your-profile`)');
    exit(1);
  }
  const prompt = typeof flags.prompt === 'string' ? flags.prompt : flags._.slice(1).join(' ');
  const diagnostics = cliDiagnostics(flags);
  await runCommand({
    profile,
    prompt,
    mode: typeof flags.mode === 'string' ? flags.mode : undefined,
    search: Boolean(flags.search),
    map: Boolean(flags.map),
    verbose: diagnostics.verbose,
    trace: diagnostics.trace,
    traceDir: diagnostics.traceDir,
  });
}

function numberFlag(flags: ParsedFlags, key: string): number | undefined {
  return typeof flags[key] === 'string' ? Number(flags[key]) : undefined;
}

async function handleEval(flags: ParsedFlags): Promise<void> {
  const suite = flags._[1];
  if (!suite) {
    console.error('Error: Suite module required (e.g. `agents eval ./evals/suite.ts`)');
    exit(1);
  }
  const ok = await evalCommand({
    suite,
    recorded: typeof flags.recorded === 'string' ? flags.recorded : undefined,
    trials: numberFlag(flags, 'trials'),
    concurrency: numberFlag(flags, 'concurrency'),
    maxCostUsd: numberFlag(flags, 'max-cost-usd'),
    threshold: numberFlag(flags, 'threshold'),
    traceDir: cliDiagnostics(flags).traceDir,
    json: Boolean(flags.json),
  });
  if (!ok) {
    exit(1);
  }
}

function handleProfile(flags: ParsedFlags): void {
  const sub = flags._[1] || 'list';
  if (sub === 'list') {
    listProfilesCommand();
    return;
  }
  const id = sub === 'show' ? flags._[2] || flags.profile : sub;
  if (typeof id !== 'string' || !id) {
    console.error('Error: Profile ID required (e.g. `agents profile show your-profile`)');
    exit(1);
  }
  showProfileCommand(id);
}

/** Unknown or omitted commands print help; a command that cannot continue exits 1. */
export async function main(cliArgs: string[] = argv.slice(2)): Promise<void> {
  const flags = parseFlags(cliArgs);
  const command = flags._[0] || (flags.help ? 'help' : 'help');

  if (command === 'fuzz') {
    const ok = fuzzGuardrailsCommand();
    if (!ok) {
      exit(1);
    }
  } else if (command === 'fuzz-canary') {
    const ok = await fuzzCanaryCommand();
    if (!ok) {
      exit(1);
    }
  } else if (command === 'bench') {
    await benchCommand({
      chunks: typeof flags.chunks === 'string' ? Number(flags.chunks) : undefined,
      iterations: typeof flags.iterations === 'string' ? Number(flags.iterations) : undefined,
      warmup: typeof flags.warmup === 'string' ? Number(flags.warmup) : undefined,
    });
  } else if (command === 'test') {
    await handleTest(flags);
  } else if (command === 'run') {
    await handleRun(flags);
  } else if (command === 'eval') {
    await handleEval(flags);
  } else if (command === 'profile') {
    handleProfile(flags);
  } else {
    printHelp();
  }
}
