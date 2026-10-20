import { localProvider, registerProvider } from '@theoremjs/agents';

/** What the two gateways share: one key slot. */
const shared = { keySlot: 'pair_key' };

export function registerPair(): void {
  registerProvider(localProvider, {
    id: 'left',
    connection: { baseUrl: 'https://left.example/v1' },
    ...shared,
  });
  registerProvider(localProvider, {
    id: 'right',
    connection: { baseUrl: 'https://right.example/v1' },
    ...shared,
  });
}
