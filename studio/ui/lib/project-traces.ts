import type { TraceFeed } from '../../../react/src/client/index.ts';
import { eachLine, NDJSON } from '../../stream-lines.ts';
import { studioTraceLine } from '../../transport.ts';

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
 * trace panel reads them: the same panel a draft's run fills in the playground.
 */
export function tracedTransport<T extends object>(
	make: (options: { endpoint: string; fetch: typeof fetch }) => T,
	endpoint: string,
	traces: TraceFeed,
): T & { traces: TraceFeed } {
	return { ...make({ endpoint, fetch: tracedFetch(traces) }), traces };
}
