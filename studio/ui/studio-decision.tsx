import type { TraceFeed } from '../../react/src/client/index.ts';
import { TheoremDecision } from '../../react/src/ui/index.ts';
import {
	createStudioDecisionTransport,
	EXAMPLE_DECISION_STATE,
	EXAMPLE_SPAN_DECISION_STATE,
	type StudioRunPayload,
} from '../mod.ts';
import {
	createBrowserStudioDecisionTransport,
	type StudioBrowserRuntime,
} from '../browser.ts';
import { useMemo } from 'react';
import { noting } from './lib/studio-activity';

/** The same decision runner in the builder preview and the standalone run tab. */
export function StudioDecision({
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
	/** Called before each decision is asked; stable, or the transport is rebuilt each render. */
	onActivity?: () => void;
	/** The run page's own trace control. Omit in the preview, which drives the trace itself. */
	trace?: boolean;
	/** The page is already the shell. The console sits in it. */
	flush?: boolean;
	/** The request on the left and the answers on the right. */
	columns?: boolean;
}) {
	const transport = useMemo(() => {
		const made = runtime
			? createBrowserStudioDecisionTransport(payload, runtime, { traces })
			: createStudioDecisionTransport(payload, { traces });
		return onActivity ? noting(made, onActivity) : made;
	}, [payload, runtime, traces, onActivity]);
	const model =
		payload.profile.type === 'decision' ? Object.values(payload.profile.models)[0] : undefined;
	return (
		<TheoremDecision
			transport={transport}
			defaultState={
				model?.apiId.startsWith('respan/') ? EXAMPLE_SPAN_DECISION_STATE : EXAMPLE_DECISION_STATE
			}
			trace={trace}
			flush={flush}
			columns={columns}
			className={className}
		/>
	);
}
