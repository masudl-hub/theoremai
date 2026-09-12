import type { ToolGate } from 'theorum/kernel';
import type { ToolGateResolution } from '../../client/tool-resume';
import { ApprovalCard } from '../ApprovalCard';
import { AuthChallengeCard } from '../AuthChallengeCard';

export type LiveToolGatePanelProps = {
	gate: ToolGate;
	input?: unknown;
	onResolve: (resolution: ToolGateResolution) => void;
};

/** @deprecated Use `LiveToolGatePanel`. */
export type LiveToolPausePanelProps = LiveToolGatePanelProps & { pause?: ToolGate };

export function LiveToolGatePanel({ gate, input, onResolve }: LiveToolGatePanelProps) {
	const toolName = gate.tool;

	return (
		<div className="live-tool-pause" role="dialog" aria-labelledby="live-tool-gate-title">
			<p id="live-tool-gate-title" className="live-tool-pause__eyebrow">
				Tool gated
			</p>
			{gate.kind === 'auth' ? (
				<AuthChallengeCard
					gate={gate}
					toolName={toolName}
					onSubmitCredential={(slot, credential) => {
						onResolve({ action: 'auth', credentials: { [slot]: credential } });
					}}
				/>
			) : (
				<ApprovalCard
					gate={gate}
					toolName={toolName}
					input={input}
					onDecision={(action) => {
						onResolve({ action });
					}}
				/>
			)}
		</div>
	);
}

/** @deprecated Use `LiveToolGatePanel`. */
export function LiveToolPausePanel({
	gate,
	pause,
	input,
	onResolve,
}: LiveToolPausePanelProps & { pause?: ToolGate }) {
	return <LiveToolGatePanel gate={gate ?? pause!} input={input} onResolve={onResolve} />;
}
