import { resolveObservabilityPolicy } from '@theoremjs/agents';
import type { TraceFeed } from '@theoremjs/react/client';
import type { StudioRunPayload } from '../../mod.ts';
import { actingAsHeaders, type StudioActingAs } from '../../people.ts';
import { eachLine, NDJSON } from '../../stream-lines.ts';
import { studioTraceLine } from '../../transport.ts';

/** Whether the agent records traces, so the page can offer them: the rule every view reads. */
export function recordsTraces(payload: StudioRunPayload | null): boolean {
	return payload !== null && resolveObservabilityPolicy(payload.profile.observability).record;
}

/** The trace record a line of a run's stream carries, or nothing when it is one of the run's events. */
function traceOf(line: string) {
	if (!line.includes('"trace"')) return undefined;
	try {
		const read = studioTraceLine.safeParse(JSON.parse(line));
		return read.success ? read.data.record : undefined;
	} catch {
		return undefined;
	}
}

/** Takes the trace lines off a run's stream and puts their records on the feed. */
function withoutTraces(traces: TraceFeed): TransformStream<Uint8Array, Uint8Array> {
	return eachLine((line, send) => {
		const record = traceOf(line);
		if (record) traces.push(record);
		else send(line);
	});
}

/** `fetch` for a project's runs: the studio's local server sends each run's trace behind its events. */
function tracedFetch(traces: TraceFeed): typeof fetch {
	return async (input, init) => {
		const response = await fetch(input, init);
		if (!response.body || !response.headers.get('content-type')?.startsWith(NDJSON)) return response;
		return new Response(response.body.pipeThrough(withoutTraces(traces)), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

/**
 * A transport to one of a project's profiles whose runs' traces land on `traces`, where the
 * trace panel reads them: the same panel a draft's run fills in the playground. Each run carries
 * who it acts as, so the project's tools act for that person.
 */
export function tracedTransport<T extends object>(
	make: (options: { endpoint: string; fetch: typeof fetch; headers: Record<string, string> }) => T,
	endpoint: string,
	traces: TraceFeed,
	actingAs: StudioActingAs | undefined,
): T & { traces: TraceFeed } {
	return { ...make({ endpoint, fetch: tracedFetch(traces), headers: actingAsHeaders(actingAs) }), traces };
}
