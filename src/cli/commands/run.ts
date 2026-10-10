import { getProfile, runTurn } from '../../kernel/default-scope.ts';
import type { ProviderHostOptions } from '../../kernel/provider-contract.ts';
import { requireModelProfile } from '../../kernel/registry/resolve.ts';
import type { TurnRequest } from '../../kernel/types.ts';
import { createCliTraceCapture, printRunEvent, printTraceRecord } from '../event-log.ts';

export interface RunOptions {
  profile: string;
  prompt?: string;
  mode?: string;
  search?: boolean;
  map?: boolean;
  provider?: ProviderHostOptions;
  verbose?: boolean;
  trace?: boolean;
  traceDir?: string;
}

export async function runCommand(options: RunOptions): Promise<void> {
  requireModelProfile(getProfile(options.profile), 'agents run');
  const provider = options.provider;
  if (!provider) {
    console.error(
      '\n\x1b[31mExecution Failed\x1b[0m: Theorem CLI does not create providers or read keys. Run turns from a host app with an explicit ProviderHostOptions.\n',
    );
    return;
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
      return;
    }
    if (options.map && !builtins.has('googleMaps')) {
      console.error(
        '\n\x1b[31mExecution Failed\x1b[0m: --map requires googleMaps on models.*.builtInTools for the selected model.\n',
      );
      return;
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
    for await (const event of runTurn(req, provider, traceCapture?.sink)) {
      printRunEvent(event, { verbose: options.verbose });
    }
    console.log('\n');
    if (options.trace) {
      printTraceRecord(traceCapture?.records.at(-1), options.verbose === true);
    }
  } catch (err) {
    console.error(
      `\n\x1b[31mExecution Failed\x1b[0m: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
