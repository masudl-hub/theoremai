import type { ToolPause } from 'theorum/kernel';
import type { ToolPauseResolution } from '../../client/tool-resume';
import { ApprovalCard } from '../ApprovalCard';
import { AuthChallengeCard } from '../AuthChallengeCard';

export type LiveToolPausePanelProps = {
	pause: ToolPause;
	onResolve: (resolution: ToolPauseResolution) => void;
};

export function LiveToolPausePanel({ pause, onResolve }: LiveToolPausePanelProps) {
	const toolName = pause.tool;

	return (
		<div className="live-tool-pause" role="dialog" aria-labelledby="live-tool-pause-title">
			<p id="live-tool-pause-title" className="live-tool-pause__eyebrow">
				Tool paused
			</p>
			{pause.kind === 'auth' ? (
				<AuthChallengeCard
					pause={pause}
					toolName={toolName}
					onSubmitCredential={(slot, credential) => {
						onResolve({ action: 'auth', credentials: { [slot]: credential } });
					}}
				/>
			) : (
				<ApprovalCard
					pause={pause}
					toolName={toolName}
					onDecision={(action, interactiveValue) => {
						onResolve(interactiveValue !== undefined ? { action, interactiveValue } : { action });
					}}
				/>
			)}
		</div>
	);
}
