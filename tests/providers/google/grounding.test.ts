import { assertEquals, assertExists } from '@std/assert';
import {
  groundingFromDelta,
  groundingFromLiveMetadata,
} from '../../../src/providers/google/grounding.ts';

// Grounding fixtures follow the shapes recorded from gemini-3.8-flash (Interactions)
// and gemini-3.1-flash-live-preview (Live) on 23/09/2026; values are synthetic.
const CHIP_HTML =
  '<div class="container"><a class="chip" href="https://www.google.com/search?q=photosynthesis">photosynthesis</a></div>';

Deno.test('google grounding: groundingFromDelta reads search chips from a google_search_result delta', () => {
  const groundingEv = groundingFromDelta({
    event_type: 'step.delta',
    index: 1,
    delta: { type: 'google_search_result', result: [{ search_suggestions: CHIP_HTML }] },
  });
  assertExists(groundingEv);
  assertEquals(groundingEv.grounding?.searchHtml, CHIP_HTML);
  assertEquals(groundingEv.grounding?.sources, []);
  // Raw Interactions payload is preserved for hosts.
  assertEquals(groundingEv.grounding?.metadata?.type, 'google_search_result');
});

Deno.test('google grounding: groundingFromDelta reads url and place citations from a model_output delta', () => {
  const groundingEv = groundingFromDelta({
    event_type: 'step.delta',
    index: 3,
    delta: {
      annotations: [
        {
          start_index: 0,
          end_index: 42,
          url: 'https://grounding.example/redirect/a',
          title: 'pubmed.example',
          type: 'url_citation',
        },
        {
          start_index: 43,
          end_index: 90,
          place_id: 'ChIJ_lab',
          name: 'Thylakoid Lab - Google Maps',
          url: 'https://maps.google.com/maps?cid=1',
          type: 'place_citation',
        },
      ],
    },
  });
  assertExists(groundingEv);
  assertEquals(groundingEv.grounding?.sources, [
    { type: 'web', title: 'pubmed.example', uri: 'https://grounding.example/redirect/a' },
    {
      type: 'maps',
      title: 'Thylakoid Lab',
      uri: 'https://maps.google.com/maps?cid=1',
      placeId: 'ChIJ_lab',
    },
  ]);
  assertEquals(groundingEv.grounding?.chunks, [
    {
      maps: {
        title: 'Thylakoid Lab',
        uri: 'https://maps.google.com/maps?cid=1',
        placeId: 'ChIJ_lab',
      },
    },
  ]);
});

Deno.test('google grounding: grounding ignores field names the wire does not send', () => {
  assertEquals(
    groundingFromDelta({
      grounding_metadata: { grounding_chunks: [{ web: { uri: 'https://example.com' } }] },
      delta: {
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com' } }] },
        searchSuggestions: '<div>chip</div>',
        annotations: [{ type: 'place_citation', name: 'Cafe', uri: 'https://maps.example/cafe' }],
        result: [{ places: [{ googleMapsUri: 'https://maps.example/park', title: 'Park' }] }],
      },
    }),
    undefined,
  );
});

Deno.test('google grounding: groundingFromLiveMetadata normalizes Live groundingMetadata', () => {
  const metadata = {
    groundingChunks: [
      { web: { uri: 'https://grounding.example/redirect/a', title: 'rhs.org.uk' } },
      { web: { uri: 'https://grounding.example/redirect/a', title: 'rhs.org.uk' } },
    ],
    groundingSupports: [
      { groundingChunkIndices: [0], segment: { endIndex: 20, text: 'It was won in 2024.' } },
    ],
    searchEntryPoint: { renderedContent: CHIP_HTML },
    webSearchQueries: ['who won'],
  };
  const groundingEv = groundingFromLiveMetadata(metadata);
  assertEquals(groundingEv, {
    type: 'grounding',
    grounding: {
      metadata,
      chunks: metadata.groundingChunks,
      searchHtml: CHIP_HTML,
      sources: [{ type: 'web', uri: 'https://grounding.example/redirect/a', title: 'rhs.org.uk' }],
    },
  });
  assertEquals(groundingFromLiveMetadata(undefined), undefined);
});
