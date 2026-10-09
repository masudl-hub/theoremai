/** The ready agents "Load an example" offers. */
export const STUDIO_EXAMPLES = {
	concierge: {
		label: 'Travel concierge',
		description: 'Text agent with weather, places, currency and trip tools.',
	},
	'live-concierge': {
		label: 'Live concierge',
		description: 'The concierge as a voice call, with the same tools.',
	},
	architect: {
		label: 'Code architect',
		description: 'Reads repos and docs. Brings a Narrator it calls for audio.',
	},
	narrator: { label: 'Narrator', description: 'Reads a script aloud.' },
	console: { label: 'Tool console', description: 'No model. Run its tools by hand.' },
	decision: {
		label: 'Jev decision',
		description: 'Checks tool calls with the Jev decision model.',
	},
} as const;
