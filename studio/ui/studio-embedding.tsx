import type { TraceFeed } from '@theoremjs/react/client';
import { TheoremEmbedding } from '@theoremjs/react/ui';
import {
	createStudioEmbeddingTransport,
	EXAMPLE_EMBEDDING_INPUT,
	type StudioRunPayload,
} from '../mod.ts';
import {
	createBrowserStudioEmbeddingTransport,
	type StudioBrowserRuntime,
} from '../browser.ts';
import { useMemo } from 'react';
import { noting } from './lib/studio-activity.ts';

/** The inputs an embedding's form starts with: example text, unless the profile embeds files only. */
export function embeddingSeed(profile: StudioRunPayload['profile']) {
	return profile.type === 'embedding' && profile.inputs.text === false ? '[""]' : EXAMPLE_EMBEDDING_INPUT;
}

/** The same embedding runner in the builder preview and the standalone run tab. */
export function StudioEmbedding({
	payload,
	className,
	runtime = null,
	traces,
	onActivity,
	trace,
	flush,
	columns,
}: {
	payload: StudioRunPayload;
	className?: string;
	runtime?: StudioBrowserRuntime | null;
	/** The conversation's trace feed, kept across recompiles. */
	traces?: TraceFeed;
	/** Called before each embedding is asked for; stable, or the transport is rebuilt each render. */
	onActivity?: () => void;
	/** The page's own trace control. */
	trace?: boolean;
	/** The page is already the shell. The console sits in it. */
	flush?: boolean;
	/** The inputs on the left and the vectors on the right. */
	columns?: boolean;
}) {
	const transport = useMemo(() => {
		const made = runtime
			? createBrowserStudioEmbeddingTransport(payload, runtime, { traces })
			: createStudioEmbeddingTransport(payload, { traces });
		return onActivity ? noting(made, onActivity) : made;
	}, [payload, runtime, traces, onActivity]);
	return (
		<TheoremEmbedding
			transport={transport}
			defaultInput={embeddingSeed(payload.profile)}
			trace={trace}
			flush={flush}
			columns={columns}
			className={className}
		/>
	);
}
