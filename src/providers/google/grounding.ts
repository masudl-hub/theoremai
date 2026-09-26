/**
 * Google grounding → `grounding` events (search metadata) and `citation`
 * events (sources), for both Google wires. Interactions and Live share one
 * source shape and one dedupe so hosts parse one shape.
 *
 * @module
 */

import { asRecord, nonEmptyString } from '../../kernel/engine/record.ts';
import type { GroundingEvent, ProviderEvent, Source } from '../../kernel/types.ts';

/*
 * Grounding reads only the shapes recorded from the wire (probes 23/09/2026):
 *
 * - Interactions (`google_search`, `google_maps`): `google_search_result` /
 *   `google_maps_result` steps carry `result[].search_suggestions` (HTML chips)
 *   and `result[].places[]` (`name`, `url`, `place_id`); `model_output` carries
 *   `annotations[]` (`url_citation`: `url`, `title`; `place_citation`: `url`,
 *   `name`, `place_id`). Streams put them on `step.delta`; buffered bodies on
 *   `steps[]` (annotations under `content[]`). Interactions sends no
 *   `grounding_metadata`.
 * - Live (`googleSearch`): `serverContent.groundingMetadata` with
 *   `groundingChunks[].web` (`uri`, `title`) and `searchEntryPoint.renderedContent`.
 *
 * The raw payload always rides on `metadata`, so fields not normalized here
 * (segment offsets, `groundingSupports`, `webSearchQueries`) stay in the trace.
 */

/** What one step or payload grounds: its search metadata and the sources it cites. */
interface Grounded {
  grounding: GroundingEvent;
  sources: Source[];
}

/** A `grounding` event, and a `citation` event when there are sources. */
function groundedEvents(grounded: Grounded | undefined): ProviderEvent[] {
  if (!grounded) return [];
  const { grounding, sources } = grounded;
  return [
    { type: 'grounding', grounding },
    ...(sources.length > 0 ? [{ type: 'citation' as const, sources }] : []),
  ];
}

/** Interactions place (`result[].places[]` entry) → maps source. */
function sourceFromPlace(place: Record<string, unknown>): Source | undefined {
  const uri = nonEmptyString(place.url);
  if (!uri) {
    return undefined;
  }
  const placeId = nonEmptyString(place.place_id);
  return {
    type: 'maps',
    uri,
    title: nonEmptyString(place.name) ?? uri,
    ...(placeId ? { placeId } : {}),
  };
}

/** Normalized maps chunk (`chunks[].maps`) for a maps source. */
function chunkFromMapsSource(source: Source): unknown {
  return {
    maps: {
      title: source.title,
      uri: source.uri,
      ...(source.placeId ? { placeId: source.placeId } : {}),
    },
  };
}

/** Live `groundingChunks[].web` → web source. */
function sourceFromWeb(web: Record<string, unknown>): Source | undefined {
  const uri = nonEmptyString(web.uri);
  if (!uri) {
    return undefined;
  }
  return { type: 'web', uri, title: nonEmptyString(web.title) ?? uri };
}

function pushUniqueSource(sources: Source[], source: Source | undefined): void {
  if (!source) {
    return;
  }
  if (
    sources.some((item) => {
      if (item.type !== source.type) {
        return false;
      }
      if (source.placeId && item.placeId && source.placeId === item.placeId) {
        return true;
      }
      return item.uri === source.uri;
    })
  ) {
    return;
  }
  sources.push(source);
}

/** Dedupe normalized maps chunks by place id, then uri; other chunks append. */
function pushUniqueChunk(chunks: unknown[], chunk: unknown): void {
  const maps = asRecord(asRecord(chunk)?.maps);
  if (!maps) {
    chunks.push(chunk);
    return;
  }
  const placeId = nonEmptyString(maps.placeId);
  const uri = nonEmptyString(maps.uri);
  if (
    chunks.some((existing) => {
      const existingMaps = asRecord(asRecord(existing)?.maps);
      if (!existingMaps) {
        return false;
      }
      const existingId = nonEmptyString(existingMaps.placeId);
      if (placeId && existingId && placeId === existingId) {
        return true;
      }
      return Boolean(uri && nonEmptyString(existingMaps.uri) === uri);
    })
  ) {
    return;
  }
  chunks.push(chunk);
}

/** Interactions `result[].search_suggestions` — the search chips HTML. */
function searchSuggestionsHtml(result: unknown): string | undefined {
  if (!Array.isArray(result)) {
    return undefined;
  }
  for (const entry of result) {
    const html = nonEmptyString(asRecord(entry)?.search_suggestions);
    if (html) {
      return html;
    }
  }
  return undefined;
}

function sourceFromAnnotation(ann: unknown): Source | undefined {
  const record = asRecord(ann);
  const uri = nonEmptyString(record?.url);
  if (!record || !uri) {
    return undefined;
  }
  if (record.type === 'place_citation') {
    const title = nonEmptyString(record.name) ?? uri;
    const placeId = nonEmptyString(record.place_id);
    return { type: 'maps', uri, title, ...(placeId ? { placeId } : {}) };
  }
  if (record.type === 'url_citation') {
    return { type: 'web', uri, title: nonEmptyString(record.title) ?? uri };
  }
  return undefined;
}

function appendAnnotationSources(into: Source[], annotations: unknown): void {
  if (!Array.isArray(annotations)) {
    return;
  }
  for (const ann of annotations) {
    pushUniqueSource(into, sourceFromAnnotation(ann));
  }
}

/** Interactions `result[].places[]` → maps sources (primary places only). */
function appendPlaceSources(into: Source[], result: unknown): void {
  if (!Array.isArray(result)) {
    return;
  }
  for (const entry of result) {
    const places = asRecord(entry)?.places;
    if (!Array.isArray(places)) {
      continue;
    }
    for (const placeValue of places) {
      const place = asRecord(placeValue);
      const source = place ? sourceFromPlace(place) : undefined;
      if (source) {
        pushUniqueSource(into, source);
      }
    }
  }
}

/**
 * Grounding on one Interactions step or `step.delta`: citations, places and
 * search chips. Maps sources also emit normalized `chunks[].maps`
 * (`title` / `uri` / `placeId`) so hosts share one parse shape with Live.
 */
function groundingFromInteractionsStep(step: Record<string, unknown>): Grounded | undefined {
  const sources: Source[] = [];
  appendAnnotationSources(sources, step.annotations);
  if (Array.isArray(step.content)) {
    for (const block of step.content) {
      appendAnnotationSources(sources, asRecord(block)?.annotations);
    }
  }
  appendPlaceSources(sources, step.result);
  const chunks: unknown[] = [];
  for (const source of sources) {
    if (source.type === 'maps') {
      pushUniqueChunk(chunks, chunkFromMapsSource(source));
    }
  }
  const html = searchSuggestionsHtml(step.result);
  if (!html && sources.length === 0) {
    return undefined;
  }
  return {
    grounding: {
      metadata: step,
      ...(chunks.length > 0 ? { chunks } : {}),
      ...(html ? { searchHtml: html } : {}),
    },
    sources,
  };
}

function mergeGrounding(a: Grounded | undefined, b: Grounded | undefined): Grounded | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const chunks: unknown[] = [];
  for (const chunk of [...(a.grounding.chunks ?? []), ...(b.grounding.chunks ?? [])]) {
    pushUniqueChunk(chunks, chunk);
  }
  const sources = [...a.sources];
  for (const source of b.sources) {
    pushUniqueSource(sources, source);
  }
  const searchHtml = b.grounding.searchHtml ?? a.grounding.searchHtml;
  const metadata = b.grounding.metadata ?? a.grounding.metadata;
  return {
    grounding: {
      ...(metadata ? { metadata } : {}),
      ...(chunks.length > 0 ? { chunks } : {}),
      ...(searchHtml ? { searchHtml } : {}),
    },
    sources,
  };
}

/** Grounding on one streamed Interactions `step.delta` payload. */
function groundingFromDelta(event: Record<string, unknown>): ProviderEvent[] {
  const delta = asRecord(event.delta);
  return groundedEvents(delta ? groundingFromInteractionsStep(delta) : undefined);
}

/** Grounding across a completed interaction's `steps[]` (buffered body). */
function groundingFromSteps(steps: unknown[]): ProviderEvent[] {
  let grounded: Grounded | undefined;
  for (const stepValue of steps) {
    const step = asRecord(stepValue);
    if (step) {
      grounded = mergeGrounding(grounded, groundingFromInteractionsStep(step));
    }
  }
  return groundedEvents(grounded);
}

/** Live `serverContent.groundingMetadata` → grounding and citation events (raw kept on `metadata`). */
function groundingFromLiveMetadata(value: unknown): ProviderEvent[] {
  const metadata = asRecord(value);
  if (!metadata) {
    return [];
  }
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
  const sources: Source[] = [];
  for (const chunk of chunks) {
    const web = asRecord(asRecord(chunk)?.web);
    if (web) {
      pushUniqueSource(sources, sourceFromWeb(web));
    }
  }
  const html = nonEmptyString(asRecord(metadata.searchEntryPoint)?.renderedContent);
  return groundedEvents({
    grounding: {
      metadata,
      ...(chunks.length > 0 ? { chunks } : {}),
      ...(html ? { searchHtml: html } : {}),
    },
    sources,
  });
}

export { groundingFromDelta, groundingFromLiveMetadata, groundingFromSteps };
