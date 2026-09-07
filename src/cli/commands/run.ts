import { runTurn } from '../../kernel/engine/runner.ts';
import { getProfile } from '../../kernel/registry/profiles.ts';
import type { ModelProvider, TurnRequest } from '../../kernel/types.ts';
import { createCliTraceCapture, printRunEvent, printTraceRecord } from '../event-log.ts';

export interface RunOptions {
  profile: string;
  prompt?: string;
  mode?: string;
  search?: boolean;
  map?: boolean;
  provider?: ModelProvider;
  verbose?: boolean;
  trace?: boolean;
  traceDir?: string;
}

export async function runCommand(options: RunOptions): Promise<void> {
  getProfile(options.profile);
  const provider = options.provider;
  if (!provider) {
    console.error(
      '\n\x1b[31mExecution Failed\x1b[0m: Theorum CLI does not create providers or read keys. Run turns from a host app with an explicit ModelProvider.\n',
    );
    return;
  }

  const prompt = options.prompt || 'Hello! Please introduce your capabilities.';
  if (options.search || options.map) {
    const profile = getProfile(options.profile);
    const selected = options.mode
      ? (profile.model.select?.[options.mode] ?? profile.model.allow[0])
      : profile.model.allow[0];
    const builtins = new Set(profile.model.config[selected]?.builtInTools ?? []);
    if (options.search && !builtins.has('googleSearch')) {
      console.error(
        '\n\x1b[31mExecution Failed\x1b[0m: --search requires googleSearch on model.config.*.builtInTools for the selected model.\n',
      );
      return;
    }
    if (options.map && !builtins.has('googleMaps')) {
      console.error(
        '\n\x1b[31mExecution Failed\x1b[0m: --map requires googleMaps on model.config.*.builtInTools for the selected model.\n',
      );
      return;
    }
  }

  const req: TurnRequest = {
    profile: options.profile,
    select: options.mode,
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
