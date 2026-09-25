import { assertEquals } from '@std/assert';
import {
  codeExecutionEvidence,
  eventsFromDelta,
  eventsFromInteractionEnd,
  eventsFromModelOutputStep,
  eventsFromThoughtStep,
  extractTokenEvent,
} from '../../../../src/providers/google/interactions/steps.ts';

const BUFFERED_CHIPS = '<div class="container"><a class="chip">chips</a></div>';

// Interactions fixtures follow the shapes recorded from gemini-3.8-flash and
// gemini-3.1-pro-preview (23/09/2026); values are synthetic.
Deno.test('interactions steps: eventsFromDelta reads text, thought summary and media deltas', () => {
  assertEquals(eventsFromDelta({ type: 'text', text: 'hello text' }), [
    { type: 'text', text: 'hello text' },
  ]);
  assertEquals(eventsFromDelta({ type: 'text', text: '' }), []);
  assertEquals(
    eventsFromDelta({ type: 'thought_summary', content: { type: 'text', text: 'weighing it' } }),
    [{ type: 'thought', text: 'weighing it' }],
  );
  assertEquals(eventsFromDelta({ type: 'image', mime_type: 'image/jpeg', data: 'xyz' }), [
    { type: 'media', media: { mimeType: 'image/jpeg', data: 'xyz' } },
  ]);
  assertEquals(eventsFromDelta({ type: 'image', mime_type: 'image/png' }), []);
  assertEquals(eventsFromDelta({ type: 'thought_signature', signature: 'sig' }), []);
  assertEquals(eventsFromDelta(null), []);
});

Deno.test('interactions steps: a streamed audio delta states its sample rate and channels in the mime', () => {
  assertEquals(
    eventsFromDelta({
      type: 'audio',
      mime_type: 'audio/l16',
      sample_rate: 24000,
      channels: 1,
      data: 'pcm',
    }),
    [{ type: 'media', media: { mimeType: 'audio/l16; rate=24000; channels=1', data: 'pcm' } }],
  );
});

Deno.test('interactions steps: a buffered audio block keeps the format its mime already states', () => {
  assertEquals(
    eventsFromModelOutputStep({
      type: 'model_output',
      content: [
        {
          type: 'audio',
          mime_type: 'audio/l16; rate=24000; channels=1',
          sample_rate: 24000,
          channels: 1,
          data: 'pcm',
        },
      ],
    }),
    [{ type: 'media', media: { mimeType: 'audio/l16; rate=24000; channels=1', data: 'pcm' } }],
  );
});

Deno.test('interactions steps: interactions readers ignore field names the wire does not send', () => {
  assertEquals(eventsFromDelta({ type: 'image', mimeType: 'image/png', data: 'abc' }), []);
  assertEquals(eventsFromDelta({ type: 'thought', text: 'thinking' }), []);
  assertEquals(eventsFromDelta({ type: 'thought_summary', content: 'bare string' }), []);
  assertEquals(
    eventsFromModelOutputStep({
      type: 'model_output',
      content: [{ type: 'media', mime_type: 'image/png', data: 'a' }],
    }),
    [],
  );
});

Deno.test('interactions steps: eventsFromThoughtStep reads a buffered thought summary', () => {
  assertEquals(
    eventsFromThoughtStep({
      type: 'thought',
      signature: 'sig',
      summary: [{ type: 'text', text: 'Checking the soil first.' }],
    }),
    [{ type: 'thought', text: 'Checking the soil first.' }],
  );
  assertEquals(eventsFromThoughtStep({ type: 'thought', signature: 'sig' }), []);
});

Deno.test('interactions steps: eventsFromModelOutputStep reads text and image blocks in order', () => {
  assertEquals(
    eventsFromModelOutputStep({
      type: 'model_output',
      content: [
        { type: 'text', text: 'The sum is 55.' },
        { type: 'image', mime_type: 'image/png', data: 'plot_bytes' },
      ],
    }),
    [
      { type: 'text', text: 'The sum is 55.' },
      { type: 'media', media: { mimeType: 'image/png', data: 'plot_bytes' } },
    ],
  );
});

Deno.test('interactions steps: codeExecutionEvidence normalizes whole call and result steps', () => {
  const call = codeExecutionEvidence({
    type: 'code_execution_call',
    id: 'call_1',
    signature: 'sig',
    arguments: { language: 'PYTHON', code: 'print(sum(range(1, 11)))' },
  });
  assertEquals(call.evidence?.kind, 'code_execution_call');
  assertEquals(call.evidence?.id, 'call_1');
  assertEquals(call.evidence?.code, 'print(sum(range(1, 11)))');
  assertEquals(call.evidence?.language, 'PYTHON');
  const result = codeExecutionEvidence({
    type: 'code_execution_result',
    call_id: 'call_1',
    is_error: false,
    result: '55\n',
  });
  assertEquals(result.evidence?.callId, 'call_1');
  assertEquals(result.evidence?.result, '55\n');
  assertEquals(result.evidence?.isError, false);
});

Deno.test('interactions steps: eventsFromInteractionEnd emits grounding from a buffered body steps[]', () => {
  const body = {
    id: 'v1_buffered',
    status: 'completed',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'Who won?' }] },
      { type: 'google_search_call', id: 'call_1', arguments: { queries: ['who won'] } },
      {
        type: 'google_search_result',
        call_id: 'call_1',
        search_type: 'web_search',
        result: [{ search_suggestions: BUFFERED_CHIPS }],
      },
      {
        type: 'model_output',
        content: [
          {
            type: 'text',
            text: 'It was won in 2024.',
            annotations: [
              {
                start_index: 0,
                end_index: 19,
                url: 'https://grounding.example/redirect/a',
                title: 'wikipedia.org',
                type: 'url_citation',
              },
            ],
          },
        ],
      },
    ],
  };
  const grounding = eventsFromInteractionEnd(body).filter((e) => e.type === 'grounding');
  assertEquals(grounding.length, 1);
  assertEquals(grounding[0]?.grounding?.searchHtml, BUFFERED_CHIPS);
  assertEquals(grounding[0]?.grounding?.sources, [
    { type: 'web', title: 'wikipedia.org', uri: 'https://grounding.example/redirect/a' },
  ]);
});

/** The interaction of an `interaction.completed` event around a usage row. */
function completed(usage: Record<string, unknown>) {
  return { id: 'int_abc', status: 'completed', usage };
}

// Counts follow live gemini-3.8-flash probes (22/09/2026), documented fields only.
Deno.test('interactions steps: Interactions usage folds thought into output', () => {
  const event = extractTokenEvent(
    completed({
      total_tokens: 298,
      total_input_tokens: 14,
      total_cached_tokens: 0,
      total_output_tokens: 37,
      total_tool_use_tokens: 0,
      total_thought_tokens: 247,
    }),
  );
  assertEquals(event, {
    type: 'tokens',
    tokens: { input: 14, output: 284, thinking: 247, total: 298 },
    interactionId: 'int_abc',
  });
});

Deno.test('interactions steps: Interactions usage folds tool-use tokens into input', () => {
  const event = extractTokenEvent(
    completed({
      total_tokens: 169,
      total_input_tokens: 18,
      total_cached_tokens: 0,
      total_output_tokens: 67,
      total_tool_use_tokens: 84,
      total_thought_tokens: 0,
    }),
  );
  assertEquals(event?.tokens, { input: 102, output: 67, toolUse: 84, total: 169 });
});

Deno.test('interactions steps: Interactions usage keeps per-modality shares and grounding as reported', () => {
  // Recorded shape (23/09/2026): an image reply lists image output only, so the
  // shares stay partial rather than being filled to the total.
  const event = extractTokenEvent(
    completed({
      total_tokens: 1400,
      total_input_tokens: 20,
      input_tokens_by_modality: [
        { modality: 'text', tokens: 12 },
        { modality: 'image', tokens: 8 },
      ],
      total_cached_tokens: 0,
      total_output_tokens: 1380,
      output_tokens_by_modality: [{ modality: 'image', tokens: 1100 }],
      total_tool_use_tokens: 0,
      total_thought_tokens: 0,
      grounding_tool_count: [{ type: 'google_search', count: 3, search_query_count: 2 }],
    }),
  );
  assertEquals(event?.tokens, {
    input: 20,
    output: 1380,
    total: 1400,
    byModality: { input: { text: 12, image: 8 }, output: { image: 1100 } },
    grounding: [{ type: 'google_search', count: 3, searchQueryCount: 2 }],
  });
});

Deno.test('interactions steps: Interactions cached tokens stay inside input', () => {
  const event = extractTokenEvent(
    completed({
      total_tokens: 7900,
      total_input_tokens: 7899,
      total_cached_tokens: 4079,
      total_output_tokens: 1,
      total_thought_tokens: 0,
    }),
  );
  assertEquals(event?.tokens, { input: 7899, output: 1, cached: 4079, total: 7900 });
});

Deno.test('interactions steps: Interactions converted input reported as 0 is derived from the total', () => {
  // text/md: Google converts the document first and reports input 0.
  const event = extractTokenEvent(
    completed({
      total_tokens: 286,
      total_input_tokens: 0,
      total_cached_tokens: 0,
      total_output_tokens: 2,
      total_tool_use_tokens: 0,
      total_thought_tokens: 0,
    }),
  );
  assertEquals(event?.tokens, { input: 284, output: 2, total: 286 });
});

Deno.test('interactions steps: Interactions usage with no readable input marks input estimated', () => {
  const event = extractTokenEvent(completed({ total_output_tokens: 5 }));
  assertEquals(event?.tokens, { input: 0, output: 5, total: 5, estimated: ['input'] });
});

Deno.test('interactions steps: an interaction without usage has no tokens event', () => {
  assertEquals(extractTokenEvent(completed({})), undefined);
  assertEquals(extractTokenEvent({ id: 'x' }), undefined);
});

Deno.test('interactions steps: eventsFromInteractionEnd emits tokens then a done carrying the status, never the identity', () => {
  const events = eventsFromInteractionEnd({
    id: 'int_tool',
    model: 'gemini-test-flash',
    status: 'requires_action',
    usage: { total_tokens: 5, total_input_tokens: 4, total_output_tokens: 1 },
  });
  assertEquals(events, [
    { type: 'tokens', tokens: { input: 4, output: 1, total: 5 }, interactionId: 'int_tool' },
    {
      type: 'done',
      stop: { kind: 'tool', native: 'requires_action' },
      interactionId: 'int_tool',
    },
  ]);
  assertEquals(eventsFromInteractionEnd({ id: 'int_run', status: 'in_progress' }), [
    {
      type: 'done',
      stop: { kind: 'stream_incomplete', native: 'in_progress' },
      interactionId: 'int_run',
    },
  ]);
});
