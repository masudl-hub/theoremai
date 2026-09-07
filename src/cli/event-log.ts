/**
 * Shared CLI turn-event printing and trace capture for `run` and `test`.
 *
 * @module
 */

import type { TurnEvent } from '../kernel/types.ts';
import { jsonlSink, memorySink, type TraceSink } from '../observability/trace.ts';
import type { TraceRecord } from '../observability/trace-record.ts';

export interface CliEventLogOptions {
  verbose?: boolean;
}

export interface CliTraceCapture {
  sink: TraceSink;
  records: TraceRecord[];
}

/** Attach an in-memory trace sink; optionally mirror to a JSONL directory. */
function createCliTraceCapture(traceDir?: string): CliTraceCapture {
  const records: TraceRecord[] = [];
  const sinks: TraceSink[] = [memorySink(records)];
  if (traceDir?.trim()) {
    sinks.push(jsonlSink(traceDir.trim()));
  }
  return {
    records,
    sink: {
      write: async (record) => {
        for (const sink of sinks) {
          await sink.write(record);
        }
      },
    },
  };
}

function printVerboseEvidence(event: TurnEvent): void {
  if (event.type !== 'evidence' || !event.evidence) {
    return;
  }
  const e = event.evidence;
  if (e.raw) {
    console.log('\n\x1b[2m[verbose evidence.raw]\x1b[0m');
    console.log(JSON.stringify(e.raw, null, 2));
  }
}

function printVerboseError(event: TurnEvent): void {
  if (event.type !== 'error' || !event.errorInternal) {
    return;
  }
  console.error(`\n\x1b[2m[verbose errorInternal]\x1b[0m ${event.errorInternal}`);
}

function printRunEvidence(event: TurnEvent, verbose: boolean): void {
  const e = event.evidence;
  if (!e) {
    return;
  }
  if (e.kind === 'code_execution_call') {
    console.log(`\n\x1b[36m🐍 [code_execution_call]\x1b[0m\n${e.code ?? ''}`);
  } else if (e.kind === 'code_execution_result') {
    console.log(
      `\n\x1b[36m🐍 [code_execution_result]\x1b[0m isError=${String(e.isError)}\n${e.result ?? ''}`,
    );
  } else if (e.kind) {
    console.log(`\n\x1b[36m📎 [evidence]\x1b[0m ${e.kind}`);
  }
  if (verbose) {
    printVerboseEvidence(event);
  }
}

/** Print one turn event for `theorum run`. */
function printRunEvent(event: TurnEvent, options: CliEventLogOptions = {}): void {
  const verbose = options.verbose === true;

  if (event.type === 'thought' && event.text) {
    Deno.stdout.write(new TextEncoder().encode(`\x1b[2m${event.text}\x1b[0m`));
  } else if (event.type === 'text' && event.text) {
    Deno.stdout.write(new TextEncoder().encode(event.text));
  } else if (event.type === 'tool' && event.tool) {
    console.log(`\n\x1b[33m⚡ [Tool Call] ${event.tool.name}\x1b[0m:`, event.tool.arguments);
  } else if (event.type === 'evidence') {
    printRunEvidence(event, verbose);
  } else if (event.type === 'structured' && event.structured) {
    console.log('\n\x1b[32m✓ [Structured Output]\x1b[0m:');
    console.log(JSON.stringify(event.structured, null, 2));
  } else if (event.type === 'media' && event.media) {
    console.log(`\n\x1b[34m🖼 [Media Output]\x1b[0m (${event.media.mimeType})`);
  } else if (event.type === 'error' && event.error) {
    console.error(`\n\x1b[31m✗ Error\x1b[0m: ${event.error}`);
    if (verbose) {
      printVerboseError(event);
    }
  }
}

function printTestEvidence(event: TurnEvent, verbose: boolean): void {
  const e = event.evidence;
  if (!e) {
    return;
  }
  if (e.kind === 'code_execution_call') {
    const preview = (e.code ?? '').replaceAll('\n', ' ').slice(0, 80);
    console.log(`\n  🐍 [code_execution_call] ${preview || e.id || ''}`);
  } else if (e.kind === 'code_execution_result') {
    const preview = (e.result ?? '').replaceAll('\n', ' ').slice(0, 80);
    console.log(`\n  🐍 [code_execution_result] isError=${String(e.isError)} ${preview}`);
  } else if (e.kind) {
    console.log(`\n  📎 [evidence] ${e.kind}`);
  }
  if (verbose) {
    printVerboseEvidence(event);
  }
}

/** Print one turn event for `theorum test`. */
function printTestEvent(event: TurnEvent, options: CliEventLogOptions = {}): void {
  const verbose = options.verbose === true;

  if (event.type === 'thought' && event.text) {
    Deno.stdout.write(new TextEncoder().encode('.'));
  } else if (event.type === 'tool' && event.tool) {
    console.log(
      `\n  ⚡ [Tool Dispatched] ${event.tool.name}(${JSON.stringify(event.tool.arguments ?? {})})`,
    );
  } else if (event.type === 'evidence') {
    printTestEvidence(event, verbose);
  } else if (event.type === 'structured') {
    console.log('\n  ✓ [Structured Schema Validated]');
  } else if (event.type === 'media') {
    console.log(`\n  ✓ [Media Generated] (${event.media?.mimeType})`);
  } else if (event.type === 'error' && event.error) {
    console.error(`\n  [Test Error Detail]: ${event.error}`);
    if (verbose) {
      printVerboseError(event);
    }
  }
}

/** Dump the last captured trace record after a CLI turn. */
function printTraceRecord(record: TraceRecord | undefined, verbose: boolean): void {
  if (!record) {
    console.error('\n\x1b[33m[trace]\x1b[0m No trace record captured for this turn.');
    return;
  }

  console.log('\n\x1b[35m════ TRACE RECORD ════\x1b[0m');
  console.log(JSON.stringify(record, null, 2));

  if (verbose && record.upstreamLog) {
    console.log('\n\x1b[35m════ UPSTREAM LOG ════\x1b[0m');
    console.log(JSON.stringify(record.upstreamLog, null, 2));
  }
}

export { createCliTraceCapture, printRunEvent, printTestEvent, printTraceRecord };
