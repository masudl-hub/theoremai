import * as T from '@theoremjs/agents';

export function registerSpaced(): void {
  T.registerProvider(T.typesafeProvider, {
    id: 'spaced',
    connection: {},
  });
}
