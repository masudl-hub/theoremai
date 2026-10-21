import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { useClipboard } from '@astryxdesign/core/hooks';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { TreeList, type TreeListItemData } from '@astryxdesign/core/TreeList';
import { VStack } from '@astryxdesign/core/VStack';
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconArrowBarToDown,
  IconArrowLeft,
  IconBrowserShare,
  IconCheck,
  IconCloud,
  IconCode,
  IconCopy,
  IconCopyPlus,
  IconFile,
  IconFileImport,
  IconFileSmile,
  IconFileZip,
  IconKey,
  IconMenu2,
  IconPlayerPlay,
  IconPlaylistX,
  IconPlus,
  IconRotateClockwise,
  IconSearch,
  IconSitemap,
  IconSparkles,
  IconTool,
  IconX,
} from '@tabler/icons-react';
import { type ProfileGraphFacetId, profileGraphFacet } from '@theoremjs/agents';
import {
  InPlace,
  PaneFailure,
  RaisedPane,
  type TheoremChatHandle,
  useDisclosureMotion,
} from '@theoremjs/react/ui';
import { canonical } from '../canonical.ts';
import {
  addAgent,
  addArchitectExample,
  addProvider,
  agentNodeId,
  type CompiledStudio,
  type CompiledWorkspace,
  compileWorkspace,
  createBlankDraft,
  createConsoleExampleDraft,
  createDecisionExampleDraft,
  createExampleDraft,
  createGeminiEmbeddingExampleDraft,
  createLiveExampleDraft,
  createNarratorExampleDraft,
  createStudioRunId,
  draftFacets,
  duplicateAgent,
  editedSince,
  excludeFacet,
  type FilesMerge,
  includableFacets,
  includeFacet,
  libraryDraft,
  localProviderAddress,
  mergedWithFiles,
  modelBindingNodeId,
  modelRoute,
  modelSharers,
  modelSlots,
  nodeOrigins,
  onStudioLocal,
  openOutcome,
  originLabel,
  originPlace,
  originWay,
  type ProjectCode,
  providerIdOf,
  providerNodeId,
  providerUse,
  rebased,
  removeAgent,
  removeLibraryTool,
  removeProvider,
  renameProvider,
  reopened,
  resetAgent,
  resetAgentNode,
  resetLibraryTool,
  resetProvider,
  type SharedEntry,
  type StudioDraft,
  type StudioIssue,
  type StudioNodeRef,
  type StudioProvider,
  type StudioRunPayload,
  type StudioTreeNode,
  type StudioWorkspace,
  sampleToolInput,
  saveStudioRunPayload,
  scopedNodeId,
  setToolAllowed,
  sharedAsk,
  sharedAt,
  sharedEntries,
  studioNodeRef,
  studioSource,
  studioTree,
  toolSpecKeyOf,
  type WorkspaceCompileResult,
  type WriteAsk,
  withAgentDraft,
  withFilesChosen,
  withProvider,
  workspaceNodeRef,
  workspaceRunAgent,
  workspaceTree,
  writeAsk,
} from '../mod.ts';
import type { StudioActingAs } from '../people.ts';
import type { OpenAnswer, SettingOrigin } from '../server/save-wire.ts';
import { type StudioSurfaceHost, studioSurface } from '../surface.ts';
import './studio.css';
import { type ConversationView, createTraceFeed, type TraceFeed } from '@theoremjs/web/client';
import {
  type CSSProperties,
  type Dispatch,
  lazy,
  memo,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import { ActingAsButton } from './acting-as-button.tsx';
import { AddProviderButton } from './add-provider.tsx';
import { IconTypeSafe, modelFamilyMark } from './brand-icons.tsx';
import { useConfirmWrite } from './confirm-write.tsx';
import {
  ConfirmWrite,
  GuardrailTest,
  ISSUE_ROW_ATTRIBUTE,
  LeavePage,
  ListBadges,
  LocalConnection,
  ProbedAgent,
  ProjectAsks,
  QuestionLink,
  RowOrigins,
  RunsOn,
  WorkspaceContext,
} from './inspector-context.ts';
import { ActingAsContext, chatKeyOf, useActingAsState } from './lib/acting-as.ts';
import { FACET_ICON } from './lib/facet-icons.ts';
import { movePanel } from './lib/panel-motion.ts';
import { screenEndpoint } from './lib/project-address.ts';
import { recordsTraces } from './lib/project-traces.ts';
import { sendWhenReady } from './lib/send-when-ready.ts';
import {
  type ChatSealer,
  clearConversation,
  restoreConversation,
  saveConversation,
} from './lib/studio-conversation.ts';
import { STUDIO_EXAMPLES } from './lib/studio-examples.ts';
import { pageInputsOf, sentPageValues, usePageValues } from './lib/studio-page.ts';
import { getPref, setPref } from './lib/studio-prefs.ts';
import {
  NO_ASKS,
  openInEditor,
  openProject,
  ProjectContext,
  type ProjectFiles,
  type ProjectSession,
  projectCode,
  readFiles,
  useProject,
} from './lib/studio-project.ts';
import { dropAside, keepReading, keptReading, setAside } from './lib/studio-restore.ts';
import { projectKey, type RestoredStudio } from './lib/studio-session.ts';
import {
  closeSettings,
  openSettings,
  settingsScreen,
  useSettingsDoor,
} from './lib/studio-settings.ts';
import { createStudioStore, type StudioStore } from './lib/studio-store.ts';
import { subscribeToFiles } from './lib/studio-watch.ts';
import { toolCredential } from './lib/tool-credentials.ts';
import { runToolProbe } from './lib/tool-probe.ts';
import { PROFILE_TYPE_ICON, toolTypeIcon } from './lib/type-icons.ts';
import { warmWhenIdle } from './lib/when-idle.ts';
import { addToolSpec, ProfileEditor } from './profile-editor.tsx';
import { ProviderEditor } from './provider-editor.tsx';
import { SharedChange } from './shared-change.tsx';
import { ChooseConflictsContext, FileConflicts } from './studio-conflicts.tsx';
import {
  type StudioConnectionState,
  StudioKeys,
  useStudioConnection,
} from './studio-connection.tsx';
import {
  type StudioHost,
  StudioHostContext,
  type StudioOpened,
  type StudioReport,
  useStudioHost,
} from './studio-host.ts';
import { NAV_WIDTH } from './studio-nav.ts';
import { StudioRunner, type StudioRunnerProps } from './studio-runner.tsx';
import { ProjectSave, ProjectTokens, useProjectSave } from './studio-save.tsx';
import { usePhone } from './use-phone.ts';

// The tester, Settings, the map and the code view load when they first open, or once the page is idle.
const testerPanel = () => import('./guardrail-health.tsx');
const settingsPanel = () => import('./studio-settings.tsx');
const mapPanel = () => import('./studio-map.tsx');
const codePane = () => import('./studio-code-pane.tsx');
const StudioMap = lazy(() => mapPanel().then((map) => ({ default: map.StudioMap })));
const CodeBody = lazy(() => codePane().then((code) => ({ default: code.CodeBody })));
const ProviderCode = lazy(() => codePane().then((code) => ({ default: code.ProviderCode })));
const GuardrailPane = lazy(() =>
  testerPanel().then((tester) => ({ default: tester.GuardrailPane })),
);
const traceReplay = () => import('./studio-trace-replay.tsx');
const TraceReplay = lazy(() => traceReplay().then((pane) => ({ default: pane.TraceReplay })));
const StudioSettings = lazy(() =>
  settingsPanel().then((settings) => ({ default: settings.StudioSettings })),
);

/** A node's icon; Identity shows the profile type's once one is picked. */
function nodeIcon(draft: StudioDraft, ref: StudioNodeRef) {
  const type = draft.identity.profileType;
  if (ref.facet === 'identity' && type) return PROFILE_TYPE_ICON[type];
  if (ref.facet === 'modelBinding') {
    const binding = draft.modelBindings.find((each) => each.key === ref.key);
    if (!binding) return FACET_ICON.modelBinding;
    const definition = draft.providers.find((each) => each.id === binding.provider)?.definition;
    if (definition === 'typesafe') return IconTypeSafe;
    return modelFamilyMark(binding.apiId) ?? FACET_ICON.modelBinding;
  }
  if (ref.facet !== 'toolSpec') return FACET_ICON[ref.facet];
  const tool = draft.toolSpecs.find((spec) => spec.key === ref.key);
  return tool ? toolTypeIcon(tool.toolType) : IconTool;
}

/**
 * What every row of one agent's tree reads: its draft, the selection, and how to change them.
 * Row ids are the draft's own; `scope` gives the workspace's, which the selection is in.
 */
interface TreeState {
  draft: StudioDraft;
  scope: (id: string) => string;
  selectedId: string;
  onSelect: (id: string) => void;
  setDraft: (next: StudioDraft | ((draft: StudioDraft) => StudioDraft)) => void;
  /** Puts the row `ref` names back to its start; undefined while it is at its start. */
  resetOf: (ref: StudioNodeRef, label: string) => (() => void) | undefined;
}

/** A row's hover action: stops at the button so the row itself isn't selected. */
function actionButton(label: string, icon: IconType, onPress: () => void) {
  return (
    <IconButton
      key={label}
      label={label}
      variant="ghost"
      size="sm"
      icon={<Icon icon={icon} size="sm" />}
      tooltip={label}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
    />
  );
}

function rowAction(label: string, icon: IconType, onPress: () => void) {
  return <span className="studio-tree-action">{actionButton(label, icon, onPress)}</span>;
}

/** A row's hover actions: Reset, while it differs from its start, then the others, the x last. */
function rowActions(
  label: string,
  reset: (() => void) | undefined,
  ...actions: ReactNode[]
): ReactNode {
  const shown = [reset && actionButton(`Reset ${label}`, IconRotateClockwise, reset), ...actions];
  return shown.some(Boolean) ? <span className="studio-tree-action">{shown}</span> : undefined;
}

function treeItem(tree: TreeState, node: StudioTreeNode, isTop = false): TreeListItemData {
  const { draft, scope, selectedId, onSelect, setDraft } = tree;
  const facet = node.ref.facet;
  const id = scope(node.id);
  const isOptional = isTop && facet !== 'toolSpec' && profileGraphFacet(facet)?.optional === true;
  const actions = rowActions(
    node.label,
    tree.resetOf(node.ref, node.label),
    isOptional &&
      actionButton(`Remove ${node.label}`, IconX, () => {
        setDraft((current) => excludeFacet(current, facet));
      }),
  );
  return {
    id,
    label: node.label,
    startContent: <Icon icon={nodeIcon(draft, node.ref)} size="sm" color="secondary" />,
    endContent: actions,
    className: actions ? 'studio-tree-row' : undefined,
    isSelected: id === selectedId,
    isExpanded: node.children.length > 0,
    onClick: () => {
      onSelect(id);
    },
    children: node.children.length
      ? node.children.map((child) => treeItem(tree, child))
      : undefined,
  };
}

/** An optional section the type allows but the draft leaves out: dimmed; a click adds it. */
function offItem(
  { scope, onSelect, setDraft }: TreeState,
  facet: ProfileGraphFacetId,
): TreeListItemData {
  const label = profileGraphFacet(facet)?.label ?? facet;
  const add = () => {
    setDraft((current) => includeFacet(current, facet));
    onSelect(scope(facet));
  };
  return {
    id: scope(facet),
    label: <span className="studio-tree-off">{label}</span>,
    startContent: (
      <Icon icon={FACET_ICON[facet as keyof typeof FACET_ICON]} size="sm" color="disabled" />
    ),
    endContent: rowAction(`Add ${label}`, IconPlus, add),
    className: 'studio-tree-row',
    onClick: add,
  };
}

/**
 * One agent: its root row, labelled with its id, holds every section the profile type allows, in
 * catalog order, optional ones left out dimmed. Only the open agent shows its sections. Its tools
 * are picked in its Tools section; the library lists them once for every agent.
 */
function agentItem(
  tree: TreeState,
  isOpen: boolean,
  actions: TreeListItemData['endContent'],
): TreeListItemData {
  const draft = { ...tree.draft, toolSpecs: [] };
  const root = studioTree(draft);
  const shown = new Map(root.children.map((node) => [node.id, node]));
  const off = includableFacets(draft);
  const all = draftFacets({ ...draft, included: [...draft.included, ...off] }).filter(
    (facet) => facet !== 'identity',
  );
  const children = all.map((facet) => {
    const node = shown.get(facet);
    return node ? treeItem(tree, node, true) : offItem(tree, facet);
  });
  return {
    ...treeItem(tree, { ...root, children: [] }),
    endContent: actions,
    className: 'studio-tree-row',
    isExpanded: isOpen,
    children: isOpen ? children : undefined,
  };
}

/** What the tree reads of the page: the workspace, the open agent, and how to change them. */
interface WorkspaceTreeState {
  workspace: StudioWorkspace;
  focus: string;
  selectedId: string;
  /** The list the sidebar shows: agents, tools, or providers. */
  list: WorkspaceList;
  /** The providers are the project's own, so they can be added and removed. */
  ownsProviders: boolean;
  setList: (next: WorkspaceList) => void;
  onSelect: (id: string) => void;
  update: (change: (workspace: StudioWorkspace) => StudioWorkspace) => void;
  setDraft: TreeState['setDraft'];
  /** Puts the workspace as `to` holds it, with a toast that can undo it; undefined when `to` is the workspace. */
  reset: (to: StudioWorkspace, body: string) => (() => void) | undefined;
  /** The Keys page, opened from the providers list. Null where the host keeps keys in its Settings. */
  keys: { open: boolean; toggle: () => void } | null;
}

function agentItems(state: WorkspaceTreeState): TreeListItemData[] {
  const { workspace, focus, selectedId, onSelect, update, setDraft, reset } = state;
  const isOnly = workspace.agents.length === 1;
  return workspace.agents.map((agent) => {
    const draft = libraryDraft(workspace, agent.key) ?? createBlankDraft();
    const name = agent.identity.agentId || 'this agent';
    return agentItem(
      {
        draft,
        scope: (id) => scopedNodeId(agent.key, id),
        selectedId,
        onSelect,
        setDraft,
        resetOf: (ref, label) =>
          reset(resetAgentNode(workspace, agent.key, ref), `Reset ${label} to how it started.`),
      },
      agent.key === focus,
      rowActions(
        name,
        reset(resetAgent(workspace, agent.key), `Reset ${name} to how it started.`),
        actionButton(`Duplicate ${name}`, IconCopyPlus, () => {
          update((current) => duplicateAgent(current, agent.key));
        }),
        !isOnly &&
          actionButton(`Remove ${name}`, IconX, () => {
            update((current) => removeAgent(current, agent.key));
          }),
      ),
    );
  });
}

/** The tool library, every agent picks its tools from these: those whose name or description holds `query`. */
function toolItems(
  { workspace, selectedId, onSelect, update, reset }: WorkspaceTreeState,
  query: string,
) {
  const needle = query.trim().toLowerCase();
  return workspaceTree(workspace).tools.flatMap((node): TreeListItemData[] => {
    const tool = workspace.toolSpecs.find((spec) => spec.key === toolSpecKeyOf(node.id));
    const text = `${node.label} ${tool?.description ?? ''}`.toLowerCase();
    if (needle && !text.includes(needle)) return [];
    return [
      {
        id: node.id,
        label: node.label,
        startContent: (
          <Icon icon={tool ? toolTypeIcon(tool.toolType) : IconTool} size="sm" color="secondary" />
        ),
        endContent: rowActions(
          node.label,
          tool &&
            reset(resetLibraryTool(workspace, tool.key), `Reset ${node.label} to how it started.`),
          actionButton(`Remove ${node.label}`, IconX, () => {
            if (tool) update((current) => removeLibraryTool(current, tool.key));
          }),
        ),
        className: 'studio-tree-row',
        isSelected: node.id === selectedId,
        onClick: () => {
          onSelect(node.id);
        },
        style: CHEVRON_COLUMN,
      },
    ];
  });
}

/** Where a shared setting is declared: its real name and its file. */
function declaredAt({ setting }: SharedEntry): string {
  return `${setting.name} · ${setting.file}:${String(setting.line)}`;
}

/**
 * The providers every agent's models pick from, each over the agents with a model on it. A
 * provider's row opens its own settings; an agent's opens its first model there.
 */
function providerItems(tree: WorkspaceTreeState): TreeListItemData[] {
  const { workspace, selectedId, onSelect, update, ownsProviders, reset } = tree;
  return workspace.providers.map((provider) => {
    const id = providerNodeId(provider.id);
    // One a model runs on stays: its row lists the agents to move first.
    const isFree = ownsProviders && providerUse(workspace, provider.id).models === 0;
    const users = workspace.agents.flatMap((agent): TreeListItemData[] => {
      const binding = agent.modelBindings.find((each) => each.provider === provider.id);
      if (!binding) return [];
      return [
        {
          id: `${id}:${agent.key}`,
          label: agent.identity.agentId || 'New agent',
          startContent: (
            <Icon
              icon={PROFILE_TYPE_ICON[agent.identity.profileType || 'text']}
              size="sm"
              color="secondary"
            />
          ),
          onClick: () => {
            onSelect(agentNodeId(agent.key, modelBindingNodeId(binding.key)));
          },
        },
      ];
    });
    const actions = rowActions(
      provider.id,
      reset(resetProvider(workspace, provider.id), `Reset ${provider.id} to how it started.`),
      isFree &&
        actionButton(`Remove ${provider.id}`, IconX, () => {
          update((current) => removeProvider(current, provider.id));
          const [first] = workspace.agents;
          if (selectedId === id && first) onSelect(agentNodeId(first.key));
        }),
    );
    return {
      id,
      label: provider.id,
      startContent: <Icon icon={IconCloud} size="sm" color="secondary" />,
      endContent: actions,
      className: actions ? 'studio-tree-row' : undefined,
      isSelected: selectedId === id,
      onClick: () => {
        onSelect(id);
      },
      isExpanded: true,
      children: users,
    };
  });
}

/** Which of the workspace's lists the sidebar shows. */
type WorkspaceList = 'agents' | 'tools' | 'providers';

/**
 * Which list shows, following the selection, and the tool search. The open row stays in view: a
 * tool far down the library, one an issue opened, or one a cleared search or the toggle shows
 * again. Revealed after the list renders.
 */
function useWorkspaceList(selectedId: string, listRef: RefObject<HTMLDivElement | null>) {
  const [query, setQuery] = useState('');
  const revealSelected = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, [listRef]);
  useEffect(() => {
    // Nothing is selected while Keys is open.
    if (selectedId) revealSelected();
  }, [selectedId, revealSelected]);
  return { query, setQuery, revealSelected };
}

/**
 * Which list shows: the tools library once a tool is open, the providers once a provider is, and
 * whatever the toggle last chose. Following the selection, it switches when the open row changes
 * between an agent, a tool, and a provider.
 */
function useListShown(selectedId: string) {
  const isTool = toolSpecKeyOf(selectedId) !== undefined;
  const isProvider = providerIdOf(selectedId) !== undefined;
  const [list, setList] = useState<WorkspaceList>(
    isTool ? 'tools' : isProvider ? 'providers' : 'agents',
  );
  const [shownFor, setShownFor] = useState(selectedId);
  if (shownFor !== selectedId) {
    setShownFor(selectedId);
    // A provider's rows open the models on it, so an agent's row keeps the providers shown.
    setList((current) =>
      isTool ? 'tools' : isProvider ? 'providers' : current === 'tools' ? 'agents' : current,
    );
  }
  return { list, setList };
}

/** The toggle between the agents, the tool library, and the providers, each with its count. */
function WorkspaceListToggle({
  workspace,
  list,
  onChange,
}: {
  workspace: StudioWorkspace;
  list: WorkspaceList;
  onChange: (next: WorkspaceList) => void;
}) {
  return (
    <SegmentedControl
      label="Workspace list"
      size="sm"
      layout="fill"
      value={list}
      onChange={(next) => {
        onChange(next === 'tools' || next === 'providers' ? next : 'agents');
      }}
    >
      {WORKSPACE_LISTS.map(({ value, name, icon }) => {
        const count = String(
          {
            agents: workspace.agents.length,
            tools: workspace.toolSpecs.length,
            providers: workspace.providers.length,
          }[value],
        );
        return (
          <Tooltip key={value} content={`${name} · ${count}`}>
            <SegmentedControlItem
              value={value}
              label={`${name}, ${count}`}
              isLabelHidden
              icon={<Icon icon={icon} size="sm" />}
            />
          </Tooltip>
        );
      })}
    </SegmentedControl>
  );
}

/** The sidebar's lists, as icons: a name and its count would not fit the nav's width. */
const WORKSPACE_LISTS: readonly { value: WorkspaceList; name: string; icon: IconType }[] = [
  { value: 'agents', name: 'Agents', icon: IconFileSmile },
  { value: 'tools', name: 'Tools', icon: IconTool },
  { value: 'providers', name: 'Providers', icon: IconCloud },
];

interface ExampleEntry {
  id: string;
  label: string;
  description: string;
  icon: IconType;
}

/** What an Add agent item does to the workspace. */
type AddAgent = (workspace: StudioWorkspace) => StudioWorkspace;

/** Makes the draft first, since an example may load its pictures, then adds it to whichever workspace is current. */
const addsDraft =
  (draft: () => StudioDraft | Promise<StudioDraft>) => async (): Promise<AddAgent> => {
    const made = await draft();
    return (workspace) => addAgent(workspace, made);
  };

/** The examples, in the order the menu lists them. The architect brings its narrator. */
const EXAMPLE_AGENTS: readonly (ExampleEntry & { add: () => Promise<AddAgent> })[] = [
  {
    id: 'concierge',
    ...STUDIO_EXAMPLES.concierge,
    icon: PROFILE_TYPE_ICON.text,
    add: addsDraft(createExampleDraft),
  },
  {
    id: 'live-concierge',
    ...STUDIO_EXAMPLES['live-concierge'],
    icon: PROFILE_TYPE_ICON.live,
    add: addsDraft(createLiveExampleDraft),
  },
  {
    id: 'architect',
    ...STUDIO_EXAMPLES.architect,
    icon: PROFILE_TYPE_ICON.text,
    add: () => Promise.resolve(addArchitectExample),
  },
  {
    id: 'narrator',
    ...STUDIO_EXAMPLES.narrator,
    icon: PROFILE_TYPE_ICON.speech,
    add: addsDraft(createNarratorExampleDraft),
  },
  {
    id: 'console',
    ...STUDIO_EXAMPLES.console,
    icon: PROFILE_TYPE_ICON.host,
    add: addsDraft(createConsoleExampleDraft),
  },
  {
    id: 'decision',
    ...STUDIO_EXAMPLES.decision,
    icon: PROFILE_TYPE_ICON.decision,
    add: addsDraft(createDecisionExampleDraft),
  },
  {
    id: 'gemini-embedding-2',
    ...STUDIO_EXAMPLES['gemini-embedding-2'],
    icon: PROFILE_TYPE_ICON.embedding,
    add: addsDraft(createGeminiEmbeddingExampleDraft),
  },
];

/** Adds a blank agent or one of the examples. */
/** As wide as the row, and no wider: the description does not widen the menu its labels size. */
const ROW_WIDE = { inlineSize: 0, minInlineSize: '100%' };

/** A menu row's description on one line. What does not fit shows on hover. */
const oneLine = (text: string) => (
  <Text type="supporting" color="secondary" maxLines={1} hasTruncateTooltip="end" style={ROW_WIDE}>
    {text}
  </Text>
);

function AddAgentMenu({ onAddAgent }: { onAddAgent: (add: AddAgent) => void }) {
  return (
    <DropdownMenu
      button={{
        label: 'Add agent',
        variant: 'ghost',
        size: 'sm',
        width: '100%',
        icon: <Icon icon={IconPlus} size="sm" />,
        style: { height: 'calc(var(--size-element-sm) - 4px)' },
      }}
      hasChevron={false}
      placement="below"
      items={[
        {
          id: 'blank',
          label: 'Blank agent',
          description: oneLine('One empty agent to build from.'),
          icon: <Icon icon={IconFile} size="sm" />,
          onClick: () => {
            void addsDraft(createBlankDraft)().then(onAddAgent);
          },
        },
        ...EXAMPLE_AGENTS.map((example) => ({
          id: example.id,
          label: example.label,
          description: oneLine(example.description),
          icon: <Icon icon={example.icon} size="sm" />,
          onClick: () => {
            void example.add().then(onAddAgent);
          },
        })),
      ]}
    />
  );
}

/** Adds a tool to the library, joined to the open agent, and opens it. */
function AddToolButton({ tree, draft }: { tree: WorkspaceTreeState; draft: StudioDraft }) {
  return (
    <Button
      label="Add tool"
      variant="ghost"
      size="sm"
      width="100%"
      icon={<Icon icon={IconPlus} size="sm" />}
      style={{ height: 'calc(var(--size-element-sm) - 4px)' }}
      onClick={() => {
        addToolSpec(draft, tree.setDraft, tree.onSelect);
      }}
    />
  );
}

/** Filters the tool library by name or description. */
function ToolSearchInput({ query, onChange }: { query: string; onChange: (next: string) => void }) {
  return (
    <TextInput
      label="Search tools"
      isLabelHidden
      size="sm"
      placeholder="Search tools"
      value={query}
      onChange={onChange}
      startIcon={IconSearch}
      hasClear
    />
  );
}

/** The shown list's rows, or why there are none. */
function WorkspaceListBody({
  tree,
  list,
  tools,
  query,
  listRef,
}: {
  tree: WorkspaceTreeState;
  list: WorkspaceList;
  tools: TreeListItemData[];
  query: string;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <ScrollableArea ref={listRef} label="Workspace" height="100%">
      {list === 'agents' ? (
        <TreeList density="compact" aria-label="Agents" items={agentItems(tree)} />
      ) : list === 'providers' ? (
        <TreeList density="compact" aria-label="Providers" items={providerItems(tree)} />
      ) : tools.length > 0 ? (
        <TreeList density="compact" aria-label="Tools" items={tools} />
      ) : (
        <Text type="supporting" color="secondary">
          {query.trim() ? `No tool matches “${query.trim()}”.` : 'No tools yet.'}
        </Text>
      )}
    </ScrollableArea>
  );
}

/**
 * The workspace's lists, one at a time: its agents, the tool library they share, and the providers.
 * The toggle follows the selection, so opening a tool from elsewhere (an issue, a new tool) shows it.
 */
function WorkspaceTreeLists({
  tree,
  draft,
  onAddAgent,
  listRef,
}: {
  tree: WorkspaceTreeState;
  /** The open agent's draft, which a new tool joins. */
  draft: StudioDraft;
  onAddAgent: (add: AddAgent) => void;
  /** The list's scroller. The toggle and search stay above it. */
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const { list, setList } = tree;
  const { query, setQuery, revealSelected } = useWorkspaceList(tree.selectedId, listRef);
  const tools = list === 'tools' ? toolItems(tree, query) : [];
  return (
    <VStack gap={2} height="100%">
      <WorkspaceListToggle
        workspace={tree.workspace}
        list={list}
        onChange={(next) => {
          setList(next);
          revealSelected();
        }}
      />
      {list === 'agents' ? <AddAgentMenu onAddAgent={onAddAgent} /> : null}
      {list === 'tools' && (
        <ToolSearchInput
          query={query}
          onChange={(next) => {
            setQuery(next);
            revealSelected();
          }}
        />
      )}
      {list === 'tools' ? <AddToolButton tree={tree} draft={draft} /> : null}
      {list === 'providers' && tree.keys ? <ManageKeysButton keys={tree.keys} /> : null}
      {list === 'providers' && tree.ownsProviders ? (
        <AddProviderButton
          taken={tree.workspace.providers.map((provider) => provider.id)}
          onAdd={(provider) => {
            tree.update((current) => addProvider(current, provider));
            tree.onSelect(providerNodeId(provider.id));
          }}
        />
      ) : null}
      <StackItem size="fill">
        <WorkspaceListBody tree={tree} list={list} tools={tools} query={query} listRef={listRef} />
      </StackItem>
    </VStack>
  );
}

/** The longest agent name the preview's header shows in full. */
const CHAT_NAME_MAX = 24;

/** `name`, cut to `CHAT_NAME_MAX` characters with an ellipsis when it is longer. */
function shortName(name: string): string {
  return name.length > CHAT_NAME_MAX ? `${name.slice(0, CHAT_NAME_MAX - 1)}…` : name;
}

/** Which agent the preview chats with, once there is more than one. */
function ChatPicker({
  agents,
  chatWith,
  onChange,
}: {
  agents: ChatAgent[];
  chatWith: string;
  onChange: (key: string) => void;
}) {
  if (agents.length < 2) return null;
  return (
    <Selector
      label="Chat with"
      isLabelHidden
      variant="ghost"
      size="sm"
      // As wide as the name, so the chevron sits right after it.
      width="fit-content"
      value={chatWith}
      options={agents}
      // why: The header shows a short name; the list under it shows each name in full.
      renderValue={(option) => (
        <span title={option.label}>{shortName(option.label ?? option.value)}</span>
      )}
      onChange={onChange}
    />
  );
}

interface ChatAgent {
  value: string;
  label: string;
}

/** The agents the preview can chat with: the same list while their keys and names stand. */
function useChatAgents(agents: StudioWorkspace['agents']): ChatAgent[] {
  const names = JSON.stringify(agents.map((agent) => [agent.key, agent.identity.agentId]));
  return useMemo(
    () =>
      (JSON.parse(names) as [string, string][]).map(([value, agentId]) => ({
        value,
        label: agentId || 'Unnamed agent',
      })),
    [names],
  );
}

/** A tree group's heading and its add button. */
/** The indent TreeList gives a leaf row beside a branch: the chevron's width and its gap. */
const CHEVRON_COLUMN = {
  '--_tree-indent': 'calc(var(--spacing-4) + var(--spacing-2))',
} as CSSProperties;

/** The tree's label for a node, e.g. the agent's id for Identity. */
function nodeLabel(node: StudioTreeNode, id: string): string | undefined {
  if (node.id === id) return node.label;
  for (const child of node.children) {
    const label = nodeLabel(child, id);
    if (label !== undefined) return label;
  }
  return undefined;
}

/**
 * The editor's title: the facet's name, e.g. Identity rather than the agent's id the tree shows;
 * for a model or tool entry, that entry's own name.
 */
function editorTitle(draft: StudioDraft, id: string): string | undefined {
  const ref = studioNodeRef(draft, id);
  if (!ref) return undefined;
  if ('key' in ref) return nodeLabel(studioTree(draft), id);
  return profileGraphFacet(ref.facet)?.label;
}

/** The editor's heading: Tools with the tools list and no tool open; else the open node's title. */
function headingOf(list: WorkspaceList, editing: string, title: string | undefined) {
  return list === 'tools' && toolSpecKeyOf(editing) === undefined
    ? profileGraphFacet('tools')?.label
    : title;
}

/** Waits before compiling after an edit, so typing doesn't recompile on every key. */
const COMPILE_DEBOUNCE_MS = 300;

/** The part of a compile the agent runs from: what the run tab and the preview both take. */
function runPayload({
  agentId,
  profile,
  customTools,
  structured,
  questions,
  providers,
  dependencies,
}: NonNullable<ReturnType<typeof workspaceRunAgent>>): StudioRunPayload {
  return { agentId, profile, customTools, structured, questions, providers, dependencies };
}

/** An agent's id as the workspace names it, for finding its compile. */
function agentIdOf(workspace: StudioWorkspace, key: string): string {
  return workspace.agents.find((agent) => agent.key === key)?.identity.agentId.trim() ?? '';
}

/** One agent's compile, from a workspace that compiled. */
function compiledAgent(
  compiled: CompiledWorkspace,
  workspace: StudioWorkspace,
  key: string,
): CompiledStudio | undefined {
  const id = agentIdOf(workspace, key);
  return compiled.agents.find((agent) => agent.agentId === id);
}

/**
 * The editor's node id for a workspace one: the open agent's own ids, a library tool's or a
 * provider's as it is.
 * `undefined` for another agent's.
 */
function innerNodeId(id: string, focus: string): string | undefined {
  if (toolSpecKeyOf(id) !== undefined || providerIdOf(id) !== undefined) return id;
  const root = agentNodeId(focus);
  if (id === root) return 'identity';
  return id.startsWith(`${root}/`) ? id.slice(root.length + 1) : undefined;
}

/** Hands the compiled agent to a new tab through this browser's storage; the run route reads it back. */
function openInNewTab(payload: StudioRunPayload, project: ProjectSession | null) {
  const runId = createStudioRunId();
  saveStudioRunPayload(payload, runId);
  // A project's agent runs the project's code on its own page too.
  const named = project ? `&project=${encodeURIComponent(project.name)}` : '';
  globalThis.open(`/studio/run?run=${encodeURIComponent(runId)}${named}`, '_blank', 'noopener');
}

type Exporter = typeof import('./lib/export-agent.ts') & typeof import('./lib/zip.ts');
let exporter: Exporter | undefined;
/** The export and its zip, loaded when the page is idle or on the first export. */
const exportKit = (): Promise<Exporter> =>
  Promise.all([import('./lib/export-agent.ts'), import('./lib/zip.ts')]).then(
    ([agent, zip]) => (exporter = { ...agent, ...zip }),
  );

/** Runs `use` with the export code: at once when it has loaded, so a copy stays inside the click. */
function withExporter(use: (kit: Exporter) => void) {
  if (exporter) use(exporter);
  else void exportKit().then(use);
}

/** The workspace's files as a .zip, named for the agent being chatted with. */
function downloadExport(
  kit: Exporter,
  files: Parameters<Exporter['zipFiles']>[0],
  agentId: string,
) {
  download(`${agentId}.zip`, new Blob([kit.zipFiles(files)], { type: 'application/zip' }));
}

/** Downloads `blob` as `filename`. */
function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

/** Calls `measure` with the node whenever it resizes; a callback ref, so it follows remounts. */
function useMeasure<T>(measure: (node: HTMLElement) => T) {
  const [value, setValue] = useState<T>();
  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      const observer = new ResizeObserver(() => {
        setValue(measure(node));
      });
      observer.observe(node);
      return () => {
        observer.disconnect();
      };
    },
    [measure],
  );
  return [ref, value] as const;
}

/** The next node with an issue after `selectedId`, wrapping, so repeated clicks walk through them. */
function nextIssueNode(issues: readonly StudioIssue[], selectedId: string): string {
  const nodes = [...new Set(issues.map((issue) => issue.nodeId))];
  return nodes[(nodes.indexOf(selectedId) + 1) % nodes.length] ?? selectedId;
}

/** The layout has no padding, so this is the content box Astryx resolves panel percentages on. */
const measureWidth = (node: HTMLElement) => node.clientWidth;

/** The side panel's default share of the layout, the tree beside the editor: the golden split. */
const SIDE_DEFAULT_PERCENT = 38.2;
/** The profile tree's width inside the side panel; the editor takes the rest. */
const TREE_WIDTH = NAV_WIDTH;

/**
 * The frame's class; on a phone it names the sheet open over the editor. While the map is open the
 * panel takes the whole frame, over the preview.
 */
function frameClass(sheet: 'tree' | 'preview' | null, map: boolean, settings: boolean): string {
  return [
    'studio-frame',
    sheet && `studio-${sheet}-open`,
    map && 'studio-map-open',
    settings && 'studio-settings-open',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Two badges per list row at the panel's default width or wider; one once it is narrowed. */
function badgesPerRow(panelSize: number, layoutWidth: number | undefined): 1 | 2 {
  if (layoutWidth === undefined) return 2;
  return panelSize >= Math.round((SIDE_DEFAULT_PERCENT / 100) * layoutWidth) ? 2 : 1;
}

/** A workspace and what it compiled to. */
interface Compile {
  workspace: StudioWorkspace;
  result: WorkspaceCompileResult;
}

/** The last workspace that compiled; it holds while the current one has issues. */
function useLastGood(compile: Compile) {
  const [lastGood, setLastGood] = useState(() =>
    compile.result.ok ? { workspace: compile.workspace, compiled: compile.result } : null,
  );
  // invariant: one object per good compile, so the payload, and the transport made from it, last
  // until the agent changes; a new one aborts whatever the preview is running.
  if (compile.result.ok && compile.result !== lastGood?.compiled) {
    const good = { workspace: compile.workspace, compiled: compile.result };
    setLastGood(good);
    return good;
  }
  return lastGood;
}

/** The views of the editor column, in the order its one button lists them; the map opens beside either. */
const EDITOR_VIEWS = [
  { id: 'editor', label: 'Editor', icon: IconAdjustmentsHorizontal, description: 'Edit as a form' },
  { id: 'code', label: 'Code', icon: IconCode, description: 'Edit as TypeScript' },
] as const;

type EditorViewName = (typeof EDITOR_VIEWS)[number]['id'];

/** The agent with every use of key slot `from` pointed at `to`; `''` lets go of it. */
function swapKeySlot<Agent extends Pick<StudioDraft, 'models' | 'modelBindings'>>(
  draft: Agent,
  from: string,
  to: string,
): Agent {
  const swap = <Slot extends string | undefined>(slot: Slot) => (slot === from ? to : slot) as Slot;
  return {
    ...draft,
    models: {
      ...draft.models,
      key: swap(draft.models.key),
      fallbackKey: swap(draft.models.fallbackKey),
    },
    modelBindings: draft.modelBindings.map((binding) => ({
      ...binding,
      keySlot: swap(binding.keySlot),
      fallbackKeySlot: swap(binding.fallbackKeySlot),
    })),
  };
}

/** "1 issue" or "N issues", or nothing at none. */
const issuesLabel = (count: number) =>
  count === 0 ? undefined : count === 1 ? '1 issue' : `${String(count)} issues`;

/** "1 issue" or "N issues" while the draft doesn't compile; nothing once it does. */
function issueCount(compiled: WorkspaceCompileResult): string | undefined {
  return compiled.ok ? undefined : issuesLabel(compiled.issues.length);
}

/** What a host that follows along is told about the draft on screen. */
function screenReport(
  draft: StudioDraft,
  compiled: WorkspaceCompileResult,
  section: string | undefined,
) {
  return {
    agent: draft.identity.handle || draft.identity.agentId || 'unnamed',
    type: draft.identity.profileType || 'not chosen',
    issues: compiled.ok ? 0 : compiled.issues.length,
    section,
  };
}

/** What th30's surface reaches on the page beyond the store; read through a ref so it is always the latest. */
type SurfacePage = {
  on: ReturnType<typeof useStudioConnection>['on'];
  connection: ReturnType<typeof useStudioConnection>;
  replaceWorkspace: (next: StudioWorkspace, message: string, by?: 'th30' | 'visitor') => void;
  copy: (text: string, what: string) => void;
  setKeysOpen: (open: boolean) => void;
  /** Starts the open agent's chat again, for the person runs act as. */
  newConversation: () => void;
  project: ProjectSession | null;
  confirmWrite: (ask: WriteAsk) => Promise<boolean>;
};

/**
 * The studio as th30's surface host: th30 works on the open agent, its draft from the store;
 * everything else comes from the page.
 */
function studioSurfaceHost(
  store: StudioStore,
  page: RefObject<SurfacePage>,
  chat: RefObject<TheoremChatHandle | null>,
): StudioSurfaceHost {
  return {
    getDraft: store.getDraft,
    getRevision: store.getRevision,
    getRunsOn: () => page.current.on,
    update: (next) => {
      store.updateDraft(next, 'th30');
      const reach = store.getPending();
      if (!reach) return undefined;
      const ask = sharedAsk(reach, store.getWorkspace());
      const asked = `Not made yet. The person is being asked: ${ask.title} ${ask.line}`;
      return `${asked} Tell them, and wait for their answer: do not make this change again.`;
    },
    replaceDraft: (next, message) => {
      const workspace = store.getWorkspace();
      page.current.replaceWorkspace(
        withAgentDraft(workspace, store.getFocus(), next),
        message,
        'th30',
      );
    },
    select: (id) => {
      store.select(scopedNodeId(store.getFocus(), id));
    },
    changesSince: (since) =>
      store.changesSince(since).map((change) => ({
        revision: change.revision,
        by: change.by === 'th30' ? 'agent' : 'person',
        sections: change.sections,
      })),
    subscribe: store.subscribe,
    ...keyAndToolMembers(store, page),
    ...runMembers(store, page, chat),
  };
}

/** th30's reach into the keys and the tool library: read and test a key, open Keys, probe a tool. */
function keyAndToolMembers(
  store: StudioStore,
  page: RefObject<SurfacePage>,
): Pick<StudioSurfaceHost, 'key' | 'openKeys' | 'testKey' | 'toolCredential' | 'testTool'> {
  return {
    key: (slot) => page.current.connection.vault[slot] ?? '',
    openKeys: () => {
      page.current.setKeysOpen(true);
    },
    testKey: async (slot) => {
      const key = page.current.connection.vault[slot]?.trim();
      if (!key) return { ok: false, error: 'No key in this slot.' };
      try {
        const response = await fetch(`${screenEndpoint()}/test-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        return await response.json<unknown>();
      } catch {
        return { ok: false, error: "Couldn't reach the studio server." };
      }
    },
    toolCredential,
    testTool: async (key, input) => {
      const tool = store.getDraft().toolSpecs.find((candidate) => candidate.key === key);
      if (!tool) return { ok: false, error: 'No such tool.' };
      const sample = JSON.stringify(input ?? sampleToolInput(tool.toolName, tool.inputJson) ?? {});
      // A tool that writes runs only once the builder read the input and said so.
      const ask = writeAsk(tool, sample);
      if (ask && !(await page.current.confirmWrite(ask))) {
        return { ok: false, error: 'The builder chose not to run it.' };
      }
      return runToolProbe(tool, sample, toolCredential(key), store.getDraft().guardrails);
    },
  };
}

/** th30's reach into the conversation and the chatted agent: send, start over, open in a new tab, get code. */
function runMembers(
  store: StudioStore,
  page: RefObject<SurfacePage>,
  chat: RefObject<TheoremChatHandle | null>,
): Pick<StudioSurfaceHost, 'send' | 'newConversation' | 'launch' | 'exportAgent'> {
  /** What the chatted agent runs, with the agents it names. */
  const runNow = () => {
    const workspace = store.getWorkspace();
    const result = compileWorkspace(workspace, page.current.on);
    return result.ok
      ? workspaceRunAgent(result, agentIdOf(workspace, workspace.chatWith))
      : undefined;
  };
  return {
    send: (text) => chat.current?.send(text) ?? Promise.resolve(null),
    newConversation: () => {
      page.current.newConversation();
    },
    launch: () => {
      const result = runNow();
      if (!result) return;
      openInNewTab(
        {
          ...runPayload(result),
          connectionMode: page.current.on.mode,
          localBaseUrl: page.current.connection.local.baseUrl,
        },
        page.current.project,
      );
    },
    exportAgent: (format) => {
      const workspace = store.getWorkspace();
      const result = compileWorkspace(workspace, page.current.on);
      const agent = result.ok ? compiledAgent(result, workspace, workspace.chatWith) : undefined;
      if (!result.ok || !agent) return Promise.resolve(false);
      const code = projectCode(page.current.project, workspace);
      withExporter((kit) => {
        if (format === 'zip') {
          downloadExport(kit, kit.exportFiles(result, agent, code), agent.agentId);
        } else if (format === 'copy') {
          page.current.copy(kit.exportText(kit.exportFiles(result, agent, code)), 'the files');
        } else {
          page.current.copy(kit.llmBrief(result, agent, code), 'the files and their brief');
        }
      });
      return Promise.resolve(true);
    },
  };
}

/**
 * Reveals the node the issue pill opened. Its first failing row is revealed once the editor shows
 * that node, which can be a render after the click, and a frame later, once the editor's new scroll
 * area scrolls.
 */
function useIssueReveal(selected: string) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [issueReveal, setIssueReveal] = useState<{ node: string }>();
  const revealed = useRef<{ node: string }>(undefined);
  useEffect(() => {
    if (!issueReveal || issueReveal === revealed.current || issueReveal.node !== selected) return;
    revealed.current = issueReveal;
    const frame = requestAnimationFrame(() => {
      const row = editorRef.current?.querySelector(`[${ISSUE_ROW_ATTRIBUTE}]`);
      row?.scrollIntoView({ block: 'center' });
      row?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [issueReveal, selected]);
  return { editorRef, reveal: setIssueReveal, revealed: issueReveal };
}

const issueKey = (issue: StudioIssue) =>
  `${issue.nodeId}\n${issue.field ?? ''}\n${String(issue.index ?? '')}`;

/**
 * The issues the editor's rows show: the ones the builder has left behind. One that turns up on
 * the page they are on (a detector just added, a field not filled in yet) stays quiet until they
 * move to another page, or press the issue pill (`revealed`). `leavePage` is for a page inside a
 * node, which `page` doesn't name.
 */
function useLeftIssues(issues: readonly StudioIssue[], page: string, revealed: unknown) {
  // The issues as of the last render: at a move, the ones that were there before it.
  const before = useRef(issues);
  const [left, setLeft] = useState(() => new Set(issues.map(issueKey)));
  const leavePage = useCallback(() => {
    const keys = new Set(before.current.map(issueKey));
    return () => {
      setLeft(keys);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a move or a press of the pill is what lets them show
  useLayoutEffect(() => {
    leavePage()();
  }, [page, revealed, leavePage]);
  useLayoutEffect(() => {
    before.current = issues;
  });
  const shown = useMemo(() => issues.filter((issue) => left.has(issueKey(issue))), [issues, left]);
  return { shown, leavePage };
}

/** Open in a new tab, for the agent being chatted with; off while the workspace has issues. */
function OpenInNewTabButton({
  compiled,
  chattedId,
  blocked,
  connection,
}: {
  compiled: CompiledWorkspace | undefined;
  chattedId: string;
  blocked: string | undefined;
  connection: Pick<StudioRunPayload, 'connectionMode' | 'localBaseUrl'>;
}) {
  const project = useProject();
  const phone = usePhone();
  return (
    <Button
      label="Open in a new tab"
      isIconOnly={phone}
      variant="ghost"
      icon={<Icon icon={IconBrowserShare} size="sm" />}
      isDisabled={!compiled}
      tooltip={
        blocked ??
        'Run this agent on a full page of its own, in a new tab, the way a person using it would see it'
      }
      onClick={() => {
        const run = compiled && workspaceRunAgent(compiled, chattedId);
        if (run) openInNewTab({ ...runPayload(run), ...connection }, project);
      }}
    />
  );
}

/** Get code: a .zip, Copy, or Copy for LLM, for every agent; off while the workspace has issues. */
function ExportMenu({
  store,
  compile,
  copy,
}: {
  store: StudioStore;
  compile: WorkspaceCompile;
  copy: (text: string, what: string) => void;
}) {
  const project = useProject();
  const compiled = compile.compiled.ok ? compile.compiled : undefined;
  const { chatted, blocked } = compile;
  /** What the project's files hold that the code names, read when the builder asks for the code. */
  const code = (): ProjectCode | undefined => projectCode(project, store.getWorkspace());
  return (
    <DropdownMenu
      button={{
        label: 'Get code',
        variant: 'ghost',
        isIconOnly: true,
        icon: <Icon icon={IconArrowBarToDown} size="sm" />,
        tooltip:
          blocked ??
          'Download every agent as a .zip, or copy its files, or copy them with a brief for an LLM',
        isDisabled: !compiled,
      }}
      menuWidth="15rem"
      hasChevron={false}
      placement="below"
      alignment="end"
      items={[
        {
          id: 'download',
          label: 'Download',
          description: oneLine('Every agent, as a .zip.'),
          icon: <Icon icon={IconFileZip} size="sm" />,
          onClick: () => {
            if (compiled && chatted) {
              withExporter((kit) => {
                downloadExport(kit, kit.exportFiles(compiled, chatted, code()), chatted.agentId);
              });
            }
          },
        },
        {
          id: 'copy',
          label: 'Copy',
          description: oneLine('Every file, each under its path, to paste into your code.'),
          icon: <Icon icon={IconCopy} size="sm" />,
          onClick: () => {
            if (compiled && chatted) {
              withExporter((kit) => {
                copy(kit.exportText(kit.exportFiles(compiled, chatted, code())), 'the files');
              });
            }
          },
        },
        {
          id: 'copy-llm',
          label: 'Copy for LLM',
          description: oneLine(
            'Every file with a brief: what to install, where each goes, what to ask you.',
          ),
          icon: <Icon icon={IconSparkles} size="sm" />,
          onClick: () => {
            if (compiled && chatted) {
              withExporter((kit) => {
                copy(kit.llmBrief(compiled, chatted, code()), 'the files and their brief');
              });
            }
          },
        },
      ]}
    />
  );
}

/** The workspace's store, kept in this tab's sessionStorage, and the open agent's draft from it. */
function useStudioWorkspace(start: RestoredStudio, project: ProjectSession | undefined) {
  // The settings the project's profiles share, on the agents it opened as: a change to one is
  // made on each of them.
  const [shared] = useState(() =>
    sharedEntries(
      start.workspace,
      project?.shared ?? [],
      project?.origins.sites,
      project?.unregistered,
    ),
  );
  // The page's tools read the store synchronously. The editor works on the open agent's draft, with the
  // whole tool library.
  const [store] = useState(() =>
    createStudioStore(start, project?.origins.sites?.profiles, project?.origins.sites?.tools),
  );
  const workspace = useSyncExternalStore(store.subscribe, store.getWorkspace, store.getWorkspace);
  const draft = useSyncExternalStore(store.subscribe, store.getDraft, store.getDraft);
  const setDraft = useCallback(
    (next: StudioDraft | ((current: StudioDraft) => StudioDraft)) => {
      store.updateDraft(next);
    },
    [store],
  );
  const update = useCallback(
    (change: (current: StudioWorkspace) => StudioWorkspace) => {
      store.update(change);
    },
    [store],
  );
  useEffect(() => {
    const flush = () => {
      store.flush();
    };
    globalThis.addEventListener('pagehide', flush);
    return () => {
      globalThis.removeEventListener('pagehide', flush);
      flush();
    };
  }, [store]);
  const { files, refreshOrigins, filesChanged, conflict, settle, showConflict, watchFiles } =
    useProjectFiles(project, store);
  // Where the files write each shared value, as they were last read.
  const sites = files?.origins.sites;
  useEffect(() => {
    store.setSites(sites?.profiles, sites?.tools);
  }, [store, sites]);
  return {
    store,
    workspace,
    draft,
    focus: store.getFocus(),
    setDraft,
    update,
    shared,
    origins: files?.origins,
    asks: files?.asks,
    files,
    refreshOrigins,
    filesChanged,
    conflict,
    settle,
    showConflict,
    watchFiles,
  };
}

/**
 * What the project's files say: the profiles they hold, the settings they set in code, and the
 * tools the studio makes ask. They are read again when the files may have moved: after a Save or
 * an undo, and when the builder comes back to the page from their editor. `filesChanged` is for
 * the studio's own moves (a Save, an undo, opening the files again): the workspace's starts then
 * stand on this reading, which the tab keeps with the edits. The local server also says when the
 * builder's editor writes a file, unless the watch is off. What the editor changed is merged
 * into the workspace setting by setting: the builder's edits stay, and a setting both changed
 * waits in `conflict` until the builder chooses with `settle`. They can close the choice and come
 * back to it with `showConflict`: their edits stand meanwhile.
 */
function useProjectFiles(project: ProjectSession | undefined, store: StudioStore) {
  const [files, setFiles] = useState<ProjectFiles | undefined>(project);
  const [pending, setConflict] = useState<Omit<FilesConflict, 'open'>>();
  const [isChoosing, showConflict] = useState(true);
  const conflict = useMemo(
    () => pending && { ...pending, open: isChoosing },
    [pending, isChoosing],
  );
  const toast = useToast();
  /** The studio's own moves still being read: a reading that lands meanwhile is theirs. */
  const ours = useRef(0);
  /** The files as last read, which name an agent the builder removed since. */
  const lastRead = useRef<StudioWorkspace | undefined>(undefined);
  const keep = useCallback((read: ProjectFiles) => {
    // Files that say what they said keep the reading, so nothing that runs on it starts again.
    setFiles((held) => (canonical(held) === canonical(read) ? held : read));
  }, []);
  const reread = useCallback(
    (isOurs: boolean, changed: readonly string[] = []) => {
      if (!project) return;
      if (isOurs) ours.current += 1;
      readFiles()
        .then(({ files: read, workspace }) => {
          const stoodOn = store.standsOn();
          if (isOurs) store.standOn(read.print);
          else if (ours.current > 0) return;
          else if (stoodOn === undefined) {
            // Edits that stand on no reading cannot be merged: the files open, and the edits are offered back.
            const before = store.getWorkspace();
            store.takeFiles(reopened(workspace, before));
            store.standOn(read.print);
            offerEditsBack(toast, store, before, projectKey(project.name));
          } else if (read.print !== stoodOn) {
            const before = store.getWorkspace();
            // After a reload the reading the edits stand on is the one the tab kept.
            const stood = lastRead.current ?? keptReading(projectKey(project.name), stoodOn);
            const merge = mergedWithFiles(before, workspace, stood);
            const named = changedFiles(changed);
            if (merge.conflicts.length > 0) {
              // The builder's edits stand, and nothing moves under them, until they choose.
              setConflict({ merge, read, workspace, files: named });
              showConflict(true);
              return;
            }
            store.takeFiles(merge.workspace);
            store.standOn(read.print);
            const said = filesToast(named, merge.updated.length, editedSince(before, stoodOn));
            if (said && getPref('filesToast') === 'on') toast({ body: said });
          }
          // Files that went back to what the edits stand on leave nothing to choose.
          setConflict(undefined);
          lastRead.current = workspace;
          keepReading(projectKey(project.name), read.print, workspace);
          keep(read);
        })
        .catch((err: unknown) => {
          // What shows still stands on the last reading, which may be older than the files now.
          toast({
            type: 'error',
            body:
              // A fetch that reaches no server fails with a TypeError.
              err instanceof TypeError
                ? "The studio's server didn't answer, so your files show as it last read them."
                : `Couldn't read your files again (${err instanceof Error ? err.message : String(err)}), so they show as last read.`,
          });
        })
        .finally(() => {
          if (isOurs) ours.current -= 1;
        });
    },
    [project, store, toast, keep],
  );
  const refreshOrigins = useCallback(() => {
    reread(false);
  }, [reread]);
  const filesChanged = useCallback(() => {
    reread(true);
  }, [reread]);
  const settle = useCallback(
    (theirs: number[]) => {
      if (!conflict) return;
      store.takeFiles(withFilesChosen(conflict.merge, theirs));
      store.standOn(conflict.read.print);
      lastRead.current = conflict.workspace;
      if (project) keepReading(projectKey(project.name), conflict.read.print, conflict.workspace);
      keep(conflict.read);
      setConflict(undefined);
    },
    [conflict, project, store, keep],
  );
  useEffect(() => {
    globalThis.addEventListener('focus', refreshOrigins);
    return () => {
      globalThis.removeEventListener('focus', refreshOrigins);
    };
  }, [refreshOrigins]);

  const [watch, setWatch] = useState({ available: false, on: getPref('watch') === 'on' });
  const watching = useRef(watch.on);
  const setWatching = useCallback(
    (on: boolean) => {
      watching.current = on;
      setPref('watch', on ? 'on' : 'off');
      setWatch((held) => ({ ...held, on }));
      // What the files changed while the watch was off comes in now.
      if (on) reread(false);
    },
    [reread],
  );
  useEffect(() => {
    if (!project) return;
    // Edits the tab kept may stand on files that changed while the page was closed.
    reread(false);
    return subscribeToFiles(project.endpoint, {
      open: () => {
        setWatch((held) => (held.available ? held : { ...held, available: true }));
      },
      files: (changed) => {
        if (watching.current) reread(false, changed);
      },
    });
  }, [project, reread]);
  const watchFiles = useMemo(
    () => (watch.available ? { on: watch.on, set: setWatching } : undefined),
    [watch, setWatching],
  );
  return { files, refreshOrigins, filesChanged, conflict, settle, showConflict, watchFiles };
}

/** A merge that waits on the builder: the settings they and their files both changed. */
interface FilesConflict {
  merge: FilesMerge;
  read: ProjectFiles;
  workspace: StudioWorkspace;
  /** The files that changed, as the builder reads them. */
  files: string;
  /** Whether the choice shows. Closed, it waits behind the editor's "conflicts" token. */
  open: boolean;
}

/** The files that changed, as a toast and the conflict dialog name them: the one, or how many. */
function changedFiles(files: readonly string[]): string {
  const [only] = files;
  if (only === undefined) return 'source code';
  return files.length === 1 ? only : `${String(files.length)} files`;
}

const conflictsLabel = (count: number) =>
  count === 1 ? '1 conflict' : `${String(count)} conflicts`;

/** What a merge with no conflicts says, or nothing when the files changed no setting. */
function filesToast(files: string, updated: number, hadEdits: boolean): string | undefined {
  if (updated === 0) return undefined;
  const settings = updated === 1 ? '1 setting updated' : `${String(updated)} settings updated`;
  const subject = files === 'source code' ? 'Source code' : files;
  return `${subject} changed: ${settings}.${hadEdits ? ' Studio edits are kept.' : ''}`;
}

/** Shows an origin's line in the builder's editor, and says where it is when no editor opens. */
function useOpenOrigin(project: ProjectSession | null) {
  const toast = useToast();
  return useCallback(
    (origin: SettingOrigin) => {
      const place = originPlace(origin);
      if (!project || !origin.file || !place) return;
      openInEditor(project, { file: origin.file, line: origin.line })
        .catch((): OpenAnswer => ({ ok: false, reason: 'failed' }))
        .then((answer) => {
          const path = answer.ok ? undefined : answer.place;
          toast({
            type: answer.ok ? undefined : 'error',
            body: openOutcome(answer, place),
            endContent: path && (
              <Button
                label="Copy path"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(path);
                }}
              />
            ),
          });
        });
    },
    [project, toast],
  );
}

/** Keys are the workspace's: every agent's slots, so a called agent's key is asked for too. */
function useWorkspaceConnection(workspace: StudioWorkspace): StudioConnectionState {
  const inProject = useProject() !== null;
  const { lentKeys, toolHandlers } = useStudioHost();
  const bindings = workspace.agents.flatMap((agent) =>
    agent.modelBindings.map((binding) => ({
      ...modelRoute(workspace.providers, agent.identity.profileType, binding),
      builtInTools: binding.builtInTools,
      local: onStudioLocal(binding.provider, inProject),
    })),
  );
  const namedSlots = workspace.agents
    .flatMap((agent) => [
      agent.models.key,
      agent.models.fallbackKey,
      ...agent.modelBindings.flatMap((binding) => {
        const { keySlot, fallbackKeySlot } = modelSlots(workspace.providers, binding);
        return [keySlot, fallbackKeySlot];
      }),
    ])
    .filter((slot): slot is string => Boolean(slot));
  return useStudioConnection(bindings, undefined, namedSlots, { lentKeys, toolHandlers });
}

/** The frame: the resizable panel on the left. */
function useStudioFrame() {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [measureLayout, layoutWidth] = useMeasure(measureWidth);
  const layoutCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      layoutRef.current = node;
      return measureLayout(node);
    },
    [measureLayout],
  );
  const sidePanel = useResizable({
    defaultSize: `${String(SIDE_DEFAULT_PERCENT)}%`,
    minSize: TREE_WIDTH + 320,
    containerRef: layoutRef,
    autoSaveId: 'studio.panel',
  });
  // The editor's own width, for while the map is open beside it: the panel's, less the tree.
  useLayoutEffect(() => {
    layoutRef.current?.style.setProperty(
      '--studio-view-width',
      `${String(sidePanel.size - TREE_WIDTH)}px`,
    );
  }, [sidePanel.size]);
  // The profile tree's branches mount and unmount; ease them both ways.
  const sidebarRef = useRef<HTMLDivElement>(null);
  useDisclosureMotion(sidebarRef);
  return {
    layoutCallbackRef,
    sidePanel,
    listBadges: badgesPerRow(sidePanel.size, layoutWidth),
    sidebarRef,
  };
}

/** The open agent's issues and the library's, by the editor's ids. */
function editorIssuesOf(compiled: WorkspaceCompileResult, focus: string): StudioIssue[] {
  if (compiled.ok) return [];
  return compiled.issues.flatMap((issue) => {
    const nodeId = innerNodeId(issue.nodeId, focus);
    return nodeId === undefined ? [] : [{ ...issue, nodeId }];
  });
}

/**
 * The workspace compiled once edits settle. Only a workspace that compiles changes the preview;
 * while one has issues, the last good agent and its conversation stay put. The chatted agent is
 * found by its key there, so renaming it doesn't lose it.
 */
function useWorkspaceCompile(
  workspace: StudioWorkspace,
  focus: string,
  connection: StudioConnectionState,
) {
  const { mode, on } = connection;
  const settled = useDebounced(workspace, COMPILE_DEBOUNCE_MS);
  const compile = useMemo(
    () => ({ workspace: settled, result: compileWorkspace(settled, on) }),
    [settled, on],
  );
  const compiled = compile.result;
  const lastGood = useLastGood(compile);
  const chatWith = workspace.chatWith;
  const localBaseUrl = connection.local.baseUrl;
  const payload = useMemo(() => {
    const run =
      lastGood && workspaceRunAgent(lastGood.compiled, agentIdOf(lastGood.workspace, chatWith));
    return run ? { ...runPayload(run), connectionMode: mode, localBaseUrl } : null;
  }, [lastGood, chatWith, mode, localBaseUrl]);
  /** The open agent's compile: what the code view shows and Export takes. */
  const focused = compiled.ok ? compiledAgent(compiled, compile.workspace, focus) : undefined;
  const source = useMemo(() => (focused ? studioSource(focused) : null), [focused]);
  /** The open agent as it compiles now, for a detector's own test. */
  const probed = useMemo(() => {
    const run = compiled.ok && workspaceRunAgent(compiled, agentIdOf(compile.workspace, focus));
    return run ? runPayload(run) : null;
  }, [compiled, compile.workspace, focus]);
  // One object per compile, so the panes that read it sit out the renders between.
  return useMemo(() => {
    const issues = issueCount(compiled);
    return {
      compiled,
      payload,
      /** The workspace the payload was compiled from: the edits the preview runs. */
      tested: lastGood?.workspace,
      traced: recordsTraces(payload),
      source,
      probed,
      editorIssues: editorIssuesOf(compiled, focus),
      /** The agent being chatted with: Get code adds its route and chat to the workspace's files. */
      chatted: compiled.ok ? compiledAgent(compiled, compile.workspace, chatWith) : undefined,
      chattedId: agentIdOf(compile.workspace, chatWith),
      issues,
      blocked: issues && `Fix ${issues} first`,
    };
  }, [compiled, compile.workspace, lastGood, payload, source, probed, focus, chatWith]);
}

type WorkspaceCompile = ReturnType<typeof useWorkspaceCompile>;

/** The preview's conversation with the chatted agent: which runner holds it, and what it resumes. */
function useConversationRun(
  mode: string,
  sealer: ChatSealer,
  chatWith: string,
  actingAs: StudioActingAs | undefined,
  question: string | undefined,
) {
  // Bumping this remounts every runner: fresh transcripts and trace feeds, the same profiles.
  const [restarts, setConversation] = useState(0);
  // Bumping a chat's own count remounts only its runner.
  const [cleared, setCleared] = useState<Readonly<Record<string, number>>>({});
  // Each person the runs act as has their own chat with each agent.
  const chatKey = chatKeyOf(chatWith, actingAs);
  /** The runners that still stand: another mode or a restart replaces them all. */
  const generation = `${mode}:${String(restarts)}`;
  const runKey = `${generation}:${chatKey}:${String(cleared[chatKey] ?? 0)}`;
  // Each kept conversation resumes in the first runner it has here; a cleared or remade one
  // starts empty.
  const [firstRuns] = useState(() => new Map<string, string>());
  if (!firstRuns.has(chatKey)) firstRuns.set(chatKey, runKey);
  const isFirstRun = firstRuns.get(chatKey) === runKey;
  const [seeded] = useState(chatWith);
  /** A conversation started for a chat's next runner: what it resumes and draws at once. */
  const [resumed, setResumed] = useState<ResumedConversation>();
  const resumes = resumed?.runKey === runKey ? resumed : undefined;
  const conversation = useMemo(
    () => (resumes ? resumes.ref : isFirstRun ? restoreConversation(chatKey, sealer) : undefined),
    [resumes, isFirstRun, chatKey, sealer],
  );
  const conversationView = resumes?.view;
  /** A docs seed's question waits in its agent's first composer, when that resumes nothing. */
  const initialText = isFirstRun && chatWith === seeded && !conversation ? question : undefined;
  /**
   * The runners that have sent something; a new one (cleared, or another mode) has no history,
   * unless it resumed a kept conversation.
   */
  const [usedRuns, setUsedRuns] = useState<ReadonlySet<string>>(() => new Set());
  const isUsed = usedRuns.has(runKey) || conversation !== undefined;
  return useMemo(
    () => ({
      runKey,
      chatKey,
      generation,
      sealer,
      conversation,
      conversationView,
      initialText,
      isUsed,
      markUsed: () => {
        setUsedRuns((runs) => (runs.has(runKey) ? runs : new Set(runs).add(runKey)));
      },
      /** Forgets this chat and starts it again; the profile stays, and other chats are left be. */
      clear: () => {
        clearConversation(chatKey);
        setCleared((counts) => ({ ...counts, [chatKey]: (counts[chatKey] ?? 0) + 1 }));
      },
      /** Goes on in a new runner with the conversation under `ref`, drawn as `view` at once. */
      resume: (ref: string, view: ConversationView) => {
        saveConversation(chatKey, sealer, ref);
        const next = (cleared[chatKey] ?? 0) + 1;
        setResumed({ runKey: `${generation}:${chatKey}:${String(next)}`, ref, view });
        setCleared((counts) => ({ ...counts, [chatKey]: next }));
      },
      setConversation,
    }),
    [
      runKey,
      chatKey,
      generation,
      sealer,
      conversation,
      conversationView,
      initialText,
      isUsed,
      cleared,
    ],
  );
}

type ConversationRun = ReturnType<typeof useConversationRun>;
type ResumedConversation = { runKey: string; ref: string; view: ConversationView };

/**
 * Once, on arrival: say when a kept draft was set aside for a docs seed, when a project's files
 * changed under the edits this tab kept, or when what was kept couldn't be read back.
 */
function useArrivalToast(
  { displaced, discarded, project }: Pick<StudioOpened, 'displaced' | 'discarded' | 'project'>,
  store: StudioStore,
) {
  const toast = useToast();
  const arrival = useRef({ displaced, discarded, name: project?.name });
  useEffect(() => {
    const { displaced, discarded, name } = arrival.current;
    const inProject = name !== undefined;
    arrival.current = { displaced: undefined, discarded: false, name };
    if (discarded) {
      toast({
        body: inProject
          ? "The edits this tab kept couldn't be restored."
          : "Your last draft couldn't be restored.",
      });
    }
    if (!displaced) return;
    if (name !== undefined) {
      offerEditsBack(toast, store, displaced, projectKey(name));
      return;
    }
    const dismiss = toast({
      body: 'Opened the example from the docs.',
      endContent: (
        <Button
          label="Back to my draft"
          variant="ghost"
          size="sm"
          onClick={() => {
            store.update(displaced);
            dismiss();
          }}
        />
      ),
    });
  }, [toast, store]);
}

/** The one offer of set-aside edits a page shows. */
const EDITS_ASIDE = 'studio-edits-aside';

/**
 * Says the project's files changed under the builder's edits, and offers the edits back. The
 * offer stays until the builder answers it, and the tab keeps the edits under `key` meanwhile, so
 * a reload offers them again. They come back over whatever the studio holds then.
 */
function offerEditsBack(
  toast: ReturnType<typeof useToast>,
  store: StudioStore,
  edits: StudioWorkspace,
  key: string,
) {
  const dismiss = toast({
    body: 'Your files changed since you made your edits here, so the studio opened the files.',
    isAutoHide: false,
    // A later change to the files replaces the offer with the edits it set aside.
    uniqueID: EDITS_ASIDE,
    // Closing the offer lets the edits go.
    onHide: () => {
      dropAside(key);
    },
    endContent: (
      <Button
        label="Bring my edits back"
        variant="ghost"
        size="sm"
        onClick={() => {
          store.update(rebased(edits, store.getWorkspace()));
          dismiss();
        }}
      />
    ),
  });
  setAside(key, edits);
}

/** What the panel widens over the preview to hold: the map beside the editor, or Settings. */
interface WidePanel {
  map: boolean;
  settings: boolean;
}
const NARROW: WidePanel = { map: false, settings: false };
const isWide = (panel: WidePanel) => panel.map || panel.settings;

/**
 * Which view stands in the editor column, whether the map is open beside it, and opening a node
 * there. The map takes the preview's place: the panel widens over it the way the shell moves after
 * load, with the tree and the editor where they were, and draws back when the map closes.
 */
function useEditorView(store: StudioStore) {
  const [keysOpen, setKeysOpen] = useState(false);
  const [editorView, setEditorView] = useState<EditorViewName>('editor');
  const [mapOpen, setMap] = useState(false);
  const [settingsOpen, setSettings] = useState(false);
  /** What was asked for last, what is on screen, and the moves still to make. */
  const wanted = useRef(NARROW);
  const shown = useRef(NARROW);
  const moves = useRef(Promise.resolve());
  const move = useCallback((next: Partial<WidePanel>) => {
    wanted.current = { ...wanted.current, ...next };
    moves.current = moves.current.then(async () => {
      // Only the last one asked for is worth moving to.
      const to = wanted.current;
      const was = shown.current;
      if (to.map === was.map && to.settings === was.settings) return;
      shown.current = to;
      const swap = () => {
        flushSync(() => {
          setMap(to.map);
          setSettings(to.settings);
        });
      };
      // Settings over an open map, and back: the panel is already as wide as it goes.
      if (isWide(to) === isWide(was)) swap();
      else await movePanel(isWide(to), swap);
    });
  }, []);
  const setMapOpen = useCallback(
    (next: boolean) => {
      move({ map: next });
    },
    [move],
  );
  const settingsWanted = useStudioSettings();
  useEffect(() => {
    move({ settings: settingsWanted });
  }, [move, settingsWanted]);
  /**
   * Opens a node from the tree, the editor, or the map, closing Keys over it. The map stays open
   * beside the editor; on a phone it covers the editor, so it closes.
   */
  const open = useCallback(
    (id: string) => {
      setKeysOpen(false);
      store.select(id);
      setEditorView('editor');
      if (!globalThis.matchMedia('(min-width: 768px)').matches) setMapOpen(false);
    },
    [store, setMapOpen],
  );
  return {
    keysOpen,
    setKeysOpen,
    editorView,
    setEditorView,
    mapOpen,
    setMapOpen,
    settingsOpen,
    open,
  };
}

type EditorViewState = ReturnType<typeof useEditorView>;

/** What the page does for its buttons and for th30: swap in a workspace (with undo), and copy. */
function usePageActions(
  store: StudioStore,
  view: EditorViewState,
  setConversation: Dispatch<SetStateAction<number>>,
) {
  const toast = useToast();
  const { copy: writeClipboard } = useClipboard();
  const { setKeysOpen, setEditorView } = view;
  /** Swaps in a whole new workspace; the toast can put the old one back. */
  const replaceWorkspace = useCallback(
    (next: StudioWorkspace, message: string, by: 'th30' | 'visitor' = 'visitor') => {
      const previous = store.getWorkspace();
      store.update(next, by);
      setKeysOpen(false);
      setEditorView('editor');
      // New agents start new conversations; the old transcripts don't carry over.
      clearConversation();
      setConversation((count) => count + 1);
      const dismiss = toast({
        body: message,
        endContent: (
          <Button
            label="Undo"
            variant="ghost"
            size="sm"
            onClick={() => {
              store.update(previous);
              dismiss();
            }}
          />
        ),
      });
    },
    [store, setKeysOpen, setEditorView, setConversation, toast],
  );
  const copy = useCallback(
    (text: string, what: string) => {
      void writeClipboard(text).then((copied) =>
        toast(
          copied
            ? { body: `Copied ${what}.` }
            : { body: "Couldn't reach the clipboard.", type: 'error' },
        ),
      );
    },
    [toast, writeClipboard],
  );
  return { replaceWorkspace, copy };
}

/**
 * th30 sees and works in the studio through its surface, mounted while the page is open. Its
 * tools read the page through a ref, so they register once and always see the latest.
 */
function useStudioSurface(store: StudioStore, page: SurfacePage) {
  const { mountSurface } = useStudioHost();
  const chatRef = useRef<TheoremChatHandle>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(
    () => mountSurface?.(studioSurface(studioSurfaceHost(store, pageRef, chatRef))),
    [store, mountSurface],
  );
  return chatRef;
}

/** What the open agent's editor knows of the others, and its allow list. */
function useWorkspaceContext(
  agents: StudioWorkspace['agents'],
  focus: string,
  update: (change: (current: StudioWorkspace) => StudioWorkspace) => void,
  ownsProviders: boolean,
) {
  return useMemo(() => {
    const self = agents.find((agent) => agent.key === focus);
    return {
      agents: agents.map((agent) => ({
        key: agent.key,
        agentId: agent.identity.agentId.trim(),
        type: agent.identity.profileType,
      })),
      self: focus,
      allowed: self?.tools.allow ?? [],
      setAllowed: (toolKey: string, allowed: boolean) => {
        update((current) => setToolAllowed(current, focus, toolKey, allowed));
      },
      addProvider: ownsProviders
        ? (provider: StudioProvider) => {
            update((current) => addProvider(current, provider));
          }
        : undefined,
      updateProvider: ownsProviders
        ? (provider: StudioProvider) => {
            update((current) => withProvider(current, provider));
          }
        : undefined,
      sharing: (bindingKey: string, id: string, apiId: string) =>
        modelSharers({ agents }, focus, bindingKey, id, apiId),
    };
  }, [agents, focus, update, ownsProviders]);
}

export type StudioWorkspaceState = ReturnType<typeof useStudioWorkspace>;
type Sheet = 'tree' | 'preview' | null;

/** The node the editor has open: the selected one while it exists, else the open agent's identity. */
function selectedNode(workspace: StudioWorkspace, focus: string): string {
  return workspaceNodeRef(workspace, workspace.selected) ? workspace.selected : agentNodeId(focus);
}

/** A phone-only button that opens a sheet over the editor, or closes it (`null`). */
function SheetButton({
  label,
  icon,
  sheet,
  setSheet,
}: {
  label: string;
  icon: IconType;
  sheet: Sheet;
  setSheet: (sheet: Sheet) => void;
}) {
  return (
    <span className="studio-phone">
      <IconButton
        label={label}
        variant="ghost"
        icon={<Icon icon={icon} size="sm" />}
        onClick={() => {
          setSheet(sheet);
        }}
      />
    </span>
  );
}

/**
 * The profile tree's column: the studio's name and version over the agents and tools. It sits
 * out renders that change nothing it shows, such as the code view or a new compile.
 */
const TreeColumn = memo(function TreeColumn({
  tree,
  draft,
  onAddAgent,
  listRef,
  setSheet,
}: {
  tree: WorkspaceTreeState;
  draft: StudioDraft;
  onAddAgent: (add: AddAgent) => void;
  listRef: RefObject<HTMLDivElement | null>;
  setSheet: (sheet: Sheet) => void;
}) {
  const project = useProject();
  const { kernelVersion } = useStudioHost();
  return (
    <Section variant="transparent" width={TREE_WIDTH} height="100%" padding={4} dividers={['end']}>
      <VStack gap={4} height="100%">
        <HStack gap={2} vAlign="start">
          <StackItem size="fill">
            <VStack gap={1}>
              <Heading level={3}>theorem studio</Heading>
              <Text type="supporting" color="secondary">
                {`${project ? `${project.name} · ` : ''}@theoremjs/agents ${kernelVersion}`}
              </Text>
            </VStack>
          </StackItem>
          <SheetButton label="Close sections" icon={IconX} sheet={null} setSheet={setSheet} />
        </HStack>
        <StackItem size="fill">
          <WorkspaceTreeLists tree={tree} draft={draft} onAddAgent={onAddAgent} listRef={listRef} />
        </StackItem>
      </VStack>
    </Section>
  );
});

/**
 * The issue count, which goes to the next issue after the selected node and shows it there. Hidden
 * with none. It counts every issue, so what blocks a run or Save always has a way to it.
 */
function IssueToken({
  compile,
  selected,
  onIssue,
}: {
  compile: WorkspaceCompile;
  selected: string;
  onIssue: (node: string) => void;
}) {
  const { compiled } = compile;
  if (compiled.ok) return null;
  const issues = issuesLabel(compiled.issues.length);
  if (!issues) return null;
  return (
    <Token
      label={issues}
      color="orange"
      description="Go to the next issue"
      onClick={() => {
        onIssue(nextIssueNode(compiled.issues, selected));
      }}
    />
  );
}

/** Replaces the workspace with one blank agent or one of the examples. */

/**
 * The one button for what the panel shows: the form or the code, which closes Keys, and the map
 * beside either, which opens and closes.
 */
function ViewToggleButton({ view }: { view: EditorViewState }) {
  const current = EDITOR_VIEWS.find((each) => each.id === view.editorView) ?? EDITOR_VIEWS[0];
  return (
    <DropdownMenu
      button={{
        label: current.label,
        variant: 'ghost',
        isIconOnly: true,
        icon: <Icon icon={current.icon} size="sm" />,
        tooltip: 'Switch between the editor, the code, and the map',
      }}
      menuWidth="15rem"
      hasChevron={false}
      placement="below"
      alignment="end"
      items={[
        ...EDITOR_VIEWS.map((each) => ({
          id: each.id,
          label: each.label,
          description: oneLine(each.description),
          icon: <Icon icon={each.icon} size="sm" />,
          endContent:
            each.id === current.id && !view.keysOpen ? (
              <Icon icon={IconCheck} size="sm" />
            ) : undefined,
          onClick: () => {
            view.setKeysOpen(false);
            view.setEditorView(each.id);
          },
        })),
        {
          id: 'map',
          label: 'Map',
          description: oneLine('See how everything connects'),
          icon: <Icon icon={IconSitemap} size="sm" />,
          endContent: view.mapOpen ? <Icon icon={IconCheck} size="sm" /> : undefined,
          onClick: () => {
            view.setMapOpen(!view.mapOpen);
          },
        },
      ]}
    />
  );
}

/** Opens the project's files again in place of every unsaved edit. Undo brings the edits back. */
function useDiscardAll({ store, filesChanged }: StudioWorkspaceState) {
  const toast = useToast();
  return useCallback(() => {
    openProject().then(
      ({ workspace: files }) => {
        const before = store.getWorkspace();
        store.takeFiles(reopened(files, before));
        filesChanged();
        const dismiss = toast({
          body: 'Discarded every unsaved edit.',
          endContent: (
            <Button
              label="Undo"
              variant="ghost"
              size="sm"
              onClick={() => {
                store.update(before);
                dismiss();
              }}
            />
          ),
        });
      },
      () => {
        toast({
          type: 'error',
          body: 'The studio server did not answer, so your edits are still here.',
        });
      },
    );
  }, [store, filesChanged, toast]);
}

/** The editor column's header: its title, the next issue, what to start from, Get code, and the view toggle. */
function EditorToolbar({
  heading,
  compile,
  selected,
  view,
  onIssue,
  project,
  getCode,
  setSheet,
}: {
  heading: string | undefined;
  compile: WorkspaceCompile;
  /** Get code, beside the view toggle. */
  getCode: ReactNode;
  /** An open project's tokens: Save, and what the studio cannot run. */
  project: ReactNode;
  selected: string;
  view: EditorViewState;
  onIssue: (node: string) => void;
  setSheet: (sheet: Sheet) => void;
}) {
  return (
    <Section variant="transparent" padding={3} dividers={['bottom']}>
      <HStack gap={1} vAlign="center">
        <SheetButton label="Sections" icon={IconMenu2} sheet="tree" setSheet={setSheet} />
        <StackItem size="fill">
          {heading && (
            <span title={heading}>
              <Heading level={4} maxLines={1}>
                {heading}
              </Heading>
            </span>
          )}
        </StackItem>
        <StackItem size="static">
          <HStack gap={1} vAlign="center">
            <IssueToken compile={compile} selected={selected} onIssue={onIssue} />
            {project}
          </HStack>
        </StackItem>
        {getCode}
        <ViewToggleButton view={view} />
        <SheetButton label="Preview" icon={IconPlayerPlay} sheet="preview" setSheet={setSheet} />
      </HStack>
    </Section>
  );
}

/** Opens the Keys page, above the providers list, in the same form as Add provider. */
function ManageKeysButton({ keys }: { keys: NonNullable<WorkspaceTreeState['keys']> }) {
  return (
    <Button
      label="Manage keys"
      variant="ghost"
      size="sm"
      width="100%"
      icon={<Icon icon={IconKey} size="sm" />}
      style={{ height: 'calc(var(--size-element-sm) - 4px)' }}
      aria-pressed={keys.open}
      onClick={keys.toggle}
    />
  );
}

/** The Keys panel, in the editor's column. */
function KeysBody({
  connection,
  state,
}: {
  connection: StudioConnectionState;
  state: StudioWorkspaceState;
}) {
  return (
    <ScrollableArea label="Keys" height="100%">
      <KeySlots connection={connection} state={state} />
    </ScrollableArea>
  );
}

/** The key slots, renamed or let go across every agent. */
function KeySlots({
  connection,
  state,
}: {
  connection: StudioConnectionState;
  state: StudioWorkspaceState;
}) {
  const { setDraft, update } = state;
  return (
    <StudioKeys
      connection={connection}
      onAddSlot={(slot) => {
        setDraft((current) =>
          current.models.key ? current : { ...current, models: { ...current.models, key: slot } },
        );
      }}
      onRenameSlot={(from, to) => {
        update((current) => ({
          ...current,
          agents: current.agents.map((agent) => swapKeySlot(agent, from, to)),
        }));
      }}
      onRemoveSlot={(slot) => {
        update((current) => ({
          ...current,
          agents: current.agents.map((agent) => swapKeySlot(agent, slot, '')),
        }));
      }}
    />
  );
}

/**
 * Whether Settings is asked for, for a host that has a door to them. They open in the studio's
 * panel, with the tree, the editor, and the preview kept under them: a run goes on, and the editor
 * is where it was left.
 */
function useStudioSettings() {
  const { hasSettings } = useStudioHost();
  useEffect(() => (hasSettings ? settingsScreen() : undefined), [hasSettings]);
  useEffect(() => {
    if (hasSettings) warmWhenIdle(settingsPanel);
  }, [hasSettings]);
  const door = useSettingsDoor();
  return hasSettings === true && door.open;
}

const HIDDEN = { display: 'none' };

/** Opens Keys where the host keeps them: in Settings, or in the editor's column. */
function useOpenKeys(setKeysOpen: (open: boolean) => void) {
  const { hasSettings } = useStudioHost();
  return useCallback(
    (open: boolean) => {
      if (!hasSettings) setKeysOpen(open);
      else if (open) openSettings('keys');
      else closeSettings();
    },
    [hasSettings, setKeysOpen],
  );
}

/** Settings for the open project, with what they reach in the studio. */
function SettingsPane({
  state,
  connection,
  project,
  setConversation,
}: {
  state: StudioWorkspaceState;
  connection: StudioConnectionState;
  project: ProjectSession;
  setConversation: Dispatch<SetStateAction<number>>;
}) {
  const { kernelVersion } = useStudioHost();
  const { store } = state;
  const save = useProjectSave();
  const toast = useToast();
  const quiet = useSyncExternalStore(store.subscribe, store.isQuiet, store.isQuiet);
  const shared = useMemo(
    () => ({
      asks: !quiet,
      set: (asks: boolean) => {
        store.setQuiet(!asks);
      },
    }),
    [quiet, store],
  );
  const clearChats = useCallback(() => {
    clearConversation();
    setConversation((count) => count + 1);
    toast({ body: "Cleared this tab's chats." });
  }, [setConversation, toast]);
  return (
    <Suspense fallback={null}>
      <StudioSettings
        project={project}
        version={kernelVersion}
        watch={state.watchFiles}
        shared={shared}
        actions={{ clearChats, discard: save?.discard }}
        keys={<KeySlots connection={connection} state={state} />}
      />
    </Suspense>
  );
}

/** The open node's editor, keyed by node so each one opens at its top. */
function EditorBody({
  state,
  connection,
  selected,
  editing,
  issues,
  listBadges,
  editorRef,
  open,
}: {
  state: StudioWorkspaceState;
  connection: StudioConnectionState;
  selected: string;
  editing: string;
  issues: StudioIssue[];
  listBadges: 1 | 2;
  editorRef: RefObject<HTMLDivElement | null>;
  open: (id: string) => void;
}) {
  const { workspace, draft, focus, setDraft, update } = state;
  const project = useProject();
  const workspaceContext = useWorkspaceContext(workspace.agents, focus, update, project !== null);
  const provider = shownProvider(workspace, editing, project !== null, connection);
  return (
    <ScrollableArea key={selected} label="Editor" height="100%" ref={editorRef}>
      <ListBadges value={listBadges}>
        <RunsOn.Provider value={connection.on}>
          <LocalConnection.Provider value={connection}>
            <WorkspaceContext.Provider value={workspaceContext}>
              {provider ? (
                <ProviderEditor
                  workspace={workspace}
                  provider={provider}
                  issues={issues.filter((issue) => issue.nodeId === editing)}
                  // The studio's own providers are the same for everyone, so they only show.
                  onChange={
                    project
                      ? (next) => {
                          update((current) => withProvider(current, next));
                        }
                      : undefined
                  }
                  // A provider the files do not hold yet is the studio's to name; code names the rest.
                  onRename={
                    project && !project.providers.includes(provider.id)
                      ? (id) => {
                          update((current) => renameProvider(current, provider.id, id));
                        }
                      : undefined
                  }
                />
              ) : (
                <ProfileEditor
                  draft={draft}
                  setDraft={setDraft}
                  selectedId={editing}
                  onSelect={(id) => {
                    open(scopedNodeId(focus, id));
                  }}
                  issues={issues}
                />
              )}
            </WorkspaceContext.Provider>
          </LocalConnection.Provider>
        </RunsOn.Provider>
      </ListBadges>
    </ScrollableArea>
  );
}

/** Clears the conversation and its traces; the profile stays. */
function ClearHistoryButton({ run }: { run: ConversationRun }) {
  return (
    <IconButton
      label="Clear history"
      variant="ghost"
      icon={<Icon icon={IconPlaylistX} size="sm" />}
      tooltip="Clear the conversation and its traces. Your profile stays."
      onClick={run.clear}
    />
  );
}

/** The types whose conversation a trace can hold, and so open and replay. */
const NO_CONVERSATION = new Set(['decision', 'host', 'embedding', 'live']);

/** Replay exchange, for a type whose conversation a trace holds. */
function ReplayExchangeButton({
  payload,
  tracing,
}: {
  payload: WorkspaceCompile['payload'];
  tracing: { open: boolean; toggle: () => void };
}) {
  const phone = usePhone();
  if (payload == null || NO_CONVERSATION.has(payload.profile.type)) return null;
  return (
    <Button
      label={tracing.open ? 'Close replay' : 'Replay exchange'}
      isIconOnly={phone}
      variant={tracing.open ? 'secondary' : 'ghost'}
      tooltip={
        tracing.open
          ? 'Back to the live conversation'
          : 'Open a recorded conversation (a .trace.json file) to see what happened, then replay its messages through this agent as it is now and compare'
      }
      icon={<Icon icon={IconFileImport} size="sm" />}
      aria-pressed={tracing.open}
      onClick={tracing.toggle}
    />
  );
}

/** The preview's header: back to the editor, the agent to chat with, history, trace, and Export. */
function PreviewHeader({
  store,
  chatAgents,
  chatWith,
  compile,
  run,
  connection,
  trace,
  testing,
  tracing,
  setSheet,
}: {
  store: StudioStore;
  chatAgents: ChatAgent[];
  chatWith: string;
  compile: WorkspaceCompile;
  run: ConversationRun;
  connection: StudioConnectionState;
  trace: { open: boolean; toggle: () => void };
  /** The guardrail test is open in the conversation's place. */
  testing: boolean;
  /** The imported trace's console, over the conversation. */
  tracing: { open: boolean; toggle: () => void };
  setSheet: (sheet: Sheet) => void;
}) {
  const traceLabel = trace.open ? 'Hide trace' : 'View trace';
  const phone = usePhone();
  const { compiled } = compile;
  return (
    <Section variant="transparent" paddingInline={3} paddingBlock={0}>
      <HStack gap={2} vAlign="center">
        <SheetButton
          label="Back to the editor"
          icon={IconArrowLeft}
          sheet={null}
          setSheet={setSheet}
        />
        <StackItem size="fill">
          <ChatPicker agents={chatAgents} chatWith={chatWith} onChange={store.chatWith} />
        </StackItem>
        <StackItem size="static">
          <HStack gap={1} vAlign="center">
            <ActingAsButton />
            {compile.payload && run.isUsed && !testing && !tracing.open && (
              <ClearHistoryButton run={run} />
            )}
            {!testing && <ReplayExchangeButton payload={compile.payload} tracing={tracing} />}
            {(compile.traced || tracing.open) && !testing ? (
              <Button
                label={traceLabel}
                isIconOnly={phone}
                variant={trace.open ? 'secondary' : 'ghost'}
                tooltip={
                  trace.open
                    ? 'Close the trace'
                    : 'See how each reply was made, step by step: every model and tool call, guardrail check and gate, with its timing'
                }
                icon={<Icon icon={IconActivity} size="sm" />}
                aria-pressed={trace.open}
                onClick={trace.toggle}
              />
            ) : null}
            <OpenInNewTabButton
              compiled={compiled.ok ? compiled : undefined}
              chattedId={compile.chattedId}
              blocked={compile.blocked}
              connection={{
                connectionMode: connection.mode,
                localBaseUrl: connection.local.baseUrl,
              }}
            />
          </HStack>
        </StackItem>
      </HStack>
    </Section>
  );
}

/**
 * Why the agent to chat with does not run: the errors in its config, or the workspace's when its
 * own has none, each a way to where it is set. Nothing while a config that compiles settles.
 */
function ConfigIssues({
  compile,
  chatWith,
  onIssue,
}: {
  compile: WorkspaceCompile;
  chatWith: string;
  onIssue: (node: string) => void;
}) {
  const { compiled } = compile;
  if (compiled.ok) return null;
  const root = agentNodeId(chatWith);
  const own = compiled.issues.filter(
    (issue) => issue.nodeId === root || issue.nodeId.startsWith(`${root}/`),
  );
  const shown = own.length > 0 ? own : compiled.issues;
  const errors = shown.length === 1 ? 'an error' : `${String(shown.length)} errors`;
  return (
    <PaneFailure title={`The agent config has ${errors}`} description="Fix it to run the agent.">
      <VStack gap={2}>
        {shown.map((issue) => (
          <Banner
            key={`${issue.nodeId}:${issue.field ?? ''}:${issue.message}`}
            status="error"
            title={issue.message}
            endContent={
              <Button
                label="Go to it"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onIssue(issue.nodeId);
                }}
              />
            }
          />
        ))}
      </VStack>
    </PaneFailure>
  );
}

/**
 * The runner for the compiled agent, its conversation saved as it goes, or the guardrail tester
 * over it; while none compiles, why.
 */
function PreviewBody({
  compile,
  run,
  connection,
  chatRef,
  chatWith,
  profileId,
  traceOpen,
  testing,
  tracing,
  feedOf,
  onIssue,
}: {
  compile: WorkspaceCompile;
  run: ConversationRun;
  connection: StudioConnectionState;
  chatRef: RefObject<TheoremChatHandle | null>;
  chatWith: string;
  /** The id of the agent to chat with, as a project names it. */
  profileId: string | undefined;
  traceOpen: boolean;
  testing: boolean;
  /** The imported trace's console, shown over the conversation while it is open. */
  tracing: ReactNode;
  /** The feed each runner's trace records land in. */
  feedOf: (runKey: string) => TraceFeed;
  onIssue: (node: string) => void;
}) {
  const { payload, traced, tested } = compile;
  /** Why the project's server does not run this profile: its files say, not the editor. */
  const unserved = useProject()?.problems.find((problem) => problem.profile === profileId);
  const pageInputs = useMemo(() => (payload ? pageInputsOf(payload) : null), [payload]);
  const [pageValues] = usePageValues(chatWith);
  const sent = useMemo(() => sentPageValues(pageInputs, pageValues), [pageInputs, pageValues]);
  const shown: KeptRun | null =
    payload && !unserved
      ? {
          chatKey: run.chatKey,
          generation: run.generation,
          props: {
            payload,
            onActivity: run.markUsed,
            conversation: run.conversation,
            conversationView: run.conversationView,
            initialText: run.initialText,
            onConversationChange: (ref) => {
              if (ref) saveConversation(run.chatKey, run.sealer, ref);
              else clearConversation(run.chatKey);
            },
            slots: sent.slots,
            context: sent.context,
            tested,
          },
        }
      : null;
  const kept = useKeptRuns(run, shown);
  const blocked = unserved ? (
    <PaneFailure
      title={`${unserved.profile} does not run here yet`}
      description={unserved.message}
    />
  ) : payload ? null : (
    <ConfigIssues compile={compile} chatWith={chatWith} onIssue={onIssue} />
  );
  return (
    <InPlace
      view={
        testing && payload ? (
          <RaisedPane>
            {(isWide) => (
              <Suspense fallback={null}>
                <GuardrailPane payload={payload} isWide={isWide} />
              </Suspense>
            )}
          </RaisedPane>
        ) : (
          tracing
        )
      }
    >
      <VStack height="100%">
        <StackItem size="fill">
          {blocked}
          {kept.map(([key, { props }]) => {
            const isShown = shown !== null && key === run.runKey;
            return (
              // Hidden, not unmounted: a call it is running goes on, and what it showed stays.
              <div key={key} style={{ display: isShown ? 'contents' : 'none' }}>
                <StudioRunner
                  {...props}
                  mode={connection.mode}
                  runtime={connection.runtime}
                  trace={traced ? traceOpen : undefined}
                  chatRef={isShown ? chatRef : undefined}
                  traces={feedOf(key)}
                />
              </div>
            );
          })}
        </StackItem>
      </VStack>
    </InPlace>
  );
}

/** A runner the preview has shown: its chat, the runners it belongs with, and what it ran with last. */
type KeptRun = {
  chatKey: string;
  generation: string;
  props: Pick<
    StudioRunnerProps,
    | 'payload'
    | 'onActivity'
    | 'conversation'
    | 'conversationView'
    | 'initialText'
    | 'onConversationChange'
    | 'slots'
    | 'context'
    | 'tested'
  >;
};

/**
 * Every runner the preview has shown, each as it was last shown. Switching agents hides one and
 * shows another, so neither loses its conversation, results, trace or a call still running. A
 * cleared chat drops its own runner; another mode or a new workspace drops them all.
 */
function useKeptRuns(run: ConversationRun, shown: KeptRun | null): [string, KeptRun][] {
  const [kept] = useState(() => new Map<string, KeptRun>());
  for (const [key, each] of kept) {
    const replaced = each.chatKey === run.chatKey && key !== run.runKey;
    if (each.generation !== run.generation || replaced) kept.delete(key);
  }
  if (shown) kept.set(run.runKey, shown);
  return [...kept];
}

/**
 * The trace feed of each runner, by its run key: the header downloads the one on screen. Another
 * mode or a restart drops them all, as it drops the runners.
 */
function useRunFeeds(generation: string) {
  const [feeds] = useState(() => new Map<string, TraceFeed>());
  return useCallback(
    (runKey: string) => {
      for (const key of feeds.keys()) if (!key.startsWith(`${generation}:`)) feeds.delete(key);
      let feed = feeds.get(runKey);
      if (!feed) {
        feed = createTraceFeed();
        feeds.set(runKey, feed);
      }
      return feed;
    },
    [feeds, generation],
  );
}

/** Sends a message once the runner for the next run key is ready: a conversation goes on live. */
function useSendAfterResume(chatRef: RefObject<TheoremChatHandle | null>, runKey: string) {
  const [next, setNext] = useState<{ text: string; after: string }>();
  useEffect(() => {
    if (!next?.text || next.after === runKey) return;
    const controller = new AbortController();
    // why: cleared once sent, not before: clearing re-renders, and the cleanup would abort the send.
    void sendWhenReady(chatRef, next.text, controller.signal).then(() => {
      if (!controller.signal.aborted) setNext(undefined);
    });
    return () => {
      controller.abort();
    };
  }, [next, runKey, chatRef]);
  return useCallback(
    (text: string) => {
      setNext({ text, after: runKey });
    },
    [runKey],
  );
}

/**
 * The compiled agent to chat with, under its header; while none compiles, why. It sits out renders
 * that change nothing it shows: typing in the editor, opening a node, Keys.
 */
const PreviewPane = memo(function PreviewPane({
  store,
  chatAgents,
  chatWith,
  compile,
  run,
  connection,
  chatRef,
  setSheet,
  onIssue,
  testing,
}: {
  store: StudioStore;
  chatAgents: ChatAgent[];
  chatWith: string;
  compile: WorkspaceCompile;
  run: ConversationRun;
  connection: StudioConnectionState;
  chatRef: RefObject<TheoremChatHandle | null>;
  setSheet: (sheet: Sheet) => void;
  /** Opens the node an issue is on, in the editor. */
  onIssue: (node: string) => void;
  /** The guardrail test, opened from the Guardrails page, takes the conversation's place. */
  testing: boolean;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const [imported, setTracing] = useState(false);
  // why: The guardrail test covers an imported trace too; closing the test shows it again.
  const tracing = imported && !testing;
  const feedOf = useRunFeeds(run.generation);
  const profileId = chatAgents.find((agent) => agent.value === chatWith)?.label;
  const sendNext = useSendAfterResume(chatRef, run.runKey);
  const { payload } = compile;
  const traceView =
    tracing && payload ? (
      <Suspense fallback={null}>
        <TraceReplay
          payload={payload}
          runtime={connection.runtime}
          trace={traceOpen}
          onLive={({ conversation, view, text }) => {
            run.resume(conversation, view);
            setTracing(false);
            sendNext(text);
          }}
        />
      </Suspense>
    ) : null;
  return (
    <LayoutContent className="studio-preview shell-fade" isScrollable={false} padding={0}>
      <VStack height="100%">
        <PreviewHeader
          store={store}
          chatAgents={chatAgents}
          chatWith={chatWith}
          compile={compile}
          run={run}
          connection={connection}
          trace={{
            open: traceOpen,
            toggle: () => {
              setTraceOpen((open) => !open);
            },
          }}
          testing={testing}
          tracing={{
            open: tracing,
            toggle: () => {
              setTracing((open) => !open);
            },
          }}
          setSheet={setSheet}
        />
        <StackItem size="fill">
          <PreviewBody
            compile={compile}
            run={run}
            connection={connection}
            chatRef={chatRef}
            chatWith={chatWith}
            profileId={profileId}
            traceOpen={traceOpen}
            testing={testing}
            tracing={traceView}
            feedOf={feedOf}
            onIssue={onIssue}
          />
        </StackItem>
      </VStack>
    </LayoutContent>
  );
});

/** Tells the host what is on screen as it changes, and that it closed. */
function useScreenReport(
  onReport: StudioHost['onReport'],
  { agent, type, issues, section }: StudioReport,
) {
  useEffect(() => {
    onReport?.({ agent, type, issues, section });
  }, [onReport, agent, type, issues, section]);
  useEffect(() => () => onReport?.(null), [onReport]);
}

/** Everything the page holds: the workspace, its connection, the editor's view, the compile, and the run. */
/** What the page opens on: the studio's own loader data, or an open project's. */
function useStudioPage(opened: StudioOpened) {
  const { onReport } = useStudioHost();
  const state = useStudioWorkspace(opened.start, opened.project);
  const { store, workspace, draft, focus } = state;
  const connection = useWorkspaceConnection(workspace);
  const view = useEditorView(store);
  const frame = useStudioFrame();
  const selected = selectedNode(workspace, focus);
  /** The open node as the editor names it: the open agent's own id, or a library tool's. */
  const editing = innerNodeId(selected, focus) ?? 'identity';
  const issueReveal = useIssueReveal(selected);
  const compile = useWorkspaceCompile(workspace, focus, connection);
  /** On a phone, the tree or the preview, each over the editor; neither shows beside it there. */
  const [sheet, setSheet] = useState<Sheet>(null);
  const { open: openNode } = view;
  const { reveal } = issueReveal;
  /** Opens the node an issue is on and shows it there, from the editor's count or the preview. */
  const goToIssue = useCallback(
    (node: string) => {
      openNode(node);
      reveal({ node });
      setSheet(null);
    },
    [openNode, reveal],
  );
  const [askedQuestion, setAskedQuestion] = useState<string>();
  const { chatWith } = workspace;
  /** Opens the decision being run, in the editor, at the question an answer is for. */
  const questionLink = useMemo(
    () => ({
      asked: askedQuestion,
      open: (id: string) => {
        openNode(scopedNodeId(chatWith, 'decision'));
        setAskedQuestion(id);
        setSheet(null);
      },
      shown: () => {
        setAskedQuestion(undefined);
      },
    }),
    [askedQuestion, chatWith, openNode],
  );
  // Settings take the panel; a phone's sheet over it would hide them.
  const { settingsOpen } = view;
  useEffect(() => {
    if (settingsOpen) setSheet(null);
  }, [settingsOpen]);
  // The project as its files are now: a Save changes which profiles they hold.
  const project = useMemo(
    () => (opened.project ? { ...opened.project, ...state.files } : null),
    [opened.project, state.files],
  );
  const actingAs = useActingAsState(project);
  const run = useConversationRun(
    connection.mode,
    // A run in the page seals with the tab's key; the hosted demo seals on its server.
    connection.runtime ? 'page' : 'demo',
    workspace.chatWith,
    actingAs.actingAs,
    opened.question,
  );
  useArrivalToast(opened, store);
  const { replaceWorkspace, copy } = usePageActions(store, view, run.setConversation);
  const asking = useConfirmWrite();
  const openKeys = useOpenKeys(view.setKeysOpen);
  const chatRef = useStudioSurface(store, {
    confirmWrite: asking.confirm,
    on: connection.on,
    connection,
    replaceWorkspace,
    copy,
    setKeysOpen: openKeys,
    newConversation: run.clear,
    project: opened.project ?? null,
  });
  const title =
    providerIdOf(editing) ??
    (toolSpecKeyOf(editing) === undefined
      ? editorTitle(draft, editing)
      : workspaceTree(state.workspace).tools.find((node) => node.id === editing)?.label);
  useScreenReport(onReport, screenReport(draft, compile.compiled, title));
  return {
    state,
    connection,
    view,
    frame,
    selected,
    editing,
    issueReveal,
    goToIssue,
    questionLink,
    compile,
    sheet,
    setSheet,
    run,
    copy,
    chatRef,
    title,
    asking,
    project,
    actingAs,
  };
}

/**
 * The profile tree beside the editor (or code) for the draft in a panel on the left; the compiled
 * agent on the right, under Get code. The draft compiles as it changes; while it doesn't
 * compile, the agent stays the last one that did.
 */
function Studio({ opened }: { opened: StudioOpened }) {
  const page = useStudioPage(opened);
  const { state, connection, view, frame, selected, editing, issueReveal, compile } = page;
  const { goToIssue, sheet, setSheet, run, copy, chatRef, title, asking, project, actingAs } = page;
  const { questionLink } = page;
  const { store, draft } = state;
  const tree = useWorkspaceTree(state, view, selected, setSheet);
  const chatAgents = useChatAgents(state.workspace.agents);
  const addAgentFrom = useAddAgent(store, state.update, view.open);
  const { setMapOpen } = view;
  const closeMap = useCallback(() => {
    setMapOpen(false);
  }, [setMapOpen]);
  const [testing, setTesting] = useState(false);
  const guardrailTest = useMemo(
    () =>
      compile.payload
        ? {
            open: testing,
            toggle: () => {
              // why: On a phone the test shows in the preview sheet, so opening it goes there.
              if (!testing) setSheet('preview');
              setTesting(!testing);
            },
          }
        : null,
    [compile.payload, testing, setSheet],
  );

  return (
    <ProjectContext.Provider value={project}>
      <ActingAsContext.Provider value={actingAs}>
        <ConfirmWrite value={asking.confirm}>
          <ProjectAsks value={state.asks ?? NO_ASKS}>
            {asking.dialog}
            <SharedChange store={state.store} />
            <SaveScope project={project} state={state} blocked={Boolean(compile.blocked)}>
              <QuestionLink value={questionLink}>
                <GuardrailTest.Provider value={guardrailTest}>
                  <Layout
                    ref={frame.layoutCallbackRef}
                    className={frameClass(sheet, view.mapOpen, view.settingsOpen)}
                    padding={0}
                    start={
                      <SidePanel
                        frame={frame}
                        tree={tree}
                        draft={draft}
                        onAddAgent={addAgentFrom}
                        setSheet={setSheet}
                        settings={
                          view.settingsOpen &&
                          project && (
                            <SettingsPane
                              state={state}
                              connection={connection}
                              project={project}
                              setConversation={run.setConversation}
                            />
                          )
                        }
                        map={
                          view.mapOpen && (
                            <Suspense fallback={null}>
                              <StudioMap
                                workspace={state.workspace}
                                shared={state.shared}
                                selected={view.keysOpen ? '' : selected}
                                onOpen={view.open}
                                onClose={closeMap}
                              />
                            </Suspense>
                          )
                        }
                      >
                        <EditorColumn
                          heading={view.keysOpen ? 'Keys' : headingOf(tree.list, editing, title)}
                          state={state}
                          connection={connection}
                          view={view}
                          compile={compile}
                          selected={selected}
                          editing={editing}
                          frame={frame}
                          issueReveal={issueReveal}
                          goToIssue={goToIssue}
                          copy={copy}
                          setSheet={setSheet}
                        />
                      </SidePanel>
                    }
                    content={
                      <PreviewPane
                        store={store}
                        chatAgents={chatAgents}
                        chatWith={state.workspace.chatWith}
                        compile={compile}
                        run={run}
                        connection={connection}
                        chatRef={chatRef}
                        setSheet={setSheet}
                        onIssue={goToIssue}
                        testing={testing && Boolean(compile.payload)}
                      />
                    }
                  />
                </GuardrailTest.Provider>
              </QuestionLink>
            </SaveScope>
          </ProjectAsks>
        </ConfirmWrite>
      </ActingAsContext.Provider>
    </ProjectContext.Provider>
  );
}

/** Save for the screen under it, when the studio is open on a project. */
function SaveScope({
  project,
  state,
  blocked,
  children,
}: {
  project: ProjectSession | null;
  state: StudioWorkspaceState;
  blocked: boolean;
  children: ReactNode;
}) {
  const discard = useDiscardAll(state);
  const { showConflict } = state;
  const choose = useCallback(() => {
    showConflict(true);
  }, [showConflict]);
  if (!project) return children;
  return (
    <ProjectSave
      project={project}
      workspace={state.workspace}
      update={state.update}
      onFilesChanged={state.filesChanged}
      onDiscard={discard}
      // A Save would be built on files that changed: it waits for the builder's choice.
      blocked={blocked || Boolean(state.conflict)}
    >
      <ChooseConflictsContext.Provider value={state.conflict ? choose : undefined}>
        {children}
      </ChooseConflictsContext.Provider>
      {state.conflict?.open && (
        <FileConflicts
          conflicts={state.conflict.merge.conflicts}
          files={state.conflict.files}
          onApply={state.settle}
          onClose={() => {
            state.showConflict(false);
          }}
        />
      )}
    </ProjectSave>
  );
}

/** Adds an agent and opens it. */
function useAddAgent(
  store: StudioStore,
  update: StudioWorkspaceState['update'],
  open: (id: string) => void,
) {
  return useCallback(
    (add: AddAgent) => {
      update(add);
      open(store.getWorkspace().selected);
    },
    [store, update, open],
  );
}

/** What the tree reads of the page; opening a node closes the phone's sheet, and Keys selects nothing. */
function useWorkspaceTree(
  state: StudioWorkspaceState,
  view: EditorViewState,
  selected: string,
  setSheet: (sheet: Sheet) => void,
): WorkspaceTreeState {
  const { workspace, focus, update, setDraft } = state;
  const { open, keysOpen, setKeysOpen, setEditorView } = view;
  const selectedId = keysOpen ? '' : selected;
  const { list, setList } = useListShown(selectedId);
  const ownsProviders = useProject() !== null;
  const { hasSettings } = useStudioHost();
  const toast = useToast();
  const reset = useCallback(
    (to: StudioWorkspace, body: string) =>
      to === workspace
        ? undefined
        : () => {
            update(() => to);
            const dismiss = toast({
              body,
              endContent: (
                <Button
                  label="Undo"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    update(() => workspace);
                    dismiss();
                  }}
                />
              ),
            });
          },
    [workspace, update, toast],
  );
  const keys = useMemo(
    () =>
      hasSettings
        ? null
        : {
            open: keysOpen,
            toggle: () => {
              setKeysOpen((was) => !was);
              setEditorView('editor');
              setSheet(null);
            },
          },
    [hasSettings, keysOpen, setKeysOpen, setEditorView, setSheet],
  );
  return useMemo(
    () => ({
      workspace,
      focus,
      selectedId,
      list,
      ownsProviders,
      setList,
      onSelect: (id) => {
        open(id);
        setSheet(null);
      },
      update,
      setDraft,
      reset,
      keys,
    }),
    [
      workspace,
      focus,
      selectedId,
      list,
      ownsProviders,
      setList,
      open,
      setSheet,
      update,
      setDraft,
      reset,
      keys,
    ],
  );
}

/** The resizable side panel: the tree beside the editor column (`children`), and its handle. */
function SidePanel({
  frame,
  tree,
  draft,
  onAddAgent,
  setSheet,
  settings,
  map,
  children,
}: {
  frame: ReturnType<typeof useStudioFrame>;
  tree: WorkspaceTreeState;
  draft: StudioDraft;
  onAddAgent: (add: AddAgent) => void;
  setSheet: (sheet: Sheet) => void;
  /** Settings, while they are open: in the tree's and the editor's place, which stay under them. */
  settings: ReactNode;
  /** The map, while it is open: beside the editor, in the room the preview gave up. */
  map: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <LayoutPanel
        resizable={frame.sidePanel.props}
        padding={0}
        className="studio-side"
        role="navigation"
        label="Studio"
        isScrollable={false}
      >
        <Section variant="raised" height="100%" padding={0} data-shell-frame="">
          {settings}
          <HStack height="100%" className="shell-fade" style={settings ? HIDDEN : undefined}>
            {/* Static, so the editor beside it never squeezes the tree. */}
            <StackItem size="static" className="studio-tree">
              <TreeColumn
                tree={tree}
                draft={draft}
                onAddAgent={onAddAgent}
                listRef={frame.sidebarRef}
                setSheet={setSheet}
              />
            </StackItem>
            <StackItem size="fill" className="studio-view">
              {children}
            </StackItem>
            {map && (
              <>
                {/* The panel's own handle went with the preview; this one resizes the editor the same way. */}
                <ResizeHandle
                  className="studio-map-handle"
                  direction="horizontal"
                  isAlwaysVisible={false}
                  resizable={frame.sidePanel.props}
                  label="Resize editor"
                />
                <StackItem size="fill" className="studio-map-pane">
                  {map}
                </StackItem>
              </>
            )}
          </HStack>
        </Section>
      </LayoutPanel>
      <ResizeHandle
        className="studio-side-handle shell-fade"
        direction="horizontal"
        isAlwaysVisible={false}
        resizable={frame.sidePanel.props}
        label="Resize profile"
      />
    </>
  );
}

/**
 * Over a section that is a shared setting: its name, where the project declares it, and how many
 * other profiles change with it.
 */
function SharedLine({
  entry,
  workspace,
  selected,
  onOpen,
}: {
  entry: SharedEntry;
  workspace: StudioWorkspace;
  /** The open node, whose agent is not one of the others. */
  selected: string;
  /** Opens where the setting is written. */
  onOpen: (() => void) | undefined;
}) {
  const others = entry.agents.flatMap((key) => {
    const agent = workspace.agents.find((each) => each.key === key);
    return agent && !selected.startsWith(`${agentNodeId(key)}/`)
      ? [agent.identity.agentId || 'New agent']
      : [];
  });
  const count = others.length;
  return (
    <Section variant="transparent" padding={3}>
      <Banner
        status="info"
        title={`${entry.setting.label} · used by ${String(count)} other ${count === 1 ? 'profile' : 'profiles'}`}
        description={`${declaredAt(entry)}. A change here changes ${others.join(', ')} too.`}
        endContent={onOpen && <Button label="Open" variant="ghost" size="sm" onClick={onOpen} />}
      />
    </Section>
  );
}

/** Over a node one place in the project's files sets whole: what sets it, where, and the way there. */
function OriginBanner({
  origin,
  partly,
  onOpen,
}: {
  origin: SettingOrigin;
  /** The origin sets only the rows the files do not write themselves. */
  partly: boolean;
  onOpen: () => void;
}) {
  const place = originPlace(origin);
  // The cause is the title. Here: what it does to this page, then the way out.
  const effect = partly ? 'The greyed rows are read-only here.' : 'Read-only here.';
  const way = place ? `Edit it at ${place}.` : originWay(origin);
  return (
    <Section variant="transparent" padding={3}>
      <Banner
        status="info"
        title={originLabel(origin)}
        description={`${effect} ${way}`}
        endContent={place && <Button label="Open" variant="ghost" size="sm" onClick={onOpen} />}
      />
    </Section>
  );
}

/** The editor column: its toolbar over the Keys panel, the open node's editor, or its code. */
function EditorColumn({
  heading,
  state,
  connection,
  view,
  compile,
  selected,
  editing,
  frame,
  issueReveal,
  goToIssue,
  copy,
  setSheet,
}: {
  heading: string | undefined;
  state: StudioWorkspaceState;
  connection: StudioConnectionState;
  view: EditorViewState;
  compile: WorkspaceCompile;
  selected: string;
  editing: string;
  frame: ReturnType<typeof useStudioFrame>;
  issueReveal: ReturnType<typeof useIssueReveal>;
  goToIssue: (node: string) => void;
  copy: (text: string, what: string) => void;
  setSheet: (sheet: Sheet) => void;
}) {
  const { editorRef, revealed } = issueReveal;
  // Keys stands over the open node, so it doesn't say what sets it.
  const over = view.keysOpen;
  const shared = over ? undefined : sharedAt(state.shared, selected);
  const { shown, leavePage } = useLeftIssues(compile.editorIssues, selected, revealed);
  const project = useProject();
  const openOrigin = useOpenOrigin(project);
  const rowOrigins = useMemo(() => {
    const scope = state.origins && nodeOrigins(state.workspace, state.origins, selected);
    return scope ? { scope, open: openOrigin } : null;
  }, [state.origins, state.workspace, selected, openOrigin]);
  const whole = rowOrigins?.scope.section;
  const said = over ? undefined : (whole ?? rowOrigins?.scope.partly);
  return (
    <VStack height="100%">
      <EditorToolbar
        heading={heading}
        compile={compile}
        selected={selected}
        view={view}
        onIssue={goToIssue}
        getCode={<ExportMenu store={state.store} compile={compile} copy={copy} />}
        project={
          project && (
            <>
              {state.conflict && (
                <Token
                  label={conflictsLabel(state.conflict.merge.conflicts.length)}
                  color="orange"
                  description="Choose between studio edits and source code"
                  onClick={() => {
                    state.showConflict(true);
                  }}
                />
              )}
              <ProjectTokens project={project} unloaded={state.files?.unloaded} />
            </>
          )
        }
        setSheet={setSheet}
      />
      {shared && (
        <SharedLine
          entry={shared}
          workspace={state.workspace}
          selected={selected}
          onOpen={
            project
              ? () => {
                  openOrigin({
                    path: [],
                    kind: 'code',
                    file: shared.setting.file,
                    line: shared.setting.line,
                  });
                }
              : undefined
          }
        />
      )}
      {said && (
        <OriginBanner
          origin={said}
          partly={!whole}
          onOpen={() => {
            openOrigin(said);
          }}
        />
      )}
      <StackItem size="fill">
        <RowOrigins value={rowOrigins}>
          <LeavePage value={leavePage}>
            <EditorColumnBody
              state={state}
              connection={connection}
              view={view}
              compile={compile}
              rowIssues={shown}
              selected={selected}
              editing={editing}
              frame={frame}
              editorRef={editorRef}
            />
          </LeavePage>
        </RowOrigins>
      </StackItem>
    </VStack>
  );
}

/** The provider open at `editing`, as the editor and the code view show it. */
function shownProvider(
  workspace: StudioWorkspace,
  editing: string,
  inProject: boolean,
  connection: StudioConnectionState,
): StudioProvider | undefined {
  const held = workspace.providers.find((each) => each.id === providerIdOf(editing));
  // The studio's own local provider is reached where the local connection says, as a run reaches it.
  return held && onStudioLocal(held.id, inProject)
    ? { ...held, connection: { baseURL: localProviderAddress(connection.local.baseUrl) } }
    : held;
}

/** Under the editor's header: the Keys panel, the open node's editor, or its code. */
function EditorColumnBody({
  state,
  connection,
  view,
  compile,
  rowIssues,
  selected,
  editing,
  frame,
  editorRef,
}: {
  state: StudioWorkspaceState;
  connection: StudioConnectionState;
  view: EditorViewState;
  compile: WorkspaceCompile;
  /** The issues the editor's rows show; the code view marks them all. */
  rowIssues: StudioIssue[];
  selected: string;
  editing: string;
  frame: ReturnType<typeof useStudioFrame>;
  editorRef: RefObject<HTMLDivElement | null>;
}) {
  const project = useProject();
  const provider = shownProvider(state.workspace, editing, project !== null, connection);
  if (view.keysOpen) return <KeysBody connection={connection} state={state} />;
  if (view.editorView === 'code') {
    return (
      <Suspense fallback={null}>
        {provider ? (
          <ProviderCode
            provider={provider}
            issues={rowIssues.filter((issue) => issue.nodeId === editing)}
            state={state}
            isEditable={project !== null}
          />
        ) : (
          <CodeBody
            source={compile.source}
            blocked={compile.blocked}
            issues={compile.editorIssues}
            state={state}
          />
        )}
      </Suspense>
    );
  }
  return (
    <ProbedAgent.Provider value={compile.probed}>
      <EditorBody
        state={state}
        connection={connection}
        selected={selected}
        editing={editing}
        issues={rowIssues}
        listBadges={frame.listBadges}
        editorRef={editorRef}
        open={view.open}
      />
    </ProbedAgent.Provider>
  );
}

/** The studio, opened on `opened`, with what the page showing it provides. */
export function StudioScreen({ opened, host }: { opened: StudioOpened; host: StudioHost }) {
  useEffect(() => {
    warmWhenIdle(testerPanel, traceReplay, mapPanel, codePane, exportKit);
  }, []);
  return (
    <StudioHostContext.Provider value={host}>
      <Studio opened={opened} />
    </StudioHostContext.Provider>
  );
}
