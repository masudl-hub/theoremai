import { TheoremEmbedding } from '@theoremjs/react/ui';
import {
	createStudioEmbeddingTransport,
	EXAMPLE_EMBEDDING_INPUT,
	type StudioRunPayload,
} from '../mod.ts';
import { createBrowserStudioEmbeddingTransport } from '../browser.ts';
import { type StudioConsoleProps, useStudioTransport } from './studio-decision.tsx';

/** The inputs an embedding's form starts with: example text, unless the profile embeds files only. */
export function embeddingSeed(profile: StudioRunPayload['profile']) {
	return profile.type === 'embedding' && profile.inputs.text === false ? '[""]' : EXAMPLE_EMBEDDING_INPUT;
}

/** The same embedding runner in the builder preview and the standalone run tab. */
export function StudioEmbedding(props: StudioConsoleProps) {
	const transport = useStudioTransport(
		props,
		createStudioEmbeddingTransport,
		createBrowserStudioEmbeddingTransport,
	);
	return (
		<TheoremEmbedding
			transport={transport}
			defaultInput={embeddingSeed(props.payload.profile)}
			trace={props.trace}
			flush={props.flush}
			columns={props.columns}
			className={props.className}
		/>
	);
}
