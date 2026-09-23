/**
 * Trace record v3 — spans shaped like OTLP/JSON plus the content they reference.
 *
 * Spans hold content as in-memory markers (`trace-span.ts`). Building a record
 * resolves every marker once, under the profile's scrub and include policy:
 *
 * - `$content` text is scrubbed, hashed, and stored in `content` by hash.
 * - `$bytes` media is hashed over its raw bytes; bytes are never stored. Text
 *   that is not base64 is hashed as text and marked `invalid_base64`.
 * - `$json` rows and wire bodies have media hashed, canaries removed, text
 *   scrubbed, and every string equal to a recorded text replaced by that
 *   text's reference; the JSON is stored by hash and referenced as
 *   `json_sha256`, so a reader knows to parse it.
 *
 * A reference says how to read it: `{ content_sha256 }` names text in
 * `content`, `{ json_sha256 }` names JSON in `content`, and a blob's
 * `content_sha256` (absent from `content`) names bytes that were never stored.
 * `inlineContent` rebuilds any value from its references.
 *
 * Include flags drop whole attribute families or events here, in one place,
 * so a missing field reads as "not recorded" and the root says which policy
 * applied (`theorem.record.include`, `theorem.record.scrub`).
 *
 * @module
 */

import { redactSensitiveOnly, sanitizeText } from '../guardrails/sanitize.ts';
import { sha256, sha256Base64 } from '../kernel/engine/hash.ts';
import { removeCanaries, tapeUpstream } from '../providers/shared/upstream-tape.ts';
import {
  isTraceBytes,
  isTraceContent,
  isTraceJson,
  type TraceAttributes,
  type TraceAttributeValue,
  type TraceSpan,
  type TraceSpanEvent,
} from './trace-span.ts';
import type {
  ResolvedObservabilityPolicy,
  ResolvedTraceInclude,
  ResolvedTraceScrub,
} from './types.ts';

const TRACE_VERSION = 3;
/** Pinned OpenTelemetry GenAI semantic conventions the attribute names follow. */
const TRACE_SCHEMA_URL =
  'https://github.com/open-telemetry/semantic-conventions-genai/tree/8ffdf56';

/** One trace record: a turn, a host-invoked tool, or a Live session root or response. */
interface TraceRecord {
  v: typeof TRACE_VERSION;
  schemaUrl: string;
  /** Host-supplied process attributes (`observability.resource`), e.g. `service.name`. */
  resource: TraceAttributes;
  /** Host-owned metadata from the request, passed through untouched. */
  metadata?: Record<string, unknown>;
  /** Root first, then in start order. */
  spans: TraceSpan[];
  /** sha256 hex → exact scrubbed text; every hash the spans reference. */
  content: Record<string, string>;
}

/** Reference keys: stored text, and stored JSON a reader parses. */
const TEXT_REF = 'content_sha256';
const JSON_REF = 'json_sha256';

/** Attribute and event families each include flag governs. */
const USAGE_PREFIXES = ['gen_ai.usage.', 'theorem.usage.'];
const EVENT_INCLUDE: Record<string, keyof ResolvedTraceInclude> = {
  'theorem.upstream.row': 'upstreamLog',
  'theorem.wire.request': 'outboundWire',
  'theorem.guardrail': 'guardrailDecisions',
};
/** Grounding events keep normalized sources; the provider's raw payload needs `evidenceRaw`. */
const RAW_ATTRIBUTE = 'raw';
/** Guardrail hits keep the matched text only under `guardrailMatchPreview`. */
const MATCH_ATTRIBUTE = 'match';

function scrubStoredText(text: string, scrub: ResolvedTraceScrub): string {
  if (scrub.sensitive && scrub.injection) {
    return sanitizeText(text);
  }
  if (scrub.sensitive) {
    return redactSensitiveOnly(text);
  }
  if (scrub.injection) {
    return sanitizeText(text, { sanitizeInput: true, redactSensitive: false });
  }
  return text;
}

interface Resolver {
  scrub: ResolvedTraceScrub;
  /** Canaries to remove; empty when `scrub.canary` is off. */
  canaries: readonly string[];
  content: Record<string, string>;
  /** Stored text → its hash, for interning rows and bodies. */
  known: Map<string, string>;
}

async function storeText(text: string, resolver: Resolver): Promise<string> {
  const hash = await sha256(text);
  resolver.content[hash] = text;
  resolver.known.set(text, hash);
  return hash;
}

function markerRest(value: Record<string, TraceAttributeValue>, key: string): TraceAttributes {
  const { [key]: _marker, ...rest } = value;
  return rest;
}

/** Pass 1: text and bytes. `$json` waits for pass 2, when every text is known. */
async function resolveContent(
  value: TraceAttributeValue,
  resolver: Resolver,
): Promise<TraceAttributeValue> {
  if (isTraceContent(value)) {
    const text = removeCanaries(scrubStoredText(value.$content, resolver.scrub), resolver.canaries);
    return { ...markerRest(value, '$content'), [TEXT_REF]: await storeText(text, resolver) };
  }
  if (isTraceBytes(value)) {
    const rest = markerRest(value, '$bytes');
    const digest = await sha256Base64(value.$bytes);
    // Not base64: hash the text as given and say so, rather than lose the record.
    return digest
      ? { ...rest, content_sha256: digest.hash, bytes: digest.bytes }
      : { ...rest, invalid_base64: true, text_sha256: await sha256(value.$bytes) };
  }
  if (isTraceJson(value)) {
    return value;
  }
  return await mapNested(value, (nested) => resolveContent(nested, resolver));
}

/** Rewrite every string inside `value` (arrays and objects, recursively). */
function mapStrings(value: unknown, rewrite: (text: string) => unknown): unknown {
  if (typeof value === 'string') {
    return rewrite(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, rewrite));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, mapStrings(nested, rewrite)]),
    );
  }
  return value;
}

/** Scrub a row's strings, then reference any string pass 1 already stored. */
function internRow(row: unknown, resolver: Resolver): unknown {
  return mapStrings(row, (text) => {
    const scrubbed = scrubStoredText(text, resolver.scrub);
    const hash = resolver.known.get(scrubbed);
    return hash ? { [TEXT_REF]: hash } : scrubbed;
  });
}

/** Pass 2: rows and bodies, interned against every text pass 1 stored. */
async function resolveJson(
  value: TraceAttributeValue,
  resolver: Resolver,
): Promise<TraceAttributeValue> {
  if (isTraceJson(value)) {
    const taped = await tapeUpstream(value.$json, resolver.canaries);
    const text = JSON.stringify(internRow(taped, resolver));
    const hash = await sha256(text);
    resolver.content[hash] = text;
    return { ...markerRest(value, '$json'), [JSON_REF]: hash };
  }
  return await mapNested(value, (nested) => resolveJson(nested, resolver));
}

async function mapNested(
  value: TraceAttributeValue,
  map: (nested: TraceAttributeValue) => Promise<TraceAttributeValue>,
): Promise<TraceAttributeValue> {
  if (Array.isArray(value)) {
    return await Promise.all(value.map(map));
  }
  if (value && typeof value === 'object') {
    const pairs = await Promise.all(
      Object.entries(value).map(async ([key, nested]) => [key, await map(nested)] as const),
    );
    return Object.fromEntries(pairs);
  }
  return value;
}

async function resolveAttributes(
  attributes: TraceAttributes,
  resolve: (value: TraceAttributeValue) => Promise<TraceAttributeValue>,
): Promise<TraceAttributes> {
  const pairs = await Promise.all(
    Object.entries(attributes).map(async ([key, value]) => [key, await resolve(value)] as const),
  );
  return Object.fromEntries(pairs);
}

async function resolveSpan(
  span: TraceSpan,
  resolve: (value: TraceAttributeValue) => Promise<TraceAttributeValue>,
): Promise<TraceSpan> {
  const events = await Promise.all(
    span.events.map(async (event) => ({
      ...event,
      attributes: await resolveAttributes(event.attributes, resolve),
    })),
  );
  return { ...span, attributes: await resolveAttributes(span.attributes, resolve), events };
}

function includedAttributes(attributes: TraceAttributes, include: ResolvedTraceInclude) {
  if (include.usage) {
    return attributes;
  }
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !USAGE_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

/** Guardrail hits without the text they matched. */
function withoutMatches(hits: TraceAttributeValue[]): TraceAttributeValue[] {
  return hits.map((hit) => {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) {
      return hit;
    }
    const { [MATCH_ATTRIBUTE]: _match, ...rest } = hit;
    return rest;
  });
}

function includedEvent(
  event: TraceSpanEvent,
  include: ResolvedTraceInclude,
): TraceSpanEvent | undefined {
  const flag = EVENT_INCLUDE[event.name];
  if (flag && !include[flag]) {
    return undefined;
  }
  if (event.name === 'theorem.grounding' && !include.evidenceRaw) {
    const { [RAW_ATTRIBUTE]: _raw, ...rest } = event.attributes;
    return { ...event, attributes: rest };
  }
  const { hits } = event.attributes;
  if (event.name === 'theorem.guardrail' && !include.guardrailMatchPreview && Array.isArray(hits)) {
    return { ...event, attributes: { ...event.attributes, hits: withoutMatches(hits) } };
  }
  return event;
}

function applyInclude(span: TraceSpan, include: ResolvedTraceInclude): TraceSpan {
  return {
    ...span,
    attributes: includedAttributes(span.attributes, include),
    events: span.events.flatMap((event) => includedEvent(event, include) ?? []),
  };
}

function enabledKeys(flags: ResolvedTraceInclude | ResolvedTraceScrub): string[] {
  return Object.entries(flags).flatMap(([key, on]) => (on ? [key] : []));
}

/**
 * Build one record from collected spans (`TraceTree.collect()`), root first.
 * The root gains the policy it was written under.
 */
async function buildRecord(args: {
  spans: TraceSpan[];
  policy: ResolvedObservabilityPolicy;
  /**
   * Every canary bound in this record (the turn's and any nested turn's);
   * removed from stored text when `scrub.canary` is on.
   */
  canaries?: readonly string[];
  metadata?: Record<string, unknown>;
}): Promise<TraceRecord> {
  const { policy } = args;
  const resolver: Resolver = {
    scrub: policy.scrub,
    canaries: policy.scrub.canary ? (args.canaries ?? []) : [],
    content: {},
    known: new Map(),
  };
  const included = args.spans.map((span) => applyInclude(span, policy.include));
  const [root] = included;
  if (root) {
    root.attributes = {
      ...root.attributes,
      'theorem.record.include': enabledKeys(policy.include),
      'theorem.record.scrub': enabledKeys(policy.scrub),
    };
  }
  const texts = await Promise.all(
    included.map((span) => resolveSpan(span, (value) => resolveContent(value, resolver))),
  );
  const spans = await Promise.all(
    texts.map((span) => resolveSpan(span, (value) => resolveJson(value, resolver))),
  );
  return {
    v: TRACE_VERSION,
    schemaUrl: TRACE_SCHEMA_URL,
    resource: { ...policy.resource },
    ...(args.metadata ? { metadata: args.metadata } : {}),
    spans,
    content: resolver.content,
  };
}

/**
 * The stored text a `{ content_sha256 }` or `{ json_sha256 }` reference names;
 * `undefined` for any other value, and for a blob, whose bytes were never stored.
 */
function contentOf(
  record: TraceRecord,
  value: TraceAttributeValue | undefined,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const hash = value[TEXT_REF] ?? value[JSON_REF];
  return typeof hash === 'string' ? record.content[hash] : undefined;
}

/**
 * `value` with every stored reference replaced by what it names, recursively:
 *
 * - `{ content_sha256 }` alone becomes its text; beside other keys (a message
 *   part) it becomes `content`, the semconv name for a part's text.
 * - `{ json_sha256 }` alone becomes its parsed JSON; beside other keys its
 *   object is merged under them. References inside it are rebuilt too.
 * - A reference whose hash is not in `content` (a blob's bytes) is kept as is.
 */
function inlineContent(record: TraceRecord, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => inlineContent(record, item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const fields = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, inlineContent(record, nested)]),
  );
  const { [TEXT_REF]: textHash, [JSON_REF]: jsonHash, ...rest } = fields;
  const text = typeof textHash === 'string' ? record.content[textHash] : undefined;
  if (text !== undefined) {
    return Object.keys(rest).length === 0 ? text : { ...rest, content: text };
  }
  const json = typeof jsonHash === 'string' ? record.content[jsonHash] : undefined;
  if (json === undefined) {
    return fields;
  }
  const parsed = inlineContent(record, JSON.parse(json));
  if (Object.keys(rest).length === 0) {
    return parsed;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...parsed, ...rest }
    : fields;
}

export type { TraceRecord };
export { buildRecord, contentOf, inlineContent, TRACE_SCHEMA_URL };
