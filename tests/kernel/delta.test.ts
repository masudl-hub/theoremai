import { assertEquals, assertExists } from '@std/assert';
import {
  eventsFromComplete,
  eventsFromDelta,
  eventsFromInteractionSteps,
  extractTokenEvent,
  extractUsageTokens,
  groundingFromEvent,
  mergeCodeExecutionPayload,
  parseStructuredOutput,
} from '../../src/kernel/engine/delta.ts';
import type { GroundingSource } from '../../src/kernel/types.ts';

Deno.test('delta.ts: eventsFromDelta extracts thought, text, image, and fallback', () => {
  // thought
  assertEquals(eventsFromDelta({ type: 'thought', text: 'thinking...' }), [
    { type: 'thought', text: 'thinking...' },
  ]);
  assertEquals(eventsFromDelta({ type: 'thought_summary', content: 'summary thought' }), [
    { type: 'thought', text: 'summary thought' },
  ]);
  assertEquals(eventsFromDelta({ type: 'thought', content: { text: 'nested thought' } }), [
    { type: 'thought', text: 'nested thought' },
  ]);

  // text
  assertEquals(eventsFromDelta({ type: 'text', text: 'hello text' }), [
    { type: 'text', text: 'hello text' },
  ]);
  assertEquals(eventsFromDelta({ type: 'text', text: '' }), []);

  // image
  assertEquals(eventsFromDelta({ type: 'image', mimeType: 'image/png', data: 'abc' }), [
    { type: 'media', media: { mimeType: 'image/png', data: 'abc' } },
  ]);
  assertEquals(eventsFromDelta({ type: 'image', mime_type: 'image/jpeg', data: 'xyz' }), [
    { type: 'media', media: { mimeType: 'image/jpeg', data: 'xyz' } },
  ]);
  assertEquals(eventsFromDelta({ type: 'image', mimeType: 'image/png' }), []);

  // unknown delta
  assertEquals(eventsFromDelta({ type: 'unknown_type' }), []);
  assertEquals(eventsFromDelta(null), []);
});

Deno.test('delta.ts: groundingFromEvent parses web, maps, rendered HTML, and nested step sources', () => {
  const event = {
    interaction: {
      id: 'inter_123',
      grounding_metadata: {
        grounding_chunks: [
          {
            web: { uri: 'https://example.com/docs', title: 'Example Docs' },
          },
          {
            web: { uri: 'https://foo.bar', domain: 'foo.bar' },
          },
          {
            maps: { google_maps_uri: 'https://maps.google.com/?q=cafe', name: 'Cool Cafe' },
          },
          {
            maps: { uri: 'https://maps.google.com/?q=park' },
          },
          null,
        ],
        search_entry_point: {
          rendered_content: '<div>Search widget</div>',
        },
      },
      steps: [
        {
          groundingMetadata: {
            groundingChunks: [
              {
                web: { uri: 'https://example.com/docs' }, // duplicate uri
              },
            ],
          },
          content: [
            {
              groundingMetadata: {
                groundingChunks: [
                  {
                    web: { uri: 'https://substep.org', title: 'Substep' },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };

  const groundingEv = groundingFromEvent(event);
  assertExists(groundingEv);
  assertExists(groundingEv.grounding);
  assertEquals(groundingEv.type, 'grounding');
  assertEquals(groundingEv.grounding.searchHtml, '<div>Search widget</div>');
  assertGroundingSources(groundingEv.grounding.sources);
});

Deno.test('delta.ts: eventsFromDelta wraps code_execution_call as google evidence', () => {
  const events = eventsFromDelta({
    type: 'code_execution_call',
    arguments: { code: 'print(1)', language: 'python' },
  });
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'evidence');
  assertEquals(events[0]?.evidence?.provider, 'google');
  assertEquals(events[0]?.evidence?.kind, 'code_execution_call');
  assertEquals(events[0]?.evidence?.code, 'print(1)');
  assertEquals(events[0]?.evidence?.language, 'python');
  assertEquals(events[0]?.evidence?.raw?.type, 'code_execution_call');
});

Deno.test('delta.ts: groundingFromEvent wraps Interactions google_search_result search_suggestions', () => {
  const chipHtml =
    '<div class="container"><a class="chip" href="https://www.google.com/search?q=photosynthesis">photosynthesis</a></div>';
  const event = {
    event_type: 'step.delta',
    delta: {
      type: 'google_search_result',
      result: [{ search_suggestions: chipHtml }],
      annotations: [
        {
          type: 'url_citation',
          title: 'PubMed review',
          url: 'https://pubmed.example/psii',
        },
        {
          type: 'place_citation',
          name: 'Thylakoid Lab',
          uri: 'https://maps.google.com/?q=lab',
        },
      ],
    },
  };

  const groundingEv = groundingFromEvent(event);
  assertExists(groundingEv);
  assertEquals(groundingEv.type, 'grounding');
  assertEquals(groundingEv.grounding?.searchHtml, chipHtml);
  assertEquals(groundingEv.grounding?.sources.length, 2);
  assertEquals(groundingEv.grounding?.sources[0], {
    type: 'web',
    title: 'PubMed review',
    uri: 'https://pubmed.example/psii',
  });
  assertEquals(groundingEv.grounding?.sources[1], {
    type: 'maps',
    title: 'Thylakoid Lab',
    uri: 'https://maps.google.com/?q=lab',
  });
  // Raw Interactions tool payload is preserved for hosts.
  assertEquals(groundingEv.grounding?.metadata?.type, 'google_search_result');
});

Deno.test('delta.ts: groundingFromEvent reads search_suggestions from step.content blocks', () => {
  const html = '<div class="chip">calvin cycle</div>';
  const groundingEv = groundingFromEvent({
    step: {
      type: 'google_search_result',
      content: [{ searchSuggestions: html }],
    },
  });
  assertExists(groundingEv);
  assertEquals(groundingEv.grounding?.searchHtml, html);
});

function assertGroundingSources(sources: GroundingSource[]): void {
  const [first, second, third, fourth, fifth] = sources;
  assertExists(first);
  assertExists(second);
  assertExists(third);
  assertExists(fourth);
  assertExists(fifth);
  assertEquals(sources.length, 5);
  assertEquals(first.title, 'Example Docs');
  assertEquals(second.title, 'foo.bar');
  assertEquals(third.type, 'maps');
  assertEquals(third.title, 'Cool Cafe');
  assertEquals(fourth.type, 'maps');
  assertEquals(fourth.title, 'https://maps.google.com/?q=park');
  assertEquals(fifth.uri, 'https://substep.org');
}

Deno.test('delta.ts: extractUsageTokens and extractTokenEvent support all token naming variations', () => {
  assertEquals(extractUsageTokens(null), undefined);
  assertEquals(extractUsageTokens({}), undefined);

  const snakeUsage = {
    prompt_tokens: 100,
    completion_tokens: 50,
    thoughts_tokens: 20,
    tool_tokens: 10,
    total_tokens: 180,
  };
  assertEquals(extractUsageTokens(snakeUsage), {
    input: 100,
    output: 50,
    thinking: 20,
    toolUse: 10,
    total: 180,
  });

  const camelUsage = {
    inputTokens: 50,
    outputTokens: 25,
    thinkingTokens: 10,
    toolTokens: 5,
  };
  assertEquals(extractUsageTokens(camelUsage), {
    input: 50,
    output: 25,
    thinking: 10,
    toolUse: 5,
    total: 90,
  });

  assertEquals(
    extractUsageTokens({
      input: 4,
      output: 2,
      intermediate_tokens: 9,
    }),
    { input: 4, output: 2, thinking: 0, toolUse: 0, total: 15, intermediate: 9 },
  );

  const eventWithUsage = {
    interaction: {
      id: 'int_abc',
      usageMetadata: {
        totalInputTokens: 20,
        totalOutputTokens: 10,
      },
    },
  };
  const tokenEvent = extractTokenEvent(eventWithUsage);
  assertEquals(tokenEvent?.type, 'tokens');
  assertEquals(tokenEvent?.tokens?.input, 20);
  assertEquals(tokenEvent?.tokens?.output, 10);
  assertEquals(tokenEvent?.interactionId, 'int_abc');
});

Deno.test('delta.ts: eventsFromComplete parses outputs array, direct output_image, and parseStructuredOutput', () => {
  const completeWithOutputs = {
    interaction: {
      output_text: 'Done here',
      outputs: [{ type: 'other' }, { type: 'image', mimeType: 'image/png', data: 'img_bytes' }],
      usage: { input: 10, output: 20 },
    },
  };
  const events1 = eventsFromComplete(completeWithOutputs, false);
  assertEquals(
    events1.map((e) => e.type),
    ['text', 'media', 'tokens'],
  );

  // Already text emitted -> output_text skipped
  const events2 = eventsFromComplete(completeWithOutputs, true);
  assertEquals(
    events2.map((e) => e.type),
    ['media', 'tokens'],
  );

  // Direct output_image
  const directImageEvent = {
    output_image: { mimeType: 'image/jpeg', data: 'direct_bytes' },
  };
  const events3 = eventsFromComplete(directImageEvent, true);
  assertEquals(events3[0]?.type, 'media');

  // parseStructuredOutput
  assertEquals(parseStructuredOutput('{"status":"ok"}'), {
    ok: true,
    structured: { status: 'ok' },
  });
  assertEquals(parseStructuredOutput('not json'), {
    ok: false,
    error: 'structured output was not valid JSON',
  });
});

Deno.test('delta.ts: eventsFromInteractionSteps replays code execution and model_output images', () => {
  const steps = [
    {
      type: 'code_execution_call',
      id: 'code_call_1',
      arguments: { code: 'print(sum(range(1, 11)))', language: 'python' },
    },
    {
      type: 'code_execution_result',
      call_id: 'code_call_1',
      is_error: false,
      result: '55\n',
    },
    {
      type: 'google_search_result',
      result: [{ search_suggestions: '<div>sum</div>' }],
    },
    {
      type: 'code_execution_call',
      id: 'code_call_2',
      arguments: { code: 'print(1/0)' },
    },
    {
      type: 'code_execution_result',
      call_id: 'code_call_2',
      is_error: true,
      result: 'ZeroDivisionError',
    },
    {
      type: 'model_output',
      content: [
        { type: 'text', text: 'The sum is 55.' },
        { type: 'image', mime_type: 'image/png', data: 'plot_bytes' },
      ],
    },
  ];
  const fromSteps = eventsFromInteractionSteps(steps, false);
  assertEquals(
    fromSteps.map((e) => e.type),
    ['evidence', 'evidence', 'evidence', 'evidence', 'evidence', 'text', 'media'],
  );
  assertEquals(fromSteps[0]?.evidence?.kind, 'code_execution_call');
  assertEquals(fromSteps[0]?.evidence?.code, 'print(sum(range(1, 11)))');
  assertEquals(fromSteps[1]?.evidence?.callId, 'code_call_1');
  assertEquals(fromSteps[1]?.evidence?.result, '55\n');
  assertEquals(fromSteps[2]?.evidence?.kind, 'google_search_result');
  assertEquals(fromSteps[3]?.evidence?.id, 'code_call_2');
  assertEquals(fromSteps[4]?.evidence?.isError, true);
  assertEquals(fromSteps[5]?.text, 'The sum is 55.');
  assertEquals(fromSteps[6]?.media, { mimeType: 'image/png', data: 'plot_bytes' });

  const batched = eventsFromComplete(
    {
      interaction: {
        status: 'completed',
        id: 'v1_code',
        steps,
        output_text: 'ignored because steps already have text',
      },
    },
    false,
  );
  assertEquals(
    batched.some((e) => e.type === 'text' && e.text === 'The sum is 55.'),
    true,
  );
  assertEquals(batched.filter((e) => e.type === 'text').length, 1);
  assertEquals(
    batched.some((e) => e.type === 'done' && e.interactionId === 'v1_code'),
    true,
  );
});

Deno.test('delta.ts: mergeCodeExecutionPayload concatenates partial code and stdout', () => {
  const merged = mergeCodeExecutionPayload(
    { type: 'code_execution_call', arguments: { code: 'print(' } },
    { arguments: { code: '1)', language: 'python' } },
  );
  assertEquals(merged.arguments, { code: 'print(1)', language: 'python' });

  const strings = mergeCodeExecutionPayload(
    { type: 'code_execution_call', arguments: 'pri' },
    { arguments: 'nt(2)' },
  );
  assertEquals(strings.arguments, 'print(2)');

  const withResult = mergeCodeExecutionPayload({ result: '1' }, { result: '1\n' });
  assertEquals(withResult.result, '1\n');
});

Deno.test('delta.ts: eventsFromInteractionSteps skips empty and unknown steps', () => {
  const events = eventsFromInteractionSteps(
    [null, { type: 'thought_signature' }, { type: 'code_execution_call', arguments: 'x = 1' }],
    false,
  );
  assertEquals(
    events.map((e) => e.type),
    ['evidence'],
  );
  assertEquals(events[0]?.evidence?.code, 'x = 1');
});
