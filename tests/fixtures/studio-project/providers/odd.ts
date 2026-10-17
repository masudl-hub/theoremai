import { geminiProvider, registerProvider, typesafeProvider } from '@theoremjs/agents';

export const spareDefinition = typesafeProvider;

export function registerOdd(): void {
  registerProvider((geminiProvider), {
    'id': 'odd',
    "connection": {} as Record<string, string>,
    keySlot: 'odd_key', // the odd one
  });
}
