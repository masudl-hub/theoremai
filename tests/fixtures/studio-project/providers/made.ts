import { localProvider, registerProvider } from '@theoremjs/agents';

function gateway(id: string, baseUrl: string) {
  registerProvider(localProvider, { id, connection: { baseUrl } });
}

export function registerMade(): void {
  gateway('made-a', 'https://a.example/v1');
  gateway('made-b', 'https://b.example/v1');
}
