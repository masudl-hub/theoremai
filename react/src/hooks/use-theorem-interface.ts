import { useEffect, useState } from 'react';
import type { ProfileInterface } from '../../../src/interface/mod.ts';
import { type ClientFailure, clientFailure } from '../client/failure';
import type { TheoremTransport } from '../client/transport';

/** `failure` is worded with the default lexicon: the profile's is not known until it loads. */
export type TheoremInterfaceState =
	| { status: 'loading'; iface: null; failure: null }
	| { status: 'ready'; iface: ProfileInterface; failure: null }
	| { status: 'error'; iface: null; failure: ClientFailure };

const LOADING: TheoremInterfaceState = { status: 'loading', iface: null, failure: null };

/** Ask the transport for the host profile's client-safe interface. */
export function useTheoremInterface(transport: TheoremTransport): TheoremInterfaceState {
	const [state, setState] = useState<TheoremInterfaceState>(LOADING);

	useEffect(() => {
		const controller = new AbortController();
		// A new transport keeps the last interface up until it describes itself, so swapping one
		// in (a recompiled playground profile) doesn't blank the chat to a spinner.
		setState((previous) => (previous.status === 'ready' ? previous : LOADING));
		transport.describe(controller.signal).then(
			(iface) => {
				if (!controller.signal.aborted) setState({ status: 'ready', iface, failure: null });
			},
			(err: unknown) => {
				if (controller.signal.aborted) return;
				setState({ status: 'error', iface: null, failure: clientFailure(err) });
			},
		);
		return () => {
			controller.abort();
		};
	}, [transport]);

	return state;
}
