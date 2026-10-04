import { useEffect, useState } from 'react';
import { type ClientFailure, clientFailure } from '../client/failure.ts';

/** What a transport describes, read once per transport; a failure when it can't be read. */
export function useDescribed<T>(transport: { describe: (signal?: AbortSignal) => Promise<T> }): {
	iface: T | null;
	describeFailure: ClientFailure | null;
} {
	const [description, setDescription] = useState<{
		transport: typeof transport;
		iface: T | null;
		describeFailure: ClientFailure | null;
	} | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		transport.describe(controller.signal).then(
			(described) => {
				if (controller.signal.aborted) return;
				setDescription({ transport, iface: described, describeFailure: null });
			},
			(err: unknown) => {
				if (!controller.signal.aborted)
					setDescription({ transport, iface: null, describeFailure: clientFailure(err) });
			},
		);
		return () => {
			controller.abort();
		};
	}, [transport]);
	return description?.transport === transport
		? { iface: description.iface, describeFailure: description.describeFailure }
		: { iface: null, describeFailure: null };
}
