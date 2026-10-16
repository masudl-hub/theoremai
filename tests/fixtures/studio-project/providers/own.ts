import { bearer, defineProvider, openAi, registerProvider } from '@theoremjs/agents';
import { z } from 'zod';

/** The project's own definition: a chat gateway under its own name, with a region of its own. */
const ownGateway = defineProvider({
  id: 'own-chat',
  name: 'Own gateway',
  description: 'A chat gateway with a region.',
  connection: z.strictObject({ baseUrl: z.string(), region: z.string() }),
  key: z.string().trim().min(1).optional(),
  authorize: bearer(),
  serves: (at) => [{ protocol: openAi, baseUrl: at.baseUrl }],
});

export function registerOwn(): void {
  registerProvider(ownGateway, {
    id: 'own',
    connection: { baseUrl: 'https://own.example/v1', region: 'eu' },
    keySlot: 'own_key',
  });
}
