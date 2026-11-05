import type { ProfileInterface } from '@theoremjs/agents/interface';
import type { ClientFailure, TheoremTransport } from '@theoremjs/web/client';
import { useMemo } from 'react';
import { useDescribed } from './use-described.ts';

/** `failure` is worded with the default labels: the profile's is not known until it loads. */
export type TheoremInterfaceState =
  | { status: 'loading'; iface: null; failure: null }
  | { status: 'ready'; iface: ProfileInterface; failure: null }
  | { status: 'error'; iface: null; failure: ClientFailure };

const LOADING: TheoremInterfaceState = { status: 'loading', iface: null, failure: null };

/**
 * Ask the transport for the host profile's client-safe interface. A new transport keeps the last
 * interface up until it describes itself, as {@link useDescribed} does.
 */
export function useTheoremInterface(transport: TheoremTransport): TheoremInterfaceState {
  const { iface, describeFailure } = useDescribed(transport);
  return useMemo(() => {
    if (describeFailure) return { status: 'error', iface: null, failure: describeFailure };
    return iface ? { status: 'ready', iface, failure: null } : LOADING;
  }, [iface, describeFailure]);
}
