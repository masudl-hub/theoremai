import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Token } from '@astryxdesign/core/Token';
import { PaneLoading, TheoremChat, TheoremLabelsProvider, useLabels } from '@theoremjs/react/ui';
import {
  createDecisionTransport,
  createEmbeddingTransport,
  createHostTransport,
  createHttpTransport,
  createTraceFeed,
  type TraceFeed,
} from '@theoremjs/web/client';
import {
  type ComponentProps,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createBrowserStudioTransport, type StudioBrowserRuntime } from '../browser.ts';
import {
  compileWorkspace,
  createStudioTransport,
  ON_OWN_KEYS,
  type StudioRunPayload,
  type StudioWorkspace,
  studioInterface,
  studioPageTools,
  type WorkspaceStarts,
  workspaceRunAgent,
} from '../mod.ts';
import { useActingAs } from './lib/acting-as.ts';
import { runsAsConversation } from './lib/conversation-types.ts';
import { tracedTransport } from './lib/project-traces.ts';
import { noting } from './lib/studio-activity.ts';
import { pageConversationKey } from './lib/studio-conversation.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';
import {
  editedProfileEndpoint,
  type ProjectSession,
  projectProfileEndpoint,
  useProject,
} from './lib/studio-project.ts';
import { warmWhenIdle } from './lib/when-idle.ts';
import {
  EditedSide,
  ProjectChat,
  SavedSide,
  SavedSlot,
  unsavedEdits,
  useEditedLoad,
  useLoadedStamp,
  useLoadedStated,
  useSavedHidden,
} from './studio-compare.tsx';
import { ChooseConflictsContext } from './studio-conflicts.tsx';
import { clearRemoves, useProjectSave } from './studio-save.tsx';

// Each type that is not a chat loads when an agent of it first runs, or once the page is idle.
const decisionRun = () => import('./studio-decision.tsx');
const embeddingRun = () => import('./studio-embedding.tsx');
const hostRun = () => import('./studio-host-console.tsx');
const liveRun = () => import('./studio-live.tsx');
const StudioDecision = lazy(() => decisionRun().then((run) => ({ default: run.StudioDecision })));
const DecisionView = lazy(() => decisionRun().then((run) => ({ default: run.DecisionView })));
const StudioEmbedding = lazy(() =>
  embeddingRun().then((run) => ({ default: run.StudioEmbedding })),
);
const EmbeddingView = lazy(() => embeddingRun().then((run) => ({ default: run.EmbeddingView })));
const StudioHostConsole = lazy(() => hostRun().then((run) => ({ default: run.StudioHostConsole })));
const HostView = lazy(() => hostRun().then((run) => ({ default: run.HostView })));
const StudioLive = lazy(() => liveRun().then((run) => ({ default: run.StudioLive })));
const ProjectLive = lazy(() => liveRun().then((run) => ({ default: run.ProjectLive })));

/** While a type's runner loads: blank, then the chat's own loading pane if it takes a while. */
function RunLoading() {
  // The fallback renders before the runner's own labels provider, so it brings one.
  return (
    <TheoremLabelsProvider>
      <RunLoadingPane />
    </TheoremLabelsProvider>
  );
}

function RunLoadingPane() {
  const t = useLabels();
  return <PaneLoading label={t('@theorem.chat.loading')} />;
}

export interface StudioRunnerProps {
  payload: StudioRunPayload;
  runtime: StudioBrowserRuntime | null;
  trace?: boolean;
  className?: string;
  /** The run page is already the shell. A decision or host sits in it, rather than on its own ground. */
  flush?: boolean;
  /** A decision or host puts the request on the left and the response on the right. */
  columns?: boolean;
  /** Called on each request the conversation sends: a turn, call, decision, or live session. */
  onActivity?: () => void;
  /**
   * The ref of a chat conversation to resume, as `onConversationChange` reported it.
   */
  conversation?: ChatProps['conversation'];
  /** The conversation under `conversation` as the server showed it, drawn at once. */
  conversationView?: ChatProps['conversationView'];
  /** The text a chat's composer starts with. */
  initialText?: ChatProps['initialText'];
  /** The files a chat's composer starts with, staged. */
  initialFiles?: ChatProps['initialFiles'];
  /** The voice notes a chat's composer starts with, staged. */
  initialVoice?: ChatProps['initialVoice'];
  /** The messages a chat's composer starts with set aside. */
  initialPending?: ChatProps['initialPending'];
  onConversationChange?: ChatProps['onConversationChange'];
  chatRef?: ChatProps['chatRef'];
  /** The value the page picked for each slot, for a chat's turns and a call's start. */
  slots?: ChatProps['slots'];
  /** What a run of a profile states: it declares its own conditions. */
  statedOf?: (of: StudioRunPayload) => ChatProps['stated'];
  /** What the page tells the agent. */
  context?: ChatProps['context'];
  /**
   * The workspace the payload was compiled from, when the page edits one. A project's chat then
   * answers twice while it holds edits the files do not: as the files, and as the edits.
   */
  tested?: StudioWorkspace;
  /** The feed its trace records land in, when the page reads them too; else its own. */
  traces?: TraceFeed;
}

/**
 * The builder preview and existing run page select transports under the same runner UI.
 *
 * A runner is one conversation. The chat keeps its transcript when an edit recompiles the draft,
 * so its trace feed outlives each transport too; remount the runner (a new `key`) to start over.
 */
export function StudioRunner({ onActivity, traces: given, ...props }: StudioRunnerProps) {
  const [own] = useState(createTraceFeed);
  const traces = given ?? own;
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const [note] = useState(() => () => activity.current?.());
  const project = useProject();
  useEffect(() => {
    warmWhenIdle(decisionRun, embeddingRun, hostRun, liveRun);
  }, []);
  return (
    <Suspense fallback={<RunLoading />}>
      <Run {...props} project={project} traces={traces} note={note} />
    </Suspense>
  );
}

function Run({
  payload,
  runtime,
  trace,
  className,
  flush,
  columns,
  conversation,
  conversationView,
  initialText,
  initialFiles,
  initialVoice,
  initialPending,
  onConversationChange,
  chatRef,
  slots,
  statedOf,
  context,
  tested,
  project,
  traces,
  note,
}: RunProps & { project: ProjectSession | null }) {
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
        conversation={conversation}
        conversationView={conversationView}
        initialText={initialText}
        initialFiles={initialFiles}
        initialVoice={initialVoice}
        initialPending={initialPending}
        onConversationChange={onConversationChange}
        chatRef={chatRef}
        slots={slots}
        statedOf={statedOf}
        context={context}
        tested={tested}
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
      <StudioHostConsole
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
  if (payload.profile.type === 'embedding')
    return (
      <StudioEmbedding
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
  return (
    <TurnRun
      payload={payload}
      runtime={runtime}
      traces={traces}
      trace={trace}
      className={className}
      note={note}
      conversation={conversation}
      conversationView={conversationView}
      initialText={initialText}
      initialFiles={initialFiles}
      initialVoice={initialVoice}
      initialPending={initialPending}
      onConversationChange={onConversationChange}
      chatRef={chatRef}
      slots={slots}
      statedOf={statedOf}
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
  const choose = useContext(ChooseConflictsContext);
  if (!save) return null;
  return (
    <>
      {choose ? (
        <Token
          label="Choose"
          color="orange"
          description="Choose between studio edits and source code, then save"
          onClick={choose}
        />
      ) : (
        <Token
          label="Save"
          color="blue"
          description={
            save.review ? 'Review the diff, then save' : 'Fix the issues in the editor first'
          }
          onClick={save.review}
        />
      )}
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
type RunProps = Omit<Parameters<typeof StudioRunner>[0], 'onActivity' | 'traces'> & {
  traces: TraceFeed;
  note: () => void;
};
/** The types that are not a conversation: a chat cannot sit beside one of these. */
const isChat = (payload: StudioRunPayload) => runsAsConversation(payload.profile.type);

/**
 * The agents the files hold, compiled from where the workspace started: an edit may have renamed
 * one or made it another type. Undefined when the files hold none of them.
 */
function compileFiles(
  starts: WorkspaceStarts,
  providers: StudioWorkspace['providers'],
  profiles: readonly string[],
) {
  const agents = Object.values(starts.agents).filter((agent) =>
    profiles.includes(agent.identity.agentId.trim()),
  );
  const here = new Set(agents.map((agent) => agent.key));
  // A tool that ran an agent the edits removed has no agent here to run.
  const toolSpecs = Object.values(starts.tools).filter(
    (tool) => tool.toolType !== 'agent' || here.has(tool.agentKey ?? ''),
  );
  const held = new Set(toolSpecs.map((tool) => tool.key));
  // The files run in the project, on its own setup.
  const compiled = compileWorkspace(
    {
      agents: agents.map((agent) => ({
        ...agent,
        tools: { ...agent.tools, allow: agent.tools.allow.filter((toolKey) => held.has(toolKey)) },
      })),
      toolSpecs,
      providers,
    },
    ON_OWN_KEYS,
  );
  return compiled.ok ? compiled : undefined;
}

/** The agent as the files hold it, from their compile. Undefined for an agent the files do not hold. */
function savedPayload(
  edits: StudioWorkspace,
  files: NonNullable<ReturnType<typeof compileFiles>>,
  payload: StudioRunPayload,
): StudioRunPayload | undefined {
  const key = edits.agents.find((agent) => agent.identity.agentId.trim() === payload.agentId)?.key;
  const start = key === undefined ? undefined : edits.starts.agents[key];
  const run = start && workspaceRunAgent(files, start.identity.agentId.trim());
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
  stated?: ChatProps['stated'];
  /** Where this side's profile answers: the files' own, or the load of the edits. */
  endpoint: string;
  /**
   * Which load of the edits the endpoint serves. A new load is a new transport, so the run reads
   * it again in place and keeps what it showed.
   */
  load?: string;
};

/** One profile on one endpoint, as its type runs: a chat, a decision, an embedding, a tool console, or a call. */
function SideRun({
  payload,
  endpoint,
  load,
  traces,
  note,
  trace,
  className,
  flush,
  columns,
  chatRef,
  slots,
  stated,
  context,
}: SideProps) {
  const { type } = payload.profile;
  // One per load, so each transport below is made again when the edits load again.
  const at = useMemo(() => ({ endpoint, load }), [endpoint, load]);
  const pageTools = useMemo(() => studioPageTools(payload), [payload]);
  const chats = isChat(payload);
  const { actingAs } = useActingAs();
  const chat = useMemo(
    () =>
      chats
        ? noting(tracedTransport(createHttpTransport, at.endpoint, traces, actingAs), note)
        : null,
    [chats, at, traces, actingAs, note],
  );
  const host = useMemo(
    () =>
      type === 'host'
        ? noting(tracedTransport(createHostTransport, at.endpoint, traces, actingAs), note)
        : null,
    [type, at, traces, actingAs, note],
  );
  const decision = useMemo(
    () =>
      type === 'decision'
        ? noting({ ...createDecisionTransport({ endpoint: at.endpoint }), traces }, note)
        : null,
    [type, at, traces, note],
  );
  const embedding = useMemo(
    () =>
      type === 'embedding'
        ? noting({ ...createEmbeddingTransport({ endpoint: at.endpoint }), traces }, note)
        : null,
    [type, at, traces, note],
  );
  if (chat)
    return (
      <TheoremChat
        detectCodeLanguage
        labels={STUDIO_LABELS}
        transport={chat}
        pageTools={pageTools}
        trace={trace}
        className={className}
        chatRef={chatRef}
        slots={slots}
        stated={stated}
        context={context}
      />
    );
  const view = { payload, trace, flush, columns, className };
  if (decision) return <DecisionView {...view} transport={decision} />;
  if (embedding) return <EmbeddingView {...view} transport={embedding} />;
  if (host) return <HostView {...view} transport={host} />;
  return (
    <ProjectLive
      payload={payload}
      endpoint={endpoint}
      note={note}
      trace={trace}
      slots={slots}
      stated={stated}
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
  statedOf,
  ...shared
}: Omit<RunProps, 'runtime' | 'tested'> & {
  project: ProjectSession;
  saved: StudioRunPayload | undefined;
  edits: StudioWorkspace;
}) {
  const { answer, pending } = useEditedLoad(project, edits, false);
  const stamp = useLoadedStamp(answer);
  const refused = answer && !answer.ok && !pending ? answer : undefined;
  const stated = useLoadedStated(statedOf?.(payload), !pending && !refused);
  const isSavedHidden = useSavedHidden();
  // The edited side's own feed, so its traces are not the files' side's.
  const [editedTraces] = useState(createTraceFeed);
  return (
    <HStack height="100%">
      <SavedSlot isShown={!isSavedHidden} hasDivider>
        {saved && (
          <SavedSide>
            <SideRun
              {...shared}
              payload={saved}
              stated={statedOf?.(saved)}
              endpoint={projectProfileEndpoint(project, saved.agentId)}
              traces={traces}
            />
          </SavedSide>
        )}
      </SavedSlot>
      <div key="edited" className="studio-edited-slot">
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
          {stamp !== undefined && (
            <SideRun
              {...shared}
              load={stamp}
              payload={payload}
              stated={stated}
              endpoint={editedProfileEndpoint(project, payload.agentId)}
              traces={editedTraces}
              chatRef={chatRef}
            />
          )}
        </EditedSide>
      </div>
    </HStack>
  );
}

/**
 * A project's profile, run by the studio's local server: the project's own tools and models.
 * While the builder has edits the files do not hold, it runs twice, side by side: as the files,
 * and as the files with the edits laid over them. Two chats share one message.
 */
function ProjectRun({
  project,
  tested,
  ...run
}: Omit<RunProps, 'runtime'> & { project: ProjectSession }) {
  const { payload, statedOf } = run;
  const edits = useMemo(() => unsavedEdits(tested, project.profiles), [tested, project.profiles]);
  const starts = edits?.starts;
  const providers = edits?.providers;
  // why: Choosing another agent or node changes neither the files nor the providers, so they compile once.
  const files = useMemo(
    () => (starts && providers ? compileFiles(starts, providers, project.profiles) : undefined),
    [starts, providers, project.profiles],
  );
  const saved = useMemo(
    () => (edits && files ? savedPayload(edits, files, payload) : undefined),
    [edits, files, payload],
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
        conversation={run.conversation}
        conversationView={run.conversationView}
        initialText={run.initialText}
        initialFiles={run.initialFiles}
        initialVoice={run.initialVoice}
        initialPending={run.initialPending}
        onConversationChange={run.onConversationChange}
        chatRef={run.chatRef}
        slots={run.slots}
        stated={statedOf?.(payload)}
        savedStated={statedOf?.(saved ?? payload)}
        context={run.context}
      />
    );
  if (!edits)
    return (
      <SideRun
        {...run}
        stated={statedOf?.(payload)}
        endpoint={projectProfileEndpoint(project, payload.agentId)}
      />
    );
  return <ProjectSides {...run} project={project} saved={saved} edits={edits} />;
}
function TurnRun({
  payload,
  runtime,
  traces,
  trace,
  className,
  note,
  conversation,
  conversationView,
  initialText,
  initialFiles,
  initialVoice,
  initialPending,
  onConversationChange,
  chatRef,
  slots,
  statedOf,
  context,
}: RunProps) {
  const stated = statedOf?.(payload);
  const iface = useMemo(() => studioInterface(payload), [payload]);
  /** The studio's page answers each page tool with the tool's stub. */
  const pageTools = useMemo(() => studioPageTools(payload), [payload]);
  const transport = useMemo(
    () =>
      noting(
        runtime
          ? createBrowserStudioTransport(payload, runtime, {
              conversationKey: pageConversationKey(),
              traces,
            })
          : createStudioTransport(payload, { traces }),
        note,
      ),
    [payload, runtime, traces, note],
  );
  return iface.type === 'live' ? (
    <StudioLive
      payload={payload}
      runtime={runtime}
      note={note}
      trace={trace}
      slots={slots}
      stated={stated}
      context={context}
    />
  ) : (
    <TheoremChat
      detectCodeLanguage
      labels={STUDIO_LABELS}
      transport={transport}
      trace={trace}
      className={className}
      conversation={conversation}
      conversationView={conversationView}
      initialText={initialText}
      initialFiles={initialFiles}
      initialVoice={initialVoice}
      initialPending={initialPending}
      onConversationChange={onConversationChange}
      chatRef={chatRef}
      slots={slots}
      stated={stated}
      context={context}
      pageTools={pageTools}
    />
  );
}
