import type { PlaygroundRunPayload } from './client/index';
import { InterfaceRunner } from './components/InterfaceRunner';
import { LiveRunner } from './components/live/LiveRunner';
import {
	moveComposerPendingWithinKind,
	removeComposerPendingMessage,
} from '../../src/interface/mod.ts';
import type { useTheoremRunAppModel } from './use-theorem-run-app-model';

export type RunModel = ReturnType<typeof useTheoremRunAppModel>;

function RunLoading() {
	return (
		<p className="iface-run-loading" aria-busy="true">
			Loading…
		</p>
	);
}

function RunMissing() {
	return (
		<p className="iface-run-inline-error" role="alert">
			No compiled agent in session. Return to the playground and press Run.
		</p>
	);
}

function RunLive(props: {
	iface: NonNullable<RunModel['liveIface']>;
	payload: PlaygroundRunPayload;
}) {
	return <LiveRunner iface={props.iface} payload={props.payload} />;
}

function RunComposer(props: RunModel & { iface: NonNullable<RunModel['iface']>; payload: PlaygroundRunPayload }) {
	return (
		<InterfaceRunner
			blocks={props.blocks}
			chatStarted={props.chatStarted}
			draftText={props.draftText}
			error={props.error}
			errorInternal={props.errorInternal}
			iface={props.iface}
			issues={[...props.issues]}
			onAuthCredential={(index, slot, credential) => {
				void props.handleAuthCredential(index, slot, credential);
			}}
			onBranch={props.handleBranch}
			onDraftTextChange={props.setDraftText}
			onFilesSelected={(files) => {
				props.setPendingFiles((prev) => [...prev, ...files]);
				props.setIssues([]);
			}}
			onAttachmentRemove={(index) => {
				props.setPendingFiles((prev) => prev.filter((_, i) => i !== index));
			}}
			onVoiceStaged={(file) => {
				props.setPendingVoice([file]);
				props.setIssues([]);
			}}
			onVoiceClear={() => {
				props.setPendingVoice([]);
			}}
			onSubmit={() => {
				void props.handleSubmit();
			}}
			onStop={props.handleStop}
			onMenuAction={props.handleMenuAction}
			onPendingMove={(id, direction) => {
				props.setPendingMessages((prev) => moveComposerPendingWithinKind(prev, id, direction));
			}}
			onPendingQueue={props.handlePendingQueue}
			onPendingRemove={(id) => {
				props.setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
			}}
			onPendingRestore={(id) => {
				void props.handlePendingRestore(id);
			}}
			onPendingSendNow={(id) => {
				const message = props.pendingMessages.find((m) => m.id === id);
				if (message) void props.handleSendNow(message);
			}}
			onToolDecision={(index, action, interactiveValue) => {
				void props.handleToolDecision(index, action, interactiveValue);
			}}
			onGenerationChange={props.handleGenerationChange}
			pendingFiles={props.pendingFiles}
			pendingMessages={props.pendingMessages}
			pendingVoice={props.pendingVoice}
			phase={props.phase}
			selectedEffort={props.session.selectedEffort ?? ''}
			selectedModel={props.session.selectedModel ?? ''}
			streamBlocks={props.streamBlocks}
			streaming={props.streaming}
		/>
	);
}

export function TheoremRunAppView(props: RunModel) {
	if (!props.ready) return <RunLoading />;
	if (props.payload?.profile.type === 'live' && props.liveIface) {
		return <RunLive iface={props.liveIface} payload={props.payload} />;
	}
	if (props.iface && props.payload) {
		return <RunComposer {...props} iface={props.iface} payload={props.payload} />;
	}
	return <RunMissing />;
}
