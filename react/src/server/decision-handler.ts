/**
 * One Web-standard handler that serves a decision profile to `<TheoremDecision />`.
 *
 * - `GET  <base>`        → `{ interface }` the profile's handle, contract, and questions
 * - `POST <base>/decide` → `{ result }` the answers for the posted `{ state }`
 *
 * The host owns the questions: the browser sends only the state, so a visitor
 * can't spend the host's key asking questions of their own.
 *
 * @module
 */

import {
	type DecisionProfile,
	type DecisionQuestion,
	defineProfile,
	errorKind,
	type KeyVault,
	lexiconText,
	publicError,
	registerProfile,
	runDecision,
	type TraceSink,
	z,
} from '@theoremjs/agents';
import { caughtStatus, HTTP_METHOD } from '@theoremjs/agents/host';
import type { DecisionProfileDefinition } from '@theoremjs/agents/kernel';
import { decisionInterface } from '../client/decision-transport.ts';
import { readBody } from './handler.ts';
import { jsonResponse } from './json-response.ts';

export type TheoremDecisionHandlerOptions = {
	/** Decision profile to serve. Registered with the kernel when the handler is created. */
	profile: DecisionProfile | DecisionProfileDefinition;
	/** The questions every decision asks, by id. */
	questions: Record<string, DecisionQuestion>;
	/** The selected decision provider's key, or a vault the profile's key slot reads from. */
	apiKey?: string;
	keyVault?: KeyVault;
	fetch?: typeof globalThis.fetch;
	/** Replaces the profile's `observability.writeTo` for every decision. */
	sink?: TraceSink;
	/** Host metadata kept on each decision's trace record, e.g. the signed-in user. */
	metadata?: (request: Request) => Record<string, unknown> | undefined;
	/**
	 * Called with any error the handler catches, for reporting. Users read the
	 * profile's lexicon wording for the error's kind, never the error itself.
	 */
	onError?: (err: unknown, ctx: { request: Request }) => void;
};

const decideBodySchema = z.object({ state: z.unknown() });

function isDecide(request: Request): boolean {
	return new URL(request.url).pathname.split('/').filter(Boolean).at(-1) === 'decide';
}

export function createTheoremDecisionHandler(
	options: TheoremDecisionHandlerOptions,
): (request: Request) => Promise<Response> {
	const profile = defineProfile(options.profile as DecisionProfileDefinition);
	if (profile.type !== 'decision') {
		// lexicon-exempt: builder config error at setup; no user sees it
		throw new Error(`createTheoremDecisionHandler serves type 'decision'; got type '${profile.type}'.`);
	}
	registerProfile(profile);
	const iface = decisionInterface(profile, options.questions);

	return async (request) => {
		try {
			if (request.method === 'GET' && !isDecide(request)) return jsonResponse(200, { interface: iface });
			if (request.method !== 'POST' || !isDecide(request)) {
				return jsonResponse(HTTP_METHOD, {
					error: lexiconText('error.request', {}, profile.lexicon),
					errorKind: 'request',
				});
			}
			const body = await readBody(request, decideBodySchema);
			const result = await runDecision(
				{
					profile: profile.id,
					// The kernel checks the state is non-null JSON within the profile's size.
					state: body.state as never,
					questions: options.questions,
					signal: request.signal,
					metadata: options.metadata?.(request),
				},
				{ apiKey: options.apiKey, keyVault: options.keyVault, fetch: options.fetch, sink: options.sink },
			);
			return jsonResponse(200, { result });
		} catch (err) {
			options.onError?.(err, { request });
			return jsonResponse(caughtStatus(err), { error: publicError(err, profile.lexicon), errorKind: errorKind(err) });
		}
	};
}
