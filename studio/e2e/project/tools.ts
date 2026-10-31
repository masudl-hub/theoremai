import { registerTool, z } from '@theoremjs/agents';

const IN_ANY_TURN = { loadTier: 'T0' as const, paths: ['*'], type: 'function' as const };

/** One red pixel: what `draw_city` draws. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

export function registerTools(): void {
  registerTool({
    ...IN_ANY_TURN,
    access: 'read-only',
    permission: 'auto',
    name: 'lookup_city',
    description: 'Looks a city up.',
    category: 'places',
    input: z.object({ city: z.string().min(1).describe('The city.') }),
    output: z.object({ city: z.string(), country: z.string() }),
    handler: (input) => ({ city: (input as { city: string }).city, country: 'PT' }),
  });
  registerTool({
    ...IN_ANY_TURN,
    access: 'read-only',
    permission: 'auto',
    name: 'draw_city',
    description: 'Draws a city.',
    category: 'places',
    input: z.object({ city: z.string().min(1).describe('The city.') }),
    output: z.object({
      drawn: z.boolean(),
      parts: z.array(
        z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }),
      ),
    }),
    handler: () => ({
      drawn: true,
      parts: [{ type: 'image' as const, mimeType: 'image/png', data: PIXEL }],
    }),
  });
  registerTool({
    ...IN_ANY_TURN,
    access: 'read-write',
    permission: 'auto',
    name: 'file_note',
    description: 'Files a note.',
    category: 'desk',
    input: z.object({ note: z.string().min(1).describe('The note.') }),
    output: z.object({ filed: z.boolean(), by: z.string() }),
    handler: (_input, ctx) => ({ filed: true, by: (ctx.host as { person: string }).person }),
  });
  registerTool({
    ...IN_ANY_TURN,
    access: 'destructive',
    permission: 'always_confirm',
    name: 'wipe_desk',
    description: 'Clears every note on the desk.',
    category: 'desk',
    input: z.object({ confirm: z.literal(true) }),
    output: z.object({ wiped: z.number() }),
    handler: () => ({ wiped: 3 }),
  });
}
