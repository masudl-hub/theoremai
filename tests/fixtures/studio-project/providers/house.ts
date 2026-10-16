import { localProvider as local, registerProvider } from "@theoremjs/agents";

/** The house gateway. */
export function registerHouse(): void {
	registerProvider(local, {
		id: "house",
		connection: {
			// where the gateway listens
			baseUrl: "https://gateway.example/v1",
		},
		keySlot: "house_key",
	});
}
