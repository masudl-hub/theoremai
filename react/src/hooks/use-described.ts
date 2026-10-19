import { useEffect, useState } from 'react';
import { type ClientFailure, clientFailure } from '../client/failure.ts';

/**
 * What a transport describes, read once per transport; a failure when it can't be read. A new
 * transport keeps the last description up until it describes itself, so swapping one in (a
 * recompiled profile) changes the page in place instead of blanking it to a spinner.
 */
export function useDescribed<T>(transport: { describe: (signal?: AbortSignal) => Promise<T> }): {
  iface: T | null;
  describeFailure: ClientFailure | null;
} {
  const [description, setDescription] = useState<{
    iface: T | null;
    describeFailure: ClientFailure | null;
  }>(NOT_DESCRIBED);
  useEffect(() => {
    const controller = new AbortController();
    transport.describe(controller.signal).then(
      (described) => {
        if (!controller.signal.aborted) setDescription({ iface: described, describeFailure: null });
      },
      (err: unknown) => {
        if (!controller.signal.aborted)
          setDescription({ iface: null, describeFailure: clientFailure(err) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [transport]);
  return description;
}

const NOT_DESCRIBED = { iface: null, describeFailure: null };
