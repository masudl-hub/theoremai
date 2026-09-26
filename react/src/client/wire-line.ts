/**
 * Every value that reaches the browser over a wire (NDJSON lines, live
 * envelopes) is checked against its schema here. A kind the client does not
 * know is reported as `unsupported` and the turn goes on; a kind it knows that
 * fails its schema is `bad_response`: a text turn ends on it, and a live call
 * reports it and goes on.
 *
 * @module
 */

import { z } from '../../../mod.ts';
import { TheoremError } from '../../../mod.ts';

/**
 * A line or envelope of a kind the client does not know. The server never
 * sends it; the client's parser makes it so the host sees what arrived. Theorem
 * shows nothing for it.
 */
export type UnsupportedEvent = { type: 'unsupported'; received: string; raw: unknown };

/** Every kind a wire carries, and the schema a value of that kind must pass. */
export type WireLines<Line extends { type: string }> = {
	readonly [K in Line['type']]: z.ZodType<Extract<Line, { type: K }>>;
};

const wireKind = z.object({ type: z.string() });

function isKnown<Line extends { type: string }>(lines: WireLines<Line>, type: string): type is Line['type'] {
	return Object.hasOwn(lines, type);
}

type Issue = z.ZodError['issues'][number];

function issuesSummary(issues: readonly Issue[], at: readonly PropertyKey[]): string {
	return issues
		.map((issue) => {
			const path = [...at, ...issue.path];
			const head = `${path.map(String).join('.') || '(root)'} ${issue.code}`;
			if (issue.code !== 'invalid_union' || issue.errors.length === 0) return head;
			return `${head} [${issue.errors.map((branch) => issuesSummary(branch, path)).join(' | ')}]`;
		})
		.join('; ');
}

/**
 * Issue paths and codes only: a failure names what broke, never the value. A
 * union that matched no branch lists each branch's issues.
 */
export function issueSummary(error: z.ZodError): string {
	return issuesSummary(error.issues, []);
}

function badResponse(what: string, error: z.ZodError): TheoremError {
	// lexicon-exempt: internal diagnostic; the user reads error.bad_response
	return new TheoremError('bad_response', `${what} failed its wire check: ${issueSummary(error)}`);
}

/** `raw` as `schema` reads it; one that fails is `bad_response`, naming `what`. */
export function checkWire<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw badResponse(what, parsed.error);
	return parsed.data;
}

/** One parsed wire value: a known kind that passed its schema, or `unsupported`. */
export function parseWireLine<Line extends { type: string }>(
	lines: WireLines<Line>,
	raw: unknown,
): Line | UnsupportedEvent {
	// lexicon-exempt: internal diagnostic; the user reads error.bad_response
	const { type } = checkWire(wireKind, raw, 'a line without a kind');
	if (!isKnown(lines, type)) return { type: 'unsupported', received: type, raw };
	return checkWire(lines[type], raw, `a '${type}' line`);
}

/**
 * A JSON text as a value; text that is not JSON is `bad_response`.
 * The parser's own error quotes the text, so it is not kept.
 */
export function parseWireJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// lexicon-exempt: internal diagnostic; the user reads error.bad_response
		throw new TheoremError('bad_response', 'a line is not JSON');
	}
}
