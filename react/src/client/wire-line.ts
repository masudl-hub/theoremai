/**
 * Every value that reaches the browser over a wire (NDJSON lines, live
 * envelopes) is checked against its schema here. A line or event of a kind the
 * client does not know is reported as `unsupported`, and one that fails its
 * check (not JSON, no kind, or a known kind that fails its schema) as
 * `malformed`; either way the reply goes on. A whole reply that fails its check
 * (the profile description) is `bad_response`.
 *
 * @module
 */

import { TheoremError, z } from '@theoremjs/agents';

/**
 * A line or envelope of a kind the client does not know. The server never
 * sends it; the client's parser makes it so the host sees what arrived. Theorem
 * shows nothing for it.
 */
export type UnsupportedEvent = { type: 'unsupported'; received: string; raw: unknown };

/**
 * A line or event that failed its wire check. The server never sends it; the
 * client's reader makes it, leaves the line out, and the reply goes on. `error`
 * is `bad_response`: its message names what broke, never the value, and the
 * user reads `session.part_skipped`.
 */
export type MalformedEvent = { type: 'malformed'; error: TheoremError };

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

function malformed(message: string): MalformedEvent {
	return {
		type: 'malformed',
		error: new TheoremError('bad_response', message, { copy: { key: 'session.part_skipped' } }),
	};
}

/** One wire value: a known kind that passed its schema, `unsupported`, or `malformed`. */
export function readWireValue<Line extends { type: string }>(
	lines: WireLines<Line>,
	raw: unknown,
): Line | UnsupportedEvent | MalformedEvent {
	const kind = wireKind.safeParse(raw);
	// lexicon-exempt: internal diagnostic; the user reads session.part_skipped
	if (!kind.success) return malformed(`a line without a kind failed its wire check: ${issueSummary(kind.error)}`);
	const { type } = kind.data;
	if (!isKnown(lines, type)) return { type: 'unsupported', received: type, raw };
	const line = lines[type].safeParse(raw);
	if (line.success) return line.data;
	// lexicon-exempt: internal diagnostic; the user reads session.part_skipped
	return malformed(`a '${type}' line failed its wire check: ${issueSummary(line.error)}`);
}

/** JSON text as a value, or undefined when it is not JSON. The parser's own error quotes the text, so it is not kept. */
function jsonValue(text: string): { value: unknown } | undefined {
	try {
		return { value: JSON.parse(text) };
	} catch (err) {
		if (err instanceof SyntaxError) return undefined;
		throw err;
	}
}

/** One wire line's text: {@link readWireValue} of its JSON, or `malformed` when it is not JSON. */
export function readWireLine<Line extends { type: string }>(
	lines: WireLines<Line>,
	text: string,
): Line | UnsupportedEvent | MalformedEvent {
	const json = jsonValue(text);
	// lexicon-exempt: internal diagnostic; the user reads session.part_skipped
	return json ? readWireValue(lines, json.value) : malformed('a line is not JSON');
}

/** A whole reply's JSON text as a value; text that is not JSON is `bad_response`. */
export function parseWireJson(text: string): unknown {
	const json = jsonValue(text);
	// lexicon-exempt: internal diagnostic; the user reads error.bad_response
	if (!json) throw new TheoremError('bad_response', 'a line is not JSON');
	return json.value;
}
