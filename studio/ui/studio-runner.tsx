import {
	createDecisionTransport,
	createHostTransport,
	createHttpTransport,
	createTraceFeed,
	type TraceFeed,
} from '../../react/src/client/index.ts';
import { LiveRunner } from '../../react/src/live.ts';
import {
	PaneState,
	TheoremChat,
	TheoremDecision,
	TheoremHost,
} from '../../react/src/ui/index.ts';
import {
	compileWorkspace,
	createStudioHostTransport,
	createStudioTransport,
	type StudioConnectionMode,
	type StudioRunPayload,
	type StudioWorkspace,
	studioInterface,
	studioLiveConnection,
	studioPageTools,
	workspaceRunAgent,
} from '../mod.ts';
import {
	browserStudioLiveConnection,
	createBrowserStudioHostTransport,
	createBrowserStudioTransport,
	type StudioBrowserRuntime,
} from '../browser.ts';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { StackItem } from '@astryxdesign/core/Stack';
import { Token } from '@astryxdesign/core/Token';
import { IconKey } from '@tabler/icons-react';
import { type ComponentProps, useMemo, useRef, useState } from 'react';
import { noting } from './lib/studio-activity.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';
import {
	editedProfileEndpoint,
	type ProjectSession,
	projectProfileEndpoint,
	useProject,
} from './lib/studio-project.ts';
import { tracedTransport } from './lib/project-traces.ts';
import {
	EditedSide,
	ProjectChat,
	SavedSide,
	unsavedEdits,
	useEditedLoad,
	useSavedHidden,
} from './studio-compare.tsx';
import { decisionSeed, StudioDecision } from './studio-decision.tsx';
import { clearRemoves, useProjectSave } from './studio-save.tsx';

export interface StudioRunnerProps {
	payload: StudioRunPayload;
	mode: StudioConnectionMode;
	runtime: StudioBrowserRuntime | null;
	trace?: boolean;
	className?: string;
	/** The run page is already the shell. A decision or host sits in it, rather than on its own ground. */
	flush?: boolean;
	/** A decision or host puts the request on the left and the response on the right. */
	columns?: boolean;
	/** Called on each request the conversation sends: a turn, call, decision or live session. */
	onActivity?: () => void;
	/** A chat conversation to resume, as `onChatChange` reported it (text and image agents). */
	initialChat?: ChatProps['initialChat'];
	/** The text a chat's composer starts with. */
	initialText?: ChatProps['initialText'];
	onChatChange?: ChatProps['onChatChange'];
	chatRef?: ChatProps['chatRef'];
	/** The value the page picked for each slot, for a chat's turns and a call's start. */
	slots?: ChatProps['slots'];
	/** What the page tells the agent. */
	context?: ChatProps['context'];
	/**
	 * The workspace the payload was compiled from, when the page edits one. A project's chat then
	 * answers twice while it holds edits the files do not: as the files, and as the edits.
	 */
	tested?: StudioWorkspace;
}

/**
 * The builder preview and existing run page select transports under the same runner UI.
 *
 * A runner is one conversation. The chat keeps its transcript when an edit recompiles the draft,
 * so its trace feed outlives each transport too; remount the runner (a new `key`) to start over.
 */
export function StudioRunner({
	payload,
	mode,
	runtime,
	trace,
	className,
	flush,
	columns,
	onActivity,
	initialChat,
	initialText,
	onChatChange,
	chatRef,
	slots,
	context,
	tested,
}: StudioRunnerProps) {
	const [traces] = useState(createTraceFeed);
	const activity = useRef(onActivity);
	activity.current = onActivity;
	const [note] = useState(() => () => activity.current?.());
	const project = useProject();
	if (project)
		return (
			<ProjectRun
				project={project}
				payload={payload}
				traces={traces}
				trace={trace}
				className={className}
				flush={flush}
				columns={columns}
				note={note}
				chatRef={chatRef}
				slots={slots}
				context={context}
				tested={tested}
			/>
		);
	if (mode !== 'demo' && !runtime)
		return (
			<PaneState
				icon={<Icon icon={IconKey} size="lg" color="secondary" />}
				title="Connect to run"
				description="Add your provider keys or local endpoint under Keys."
			/>
		);
	if (payload.profile.type === 'decision')
		return (
			<StudioDecision
				payload={payload}
				runtime={runtime}
				traces={traces}
				trace={trace}
				className={className}
				onActivity={note}
				flush={flush}
				columns={columns}
			/>
		);
	if (payload.profile.type === 'host')
		return (
			<HostRun
				payload={payload}
				runtime={runtime}
				traces={traces}
				trace={trace}
				className={className}
				flush={flush}
				columns={columns}
				note={note}
			/>
		);
	return (
		<TurnRun
			payload={payload}
			runtime={runtime}
			traces={traces}
			trace={trace}
			className={className}
			note={note}
			initialChat={initialChat}
			initialText={initialText}
			onChatChange={onChatChange}
			chatRef={chatRef}
			slots={slots}
			context={context}
		/>
	);
}

/**
 * The two ways out of a run that waits on a Save: write the edits, or drop them. Dropping an
 * agent the files never held removes it.
 */
function UnsavedActions({ agentId, isNew }: { agentId: string; isNew: boolean }) {
	const save = useProjectSave();
	if (!save) return null;
	return (
		<>
			<Token
				label="Save"
				color="blue"
				description={save.review ? 'Review the diff, then save' : 'Fix the issues in the editor first'}
				onClick={save.review}
			/>
			<Button
				label={isNew ? 'Remove agent' : 'Clear changes'}
				variant="ghost"
				size="sm"
				onClick={() => {
					save.clear(agentId);
				}}
			/>
		</>
	);
}

export type ChatProps = ComponentProps<typeof TheoremChat>;
type RunProps = Omit<Parameters<typeof StudioRunner>[0], 'mode' | 'onActivity'> & {
	traces: TraceFeed;
	note: () => void;
};
/** The types that are not a conversation: a chat cannot sit beside one of these. */
const NOT_A_CHAT = new Set(['decision', 'host', 'live']);
const isChat = (payload: StudioRunPayload) => !NOT_A_CHAT.has(payload.profile.type);

/**
 * The agent as the files hold it, compiled from where the workspace started: an edit may have
 * renamed it or made it another type. Undefined for an agent the files do not hold.
 */
function savedPayload(
	edits: StudioWorkspace,
	payload: StudioRunPayload,
	profiles: readonly string[],
): StudioRunPayload | undefined {
	const inFiles = (agent: { identity: { agentId: string } }) =>
		profiles.includes(agent.identity.agentId.trim());
	const key = edits.agents.find((agent) => agent.identity.agentId.trim() === payload.agentId)?.key;
	const start = key === undefined ? undefined : edits.starts.agents[key];
	if (!start || !inFiles(start)) return undefined;
	const agents = Object.values(edits.starts.agents).filter(inFiles);
	const here = new Set(agents.map((agent) => agent.key));
	// A tool that ran an agent the edits removed has no agent here to run.
	const toolSpecs = Object.values(edits.starts.tools).filter(
		(tool) => tool.toolType !== 'agent' || here.has(tool.agentKey ?? ''),
	);
	const held = new Set(toolSpecs.map((tool) => tool.key));
	const files: StudioWorkspace = {
		...edits,
		agents: agents.map((agent) => ({
			...agent,
			tools: { ...agent.tools, allow: agent.tools.allow.filter((toolKey) => held.has(toolKey)) },
		})),
		toolSpecs,
	};
	const compiled = compileWorkspace(files, payload.connectionMode);
	const run = compiled.ok ? workspaceRunAgent(compiled, start.identity.agentId.trim()) : undefined;
	if (!run) return undefined;
	const { agentId, profile, customTools, structured, questions, dependencies } = run;
	return { ...payload, agentId, profile, customTools, structured, questions, dependencies };
}

type SideProps = Pick<
	RunProps,
	| 'payload'
	| 'traces'
	| 'note'
	| 'trace'
	| 'className'
	| 'flush'
	| 'columns'
	| 'chatRef'
	| 'slots'
	| 'context'
> & {
	/** Where this side's profile answers: the files' own, or the load of the edits. */
	endpoint: string;
};

/** One profile on one endpoint, as its type runs: a chat, a decision, a tool console or a call. */
function SideRun({
	payload,
	endpoint,
	traces,
	note,
	trace,
	className,
	flush,
	columns,
	chatRef,
	slots,
	context,
}: SideProps) {
	const { type } = payload.profile;
	const chats = isChat(payload);
	const chat = useMemo(
		() => (chats ? noting(tracedTransport(createHttpTransport, endpoint, traces), note) : null),
		[chats, endpoint, traces, note],
	);
	const host = useMemo(
		() =>
			type === 'host' ? noting(tracedTransport(createHostTransport, endpoint, traces), note) : null,
		[type, endpoint, traces, note],
	);
	const decision = useMemo(
		() => (type === 'decision' ? noting(createDecisionTransport({ endpoint }), note) : null),
		[type, endpoint, note],
	);
	if (chat)
		return (
			<TheoremChat
				detectCodeLanguage
				labels={STUDIO_LABELS}
				transport={chat}
				trace={trace}
				className={className}
				chatRef={chatRef}
				slots={slots}
				context={context}
			/>
		);
	if (decision)
		return (
			<TheoremDecision
				transport={decision}
				defaultState={decisionSeed(payload.profile)}
				trace={trace}
				flush={flush}
				columns={columns}
				className={className}
			/>
		);
	if (host)
		return (
			<TheoremHost
				detectCodeLanguage
				labels={STUDIO_LABELS}
				transport={host}
				trace={trace}
				flush={flush}
				columns={columns}
				className={className}
			/>
		);
	return (
		<ProjectCall
			payload={payload}
			endpoint={endpoint}
			note={note}
			trace={trace}
			slots={slots}
			context={context}
		/>
	);
}

/**
 * A project's profile with edits the files do not hold, where either side is not a chat: the
 * files' run and the edits' run side by side, each its own. The files' side can be put away.
 */
function ProjectSides({
	project,
	payload,
	saved,
	edits,
	traces,
	chatRef,
	...shared
}: Omit<RunProps, 'runtime' | 'tested'> & {
	project: ProjectSession;
	saved: StudioRunPayload | undefined;
	edits: StudioWorkspace;
}) {
	const { answer, pending } = useEditedLoad(project, edits, false);
	const stamp = answer?.ok ? answer.stamp : undefined;
	const refused = answer && !answer.ok && !pending ? answer : undefined;
	const isSavedHidden = useSavedHidden();
	// The edited side's own feed, so its traces are not the files' side's.
	const [editedTraces] = useState(createTraceFeed);
	return (
		<HStack height="100%">
			{saved && !isSavedHidden && (
				<StackItem key="saved" size="fill">
					<SavedSide>
						<SideRun
							{...shared}
							payload={saved}
							endpoint={projectProfileEndpoint(project, saved.agentId)}
							traces={traces}
						/>
					</SavedSide>
				</StackItem>
			)}
			{saved && !isSavedHidden && <Divider orientation="vertical" />}
			<StackItem key="edited" size="fill">
				<EditedSide
					refused={refused}
					isLoading={stamp === undefined && !refused}
					hasSaved={saved !== undefined}
					actions={
						<UnsavedActions
							agentId={payload.agentId}
							isNew={clearRemoves(edits, payload.agentId, project.profiles)}
						/>
					}
				>
					{stamp !== undefined && !refused && (
						// A new load of the edits is a new run.
						<SideRun
							{...shared}
							key={stamp}
							payload={payload}
							endpoint={editedProfileEndpoint(project, payload.agentId)}
							traces={editedTraces}
							chatRef={chatRef}
						/>
					)}
				</EditedSide>
			</StackItem>
		</HStack>
	);
}

/**
 * A project's profile, run by the studio's local server: the project's own tools and models.
 * While the builder has edits the files do not hold, it runs twice, side by side: as the files,
 * and as the files with the edits laid over them. Two chats share one message.
 */
function ProjectRun({ project, tested, ...run }: Omit<RunProps, 'runtime'> & { project: ProjectSession }) {
	const { payload } = run;
	const edits = useMemo(
		() => unsavedEdits(tested, project.profiles),
		[tested, project.profiles],
	);
	const saved = useMemo(
		() => (edits ? savedPayload(edits, payload, project.profiles) : undefined),
		[edits, payload, project.profiles],
	);
	if (isChat(payload) && (!saved || isChat(saved)))
		return (
			<ProjectChat
				project={project}
				profileId={payload.agentId}
				tested={tested}
				note={run.note}
				traces={run.traces}
				trace={run.trace}
				className={run.className}
				chatRef={run.chatRef}
				slots={run.slots}
				context={run.context}
			/>
		);
	if (!edits)
		return <SideRun {...run} endpoint={projectProfileEndpoint(project, payload.agentId)} />;
	return <ProjectSides {...run} project={project} saved={saved} edits={edits} />;
}
/** A project's live profile: the call runs in the project, through the studio's local server. */
function ProjectCall({
	payload,
	endpoint,
	note,
	trace,
	slots,
	context,
}: Pick<RunProps, 'payload' | 'note' | 'trace' | 'slots' | 'context'> & { endpoint: string }) {
	const iface = useMemo(() => studioInterface(payload), [payload]);
	/** The studio's page answers each page tool with the tool's stub. */
	const pageTools = useMemo(() => studioPageTools(payload), [payload]);
	if (iface.type !== 'live') return null;
	return (
		<LiveRunner
			labels={STUDIO_LABELS}
			iface={iface}
			connection={() => {
				note();
				return { createSocket: () => new WebSocket(endpoint.replace(/^http/, 'ws')) };
			}}
			trace={trace}
			slots={slots}
			context={context}
			pageTools={pageTools}
		/>
	);
}
function HostRun({ payload, runtime, traces, trace, className, flush, columns, note }: RunProps) {
	const transport = useMemo(
		() =>
			noting(
				runtime
					? createBrowserStudioHostTransport(payload, runtime, { traces })
					: createStudioHostTransport(payload, { traces }),
				note,
			),
		[payload, runtime, traces, note],
	);
	return (
		<TheoremHost
			detectCodeLanguage
			labels={STUDIO_LABELS}
			transport={transport}
			trace={trace}
			flush={flush}
			columns={columns}
			className={className}
		/>
	);
}
function TurnRun({
	payload,
	runtime,
	traces,
	trace,
	className,
	note,
	initialChat,
	initialText,
	onChatChange,
	chatRef,
	slots,
	context,
}: RunProps) {
	const iface = useMemo(() => studioInterface(payload), [payload]);
	/** The studio's page answers each page tool with the tool's stub. */
	const pageTools = useMemo(() => studioPageTools(payload), [payload]);
	const transport = useMemo(
		() =>
			noting(
				runtime
					? createBrowserStudioTransport(payload, runtime, { traces })
					: createStudioTransport(payload, { traces }),
				note,
			),
		[payload, runtime, traces, note],
	);
	return iface.type === 'live' ? (
		<LiveRunner
			labels={STUDIO_LABELS}
			iface={iface}
			connection={() => {
				note();
				return runtime
					? browserStudioLiveConnection(payload, runtime)
					: studioLiveConnection(payload);
			}}
			trace={trace}
			slots={slots}
			context={context}
			pageTools={pageTools}
		/>
	) : (
		<TheoremChat
			detectCodeLanguage
			labels={STUDIO_LABELS}
			transport={transport}
			trace={trace}
			className={className}
			initialChat={initialChat}
			initialText={initialText}
			onChatChange={onChatChange}
			chatRef={chatRef}
			slots={slots}
			context={context}
			pageTools={pageTools}
		/>
	);
}
