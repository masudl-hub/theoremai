import { Banner } from '@astryxdesign/core/Banner';
import { Center } from '@astryxdesign/core/Center';
import { ChatLayout } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { VStack } from '@astryxdesign/core/VStack';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { type ReactNode, useMemo } from 'react';
import {
	type ComposerProfileInterface,
	moveComposerPendingWithinKind,
	removeComposerPendingMessage,
} from '../../../src/interface/mod.ts';
import { createHttpTransport, type HttpTransportOptions, type TheoremTransport } from '../client/transport';
import { useTheoremChat } from '../hooks/use-theorem-chat';
import { useTheoremInterface } from '../hooks/use-theorem-interface';
import { ChatComposerBar } from './ChatComposerBar';
import { ChatTranscript } from './ChatTranscript';
import { TheoremThemeProvider } from './theme';

export type TheoremChatProps = {
	/** Where `createTheoremHandler` is mounted. Default `/api/theorem`. Ignored when `transport` is set. */
	endpoint?: string;
	/** Extra fetch options for the default HTTP transport (auth headers, custom fetch). */
	http?: Omit<HttpTransportOptions, 'endpoint'>;
	/** Bring your own transport (tests, playgrounds, non-HTTP hosts). */
	transport?: TheoremTransport;
	/** Astryx theme. Omit to inherit the host's `<Theme>` or use `theoremTheme`. */
	theme?: DefinedTheme;
	mode?: 'system' | 'light' | 'dark';
	placeholder?: string;
	/** Shown before the first message. */
	emptyState?: ReactNode;
	density?: 'compact' | 'balanced' | 'spacious';
	/**
	 * Widest the transcript and composer may grow, as a CSS length. Default
	 * {@link DEFAULT_CHAT_MAX_WIDTH}: 60% of the chat, or full width on narrow screens.
	 */
	maxWidth?: string;
	/** Page scroller when the chat is not its own scroll container (e.g. `document.documentElement`). */
	scrollRef?: React.RefObject<HTMLElement | null>;
	className?: string;
	style?: React.CSSProperties;
};

/**
 * 60% of the chat's width, but never narrower than 640px (or the full width,
 * whichever is smaller) — so phones and narrow panes get 100%.
 */
export const DEFAULT_CHAT_MAX_WIDTH = 'max(60%, min(100%, 640px))';

/** Centres content in a column no wider than `maxWidth`, using Astryx layout props. */
function ChatColumn({ maxWidth, children }: { maxWidth: string; children: ReactNode }) {
	return (
		<Center axis="horizontal" width="100%">
			<VStack width="100%" maxWidth={maxWidth}>
				{children}
			</VStack>
		</Center>
	);
}

type ChatBodyProps = Omit<TheoremChatProps, 'endpoint' | 'http' | 'transport' | 'theme' | 'mode'> & {
	transport: TheoremTransport;
	iface: ComposerProfileInterface;
};

function ChatBody({
	transport,
	iface,
	placeholder,
	emptyState,
	density,
	maxWidth = DEFAULT_CHAT_MAX_WIDTH,
	scrollRef,
	className,
	style,
}: ChatBodyProps) {
	const chat = useTheoremChat({ transport, iface });
	const blocks = useMemo(() => [...chat.blocks, ...chat.streamBlocks], [chat.blocks, chat.streamBlocks]);
	const handle = iface.identity.handle;

	// Structure from Astryx's AI chat template: Layout › LayoutContent › ChatLayout,
	// with the composer in ChatLayout's own dock. The dock leaves 12px under the
	// composer; paddingBlockEnd={3} adds 12px more for a 24px bottom margin.
	return (
		<Layout
			height="fill"
			className={className}
			style={style}
			content={
				<LayoutContent padding={0}>
					<VStack height="100%">
						<ChatLayout
							density={density}
							scrollRef={scrollRef}
							emptyState={emptyState ?? <EmptyState title={`@${handle}`} description="Start a conversation." />}
							composer={
								<VStack paddingBlockEnd={3}>
									<ChatColumn maxWidth={maxWidth}>
										<ChatComposerBar
											iface={iface}
											draftText={chat.draftText}
											pendingFiles={chat.pendingFiles}
											pendingVoice={chat.pendingVoice}
											pendingMessages={chat.pendingMessages}
											issues={chat.issues}
											phase={chat.phase}
											error={chat.error}
											selectedModel={chat.session.selectedModel}
											selectedEffort={chat.session.selectedEffort}
											placeholder={placeholder}
											onDraftTextChange={chat.setDraftText}
											onFilesSelected={(files) => {
												chat.setPendingFiles((prev) => [...prev, ...files]);
												chat.setIssues([]);
											}}
											onAttachmentRemove={(index) => {
												chat.setPendingFiles((prev) => prev.filter((_, i) => i !== index));
											}}
											onVoiceStaged={(file) => {
												chat.setPendingVoice([file]);
												chat.setIssues([]);
											}}
											onVoiceClear={() => chat.setPendingVoice([])}
											onSubmit={() => {
												void chat.handleSubmit();
											}}
											onStop={chat.handleStop}
											onMenuAction={chat.handleMenuAction}
											onGenerationChange={chat.handleGenerationChange}
											onPendingMove={(id, direction) => {
												chat.setPendingMessages((prev) => moveComposerPendingWithinKind(prev, id, direction));
											}}
											onPendingRemove={(id) => {
												chat.setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
											}}
											onPendingQueue={chat.handlePendingQueue}
											onPendingRestore={(id) => {
												void chat.handlePendingRestore(id);
											}}
											onPendingSendNow={(id) => {
												const message = chat.pendingMessages.find((m) => m.id === id);
												if (message) void chat.handleSendNow(message);
											}}
										/>
									</ChatColumn>
								</VStack>
							}
						>
							{blocks.length > 0 ? (
								<ChatColumn maxWidth={maxWidth}>
									<ChatTranscript
										blocks={blocks}
										handle={`@${handle}`}
										streaming={chat.streaming}
										onBranch={chat.handleBranch}
										onToolDecision={(index, action, value) => {
											void chat.handleToolDecision(index, action, value);
										}}
										onAuthCredential={(index, slot, credential) => {
											void chat.handleAuthCredential(index, slot, credential);
										}}
									/>
								</ChatColumn>
							) : null}
						</ChatLayout>
					</VStack>
				</LayoutContent>
			}
		/>
	);
}

function ChatForTransport(props: Omit<TheoremChatProps, 'endpoint' | 'http' | 'theme' | 'mode'> & { transport: TheoremTransport }) {
	const described = useTheoremInterface(props.transport);
	if (described.status === 'loading') return <Spinner size="lg" label="Loading…" />;
	if (described.status === 'error') {
		return <Banner status="error" title="Couldn't reach the agent" description={described.error.message} />;
	}
	if (described.iface.type === 'live') {
		return (
			<Banner
				status="warning"
				title="Live profiles aren't supported here"
				description="Use LiveRunner from @theoremai/react/live."
			/>
		);
	}
	return <ChatBody {...props} transport={props.transport} iface={described.iface} />;
}

/**
 * Drop-in chat for a profile served by `createTheoremHandler`:
 *
 * ```tsx
 * <TheoremChat endpoint="/api/theorem" />
 * ```
 */
export function TheoremChat({ endpoint, http, transport, theme, mode, ...rest }: TheoremChatProps) {
	const resolved = useMemo(
		() => transport ?? createHttpTransport({ ...http, endpoint }),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `http` identity is caller-owned; endpoint drives reconnection.
		[transport, endpoint],
	);
	return (
		<TheoremThemeProvider theme={theme} mode={mode}>
			<ChatForTransport {...rest} transport={resolved} />
		</TheoremThemeProvider>
	);
}
