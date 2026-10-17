import { registerTool as tool, z } from '@theoremjs/agents';

const READ = { access: 'read-only', permission: 'auto', loadTier: 'T0' } as const;

/** The kit every agent picks from: a lookup, and a read over HTTP. */
export function registerKit(): void {
	tool({
		...READ,
		type: 'function',
		paths: ['*'],
		name: 'lookup_city',
		description: 'Looks a city up.',
		category: 'places',
		input: z.object({ city: z.string().min(1).describe('The city.') }),
		output: z.object({ city: z.string(), country: z.string() }),
		handler: (input) => ({ city: (input as { city: string }).city, country: 'PT' }),
	});

	tool({
		...READ,
		"type": "http",
		paths: ["*"],
		name: `fetch_rates`,
		description: 'Reads the day\'s rates.',
		category: 'money',
		method: 'GET',
		endpoint: 'https://rates.example/v1/today',
		input: z.object({}),
		output: z.object({ rates: z.record(z.string(), z.number()) }),
	});
}
