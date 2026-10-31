import { getProfile, runTurn } from '../../kernel/default-scope.ts';
import type { ProviderHostOptions } from '../../kernel/protocols/runtime.ts';
import { requireModelProfile } from '../../kernel/registry/resolve.ts';
import type { TurnRequest, TurnWiring } from '../../kernel/types.ts';
import { createCliTraceCapture, printRunEvent, printTraceRecord } from '../event-log.ts';
import { preparedRequest } from '../setup.ts';

export interface RunOptions {
  profile: string;
  prompt?: string;
  mode?: string;
  search?: boolean;
  map?: boolean;
  provider?: ProviderHostOptions;
  prepare?: TurnWiring['prepare'];
  verbose?: boolean;
  trace?: boolean;
  traceDir?: string;
}

/** Runs one turn and prints it; false when the turn could not run or failed. */
export async function runCommand(options: RunOptions): Promise<boolean> {
  requireModelProfile(getProfile(options.profile), 'agents run');
  const provider = options.provider;
  if (!provider) {
    console.error(
      '\n\x1b[31mExecution Failed\x1b[0m: Theorem CLI does not create providers or read keys. Pass --setup <file> to run on the provider your setup file wires, or run turns from a host app with an explicit ProviderHostOptions.\n',
    );
    return false;
  }

  const prompt = options.prompt || 'Hello! Please introduce your capabilities.';
  if (options.search || options.map) {
    const profile = requireModelProfile(getProfile(options.profile), 'agents run');
    const selected = options.mode ?? profile.defaultModel;
    const builtins = new Set(profile.models[selected]?.builtInTools ?? []);
    if (options.search && !builtins.has('googleSearch')) {
      console.error(
        '\n\x1b[31mExecution Failed\x1b[0m: --search requires googleSearch on models.*.builtInTools for the selected model.\n',
      );
      return false;
    }
    if (options.map && !builtins.has('googleMaps')) {
      console.error(
        '\n\x1b[31mExecution Failed\x1b[0m: --map requires googleMaps on models.*.builtInTools for the selected model.\n',
      );
      return false;
    }
  }

  const req: TurnRequest = {
    profile: options.profile,
    model: options.mode,
    input: { text: prompt },
  };

  console.log(`\n▶ [RUNNING TURN] Profile: ${options.profile} (${options.mode ?? 'default'})`);
  console.log(`Prompt: "${prompt}"\n`);

  const traceCapture = options.trace ? createCliTraceCapture(options.traceDir) : undefined;

  try {
    const turn = await preparedRequest(options.prepare, req);
    let failed = false;
    for await (const event of runTurn(turn, provider, traceCapture?.sink)) {
      if (event.type === 'error') failed = true;
      printRunEvent(event, { verbose: options.verbose });
    }
    console.log('\n');
    if (options.trace) {
      printTraceRecord(traceCapture?.records.at(-1), options.verbose === true);
    }
    return !failed;
  } catch (err) {
    console.error(
      `\n\x1b[31mExecution Failed\x1b[0m: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}
