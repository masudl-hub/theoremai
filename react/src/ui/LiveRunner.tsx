import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import {
	ChatComposer,
	ChatComposerInput,
	ChatLayout,
	ChatMessage,
	ChatMessageBubble,
	ChatMessageList,
	ChatSystemMessage,
	ChatSendButton,
} from '@astryxdesign/core/Chat';
import { Dialog } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import { VStack } from '@astryxdesign/core/VStack';
import {
	IconCameraRotate,
	IconMessage,
	IconMicrophone,
	IconMicrophoneOff,
	IconPhone,
	IconPhoneOff,
	IconSubtitles,
	IconVideo,
	IconVideoOff,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import type { LiveProfileInterface } from '../../../src/interface/mod.ts';
import type { LiveCaptionState } from '../client/live/live-captions';
import type { LiveToolGatePrompt } from '../client/live/live-tool';
import type { LiveFacingMode } from '../client/live/live-video';
import type { ToolGateResolution } from '../client/tool-resume';
import { InkWaveform } from '../components/InkWaveform';
import { useLiveRunnerModel } from '../components/live/use-live-runner-model';
import { NO_FOCUS_RING } from './ChatComposerBar';
import { liveStateLabel, type TheoremLabels } from './labels';
import { TheoremLabelsProvider, useLabels } from './labels-provider';
import { SidePanel, SidePanelHeader, SidePanelToggle, useSidePanel } from './SidePanel';
import { ApprovalCard, AuthChallengeCard } from './ToolGateCard';
import { DEFAULT_CHAT_MAX_WIDTH } from './TheoremChat';
import { useTraceInspector } from './TraceInspector';

export type LiveRunnerProps = {
	iface: LiveProfileInterface;
	/** Resolve the live profile id to open on the relay. */
	registerProfile: () => Promise<string>;
	/** Replacement lines by locale, as on `TheoremChat`. */
	labels?: TheoremLabels;
};

type LiveModel = ReturnType<typeof useLiveRunnerModel>;

/** The waveform's box: it rests on the stage floor rather than filling the stage. */
const WAVE_MAX_WIDTH = 720;
const WAVE_HEIGHT = 320;

/**
 * Live (voice / video) runner on Astryx. Before a call: a landing like the
 * chat's, offering a voice or video call. In a call: the agent tag and state
 * over the ink waveform, captions in a right-hand chat column, call controls
 * in a toolbar, and tool gates in a dialog. Offers the trace inspector when
 * the profile records traces.
 */
export function LiveRunner({ labels, ...props }: LiveRunnerProps) {
	return (
		<TheoremLabelsProvider labels={labels}>
			<LiveRunnerBody {...props} />
		</TheoremLabelsProvider>
	);
}

function LiveRunnerBody({ iface, registerProfile }: Omit<LiveRunnerProps, 'labels'>) {
	const t = useLabels();
	const model = useLiveRunnerModel(iface, registerProfile);
	// Both panels size against the whole live layout, so a third means the same for each.
	const layoutRef = useRef<HTMLDivElement | null>(null);
	const inspector = useTraceInspector(iface, layoutRef, model.traces);
	const captions = useSidePanel(layoutRef, true);
	const captionLabels = {
		name: t('@theorem.panel.captions.name'),
		show: t('@theorem.panel.captions.show'),
		hide: t('@theorem.panel.captions.hide'),
		resize: t('@theorem.panel.captions.resize'),
	};
	const captionsToggle = (
		<SidePanelToggle
			labels={captionLabels}
			icon={<Icon icon={IconMessage} />}
			panelId={captions.id}
			open={captions.open}
			onToggle={captions.toggle}
		/>
	);

	if (!model.callStarted) {
		return (
			<Layout
				ref={layoutRef}
				height="fill"
				header={<SidePanelHeader>{inspector.toggle}</SidePanelHeader>}
				end={inspector.panel}
				content={
					<LayoutContent padding={0}>
						<LiveLanding model={model} />
					</LayoutContent>
				}
			/>
		);
	}

	return (
		<>
			{/* One panel per Layout, nested, as Astryx's IDE template does: the trace
			    on the outer Layout, captions on the inner one beside the stage. */}
			<Layout
				ref={layoutRef}
				height="fill"
				header={
					<SidePanelHeader>
						{captionsToggle}
						{inspector.toggle}
					</SidePanelHeader>
				}
				end={inspector.panel}
				content={
					<LayoutContent padding={0}>
						<Layout
							height="fill"
							end={
								<SidePanel id={captions.id} labels={captionLabels} resizable={captions.resizable} open={captions.open} padding={0}>
									<LiveCaptions model={model} />
								</SidePanel>
							}
							content={
								<LayoutContent padding={0}>
									<VStack height="100%" paddingInline={3} paddingBlockEnd={3}>
										<LiveStage model={model} />
									</VStack>
								</LayoutContent>
							}
						/>
					</LayoutContent>
				}
			/>
			<LiveToolGateDialog prompt={model.gatePrompt} onResolve={model.resolveGateDecision} />
		</>
	);
}

/**
 * Before a call: the chat landing's greeting, with call buttons where the
 * composer would be. Video starts camera and mic together.
 */
function LiveLanding({ model }: { model: LiveModel }) {
	const t = useLabels();
	return (
		<VStack minHeight="100%" vAlign="center" gap={8} paddingInline={3}>
			<Center axis="horizontal" width="100%">
				<VStack width="100%" maxWidth={DEFAULT_CHAT_MAX_WIDTH} gap={8}>
					{/* Greeting type from Astryx's AI chat template, as on the chat landing. */}
					<VStack gap={1}>
						<Text type="large" as="h2">
							{t('@theorem.agent.handle', { handle: model.handle })}
						</Text>
						<Text type="display-2" as="h1">
							{t('@theorem.live.greeting')}
						</Text>
					</VStack>
					<HStack gap={2} wrap="wrap">
						<Button
							label={t(model.voiceAvailable ? '@theorem.live.start_voice_call' : '@theorem.live.start_call')}
							variant="primary"
							icon={<Icon icon={IconPhone} />}
							onClick={() => model.startCall({ video: false })}
						/>
						{model.videoAvailable ? (
							<Button
								label={t('@theorem.live.start_video_call')}
								variant="secondary"
								icon={<Icon icon={IconVideo} />}
								onClick={() => model.startCall({ video: true })}
							/>
						) : null}
					</HStack>
				</VStack>
			</Center>
		</VStack>
	);
}

/**
 * The agent tag and state over the resting waveform, then the call controls,
 * all in one column the waveform's width.
 */
function LiveStage({ model }: { model: LiveModel }) {
	const t = useLabels();
	const ref = useEnterMotion<HTMLElement>();
	return (
		<VStack ref={ref} height="100%" hAlign="center">
			<VStack width="100%" maxWidth={WAVE_MAX_WIDTH} height="100%" gap={3}>
				{/* Tag styled and placed as the chat names the agent on its messages. */}
				<VStack gap={0.5}>
					<Text type="label" color="secondary">
						{t('@theorem.agent.handle', { handle: model.handle })}
					</Text>
					<Text size="sm" color="secondary">
						{liveStateLabel(t, model.liveState, model.activeTool)}
					</Text>
				</VStack>
				{model.failure ? <Banner status="error" title={model.failure.error} /> : null}
				{model.sessionEnded ? <Banner status="info" title={model.sessionEnded} /> : null}
				<StackItem size="fill">
					<VStack height="100%" vAlign="end">
						{/* Bars stand on the stage floor, in the icon colour (no Stack colour prop). */}
						<VStack
							width="100%"
							height={WAVE_HEIGHT}
							style={{ color: 'var(--color-icon-primary)' }}
							aria-hidden="true"
						>
							<InkWaveform
								status={model.status}
								inputLevel={model.inputLevel}
								outputLevel={model.outputLevel}
								toolActive={model.toolActive}
								variant="hero"
							/>
						</VStack>
					</VStack>
				</StackItem>
				<LiveControls model={model} />
			</VStack>
		</VStack>
	);
}

/**
 * Eases the call view in from the landing: Astryx has no enter-transition
 * helper, so this animates with its `--duration-medium` / `--ease-standard`.
 */
function useEnterMotion<T extends HTMLElement>() {
	const ref = useRef<T | null>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
		const tokens = getComputedStyle(el);
		const duration = Number.parseFloat(tokens.getPropertyValue('--duration-medium')) || 410;
		el.animate(
			[
				{ opacity: 0, transform: 'translateY(8px)' },
				{ opacity: 1, transform: 'none' },
			],
			{ duration, easing: tokens.getPropertyValue('--ease-standard').trim() || 'ease-out' },
		);
	}, []);
	return ref;
}

/**
 * Mic, camera, text and call controls, centred under the stage. Icons show
 * what a click does, as End call does: a slash means "turn this off".
 */
function LiveControls({ model }: { model: LiveModel }) {
	const t = useLabels();
	const inactive = !model.sessionActive;
	const controls: ReactNode[] = [];

	if (model.voiceAvailable) {
		controls.push(
			<ToggleButton
				key="mic"
				label={t('@theorem.live.microphone')}
				tooltip={t(model.isMuted ? '@theorem.live.unmute' : '@theorem.live.mute')}
				isIconOnly
				isPressed={!model.isMuted}
				isDisabled={inactive}
				icon={<Icon icon={IconMicrophone} />}
				pressedIcon={<Icon icon={IconMicrophoneOff} />}
				onPressedChange={model.handleToggleMic}
			/>,
		);
	}
	if (model.videoAvailable) {
		controls.push(
			<ToggleButton
				key="video"
				label={t('@theorem.live.camera')}
				tooltip={t(model.isVideoOn ? '@theorem.live.camera_off' : '@theorem.live.camera_on')}
				isIconOnly
				isPressed={model.isVideoOn}
				isDisabled={inactive}
				icon={<Icon icon={IconVideo} />}
				pressedIcon={<Icon icon={IconVideoOff} />}
				onPressedChange={() => {
					void model.handleToggleVideo();
				}}
			/>,
		);
		if (model.isVideoOn) {
			controls.push(
				<IconButton
					key="flip"
					label={t('@theorem.live.flip_camera')}
					tooltip={t('@theorem.live.flip_camera')}
					variant="ghost"
					isDisabled={inactive}
					icon={<Icon icon={IconCameraRotate} />}
					onClick={() => {
						void model.handleFlipCamera();
					}}
				/>,
			);
		}
	}
	controls.push(
		model.canRestart ? (
			<IconButton
				key="call"
				label={t('@theorem.live.start_call')}
				tooltip={t('@theorem.live.start_call')}
				variant="primary"
				icon={<Icon icon={IconPhone} />}
				onClick={() => {
					void model.handleRestart();
				}}
			/>
		) : (
			<IconButton
				key="call"
				label={t('@theorem.live.end_call')}
				tooltip={t('@theorem.live.end_call')}
				variant="destructive"
				isDisabled={inactive}
				icon={<Icon icon={IconPhoneOff} />}
				onClick={model.handleEnd}
			/>
		),
	);

	return (
		<Toolbar
			label={t('@theorem.live.controls')}
			dividers={['top']}
			centerContent={
				<HStack gap={2} vAlign="center">
					{controls}
				</HStack>
			}
		/>
	);
}

/**
 * Captions as a chat column: committed turns, then the interim lines still
 * being heard, and the text composer in its dock when the profile takes text.
 */
function LiveCaptions({ model }: { model: LiveModel }) {
	const t = useLabels();
	const { interimAgent } = model.captions;
	const agentName = t('@theorem.agent.handle', { handle: model.handle });
	const composer = model.textAvailable ? (
		<ChatComposer
			style={NO_FOCUS_RING}
			value={model.textDraft}
			onChange={model.setTextDraft}
			onSubmit={model.handleSendText}
			isDisabled={!model.sessionActive}
			placeholder={t('@theorem.composer.placeholder', { handle: model.handle })}
			input={<ChatComposerInput />}
			sendButton={<ChatSendButton />}
		/>
	) : null;

	const messages = [
		...model.pastCalls.flatMap((turns, call) => [
			...turns.map((turn) => captionMessage(`${String(call)}:${turn.id}`, turn.role, turn.text, agentName)),
			<ChatSystemMessage key={`session-${String(call + 1)}`} variant="divider">
				{t('@theorem.live.new_session')}
			</ChatSystemMessage>,
		]),
		...captionMessages(model.captions, agentName),
	];

	// The empty state goes in ChatLayout's slot, which centres it; the list's
	// own slot sits under its bottom-align spacer. ChatLayout flexes to fill the
	// stack below any video preview.
	return (
		<VStack height="100%">
			{model.videoPreview ? (
				<LiveVideoPreview video={model.videoPreview} facingMode={model.videoFacingMode} />
			) : null}
			<ChatLayout
				composer={composer}
				emptyState={
					<EmptyState
						icon={<Icon icon={IconSubtitles} size="lg" color="secondary" />}
						title={t('@theorem.panel.captions.empty.title')}
						description={t('@theorem.panel.captions.empty.description')}
						isCompact
					/>
				}
			>
				{messages.length > 0 ? (
					<ChatMessageList isStreaming={interimAgent !== ''}>{messages}</ChatMessageList>
				) : null}
			</ChatLayout>
		</VStack>
	);
}

/** The current call's committed turns, then the lines still being heard. */
function captionMessages({ turns, interimUser, interimAgent }: LiveCaptionState, agentName: string): ReactNode[] {
	const messages = turns.map((turn) => captionMessage(turn.id, turn.role, turn.text, agentName));
	if (interimUser) messages.push(captionMessage('interim-user', 'user', interimUser, agentName));
	if (interimAgent) messages.push(captionMessage('interim-agent', 'agent', interimAgent, agentName));
	return messages;
}

function captionMessage(key: string, role: 'user' | 'agent', text: string, agentName: string): ReactNode {
	return role === 'user' ? (
		<ChatMessage key={key} sender="user">
			<ChatMessageBubble>{text}</ChatMessageBubble>
		</ChatMessage>
	) : (
		<ChatMessage key={key} sender="assistant" name={agentName}>
			<Text>{text}</Text>
		</ChatMessage>
	);
}

/**
 * The camera preview, at the top of the captions panel. The capture element comes
 * from the session client, so it is mounted imperatively; it sits one level
 * below AspectRatio, so it carries its own fill and mirror styles.
 */
function LiveVideoPreview({ video, facingMode }: { video: HTMLVideoElement; facingMode: LiveFacingMode }) {
	const t = useLabels();
	const hostRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
		host.replaceChildren(video);
		return () => {
			if (video.parentElement === host) host.removeChild(video);
		};
	}, [video]);

	useEffect(() => {
		video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : '';
	}, [video, facingMode]);

	return (
		<AspectRatio ratio={4 / 3} fit="cover">
			<div ref={hostRef} aria-label={t('@theorem.live.camera_preview')} role="img" />
		</AspectRatio>
	);
}

/** Tool approvals and credential prompts, as a dialog that must be answered. */
function LiveToolGateDialog({
	prompt,
	onResolve,
}: {
	prompt: LiveToolGatePrompt | null;
	onResolve: (resolution: ToolGateResolution) => void;
}) {
	return (
		<Dialog
			isOpen={prompt !== null}
			purpose="required"
			width={480}
			// "required" disables dismissal; should one slip through, it denies.
			onOpenChange={(open) => {
				if (!open) onResolve({ action: 'deny' });
			}}
		>
			{prompt ? (
				prompt.gate.kind === 'auth' ? (
					<AuthChallengeCard
						gate={prompt.gate}
						toolName={prompt.gate.tool}
						onSubmitCredential={(slot, credential) => {
							onResolve({ action: 'auth', credentials: { [slot]: credential } });
						}}
					/>
				) : (
					<ApprovalCard
						gate={prompt.gate}
						toolName={prompt.gate.tool}
						input={prompt.input}
						onDecision={(action) => {
							onResolve({ action });
						}}
					/>
				)
			) : null}
		</Dialog>
	);
}
