import { defineProvider, googleAdapter, typesafeAdapter } from '@theoremjs/agents';

export const spareAdapter = typesafeAdapter();

export const odd = defineProvider({
  'id': 'odd',
  "connection": {} as Record<string, string>,
  keySlot: 'odd_key', // the odd one
  adapter: (googleAdapter()),
});
