import { defineProvider, openAIChat as chat } from "@theoremjs/agents";

/** The house gateway. */
export const house = defineProvider({
	id: "house",
	connection: {
		// where the gateway listens
		baseURL: "https://gateway.example/v1",
	},
	keySlot: "house_key",
	adapter: chat({
		// The gateway takes tools: this says so, so a run may send them.
		capabilities: {
			profileTypes: ["text"],
			inputKinds: ["text"],
			outputKinds: ["text"],
			builtins: [],
			features: {
				streaming: "supported",
				clientTools: "supported",
				parallelTools: "unknown",
				structuredOutput: "unknown",
				thinking: "supported",
				summaries: "unknown",
				storedContinuation: "unsupported",
			},
		},
	}),
});
