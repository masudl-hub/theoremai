import * as Theorem from '@theoremjs/agents';

/** Wipes the desk. Always asks first. */
export const wipe = {
  type: 'function' as const,
  name: 'wipe_desk',
  description: 'Clears every note on the desk.',
  category: 'desk',
  access: 'destructive' as const,
  permission: 'always_confirm' as const,
  loadTier: 'T0' as const,
  paths: ['*'],
  input: Theorem.z.object({ confirm: Theorem.z.literal(true) }),
  output: Theorem.z.object({ wiped: Theorem.z.number() }),
  handler: () => ({ wiped: 3 }),
};
