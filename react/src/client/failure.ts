/**
 * One failure, two worlds, in the browser: the builder reads `errorKind` and
 * `errorInternal`; the user reads `error`, the profile's wording for it.
 *
 * @module
 */

import {
	describeError,
	type ErrorKind,
	errorKind,
	type LexiconOverrides,
	lexiconText,
	publicError,
} from '../../../mod.ts';
import type { AttachmentValidationIssue } from '../../../src/interface/mod.ts';
import { isTheoremStreamError } from './transport.ts';

export type ClientFailure = {
	/** What the user reads: the host's wording, else the profile lexicon's for the failure. */
	error: string;
	errorKind: ErrorKind;
	/** Raw detail for the builder; never shown to the user. */
	errorInternal?: string;
};

/**
 * Word a caught value for the user with the profile's `lexicon` (the interface's
 * `lexicon`). A host-reported failure keeps the host's wording.
 */
export function clientFailure(err: unknown, lexicon?: LexiconOverrides): ClientFailure {
	if (isTheoremStreamError(err)) {
		return {
			error: err.publicMessage ?? lexiconText(`error.${err.kind}`, {}, lexicon),
			errorKind: err.kind,
			...(err.internalMessage ? { errorInternal: err.internalMessage } : {}),
		};
	}
	const error = publicError(err, lexicon);
	const internal = describeError(err);
	return {
		error,
		errorKind: errorKind(err),
		...(internal && internal !== error ? { errorInternal: internal } : {}),
	};
}

/** A turn that did not run or did not finish. */
export type TurnFailure = ClientFailure & {
	ok: false;
	/** The files the profile refused, one entry per reason (the kernel's check). */
	issues?: AttachmentValidationIssue[];
	/** The user stopped it; nothing to show. */
	aborted?: boolean;
};

/** A caught value as a turn failure; an aborted `signal` marks it the user's stop. */
export function turnFailure(
	err: unknown,
	lexicon?: LexiconOverrides,
	signal?: AbortSignal,
): TurnFailure {
	const failure = clientFailure(err, lexicon);
	const aborted = failure.errorKind === 'cancelled' || signal?.aborted === true;
	return { ok: false, ...failure, ...(aborted ? { aborted: true } : {}) };
}
