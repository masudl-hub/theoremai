import { assertEquals } from '@std/assert';
import {
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
  traceSpanMeta,
} from '../../src/observability/trace-catalog.ts';
import type { TraceSpan } from '../../src/observability/trace-span.ts';
import { stubSpan } from '../fixtures/trace-record.ts';

const SRC = new URL('../../src/', import.meta.url);
/** Where the kernel and host record spans; exporters under observability/ translate, not record. */
const EMITTER_ROOTS = ['kernel', 'host'];
const ATTRIBUTE_KEY =
  /'((?:gen_ai|theorem|http|server|url|error|exception)\.[a-z0-9_.]*[a-z0-9_])'/g;
const EVENT_NAME = /\.event\(\s*'([^']+)'/g;

async function emitterSources(): Promise<string[]> {
  const sources: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = new URL(entry.isDirectory ? `${entry.name}/` : entry.name, dir);
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith('.ts')) sources.push(await Deno.readTextFile(path));
    }
  };
  for (const root of EMITTER_ROOTS) await walk(new URL(`${root}/`, SRC));
  return sources;
}

Deno.test('every attribute key and event name the kernel writes has a catalog entry', async () => {
  const sources = await emitterSources();
  const missing = new Set<string>();
  for (const text of sources) {
    for (const [, key = ''] of text.matchAll(ATTRIBUTE_KEY)) {
      // A header prefix (`http.request.header`) names a family: check one member.
      if (!(traceAttributeMeta(key) ?? traceAttributeMeta(`${key}.x`) ?? traceEventMeta(key))) {
        missing.add(key);
      }
    }
    for (const [, name = ''] of text.matchAll(EVENT_NAME)) {
      if (!traceEventMeta(name)) missing.add(`event ${name}`);
    }
  }
  assertEquals(sources.length > 0, true);
  assertEquals([...missing].sort(), []);
});

Deno.test('modality usage and recorded headers are named by their family', () => {
  assertEquals(traceAttributeMeta('gen_ai.usage.audio.input_tokens')?.label, 'Audio input tokens');
  assertEquals(traceAttributeMeta('theorem.usage.video.output_tokens')?.format, 'tokens');
  assertEquals(
    traceAttributeMeta('http.response.header.retry-after')?.label,
    'Response header retry-after',
  );
  assertEquals(traceAttributeMeta('http.request.header.x-goog-api-key')?.group, 'http');
  assertEquals(traceAttributeMeta('gen_ai.usage.audio.total_tokens'), undefined);
  assertEquals(traceAttributeMeta('custom.host.key'), undefined);
});

Deno.test('an event attribute reads its own entry, then the span catalog', () => {
  assertEquals(
    traceEventAttributeMeta('theorem.stage', 'stage')?.options?.pre_tool?.label,
    'Before a tool',
  );
  assertEquals(
    traceEventAttributeMeta('theorem.guardrail', 'stage')?.options?.tool_result?.label,
    'Tool result',
  );
  assertEquals(traceEventAttributeMeta('exception', 'exception.type')?.label, 'Exception');
  assertEquals(traceEventAttributeMeta('theorem.stage', 'nope'), undefined);
});

function span(name: string, attributes: TraceSpan['attributes'], events: string[] = []): TraceSpan {
  return {
    ...stubSpan(),
    name,
    attributes,
    events: events.map((event) => ({ name: event, timeUnixNano: '0', attributes: {} })),
  };
}

Deno.test('a span is named from what it recorded', () => {
  const agent = { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'chat' };
  assertEquals(traceSpanMeta(span('invoke_agent chat', agent)), {
    type: 'turn',
    label: 'Turn',
    doc: 'One exchange: the model calls and tool calls it took to answer.',
    subject: 'chat',
  });
  assertEquals(
    traceSpanMeta(span('invoke_agent chat', agent, ['theorem.session'])).label,
    'Live session',
  );
  const call = { 'gen_ai.operation.name': 'generate_content', 'gen_ai.request.model': 'm-1' };
  assertEquals(traceSpanMeta(span('generate_content m-1', call)).label, 'Model call');
  assertEquals(traceSpanMeta(span('generate_content m-1', call)).subject, 'm-1');
  assertEquals(
    traceSpanMeta(span('generate_content m-1', { ...call, 'theorem.request.live': {} })).label,
    'Live response',
  );
  assertEquals(
    traceSpanMeta(span('chat m-1', { 'gen_ai.operation.name': 'chat' })).label,
    'Model call',
  );
  const tool = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup' };
  assertEquals(traceSpanMeta(span('execute_tool lookup', tool)).subject, 'lookup');
  const post = { 'http.request.method': 'POST', 'url.path': '/v1/x' };
  assertEquals(traceSpanMeta(span('POST', post)), {
    type: 'http',
    label: 'HTTP try',
    doc: 'One HTTP attempt of a model call.',
    subject: '/v1/x',
  });
  assertEquals(traceSpanMeta(span('cutout', {})).label, 'Cutout');
  assertEquals(traceSpanMeta(span('host step', {})), {
    type: 'host',
    label: 'Host span',
    doc: 'A step the host recorded itself.',
    subject: 'host step',
  });
});
