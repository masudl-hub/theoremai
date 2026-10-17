import { stdout } from 'node:process';
import type { TurnEvent, TurnEventOf } from '../kernel/turn-events.ts';
import { jsonlSink } from '../observability/jsonl.ts';
import { memorySink } from '../observability/trace.ts';
import { inlineContent, type TraceRecord } from '../observability/trace-record.ts';
import type { TraceSink } from '../observability/trace-sink.ts';

export interface CliEventLogOptions {
  verbose?: boolean;
}

export interface CliTraceCapture {
  sink: TraceSink;
  records: TraceRecord[];
}

function createCliTraceCapture(traceDir?: string): CliTraceCapture {
  const records: TraceRecord[] = [];
  const sinks: TraceSink[] = [memorySink(records)];
  if (traceDir?.trim()) {
    sinks.push(jsonlSink(traceDir.trim()));
  }
  return {
    records,
    sink: {
      write: async (record, context) => {
        for (const sink of sinks) {
          await sink.write(record, context);
        }
      },
    },
  };
}

function printVerboseEvidence(event: TurnEventOf<'evidence'>): void {
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

function printRunEvidence(event: TurnEventOf<'evidence'>, verbose: boolean): void {
  const e = event.evidence;
  if (e.kind === 'code_execution_call') {
    console.log(`\n\x1b[36m🐍 [code_execution_call]\x1b[0m\n${e.code}`);
  } else if (e.kind === 'code_execution_result') {
    console.log(
      `\n\x1b[36m🐍 [code_execution_result]\x1b[0m isError=${String(e.isError)}\n${e.result ?? ''}`,
    );
  } else {
    console.log(`\n\x1b[36m📎 [evidence]\x1b[0m ${e.kind}`);
  }
  if (verbose) {
    printVerboseEvidence(event);
  }
}

function printRunEvent(event: TurnEvent, options: CliEventLogOptions = {}): void {
  const verbose = options.verbose === true;

  if (event.type === 'thought' && event.text) {
    stdout.write(`\x1b[2m${event.text}\x1b[0m`);
  } else if (event.type === 'text' && event.text) {
    stdout.write(event.text);
  } else if (event.type === 'tool' && event.tool.phase === undefined) {
    stdout.write(`\n\x1b[33m⚡ [Tool Call] ${event.tool.name}\x1b[0m: `);
    console.log(event.tool.arguments);
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

function printTestEvidence(event: TurnEventOf<'evidence'>, verbose: boolean): void {
  const e = event.evidence;
  if (e.kind === 'code_execution_call') {
    const preview = e.code.replaceAll('\n', ' ').slice(0, 80);
    console.log(`\n  🐍 [code_execution_call] ${preview || e.id}`);
  } else if (e.kind === 'code_execution_result') {
    const preview = (e.result ?? '').replaceAll('\n', ' ').slice(0, 80);
    console.log(`\n  🐍 [code_execution_result] isError=${String(e.isError)} ${preview}`);
  } else {
    console.log(`\n  📎 [evidence] ${e.kind}`);
  }
  if (verbose) {
    printVerboseEvidence(event);
  }
}

function printTestEvent(event: TurnEvent, options: CliEventLogOptions = {}): void {
  const verbose = options.verbose === true;

  if (event.type === 'thought' && event.text) {
    stdout.write('.');
  } else if (event.type === 'tool' && event.tool.phase === undefined) {
    console.log(
      `\n  ⚡ [Tool Dispatched] ${event.tool.name}(${JSON.stringify(event.tool.arguments)})`,
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

function upstreamRows(record: TraceRecord): unknown[] {
  return record.spans.flatMap((span) =>
    span.events.flatMap((event) =>
      event.name === 'theorem.upstream.row' ? [inlineContent(record, event.attributes.row)] : [],
    ),
  );
}

function printTraceRecord(record: TraceRecord | undefined, verbose: boolean): void {
  if (!record) {
    console.error('\n\x1b[33m[trace]\x1b[0m No trace record captured for this turn.');
    return;
  }

  console.log('\n\x1b[35m════ TRACE RECORD ════\x1b[0m');
  console.log(JSON.stringify(record, null, 2));

  const rows = verbose ? upstreamRows(record) : [];
  if (rows.length > 0) {
    console.log('\n\x1b[35m════ UPSTREAM LOG ════\x1b[0m');
    console.log(JSON.stringify(rows, null, 2));
  }
}

export { createCliTraceCapture, printRunEvent, printTestEvent, printTraceRecord };
