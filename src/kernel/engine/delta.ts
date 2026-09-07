import { turnStopFromInteractionStatus } from '../stop.ts';
import type {
  GroundingEvent,
  GroundingSource,
  ProviderEvidenceEvent,
  TurnEvent,
  TurnTokens,
} from '../types.ts';
import { asRecord } from './record.ts';

function deltaText(delta: Record<string, unknown>): string {
  if (typeof delta.text === 'string') {
    return delta.text;
  }
  const { content } = delta;
  if (typeof content === 'string') {
    return content;
  }
  const nested = asRecord(content);
  if (nested && typeof nested.text === 'string') {
    return nested.text;
  }
  return '';
}

function deltaMedia(delta: Record<string, unknown>): TurnEvent | undefined {
  const mimeType = delta.mimeType ?? delta.mime_type;
  const { data } = delta;
  if (typeof mimeType === 'string' && typeof data === 'string' && data) {
    return { type: 'media', media: { mimeType, data } };
  }
  return undefined;
}

function eventIfText(type: 'thought' | 'text', delta: Record<string, unknown>): TurnEvent[] {
  const text = deltaText(delta);
  if (!text) {
    return [];
  }
  return [{ type, text }];
}

function eventsFromImage(delta: Record<string, unknown>): TurnEvent[] {
  const media = deltaMedia(delta);
  if (media) {
    return [media];
  }
  return [];
}

function eventsFromAudio(delta: Record<string, unknown>): TurnEvent[] {
  const media = deltaMedia(delta);
  if (media) {
    return [media];
  }
  // Google TTS deltas may ship data without a mime; treat as raw PCM.
  const { data } = delta;
  if (typeof data === 'string' && data) {
    return [{ type: 'media', media: { mimeType: 'audio/pcm', data } }];
  }
  return [];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return undefined;
}

function isCodeExecutionType(type: string): boolean {
  return type === 'code_execution_call' || type === 'code_execution_result';
}

function isGoogleBuiltinStepType(type: string): boolean {
  return type.startsWith('google_') || type === 'url_context_call' || type === 'url_context_result';
}

function googleBuiltinEvidence(raw: Record<string, unknown>): TurnEvent {
  const type = String(raw.type ?? '');
  return {
    type: 'evidence',
    evidence: {
      provider: 'google',
      raw,
      ...(type ? { kind: type } : {}),
    },
  };
}

function mergeSandboxString(prev: unknown, next: unknown): string | undefined {
  if (typeof next !== 'string') {
    return typeof prev === 'string' ? prev : undefined;
  }
  if (typeof prev !== 'string' || !prev) {
    return next;
  }
  if (next.startsWith(prev) || prev.endsWith(next)) {
    return next.length >= prev.length ? next : prev;
  }
  return prev + next;
}

function argumentsField(record: Record<string, unknown> | undefined): unknown {
  if (!record) {
    return undefined;
  }
  return record.arguments;
}

function mergedArgObject(
  prevArgs: Record<string, unknown> | undefined,
  incomingArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const language = incomingArgs?.language;
  return {
    ...prevArgs,
    ...incomingArgs,
    code: mergeSandboxString(prevArgs?.code, incomingArgs?.code),
    language: language === undefined ? prevArgs?.language : language,
  };
}

function mergeStringArguments(prev: unknown, next: unknown): unknown {
  if (typeof next === 'string') {
    return mergeSandboxString(prev, next);
  }
  if (typeof prev === 'string') {
    return mergeSandboxString(prev, next);
  }
  if (next !== undefined) {
    return next;
  }
  return prev;
}

function mergeCodeExecutionArguments(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): unknown {
  const prevArgs = asRecord(argumentsField(existing));
  const incomingArgs = asRecord(incoming.arguments);
  if (prevArgs) {
    return mergedArgObject(prevArgs, incomingArgs);
  }
  if (incomingArgs) {
    return mergedArgObject(prevArgs, incomingArgs);
  }
  return mergeStringArguments(argumentsField(existing), incoming.arguments);
}

/** Merge a later code-exec delta/step onto an earlier snapshot (partial code/stdout). */
function mergeCodeExecutionPayload(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing, ...incoming };
  const argumentsValue = mergeCodeExecutionArguments(existing, incoming);
  if (argumentsValue !== undefined) {
    next.arguments = argumentsValue;
  }
  const result = mergeSandboxString(existing?.result, incoming.result);
  if (result !== undefined) {
    next.result = result;
  }
  return next;
}

function codeFromArguments(args: unknown): { code?: string; language?: string } {
  if (typeof args === 'string') {
    return { code: args };
  }
  const rec = asRecord(args);
  if (!rec) {
    return {};
  }
  return {
    ...(typeof rec.code === 'string' ? { code: rec.code } : {}),
    ...(typeof rec.language === 'string' ? { language: rec.language } : {}),
  };
}

function sandboxReportedError(raw: Record<string, unknown>): boolean | undefined {
  if (raw.is_error === undefined && raw.isError === undefined) {
    return undefined;
  }
  return raw.is_error === true || raw.isError === true;
}

function applyCodeExecutionFields(
  evidence: ProviderEvidenceEvent,
  raw: Record<string, unknown>,
): void {
  const type = String(raw.type ?? '');
  if (isCodeExecutionType(type)) {
    evidence.kind = type;
  }
  const fromArgs = codeFromArguments(raw.arguments);
  if (fromArgs.code) {
    evidence.code = fromArgs.code;
  }
  if (fromArgs.language) {
    evidence.language = fromArgs.language;
  }
  if (typeof raw.result === 'string') {
    evidence.result = raw.result;
  }
  const isError = sandboxReportedError(raw);
  if (isError !== undefined) {
    evidence.isError = isError;
  }
  const id = nonEmptyString(raw.id);
  if (id) {
    evidence.id = id;
  }
  const callId = nonEmptyString(raw.call_id ?? raw.callId);
  if (callId) {
    evidence.callId = callId;
  }
}

/** Normalize a Google `code_execution_*` step/delta into an `evidence` event. */
function codeExecutionEvidence(raw: Record<string, unknown>): TurnEvent {
  const evidence: ProviderEvidenceEvent = { provider: 'google', raw };
  applyCodeExecutionFields(evidence, raw);
  return { type: 'evidence', evidence };
}

/** Stable key so streamed deltas and batched `steps[]` do not double-emit. */
function codeExecutionStepKey(raw: Record<string, unknown>, index?: number): string {
  const type = String(raw.type ?? 'code_execution');
  const id = nonEmptyString(raw.id) ?? nonEmptyString(raw.call_id ?? raw.callId);
  if (id) {
    return `${type}:${id}`;
  }
  const fromArgs = codeFromArguments(raw.arguments);
  if (fromArgs.code) {
    return `${type}:code:${fromArgs.code}`;
  }
  if (typeof raw.result === 'string') {
    return `${type}:result:${raw.result}`;
  }
  if (raw.result !== undefined) {
    return `${type}:result:${JSON.stringify(raw.result)}`;
  }
  return `${type}:idx:${String(index ?? '')}`;
}

function eventsFromDelta(deltaValue: unknown): TurnEvent[] {
  const delta = asRecord(deltaValue);
  if (!delta) {
    return [];
  }
  const deltaType = String(delta.type ?? '');
  if (isCodeExecutionType(deltaType)) {
    return [codeExecutionEvidence(delta)];
  }
  if (deltaType === 'thought_summary' || deltaType === 'thought') {
    return eventIfText('thought', delta);
  }
  if (deltaType === 'text') {
    return eventIfText('text', delta);
  }
  if (deltaType === 'image') {
    return eventsFromImage(delta);
  }
  if (deltaType === 'audio' || deltaType === 'output_audio') {
    return eventsFromAudio(delta);
  }
  return [];
}

function mediaFromRecord(rec: Record<string, unknown>): TurnEvent | undefined {
  const mimeType = rec.mimeType ?? rec.mime_type;
  const { data } = rec;
  if (typeof mimeType === 'string' && typeof data === 'string' && data) {
    return { type: 'media', media: { mimeType, data } };
  }
  return undefined;
}

function mediaFromOutputItem(item: unknown): TurnEvent | undefined {
  const rec = asRecord(item);
  if (!rec) {
    return undefined;
  }
  if (rec.type !== 'image' && rec.type !== 'media' && rec.type !== 'audio') {
    return undefined;
  }
  return mediaFromRecord(rec);
}

function mediaEventsFromOutputs(outputs: unknown): TurnEvent[] {
  if (!Array.isArray(outputs)) {
    return [];
  }
  const events: TurnEvent[] = [];
  for (const item of outputs) {
    const media = mediaFromOutputItem(item);
    if (media) {
      events.push(media);
    }
  }
  return events;
}

function mediaEventsFromComplete(event: Record<string, unknown>): TurnEvent[] {
  const interaction = asRecord(event.interaction) ?? event;
  const events: TurnEvent[] = [];
  const directImage = asRecord(interaction.output_image);
  if (directImage) {
    const media = mediaFromRecord(directImage);
    if (media) {
      events.push(media);
    }
  }
  const directAudio = asRecord(interaction.output_audio);
  if (directAudio) {
    const media = mediaFromRecord(directAudio);
    if (media) {
      events.push(media);
    } else {
      const { data } = directAudio;
      if (typeof data === 'string' && data) {
        events.push({ type: 'media', media: { mimeType: 'audio/pcm', data } });
      }
    }
  }
  if (events.length === 0) {
    events.push(...mediaEventsFromOutputs(interaction.outputs));
  }
  return events;
}

function eventsFromModelOutputContent(
  step: Record<string, unknown>,
  alreadyText: boolean,
): TurnEvent[] {
  const events: TurnEvent[] = [];
  const content = step.content;
  if (!Array.isArray(content)) {
    return events;
  }
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) {
      continue;
    }
    const type = String(rec.type ?? '');
    if (type === 'text' && !alreadyText) {
      events.push(...eventIfText('text', rec));
    }
    if (type === 'image' || type === 'media') {
      events.push(...eventsFromImage(rec));
    }
    if (type === 'audio' || type === 'output_audio') {
      events.push(...eventsFromAudio(rec));
    }
  }
  return events;
}

function eventsFromInteractionStep(
  step: Record<string, unknown>,
  sawText: boolean,
): { events: TurnEvent[]; sawText: boolean } {
  const type = String(step.type ?? '');
  if (isCodeExecutionType(type)) {
    return { events: [codeExecutionEvidence(step)], sawText };
  }
  if (isGoogleBuiltinStepType(type)) {
    return { events: [googleBuiltinEvidence(step)], sawText };
  }
  if (type !== 'model_output') {
    return { events: [], sawText };
  }
  const fromOutput = eventsFromModelOutputContent(step, sawText);
  return {
    events: fromOutput,
    sawText: sawText || fromOutput.some((item) => item.type === 'text'),
  };
}

/**
 * Replay a completed Interactions `steps[]` array (non-SSE or stream tail).
 * Emits typed code-execution evidence plus model_output text/media.
 */
function eventsFromInteractionSteps(steps: unknown[], alreadyText: boolean): TurnEvent[] {
  const events: TurnEvent[] = [];
  let sawText = alreadyText;
  for (const stepValue of steps) {
    const step = asRecord(stepValue);
    if (!step) {
      continue;
    }
    const next = eventsFromInteractionStep(step, sawText);
    events.push(...next.events);
    sawText = next.sawText;
  }
  return events;
}

function cleanMapsTitle(title: string): string {
  const suffix = 'google maps';
  const trimmed = title.trimEnd();
  if (trimmed.length < suffix.length) {
    return title.trim();
  }
  if (trimmed.slice(-suffix.length).toLowerCase() !== suffix) {
    return title.trim();
  }
  let end = trimmed.length - suffix.length;
  while (end > 0 && /\s/.test(trimmed[end - 1])) {
    end--;
  }
  if (end > 0 && trimmed[end - 1] === '-') {
    end--;
    while (end > 0 && /\s/.test(trimmed[end - 1])) {
      end--;
    }
  }
  return trimmed.slice(0, end).trimEnd();
}

function isPrimaryMapsPlace(name: string, uri: string): boolean {
  if (/^Review of\b/i.test(name)) {
    return false;
  }
  if (/\/maps\/reviews\//i.test(uri)) {
    return false;
  }
  return true;
}

function placeIdFromRecord(record: Record<string, unknown>): string | undefined {
  return nonEmptyString(record.placeId ?? record.place_id);
}

function sourceFromMaps(maps: Record<string, unknown>): GroundingSource | undefined {
  const uri = maps.uri ?? maps.googleMapsUri ?? maps.google_maps_uri ?? maps.url;
  if (typeof uri !== 'string' || !uri) {
    return undefined;
  }
  const rawTitle = maps.title ?? maps.name;
  const title = typeof rawTitle === 'string' && rawTitle ? cleanMapsTitle(rawTitle) : uri;
  const placeId = placeIdFromRecord(maps);
  return {
    type: 'maps',
    uri,
    title,
    ...(placeId ? { placeId } : {}),
  };
}

/** Classic grounding chunk shape hosts already parse (`chunks[].maps`). */
function chunkFromMapsPlace(place: Record<string, unknown>): unknown | undefined {
  const source = sourceFromMaps(place);
  if (!source || !isPrimaryMapsPlace(source.title, source.uri)) {
    return undefined;
  }
  return {
    maps: {
      title: source.title,
      uri: source.uri,
      ...(source.placeId ? { placeId: source.placeId } : {}),
    },
  };
}

function sourceFromWeb(web: Record<string, unknown>): GroundingSource | undefined {
  const uri = web.uri;
  if (typeof uri !== 'string' || !uri) {
    return undefined;
  }
  const title = web.title ?? web.domain;
  return {
    type: 'web',
    uri,
    title: typeof title === 'string' && title ? title : uri,
  };
}

function pushUniqueSource(sources: GroundingSource[], source: GroundingSource | undefined): void {
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

function groundingChunks(metadata: Record<string, unknown>): unknown[] {
  const chunks = metadata.groundingChunks ?? metadata.grounding_chunks;
  if (Array.isArray(chunks)) {
    return chunks;
  }
  return [];
}

function searchHtml(metadata: Record<string, unknown>): string | undefined {
  const searchEntryPoint = asRecord(metadata.searchEntryPoint ?? metadata.search_entry_point);
  const renderedContent = searchEntryPoint?.renderedContent ?? searchEntryPoint?.rendered_content;
  if (typeof renderedContent === 'string' && renderedContent.trim()) {
    return renderedContent;
  }
  return undefined;
}

function searchSuggestionsFromRecord(record: Record<string, unknown>): string | undefined {
  return nonEmptyString(record.search_suggestions ?? record.searchSuggestions);
}

function firstSearchSuggestions(items: unknown): string | undefined {
  if (!Array.isArray(items)) {
    return undefined;
  }
  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const html = searchSuggestionsFromRecord(record);
    if (html) {
      return html;
    }
  }
  return undefined;
}

/** Interactions streams search chips as `search_suggestions` HTML, not classic entry points. */
function searchSuggestionsHtml(step: Record<string, unknown>): string | undefined {
  return (
    searchSuggestionsFromRecord(step) ??
    firstSearchSuggestions(step.result) ??
    firstSearchSuggestions(step.content)
  );
}

function sourceFromAnnotation(ann: unknown): GroundingSource | undefined {
  const record = asRecord(ann);
  if (!record) {
    return undefined;
  }
  const uri = nonEmptyString(record.url ?? record.uri);
  if (!uri) {
    return undefined;
  }
  const kind = String(record.type ?? '');
  const rawTitle = nonEmptyString(record.title ?? record.name) ?? uri;
  if (kind === 'place_citation') {
    const title = cleanMapsTitle(rawTitle);
    if (!isPrimaryMapsPlace(title, uri)) {
      return undefined;
    }
    const placeId = placeIdFromRecord(record);
    return {
      type: 'maps',
      uri,
      title,
      ...(placeId ? { placeId } : {}),
    };
  }
  if (kind === 'url_citation' || kind === 'citation' || !kind) {
    return { type: 'web', uri, title: rawTitle };
  }
  return undefined;
}

function pushUniqueChunk(chunks: unknown[], chunk: unknown): void {
  const maps = asRecord(asRecord(chunk)?.maps);
  if (!maps) {
    chunks.push(chunk);
    return;
  }
  const placeId = placeIdFromRecord(maps);
  const uri = nonEmptyString(maps.uri ?? maps.url);
  if (
    chunks.some((existing) => {
      const existingMaps = asRecord(asRecord(existing)?.maps);
      if (!existingMaps) {
        return false;
      }
      const existingId = placeIdFromRecord(existingMaps);
      if (placeId && existingId && placeId === existingId) {
        return true;
      }
      return Boolean(uri && nonEmptyString(existingMaps.uri ?? existingMaps.url) === uri);
    })
  ) {
    return;
  }
  chunks.push(chunk);
}

/** Interactions `google_maps_result.result[].places[]` — not classic groundingChunks. */
function chunksAndSourcesFromMapsResult(result: unknown): {
  chunks: unknown[];
  sources: GroundingSource[];
} {
  const chunks: unknown[] = [];
  const sources: GroundingSource[] = [];
  if (!Array.isArray(result)) {
    return { chunks, sources };
  }
  for (const entry of result) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const places = record.places;
    if (!Array.isArray(places)) {
      continue;
    }
    for (const placeValue of places) {
      const place = asRecord(placeValue);
      if (!place) {
        continue;
      }
      const chunk = chunkFromMapsPlace(place);
      if (!chunk) {
        continue;
      }
      pushUniqueChunk(chunks, chunk);
      pushUniqueSource(sources, sourceFromMaps(place));
    }
  }
  return { chunks, sources };
}

function appendAnnotationSources(into: GroundingSource[], annotations: unknown): void {
  for (const source of sourcesFromAnnotations(annotations)) {
    pushUniqueSource(into, source);
  }
}

function sourcesFromAnnotations(annotations: unknown): GroundingSource[] {
  if (!Array.isArray(annotations)) {
    return [];
  }
  const sources: GroundingSource[] = [];
  for (const ann of annotations) {
    pushUniqueSource(sources, sourceFromAnnotation(ann));
  }
  return sources;
}

/**
 * Wrap Interactions tool-result steps (google_search_result, maps, etc.) into grounding.
 * Preserves the raw step on `metadata` so hosts can inspect everything Gemini returned.
 *
 * Maps places arrive as `google_maps_result.result[].places[]` and as
 * `place_citation` annotations on model_output content — not classic
 * `grounding_metadata.groundingChunks`. Emit both `sources` and `chunks`
 * (`chunks[].maps`) so hosts share one parse shape.
 */
function groundingFromInteractionsTool(step: Record<string, unknown>): GroundingEvent | undefined {
  const sources: GroundingSource[] = [];
  const chunks: unknown[] = [];

  appendAnnotationSources(sources, step.annotations);
  if (Array.isArray(step.content)) {
    for (const block of step.content) {
      const record = asRecord(block);
      if (record) {
        appendAnnotationSources(sources, record.annotations);
      }
    }
  }
  for (const source of sources) {
    if (source.type !== 'maps') {
      continue;
    }
    pushUniqueChunk(chunks, {
      maps: {
        title: source.title,
        uri: source.uri,
        ...(source.placeId ? { placeId: source.placeId } : {}),
      },
    });
  }

  const fromMapsResult = chunksAndSourcesFromMapsResult(step.result);
  for (const chunk of fromMapsResult.chunks) {
    pushUniqueChunk(chunks, chunk);
  }
  for (const source of fromMapsResult.sources) {
    pushUniqueSource(sources, source);
  }

  const html = searchSuggestionsHtml(step);
  if (!html && sources.length === 0 && chunks.length === 0) {
    return undefined;
  }
  return {
    metadata: step,
    ...(chunks.length > 0 ? { chunks } : {}),
    ...(html ? { searchHtml: html } : {}),
    sources,
  };
}

function sourcesFromChunks(chunks: unknown[]): GroundingSource[] {
  const sources: GroundingSource[] = [];
  for (const chunk of chunks) {
    const record = asRecord(chunk);
    if (!record) {
      continue;
    }
    const maps = asRecord(record.maps);
    if (maps) {
      pushUniqueSource(sources, sourceFromMaps(maps));
    }
    const web = asRecord(record.web);
    if (web) {
      pushUniqueSource(sources, sourceFromWeb(web));
    }
  }
  return sources;
}

function mergeGrounding(
  a: GroundingEvent | undefined,
  b: GroundingEvent | undefined,
): GroundingEvent | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const chunks: unknown[] = [];
  for (const chunk of [...(a.chunks ?? []), ...(b.chunks ?? [])]) {
    pushUniqueChunk(chunks, chunk);
  }
  const sources = [...a.sources];
  for (const source of b.sources) {
    pushUniqueSource(sources, source);
  }
  return {
    metadata: b.metadata ?? a.metadata,
    ...(chunks.length > 0 ? { chunks } : {}),
    searchHtml: b.searchHtml ?? a.searchHtml,
    sources,
  };
}

function groundingFromMetadata(metadataValue: unknown): GroundingEvent | undefined {
  const metadata = asRecord(metadataValue);
  if (!metadata) {
    return undefined;
  }
  const chunks = groundingChunks(metadata);
  const sources = sourcesFromChunks(chunks);
  const html = searchHtml(metadata);
  if (chunks.length === 0 && sources.length === 0 && !html) {
    return { metadata, sources };
  }
  return {
    metadata,
    ...(chunks.length > 0 ? { chunks } : {}),
    ...(html ? { searchHtml: html } : {}),
    sources,
  };
}

function groundingMetadataFromRecord(record: Record<string, unknown>): unknown {
  return record.groundingMetadata ?? record.grounding_metadata;
}

function groundingFromStep(stepValue: unknown): GroundingEvent | undefined {
  const step = asRecord(stepValue);
  if (!step) {
    return undefined;
  }
  let grounding = groundingFromMetadata(groundingMetadataFromRecord(step));
  const content = step.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      grounding = mergeGrounding(
        grounding,
        groundingFromMetadata(groundingMetadataFromRecord(asRecord(block) ?? {})),
      );
    }
  }
  // Interactions search/maps tool results: chips + citations live on the step/delta itself.
  grounding = mergeGrounding(grounding, groundingFromInteractionsTool(step));
  return grounding;
}

function groundingFromEvent(event: Record<string, unknown>): TurnEvent | undefined {
  let grounding = groundingFromMetadata(groundingMetadataFromRecord(event));
  grounding = mergeGrounding(grounding, groundingFromStep(event.step));
  grounding = mergeGrounding(grounding, groundingFromStep(event.delta));
  const interaction = asRecord(event.interaction);
  if (interaction) {
    grounding = mergeGrounding(
      grounding,
      groundingFromMetadata(groundingMetadataFromRecord(interaction)),
    );
  }
  const steps = interaction?.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      grounding = mergeGrounding(grounding, groundingFromStep(step));
    }
  }
  if (!grounding) {
    return undefined;
  }
  return { type: 'grounding', grounding };
}

const INPUT_KEYS = [
  'total_input_tokens',
  'totalInputTokens',
  'prompt_token_count',
  'promptTokenCount',
  'prompt_tokens',
  'input_tokens',
  'inputTokens',
  'input',
] as const;

const OUTPUT_KEYS = [
  'total_output_tokens',
  'totalOutputTokens',
  'candidates_token_count',
  'candidatesTokenCount',
  'candidates_tokens',
  'completion_tokens',
  'output_tokens',
  'outputTokens',
  'output',
] as const;

const THINKING_KEYS = [
  'total_thought_tokens',
  'totalThoughtTokens',
  'thoughts_token_count',
  'thoughtsTokenCount',
  'thoughts_tokens',
  'thinking_tokens',
  'thinkingTokens',
  'thinking',
] as const;

const TOOL_KEYS = [
  'total_tool_use_tokens',
  'totalToolUseTokens',
  'tool_use_token_count',
  'toolUseTokenCount',
  'tool_tokens',
  'toolTokens',
  'toolUse',
] as const;

const INTERMEDIATE_KEYS = [
  'total_intermediate_tokens',
  'totalIntermediateTokens',
  'intermediate_tokens',
  'intermediateTokens',
  'intermediate',
] as const;

const TOTAL_KEYS = [
  'total_tokens',
  'totalTokens',
  'total_token_count',
  'totalTokenCount',
  'total',
] as const;

function pickNumericField(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const val = record[key];
    if (val !== undefined && val !== null) {
      const n = Number(val);
      if (!Number.isNaN(n)) {
        return n;
      }
    }
  }
  return 0;
}

function extractUsageTokens(raw: unknown): TurnTokens | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const input = pickNumericField(r, INPUT_KEYS);
  const output = pickNumericField(r, OUTPUT_KEYS);
  const thinking = pickNumericField(r, THINKING_KEYS);
  const toolUse = pickNumericField(r, TOOL_KEYS);
  const intermediate = pickNumericField(r, INTERMEDIATE_KEYS);
  const total =
    pickNumericField(r, TOTAL_KEYS) || input + output + thinking + toolUse + intermediate;
  if (input > 0 || output > 0 || thinking > 0 || toolUse > 0 || intermediate > 0 || total > 0) {
    return {
      input,
      output,
      thinking,
      toolUse,
      total,
      ...(intermediate > 0 ? { intermediate } : {}),
    };
  }
  return undefined;
}

const USAGE_KEYS = ['usage', 'usage_metadata', 'usageMetadata'] as const;

function findUsageObject(target: Record<string, unknown>, event: Record<string, unknown>): unknown {
  for (const key of USAGE_KEYS) {
    if (target[key]) return target[key];
  }
  for (const key of USAGE_KEYS) {
    if (event[key]) return event[key];
  }
  return undefined;
}

function extractTokenEvent(
  event: Record<string, unknown>,
  interaction?: Record<string, unknown>,
): TurnEvent | undefined {
  const target = interaction ?? asRecord(event.interaction) ?? event;
  const usage = extractUsageTokens(findUsageObject(target, event));
  const interactionId = typeof target.id === 'string' ? target.id : undefined;
  if (!usage) {
    return undefined;
  }
  return {
    type: 'tokens',
    tokens: usage,
    ...(interactionId ? { interactionId } : {}),
  };
}

function eventsFromComplete(event: Record<string, unknown>, alreadyText: boolean): TurnEvent[] {
  const interaction = asRecord(event.interaction) ?? event;
  const events: TurnEvent[] = [];
  let sawText = alreadyText;
  const steps = interaction.steps;
  if (Array.isArray(steps)) {
    const fromSteps = eventsFromInteractionSteps(steps, sawText);
    events.push(...fromSteps);
    if (fromSteps.some((item) => item.type === 'text')) {
      sawText = true;
    }
  }
  const outputText = interaction.output_text;
  if (!sawText && typeof outputText === 'string' && outputText) {
    events.push({ type: 'text', text: outputText });
    sawText = true;
  }
  if (!events.some((item) => item.type === 'media')) {
    events.push(...mediaEventsFromComplete(event));
  }
  const tokenEvent = extractTokenEvent(event, interaction);
  if (tokenEvent) events.push(tokenEvent);
  const groundingEvent = groundingFromEvent(event);
  if (groundingEvent) events.push(groundingEvent);
  const done = doneFromInteractionStatus(interaction, event);
  if (done) events.push(done);
  return events;
}

const TERMINAL_INTERACTION_STATUSES = new Set([
  'completed',
  'incomplete',
  'budget_exceeded',
  'failed',
  'cancelled',
  'requires_action',
]);

function doneFromInteractionStatus(
  interaction: Record<string, unknown>,
  event: Record<string, unknown>,
): TurnEvent | undefined {
  const status =
    typeof interaction.status === 'string'
      ? interaction.status
      : typeof event.status === 'string'
        ? event.status
        : undefined;
  if (!status || !TERMINAL_INTERACTION_STATUSES.has(status.toLowerCase())) return undefined;
  return {
    type: 'done',
    stop: turnStopFromInteractionStatus(status),
    ...(typeof interaction.id === 'string' ? { interactionId: interaction.id } : {}),
  };
}

export type ParsedStructuredOutput =
  | { ok: true; structured: unknown }
  | { ok: false; error: string };

/** Parse model text as structured JSON. Invalid JSON is a hard failure — never silent skip. */
function parseStructuredOutput(text: string): ParsedStructuredOutput {
  try {
    return { ok: true, structured: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'structured output was not valid JSON' };
  }
}

export {
  codeExecutionEvidence,
  codeExecutionStepKey,
  eventsFromComplete,
  eventsFromDelta,
  eventsFromInteractionSteps,
  extractTokenEvent,
  extractUsageTokens,
  googleBuiltinEvidence,
  groundingFromEvent,
  isCodeExecutionType,
  isGoogleBuiltinStepType,
  mergeCodeExecutionPayload,
  parseStructuredOutput,
};
