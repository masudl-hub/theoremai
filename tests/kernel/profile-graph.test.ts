import '../fixtures/test-host.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { PROFILE_GRAPH, spineFacetsForProfileType } from '../../src/kernel/profile-graph.ts';
import { PROFILE_FIELDS, PROFILE_TYPES } from '../../src/kernel/schema.ts';

/** Top-level PROFILE_FIELDS keys (section / owned scalars). */
function sectionKeys(): string[] {
  return Object.keys(PROFILE_FIELDS).filter((key) => !key.includes('.'));
}

function ownedKeys(): Set<string> {
  const owned = new Set<string>();
  for (const facet of PROFILE_GRAPH) {
    if (!facet.profilePath.includes('.') && !facet.profilePath.includes('*')) {
      owned.add(facet.profilePath);
    }
    for (const key of facet.ownsFields ?? []) {
      owned.add(key);
    }
  }
  return owned;
}

Deno.test('PROFILE_GRAPH ids are unique', () => {
  const ids = PROFILE_GRAPH.map((f) => f.id);
  assertEquals(ids.length, new Set(ids).size);
});

Deno.test('PROFILE_GRAPH profilePaths resolve in PROFILE_FIELDS (or tools.allow)', () => {
  for (const facet of PROFILE_GRAPH) {
    if (facet.profilePath === 'tools.allow') {
      assertEquals(Boolean(PROFILE_FIELDS.tools), true);
      continue;
    }
    if (facet.profilePath === 'models.*') {
      assertEquals(Boolean(PROFILE_FIELDS['models.*']), true);
      continue;
    }
    assertEquals(Boolean(PROFILE_FIELDS[facet.profilePath]), true);
  }
});

Deno.test('every top-level PROFILE_FIELDS key is owned by PROFILE_GRAPH', () => {
  const owned = ownedKeys();
  for (const key of sectionKeys()) {
    assertEquals(owned.has(key), true);
  }
});

Deno.test('PROFILE_GRAPH ownsFields exist in PROFILE_FIELDS', () => {
  for (const facet of PROFILE_GRAPH) {
    for (const key of facet.ownsFields ?? []) {
      assertEquals(Boolean(PROFILE_FIELDS[key]), true);
    }
  }
});

Deno.test('spineFacetsForProfileType includes identity, models, guardrails, observability', () => {
  for (const type of PROFILE_TYPES) {
    const ids = spineFacetsForProfileType(type).map((f) => f.id);
    assertEquals(ids.includes('identity'), true);
    assertEquals(ids.includes('models'), true);
    assertEquals(ids.includes('guardrails'), true);
    assertEquals(ids.includes('observability'), true);
  }
});

Deno.test('speech spine omits tools and inputs; live omits inputs and outputs', () => {
  const speech = spineFacetsForProfileType('speech').map((f) => f.id);
  assertEquals(speech.includes('tools'), false);
  assertEquals(speech.includes('inputs'), false);

  const live = spineFacetsForProfileType('live').map((f) => f.id);
  assertEquals(live.includes('inputs'), false);
  assertEquals(live.includes('outputs'), false);
  assertEquals(live.includes('turnBehaviour'), false);
});

Deno.test('ALL covers PROFILE_TYPES exactly', () => {
  const allFacets = PROFILE_GRAPH.filter((f) => f.id === 'identity' || f.id === 'models');
  for (const facet of allFacets) {
    const sortedFacetTypes = [...facet.profileTypes].sort();
    const sortedProfileTypes = [...PROFILE_TYPES].sort();
    assertEquals(JSON.stringify(sortedFacetTypes), JSON.stringify(sortedProfileTypes));
  }
});

Deno.test('every PROFILE_TYPES member appears in at least one facet profileTypes', () => {
  for (const type of PROFILE_TYPES) {
    const found = PROFILE_GRAPH.some((f) => f.profileTypes.includes(type));
    assertEquals(found, true);
  }
});

Deno.test('PROFILE_GRAPH has no orphan ids (every id appears in at least one profileType)', () => {
  for (const facet of PROFILE_GRAPH) {
    assertEquals(facet.profileTypes.length > 0, true);
  }
});

Deno.test('inputs non-optional for text/image; tools non-optional for text/image/live', () => {
  const inputs = PROFILE_GRAPH.find((f) => f.id === 'inputs');
  assertEquals(inputs?.optional, false);

  const tools = PROFILE_GRAPH.find((f) => f.id === 'tools');
  assertEquals(tools?.optional, false);
});
