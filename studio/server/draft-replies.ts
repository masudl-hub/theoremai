/**
 * How the draft server answers: a run's events as NDJSON, and a failure as JSON, each worded
 * for a visitor.
 *
 * @module
 */
import type { ProfileDefinition, TurnEvent } from '@theoremjs/agents';
import { toErrorEvent, withPublicLabels } from '@theoremjs/agents/guardrails';
import { caughtStatus, clientError, forClient } from '@theoremjs/agents/host';
import { failedDecisionTraces } from '../runtime.ts';

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
} as const;

/**
 * NDJSON response that streams a run's events, each as a visitor may have it. A failure the run didn't turn into an event itself
 * (one thrown before the kernel's turn starts, such as registering the profile or creating its
 * provider) ends the stream as the kernel's own error event, as a visitor may have it: its kind's
 * wording, from the profile's `labels` when it has one, and never the raw detail.
 */
export function ndjsonEventStream(
  source: AsyncIterable<unknown>,
  labels?: ProfileDefinition['labels'],
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of source) {
          const line =
            (event as { type?: string }).type === 'conversation'
              ? event
              : forClient(event as TurnEvent);
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify(forClient(withPublicLabels(toErrorEvent(err), labels)))}\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}

/** A JSON reply the browser never caches. */
export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * The reply for a failure caught before a route had anything to stream: the status of its kind,
 * the wording a visitor may read, from the profile's `labels` when the request carried one, and
 * the traces the failed run left, when it left any.
 */
export function errorJson(err: unknown, labels?: ProfileDefinition['labels']): Response {
  const traces = failedDecisionTraces(err);
  return noStoreJson(
    { ...clientError(err, labels), ...(traces.length > 0 ? { traces } : {}) },
    caughtStatus(err),
  );
}
