import { Center } from '@astryxdesign/core/Center';
import type { ChatComposerInputHandle } from '@astryxdesign/core/Chat';
import { Divider } from '@astryxdesign/core/Divider';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import {
  type ComposerMenuAction,
  type ComposerPendingKind,
  type ComposerPendingMessage,
  type ComposerProfileInterface,
  createComposerPendingMessage,
  orderComposerPendingMessages,
  removeComposerPendingMessage,
} from '@theoremjs/agents/interface';
import {
  ChatComposerBar,
  DEFAULT_CHAT_MAX_WIDTH,
  InPlace,
  PaneFailure,
  PaneLoading,
  TheoremChat,
  type TheoremChatHandle,
} from '@theoremjs/react/ui';
import {
  type ChatController,
  type ChatState,
  type ClientFailure,
  clientFailure,
  composerFieldsFromDraft,
  composerHasPayload,
  createHttpTransport,
  createTraceFeed,
  encodeComposerDraft,
  followGenerationDefaults,
  type SendTextOptions,
  type TraceFeed,
} from '@theoremjs/web/client';
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { atStart, type StudioWorkspace } from '../mod.ts';
import type { EditedAnswer, SaveRefusal } from '../server/save-wire.ts';
import { useActingAs } from './lib/acting-as.ts';
import { runsAsConversation } from './lib/conversation-types.ts';
import { tracedTransport } from './lib/project-traces.ts';
import { noting } from './lib/studio-activity.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';
import {
  editedProfileEndpoint,
  openEdited,
  type ProjectSession,
  projectProfileEndpoint,
} from './lib/studio-project.ts';
import { RefusalDetail } from './refusal-detail.tsx';

type Side = 'saved' | 'edited';
const SIDES: readonly Side[] = ['saved', 'edited'];

/** Why the edits are not running, as the builder reads it. */
const NOT_RUNNING: Partial<Record<SaveRefusal['reason'], string>> = {
  issues: 'Fix the issues in the editor to run your edits.',
  load: 'The project did not start with your edits.',
  differs: 'The studio cannot run these edits before they are saved.',
  unanswered: 'The studio did not answer.',
};

/** A server that did not answer, as a refusal the pane can show. */
function unreachable(saved: string[]) {
  return (error: unknown): EditedAnswer => ({
    ok: false,
    reason: 'unanswered',
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
 * The stamp of the last load of the edits that ran. A refused load leaves the one before it
 * standing under the refusal, so the edited side keeps what it showed; with no edits, none.
 */
export function useLoadedStamp(answer: EditedAnswer | undefined): string | undefined {
  const [loaded, setLoaded] = useState<string>();
  const now = answer === undefined ? undefined : answer.ok ? answer.stamp : loaded;
  if (now !== loaded) setLoaded(now);
  return now;
}

/** A side's chat as it stands, and as it changes. Null until the side is mounted. */
function useSideState(chat: ChatController | null): ChatState | null {
  const subscribe = useCallback(
    (listener: () => void) => (chat ? chat.subscribe(listener) : () => {}),
    [chat],
  );
  return useSyncExternalStore(subscribe, () => chat?.getState() ?? null);
}

/**
 * The two sides' chats, and which of them still answers. A side rests when its turn is done: the
 * reply ended, and any question it stopped on was answered.
 */
function usePair() {
  const handles = useRef<Record<Side, TheoremChatHandle | null>>({ saved: null, edited: null });
  const [chats, setChats] = useState<Record<Side, ChatController | null>>({
    saved: null,
    edited: null,
  });
  const [refs] = useState(() => {
    const ref = (side: Side) => (handle: TheoremChatHandle | null) => {
      handles.current[side] = handle;
      const chat = handle?.controller ?? null;
      setChats((now) => (now[side] === chat ? now : { ...now, [side]: chat }));
    };
    return { saved: ref('saved'), edited: ref('edited') };
  });
  const states = { saved: useSideState(chats.saved), edited: useSideState(chats.edited) };
  const busy = SIDES.filter((side) => states[side] && states[side].phase !== 'idle');
  const send = useCallback(async (text: string, options?: SendTextOptions) => {
    const sent = SIDES.flatMap((side) => {
      const chat = handles.current[side]?.controller;
      return chat ? [[side, chat] as const] : [];
    });
    // A side's send resolves once its reply is done, or at once when it could not take it.
    const answers = sent.map(
      async ([side, chat]) => [side, await chat.sendText(text, options).catch(() => null)] as const,
    );
    return new Map(await Promise.all(answers));
  }, []);
  const stop = useCallback(() => {
    for (const side of SIDES) handles.current[side]?.stop();
  }, []);
  return { busy, send, stop, refs, handles, chats, states };
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
      <RefusalDetail refusal={refusal} />
    </PaneFailure>
  );
}

/** The phase the shared composer shows: streaming while either side streams, else gated while either waits. */
function pairPhase(states: readonly ChatState[]): ChatState['phase'] {
  if (states.some((state) => state.phase === 'streaming')) return 'streaming';
  return states.some((state) => state.phase === 'gated') ? 'gated' : 'idle';
}

function allowsSteering(state: ChatState): boolean {
  return state.iface != null && 'allowSteering' in state.iface && state.iface.allowSteering;
}

/** Each side's pending messages, once each: both sides hold a shared message under one id. */
function pairPending(states: readonly ChatState[]): ComposerPendingMessage[] {
  const byId = new Map(
    states.flatMap((state) => state.pendingMessages.map((message) => [message.id, message])),
  );
  return orderComposerPendingMessages([...byId.values()]);
}

/** Whether a side's running turn would take a steer now. */
const takesSteer = (state: ChatState): boolean =>
  state.phase === 'streaming' && allowsSteering(state);

type SideChat = { chat: ChatController; state: ChatState };

/** The shared composer's model and effort, and whether the builder chose them. */
type SharedPick = {
  model?: string;
  effort?: string;
  of?: ComposerProfileInterface;
  isChosen: boolean;
};

/**
 * The one composer of both sides. It only types for them: each side does with what is sent what
 * its own composer would. An idle side sends it, a busy one queues it; a steer goes to each side
 * whose running turn takes one; and each side refuses a model or file its profile does not take.
 */
function SharedComposer({
  sides,
  edited,
  inputRef,
}: {
  sides: readonly SideChat[];
  edited: ChatState;
  inputRef: RefObject<ChatComposerInputHandle | null>;
}) {
  const iface = edited.iface ?? undefined;
  const [draftText, setDraftText] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingVoice, setPendingVoice] = useState<File[]>([]);
  const [failure, setFailure] = useState<ClientFailure | null>(null);
  const [pick, setPick] = useState<SharedPick>({ isChosen: false });
  // The pick follows the edited side's profile as a chat's own composer follows its profile.
  if (iface && pick.of !== iface) {
    const next = followGenerationDefaults(iface, pick, pick.of);
    setPick({ ...next, of: iface, isChosen: pick.isChosen && next.model === pick.model });
  }
  const states = sides.map((side) => side.state);
  const phase = pairPhase(states);
  if (!iface) return null;
  // Unchosen, each side runs its own defaults: an edit to the defaults is what the two show.
  const chosen = pick.isChosen ? { model: pick.model, effort: pick.effort } : {};
  const options = (): SendTextOptions => ({ files: pendingFiles, voice: pendingVoice, ...chosen });
  const message = async (kind: ComposerPendingKind) =>
    createComposerPendingMessage({
      kind,
      draft: await encodeComposerDraft({ text: draftText, pendingFiles, pendingVoice }),
    });
  const clear = () => {
    setDraftText('');
    setPendingFiles([]);
    setPendingVoice([]);
  };
  const takePick = (chat: ChatController) => {
    if (chosen.model !== undefined)
      chat.setGeneration({ modelId: chosen.model, effort: chosen.effort });
  };
  /** Each side as its own composer would: an idle side sends, a busy one takes `kind`. */
  const deliver = async (kind: ComposerMenuAction) => {
    const text = draftText;
    const sent = options();
    let shared: ComposerPendingMessage;
    try {
      shared = await message(kind === 'send_now' ? 'queue' : kind);
    } catch (error) {
      // The draft stays in the composer, with why it could not go.
      setFailure(clientFailure(error, iface.labels));
      return;
    }
    setFailure(null);
    clear();
    for (const { chat, state } of sides) {
      if (kind === 'steer') {
        if (takesSteer(state)) void chat.pend(shared);
        continue;
      }
      if (kind === 'stash') {
        void chat.pend(shared);
        continue;
      }
      // why: reading the attachments took time, and a side may have finished or started since.
      if (chat.getState().phase === 'idle') {
        void chat.sendText(text, sent);
        continue;
      }
      takePick(chat);
      void (kind === 'send_now' ? chat.sendNow(shared) : chat.pend(shared));
    }
  };
  const each = (act: (chat: ChatController) => void) => {
    for (const { chat } of sides) act(chat);
  };
  const pending = pairPending(states);
  return (
    <SharedDock>
      <ChatComposerBar
        // why: a steer goes only to a running turn, so one that no side would take is not offered.
        iface={{
          ...iface,
          ...('allowSteering' in iface
            ? { allowSteering: sides.some(({ state }) => takesSteer(state)) }
            : {}),
        }}
        draftText={draftText}
        pendingFiles={pendingFiles}
        pendingVoice={pendingVoice}
        pendingMessages={pending}
        issues={[]}
        phase={phase}
        failure={failure}
        selectedModel={pick.model}
        selectedEffort={pick.effort}
        placeholder="Message both"
        inputRef={inputRef}
        onDraftTextChange={setDraftText}
        onFilesSelected={(files) => {
          setPendingFiles((prev) => [...prev, ...files]);
        }}
        onAttachmentRemove={(index) => {
          setPendingFiles((prev) => prev.filter((_, at) => at !== index));
        }}
        onVoiceStaged={(file) => {
          setPendingVoice([file]);
        }}
        onVoiceClear={() => {
          setPendingVoice([]);
        }}
        onSubmit={() => {
          void deliver('queue');
        }}
        onStop={() => {
          each((chat) => {
            chat.stop();
          });
        }}
        onMenuAction={(action) => {
          void deliver(action);
        }}
        onGenerationChange={(next) => {
          setPick({ model: next.modelId, effort: next.effort, of: iface, isChosen: true });
        }}
        slotChoices={
          edited.slots && {
            ...edited.slots,
            onChange: (name, value) => {
              each((chat) => {
                chat.pickSlot(name, value);
              });
            },
          }
        }
        onPendingMove={(id, direction) => {
          each((chat) => {
            chat.movePending(id, direction);
          });
        }}
        onPendingRemove={(id) => {
          each((chat) => {
            chat.setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
          });
        }}
        onPendingQueue={(id) => {
          each((chat) => {
            chat.queuePending(id);
          });
        }}
        onPendingRestore={(id) => {
          void (async () => {
            const restored = pending.find((held) => held.id === id);
            if (!restored) return;
            // As a chat restores: what the composer holds is stashed first.
            if (composerHasPayload(draftText, pendingFiles, pendingVoice)) await deliver('stash');
            each((chat) => {
              chat.setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
            });
            const fields = composerFieldsFromDraft(restored.draft);
            setDraftText(fields.text);
            setPendingFiles(fields.files);
            setPendingVoice(fields.voice);
          })();
        }}
        onPendingSendNow={(id) => {
          for (const { chat, state } of sides) {
            const held = state.pendingMessages.find((m) => m.id === id);
            if (!held) continue;
            takePick(chat);
            void chat.sendNow(held);
          }
        }}
      />
    </SharedDock>
  );
}

/**
 * Where the shared composer sits: the width and inset of a chat's own dock.
 * why: it sits outside both chats' layouts, so it brings the 12px sides and 24px below they give.
 */
function SharedDock({ children }: { children: ReactNode }) {
  return (
    <VStack paddingInline={3} paddingBlockEnd={6}>
      <Center axis="horizontal" width="100%">
        <VStack width="100%" maxWidth={DEFAULT_CHAT_MAX_WIDTH}>
          {children}
        </VStack>
      </Center>
    </VStack>
  );
}

/** The composer while the edits cannot take a message: it says why. */
function WaitingComposer({ handle, why }: { handle: string; why: string }) {
  return (
    <SharedDock>
      <ChatComposerBar
        handle={handle}
        draftText=""
        onDraftTextChange={() => {}}
        onSubmit={() => {}}
        isDisabled
        placeholder={why}
      />
    </SharedDock>
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

/** Why a message cannot go to both sides now, when it cannot. */
function whyNot(failed: boolean, isReady: boolean): string | undefined {
  if (failed) return 'Your edits are not running';
  return isReady ? undefined : 'Loading your edits';
}

/**
 * Each side's latest conversation ref, so a side that comes back, or the edited side when its load
 * is replaced, starts from what was said. Every load seals with the studio run's one key, so the
 * edited side opens the files' side's ref and goes on from there on its own.
 */
function useConversations(isEditing: boolean) {
  const conversations = useRef<Partial<Record<Side, string>>>({});
  if (!isEditing) conversations.current.edited = undefined;
  const [onChange] = useState(() => {
    const change = (side: Side) => (ref: string | undefined) => {
      conversations.current[side] = ref;
    };
    return { saved: change('saved'), edited: change('edited') };
  });
  return { conversations, onChange };
}

/** Where each side sends: the files' profile, and the edited load's once there is one. */
function useTransports(
  project: ProjectSession,
  ids: { saved: string; edited: string },
  stamp: string | undefined,
  { note, traces }: Pick<ProjectChatProps, 'note' | 'traces'>,
) {
  const { actingAs } = useActingAs();
  const saved = useMemo(() => {
    const endpoint = projectProfileEndpoint(project, ids.saved);
    return noting(tracedTransport(createHttpTransport, endpoint, traces, actingAs), note);
  }, [project, ids.saved, traces, actingAs, note]);
  // One feed for the edited side, so a new load keeps the traces of the turns it starts from.
  const [editedTraces] = useState(createTraceFeed);
  const edited = useMemo(() => {
    if (stamp === undefined) return null;
    const endpoint = editedProfileEndpoint(project, ids.edited);
    return noting(tracedTransport(createHttpTransport, endpoint, editedTraces, actingAs), note);
  }, [project, ids.edited, stamp, editedTraces, actingAs, note]);
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
      <InPlace view={refused ? <NotRunning refusal={refused} actions={actions} /> : null}>
        {children}
      </InPlace>
      {isLoading && <PaneLoading label="Loading your edits" />}
    </Pane>
  );
}

/** What the comparison shows now: which sides there are, and what each one runs. */
function useComparison({ project, profileId, tested, note, traces }: ProjectChatProps) {
  const edits = useMemo(() => unsavedEdits(tested, project.profiles), [tested, project.profiles]);
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
  const chatsInFiles = !saved || runsAsConversation(saved.profileType);
  const inFiles =
    !isEditing || (chatsInFiles && (answer?.saved ?? project.profiles).includes(ids.saved));
  const { conversations, onChange } = useConversations(isEditing);
  const stamp = useLoadedStamp(answer);
  const transports = useTransports(project, ids, stamp, { note, traces });
  const refused = answer && !answer.ok && !pending ? answer : undefined;
  return {
    pair,
    isBusy,
    isEditing,
    inFiles,
    /** Both sides are there, so one message goes to both. */
    isShared: isEditing && inFiles,
    conversations,
    onChange,
    transports,
    refused,
    isReady: !pending && !refused && transports.edited !== null,
  };
}

/**
 * The chat the page holds: a message goes to both sides while both are there and can take it, and
 * to the one side otherwise. It answers with what the edits said, and its controller is theirs.
 */
function useChatHandle(
  chatRef: Ref<TheoremChatHandle> | undefined,
  pair: ReturnType<typeof usePair>,
  only: Side | undefined,
  canSendBoth: boolean,
  sharedInput: RefObject<ChatComposerInputHandle | null>,
) {
  const { send, stop, handles } = pair;
  useImperativeHandle(
    chatRef,
    () => ({
      send: (text, options) => {
        if (only) return handles.current[only]?.send(text, options) ?? Promise.resolve(null);
        if (!canSendBoth) return Promise.resolve(null);
        return send(text, options).then((answers) => answers.get('edited') ?? null);
      },
      stop,
      focus: () => {
        if (only) handles.current[only]?.focus();
        else sharedInput.current?.focus();
      },
      get controller() {
        const chat = handles.current[only ?? 'edited']?.controller;
        if (!chat) throw new Error('The chat is not open yet.');
        return chat;
      },
    }),
    [only, canSendBoth, send, stop, handles, sharedInput],
  );
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
  const sharedInput = useRef<ChatComposerInputHandle | null>(null);
  useChatHandle(chatRef, pair, only, !isBusy && isReady, sharedInput);
  const shared = SIDES.flatMap((side) => {
    const chat = pair.chats[side];
    const state = pair.states[side];
    return chat && state ? [{ chat, state }] : [];
  });
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
                  conversation={view.conversations.current.saved}
                  onConversationChange={view.onChange.saved}
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
                    // A new load is a new transport: the chat reads it in place and keeps its transcript.
                    transport={transports.edited}
                    conversation={
                      view.conversations.current.edited ?? view.conversations.current.saved
                    }
                    onConversationChange={view.onChange.edited}
                    // Under a refusal nothing reaches it: the edits it ran are not loaded.
                    chatRef={refused ? undefined : pair.refs.edited}
                  />
                )}
              </EditedSide>
            </div>
          )}
        </HStack>
      </StackItem>
      {isShared &&
        (isReady && pair.states.edited ? (
          <SharedComposer sides={shared} edited={pair.states.edited} inputRef={sharedInput} />
        ) : (
          <WaitingComposer
            handle={profileId}
            why={whyNot(refused !== undefined, isReady) ?? 'Loading your edits'}
          />
        ))}
    </VStack>
  );
}
