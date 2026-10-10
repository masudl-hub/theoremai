import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
	createHttpTransport,
	createTraceFeed,
	type TraceFeed,
} from '../../react/src/client/index.ts';
import {
	ChatComposerBar,
	PaneFailure,
	PaneLoading,
	TheoremChat,
	type TheoremChatHandle,
} from '../../react/src/ui/index.ts';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import { atStart, type StudioWorkspace } from '../mod.ts';
import type { EditedAnswer, SaveRefusal } from '../server/save-wire.ts';
import {
	type ComponentProps,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { tracedTransport } from './lib/project-traces.ts';
import { noting } from './lib/studio-activity.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';
import {
	editedProfileEndpoint,
	openEdited,
	type ProjectSession,
	projectProfileEndpoint,
} from './lib/studio-project.ts';

type ChatProps = ComponentProps<typeof TheoremChat>;
type Snapshot = NonNullable<ChatProps['initialChat']>;
type Side = 'saved' | 'edited';
const SIDES: readonly Side[] = ['saved', 'edited'];

/** Why the edits are not running, as the builder reads it. */
const NOT_RUNNING: Partial<Record<SaveRefusal['reason'], string>> = {
	issues: 'Fix the issues in the editor to run your edits.',
	load: 'The project did not start with your edits.',
	differs: 'The studio cannot run these edits before they are saved.',
};

/** A server that did not answer, as a refusal the pane can show. */
function unreachable(saved: string[]) {
	return (error: unknown): EditedAnswer => ({
		ok: false,
		reason: 'load',
		detail: [error instanceof Error ? error.message : String(error)],
		saved,
	});
}

/**
 * The load that runs a workspace's edits: asked for when there are edits, and again when they
 * change. `answer` is the last one the server gave; `pending` while it is not for these edits yet.
 * It waits while `hold` is set, so a reply that is streaming is not cut off by the next edit.
 */
export function useEditedLoad(
	project: ProjectSession,
	edits: StudioWorkspace | undefined,
	hold: boolean,
): { answer: EditedAnswer | undefined; pending: boolean } {
	const [held, setHeld] = useState<{ of: StudioWorkspace; answer: EditedAnswer }>();
	useEffect(() => {
		if (!edits || hold || held?.of === edits) return;
		let stale = false;
		openEdited(project, edits)
			.catch(unreachable(held?.answer.saved ?? project.profiles))
			.then((answer) => {
				if (!stale) setHeld({ of: edits, answer });
			});
		return () => {
			stale = true;
		};
	}, [project, edits, hold, held]);
	if (!edits) return { answer: undefined, pending: false };
	return { answer: held?.answer, pending: held?.of !== edits };
}

/**
 * One message sent to both sides, and which of them still answers it. A side rests when its turn
 * is done: the reply ended, and any question it stopped on was answered.
 */
function usePair() {
	const chats = useRef<Record<Side, TheoremChatHandle | null>>({ saved: null, edited: null });
	const turns = useRef<Record<Side, { settled: boolean; rested: boolean }>>({
		saved: { settled: true, rested: true },
		edited: { settled: true, rested: true },
	});
	const [busy, setBusy] = useState<readonly Side[]>([]);
	const done = useCallback((side: Side) => {
		setBusy((sides) => sides.filter((other) => other !== side));
	}, []);
	/** A side's conversation came to rest. */
	const rested = useCallback(
		(side: Side) => {
			turns.current[side].rested = true;
			if (turns.current[side].settled) done(side);
		},
		[done],
	);
	const send = useCallback(
		async (text: string) => {
			const sent = SIDES.filter((side) => chats.current[side]);
			setBusy(sent);
			const answers = sent.map(async (side) => {
				const turn = turns.current[side];
				turn.settled = false;
				turn.rested = false;
				const added = await chats.current[side]?.send(text).catch(() => null);
				turn.settled = true;
				// Nothing was added: the chat could not take it, or it failed before it was sent.
				if (!added?.blocks.length || turn.rested) done(side);
				return [side, added ?? null] as const;
			});
			return new Map(await Promise.all(answers));
		},
		[done],
	);
	const stop = useCallback(() => {
		for (const side of SIDES) chats.current[side]?.stop();
	}, []);
	const [refs] = useState(() => ({
		saved: (handle: TheoremChatHandle | null) => {
			chats.current.saved = handle;
		},
		edited: (handle: TheoremChatHandle | null) => {
			chats.current.edited = handle;
		},
	}));
	return useMemo(
		() => ({ busy, send, stop, rested, refs, chats }),
		[busy, send, stop, rested, refs],
	);
}

/** Whether the files' side is put away, for every comparison in this tab. */
const savedSide = { isHidden: false, listeners: new Set<() => void>() };

function setSavedHidden(isHidden: boolean): void {
	savedSide.isHidden = isHidden;
	for (const listener of savedSide.listeners) listener();
}

function watchSavedSide(listener: () => void) {
	savedSide.listeners.add(listener);
	return () => {
		savedSide.listeners.delete(listener);
	};
}

/** Whether the builder put the files' side away: the edits then run alone. */
export function useSavedHidden(): boolean {
	return useSyncExternalStore(
		watchSavedSide,
		() => savedSide.isHidden,
		() => false,
	);
}

/** One side of the comparison: what it runs, over its conversation. */
function Pane({
	title,
	startContent,
	children,
}: {
	title: string | undefined;
	/** The side's own control, before its title: the same place on either side. */
	startContent?: ReactNode;
	children: ReactNode;
}) {
	return (
		<VStack height="100%">
			{title && (
				<HStack
					paddingInline={3}
					paddingBlock={2}
					gap={1}
					vAlign="center"
					// As tall with the control as without, so the two titles sit on one line.
					style={{ minHeight: '2.75rem' }}
				>
					{startContent}
					<Text type="supporting" weight="semibold" color="secondary">
						{title}
					</Text>
				</HStack>
			)}
			<StackItem size="fill">{children}</StackItem>
		</VStack>
	);
}

/**
 * Where the files' side stands in the row, with the line between it and the edits. Hiding it
 * closes it toward its edge and showing it opens it again, on the motion the rest of the studio
 * uses; it leaves the page once it has closed. It does not move when the page first opens.
 */
export function SavedSlot({
	isShown,
	hasDivider,
	children,
}: {
	isShown: boolean;
	/** Whether the edits sit beside it. */
	hasDivider: boolean;
	/** The side. With none there is nothing to close, and the slot is gone at once. */
	children: ReactNode;
}) {
	const [isMounted, setMounted] = useState(isShown);
	const [hasMoved, setMoved] = useState(false);
	const slot = useRef<HTMLDivElement>(null);
	if (isShown && !isMounted) setMounted(true);
	if (isShown !== isMounted && !hasMoved) setMoved(true);
	useEffect(() => {
		if (isShown || !slot.current) return;
		// It leaves once its own motion has run: at once where motion is reduced, and still on time
		// in a tab that is not showing, where nothing reports a transition's end.
		const seconds = Number.parseFloat(getComputedStyle(slot.current).transitionDuration) || 0;
		const timer = setTimeout(() => {
			setMounted(false);
		}, seconds * 1000);
		return () => {
			clearTimeout(timer);
		};
	}, [isShown]);
	if (!children || !(isShown || isMounted)) return null;
	return (
		<div
			ref={slot}
			className="studio-saved-slot"
			data-moved={hasMoved ? '' : undefined}
			data-closed={isShown ? undefined : ''}
			aria-hidden={isShown ? undefined : true}
		>
			<div className="studio-saved-slot-side">{children}</div>
			{hasDivider && <Divider orientation="vertical" />}
		</div>
	);
}

/**
 * The files' side: its run, and while the edits sit beside it, its title and the way to put it
 * away.
 */
export function SavedSide({
	isCompared = true,
	children,
}: {
	isCompared?: boolean;
	children: ReactNode;
}) {
	return (
		<Pane
			title={isCompared ? 'Saved (your files)' : undefined}
			startContent={
				<IconButton
					label="Hide saved"
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconLayoutSidebarLeftCollapse} size="sm" />}
					tooltip="Hide saved: run your edits alone"
					onClick={() => {
						setSavedHidden(true);
					}}
				/>
			}
		>
			{children}
		</Pane>
	);
}

function NotRunning({ refusal, actions }: { refusal: SaveRefusal; actions?: ReactNode }) {
	return (
		<PaneFailure
			title={NOT_RUNNING[refusal.reason] ?? 'Your edits are not running.'}
			actions={actions}
		>
			{refusal.detail.length > 0 && (
				<CodeBlock code={refusal.detail.join('\n')} size="sm" isWrapped maxHeight={320} />
			)}
		</PaneFailure>
	);
}

/** The message both sides get, and the stop for both while either answers. */
function SharedComposer({
	handle,
	why,
	isBusy,
	onSend,
	onStop,
}: {
	handle: string;
	/** Why a message cannot go now, when it cannot. */
	why: string | undefined;
	isBusy: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
}) {
	const [text, setText] = useState('');
	return (
		<HStack gap={2} vAlign="end" padding={3}>
			<StackItem size="fill">
				<ChatComposerBar
					handle={handle}
					draftText={text}
					onDraftTextChange={setText}
					onSubmit={onSend}
					isDisabled={isBusy || why !== undefined}
					placeholder={why ?? 'Message both'}
				/>
			</StackItem>
			{isBusy && <Button label="Stop" variant="ghost" onClick={onStop} />}
		</HStack>
	);
}

export interface ProjectChatProps {
	project: ProjectSession;
	/** The id of the profile the page chats with, as its edits name it. */
	profileId: string;
	/** The workspace the preview runs, edits and all. Without one, the files alone are run. */
	tested: StudioWorkspace | undefined;
	note: () => void;
	/** Where the files' side keeps its runs' traces. */
	traces: TraceFeed;
	trace?: boolean;
	className?: string;
	chatRef?: Ref<TheoremChatHandle>;
	/** The value the page picked for each slot. */
	slots?: Record<string, string>;
	/** What the page tells the agent. */
	context?: unknown;
}

/** The agent as the files hold it: an edit may have renamed it, or made it another type. */
function savedOf(tested: StudioWorkspace | undefined, profileId: string) {
	const agent = tested?.agents.find((held) => held.identity.agentId === profileId);
	return agent && tested?.starts.agents[agent.key]?.identity;
}

/** The types a chat cannot talk to: the files' side of one of these has no conversation to show. */
const NOT_A_CHAT = new Set(['decision', 'host', 'live']);

/** Why a message cannot go to both sides now, when it cannot. */
function whyNot(failed: boolean, isReady: boolean): string | undefined {
	if (failed) return 'Your edits are not running';
	return isReady ? undefined : 'Loading your edits';
}

/**
 * Each side's conversation as it last came to rest, so the edited side starts from what was said
 * when its load is replaced.
 */
function useSnapshots(isEditing: boolean, rested: (side: Side) => void) {
	const snapshots = useRef<Partial<Record<Side, Snapshot>>>({});
	if (!isEditing) snapshots.current.edited = undefined;
	const [onRest] = useState(() => {
		const rest = (side: Side) => (snapshot: Snapshot) => {
			snapshots.current[side] = snapshot;
			rested(side);
		};
		return { saved: rest('saved'), edited: rest('edited') };
	});
	return { snapshots, onRest };
}

/** Where each side sends: the files' profile, and the edited load's once there is one. */
function useTransports(
	project: ProjectSession,
	ids: { saved: string; edited: string },
	stamp: string | undefined,
	{ note, traces }: Pick<ProjectChatProps, 'note' | 'traces'>,
) {
	const saved = useMemo(
		() =>
			noting(
				tracedTransport(createHttpTransport, projectProfileEndpoint(project, ids.saved), traces),
				note,
			),
		[project, ids.saved, traces, note],
	);
	// One feed for the edited side, so a new load keeps the traces of the turns it starts from.
	const [editedTraces] = useState(createTraceFeed);
	const edited = useMemo(() => {
		if (stamp === undefined) return null;
		const endpoint = editedProfileEndpoint(project, ids.edited);
		return noting(tracedTransport(createHttpTransport, endpoint, editedTraces), note);
	}, [project, ids.edited, stamp, editedTraces, note]);
	return { saved, edited };
}

/**
 * The workspace when it holds edits the files do not: a changed setting, or an agent added or
 * removed. Undefined when it is the files' own.
 */
export function unsavedEdits(
	tested: StudioWorkspace | undefined,
	profiles: readonly string[],
): StudioWorkspace | undefined {
	if (!tested) return undefined;
	// An agent added here is at its own start, and still one the files do not hold.
	const isFiles =
		atStart(tested) &&
		tested.agents.length === profiles.length &&
		tested.agents.every((agent) => profiles.includes(agent.identity.agentId));
	return isFiles ? undefined : tested;
}

/** The edited side: its run, why it is not running, or that it is loading. */
export function EditedSide({
	refused,
	isLoading,
	hasSaved,
	actions,
	children,
}: {
	refused: SaveRefusal | undefined;
	isLoading: boolean;
	/** The files hold this agent too, so their side can come back beside this one. */
	hasSaved: boolean;
	/** The ways out when the edits cannot run. */
	actions?: ReactNode;
	children: ReactNode;
}) {
	const isSavedHidden = useSavedHidden();
	return (
		<Pane
			title="Edited (studio)"
			startContent={
				hasSaved &&
				isSavedHidden && (
					<IconButton
						label="Show saved"
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconLayoutSidebarLeftExpand} size="sm" />}
						tooltip="Show saved: run your files beside your edits"
						onClick={() => {
							setSavedHidden(false);
						}}
					/>
				)
			}
		>
			{refused && <NotRunning refusal={refused} actions={actions} />}
			{children}
			{isLoading && <PaneLoading label="Loading your edits" />}
		</Pane>
	);
}

/** What the comparison shows now: which sides there are, and what each one runs. */
function useComparison({ project, profileId, tested, note, traces }: ProjectChatProps) {
	const edits = useMemo(
		() => unsavedEdits(tested, project.profiles),
		[tested, project.profiles],
	);
	const pair = usePair();
	const isBusy = pair.busy.length > 0;
	const { answer, pending } = useEditedLoad(project, edits, isBusy);
	const saved = savedOf(tested, profileId);
	const ids = useMemo(
		() => ({ saved: saved?.agentId ?? profileId, edited: profileId }),
		[saved?.agentId, profileId],
	);
	const isEditing = edits !== undefined;
	// A profile the edits made a chat is another type in the files, which a chat cannot talk to.
	const chatsInFiles = !saved || !NOT_A_CHAT.has(saved.profileType);
	const inFiles =
		!isEditing || (chatsInFiles && (answer?.saved ?? project.profiles).includes(ids.saved));
	const { snapshots, onRest } = useSnapshots(isEditing, pair.rested);
	const stamp = answer?.ok ? answer.stamp : undefined;
	const transports = useTransports(project, ids, stamp, { note, traces });
	return {
		pair,
		isBusy,
		isEditing,
		inFiles,
		/** Both sides are there, so one message goes to both. */
		isShared: isEditing && inFiles,
		snapshots,
		onRest,
		stamp,
		transports,
		refused: answer && !answer.ok && !pending ? answer : undefined,
		isReady: !pending && transports.edited !== null,
	};
}

/**
 * The chat the page holds: a message goes to both sides while both are there and can take it, and
 * to the one side otherwise. It answers with what the edits said.
 */
function useChatHandle(
	chatRef: Ref<TheoremChatHandle> | undefined,
	pair: ReturnType<typeof usePair>,
	only: Side | undefined,
	canSendBoth: boolean,
) {
	const { send, stop, chats } = pair;
	const sendBoth = useCallback(
		async (text: string) => (await send(text)).get('edited') ?? null,
		[send],
	);
	useImperativeHandle(
		chatRef,
		() => ({
			send: (text) => {
				if (only) return chats.current[only]?.send(text) ?? Promise.resolve(null);
				return canSendBoth ? sendBoth(text) : Promise.resolve(null);
			},
			stop,
		}),
		[only, canSendBoth, sendBoth, stop, chats],
	);
	return sendBoth;
}

/**
 * A project's text or image profile, run by the studio's local server. While the builder has
 * edits the files do not hold, one message is answered twice, side by side: by the files, and by
 * the files with the edits laid over them.
 */
export function ProjectChat(props: ProjectChatProps) {
	const { profileId, trace, className, chatRef, slots, context } = props;
	const view = useComparison(props);
	const { pair, isBusy, transports, refused, isReady } = view;
	const isSavedHidden = useSavedHidden();
	const showsSaved = view.inFiles && !(view.isEditing && isSavedHidden);
	const isShared = view.isShared && showsSaved;
	const only = isShared ? undefined : showsSaved ? 'saved' : 'edited';
	const sendBoth = useChatHandle(chatRef, pair, only, !isBusy && isReady);
	const common = {
		detectCodeLanguage: true,
		labels: STUDIO_LABELS,
		trace,
		className,
		slots,
		context,
		composer: !isShared,
	};
	return (
		<VStack height="100%">
			<StackItem size="fill">
				<HStack height="100%">
					<SavedSlot isShown={showsSaved} hasDivider={view.isShared}>
						{view.inFiles && (
							<SavedSide isCompared={view.isEditing}>
								<TheoremChat
									{...common}
									transport={transports.saved}
									// A side that comes back starts from what it had said.
									initialChat={view.snapshots.current.saved}
									onChatChange={view.onRest.saved}
									chatRef={pair.refs.saved}
								/>
							</SavedSide>
						)}
					</SavedSlot>
					{view.isEditing && (
						<div key="edited" className="studio-edited-slot">
							<EditedSide
								refused={refused}
								isLoading={!transports.edited && !refused}
								hasSaved={view.inFiles}
							>
								{transports.edited && (
									<TheoremChat
										{...common}
										key={view.stamp}
										transport={transports.edited}
										initialChat={view.snapshots.current.edited ?? view.snapshots.current.saved}
										onChatChange={view.onRest.edited}
										chatRef={pair.refs.edited}
									/>
								)}
							</EditedSide>
						</div>
					)}
				</HStack>
			</StackItem>
			{isShared && (
				<SharedComposer
					handle={profileId}
					why={whyNot(refused !== undefined, isReady)}
					isBusy={isBusy}
					onSend={(text) => {
						void sendBoth(text);
					}}
					onStop={pair.stop}
				/>
			)}
		</VStack>
	);
}
