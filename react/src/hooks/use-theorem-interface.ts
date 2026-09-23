import { useEffect, useState } from 'react';
import type { ProfileInterface } from '../../../src/interface/mod.ts';
import type { TheoremTransport } from '../client/transport';

export type TheoremInterfaceState =
	| { status: 'loading'; iface: null; error: null }
	| { status: 'ready'; iface: ProfileInterface; error: null }
	| { status: 'error'; iface: null; error: Error };

const LOADING: TheoremInterfaceState = { status: 'loading', iface: null, error: null };

/** Ask the transport for the host profile's client-safe interface. */
export function useTheoremInterface(transport: TheoremTransport): TheoremInterfaceState {
	const [state, setState] = useState<TheoremInterfaceState>(LOADING);

	useEffect(() => {
		const controller = new AbortController();
		setState(LOADING);
		transport.describe(controller.signal).then(
			(iface) => {
				if (!controller.signal.aborted) setState({ status: 'ready', iface, error: null });
			},
			(err: unknown) => {
				if (controller.signal.aborted) return;
				const error = err instanceof Error ? err : new Error(String(err));
				setState({ status: 'error', iface: null, error });
			},
		);
		return () => {
			controller.abort();
		};
	}, [transport]);

	return state;
}
