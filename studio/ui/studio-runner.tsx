import {
	createDecisionTransport,
	createHostTransport,
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
	createStudioHostTransport,
	createStudioTransport,
	type StudioConnectionMode,
	type StudioRunPayload,
	type StudioWorkspace,
	studioInterface,
	studioLiveConnection,
	studioPageTools,
} from '../mod.ts';
import {
	browserStudioLiveConnection,
	createBrowserStudioHostTransport,
	createBrowserStudioTransport,
	type StudioBrowserRuntime,
} from '../browser.ts';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
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
import { EditedSide, ProjectChat, unsavedEdits, useEditedLoad } from './studio-compare.tsx';
import { decisionSeed, StudioDecision } from './studio-decision.tsx';
import { useProjectSave } from './studio-save.tsx';

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

/** The two ways out of a run that waits on a Save: write the edits, or drop them. */
function UnsavedActions({ agentId }: { agentId: string }) {
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
				label="Clear changes"
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
/**
 * A project's profile, run by the studio's local server: the project's own tools and models.
 * While the builder has edits the files do not hold, the run is the files with those edits laid
 * over them. A chat then answers twice, side by side with the files' own.
 */
function ProjectRun({
	project,
	payload,
	traces,
	trace,
	className,
	flush,
	columns,
	note,
	chatRef,
	slots,
	context,
	tested,
}: Omit<RunProps, 'runtime'> & { project: ProjectSession }) {
	const { type } = payload.profile;
	const isChat = type !== 'host' && type !== 'decision' && type !== 'live';
	const edits = useMemo(
		() => unsavedEdits(tested, project.profiles),
		[tested, project.profiles],
	);
	// A chat asks for its own load, and holds it while a reply streams.
	const { answer, pending } = useEditedLoad(project, isChat ? undefined : edits, false);
	const stamp = answer?.ok ? answer.stamp : undefined;
	const endpoint = edits
		? editedProfileEndpoint(project, payload.agentId)
		: projectProfileEndpoint(project, payload.agentId);
	// A new load of the edits is a new run: its transport is made again with the load's stamp.
	const host = useMemo(
		() =>
			type === 'host' ? noting(tracedTransport(createHostTransport, endpoint, traces), note) : null,
		// biome-ignore lint/correctness/useExhaustiveDependencies: the stamp names the load the endpoint reaches
		[type, endpoint, stamp, traces, note],
	);
	const decision = useMemo(
		() => (type === 'decision' ? noting(createDecisionTransport({ endpoint }), note) : null),
		// biome-ignore lint/correctness/useExhaustiveDependencies: the stamp names the load the endpoint reaches
		[type, endpoint, stamp, note],
	);
	if (isChat)
		return (
			<ProjectChat
				project={project}
				profileId={payload.agentId}
				tested={tested}
				note={note}
				traces={traces}
				trace={trace}
				className={className}
				chatRef={chatRef}
				slots={slots}
				context={context}
			/>
		);
	const run = decision ? (
		<TheoremDecision
			key={stamp}
			transport={decision}
			defaultState={decisionSeed(payload.profile)}
			trace={trace}
			flush={flush}
			columns={columns}
			className={className}
		/>
	) : host ? (
		<TheoremHost
			key={stamp}
			detectCodeLanguage
			labels={STUDIO_LABELS}
			transport={host}
			trace={trace}
			flush={flush}
			columns={columns}
			className={className}
		/>
	) : (
		<ProjectCall
			key={stamp}
			payload={payload}
			endpoint={endpoint}
			note={note}
			trace={trace}
			slots={slots}
			context={context}
		/>
	);
	if (!edits) return run;
	const refused = answer && !answer.ok && !pending ? answer : undefined;
	return (
		<EditedSide
			refused={refused}
			isLoading={stamp === undefined && !refused}
			actions={<UnsavedActions agentId={payload.agentId} />}
		>
			{stamp !== undefined && !refused && run}
		</EditedSide>
	);
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
