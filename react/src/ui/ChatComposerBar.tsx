import { Button } from '@astryxdesign/core/Button';
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerStatus,
  ChatSendButton,
} from '@astryxdesign/core/Chat';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip as HoverTip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconArrowBigRightLines,
  IconArrowDown,
  IconArrowUp,
  IconBrain,
  IconCornerDownLeft,
  IconInputAi,
  IconListNumbers,
  IconMicrophone,
  IconPaperclip,
  IconPencil,
  IconPlayerRecordFilled,
  IconSend,
  IconStack2,
  IconSteeringWheel,
  IconX,
} from '@tabler/icons-react';
import { attachmentIssueText, type LabelOverrides, labelText } from '@theoremjs/agents';
import {
  type AttachmentValidationIssue,
  type ComposerMenuAction,
  type ComposerPendingMessage,
  type ComposerProfileInterface,
  type ComposerRunPhase,
  composerPendingMoves,
  composerPendingPreview,
  effortSelectEnabled,
  interfaceEffortOptions,
  interfaceModelOptions,
  type LiveProfileInterface,
  modelSelectEnabled,
} from '@theoremjs/agents/interface';
import type { ClientFailure } from '@theoremjs/web/client';
import {
  type ComposerDrawerSummary,
  type ComposerHint as ComposerHintData,
  composerActionState,
  composerDrawerSummary,
  isStashShortcut,
  resolveComposerHint,
  STASH_SHORTCUT,
} from '@theoremjs/web/client';
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { stageComposerFiles } from '../client/composer-attachments.ts';
import { useComposerVoice, type VoiceFailure } from '../components/use-composer-voice.ts';
import { useEditorSelection } from '../components/use-editor-selection.ts';
import { composerDrawerLabel } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { VoiceNote } from './VoiceNote.tsx';

const NO_FOCUS_RING = { '--focus-outline-width': '0px' } as React.CSSProperties;

/** A slot the profile declares: its allowed values, the one chosen, and how to choose another. */
/** The effort selector's icon. The studio's Agents list shows the same one. */
export const EFFORT_ICON = IconBrain;

export type SlotChoiceOption = {
  value: string;
  description?: string;
};

export type SlotDeclView = {
  label?: string;
  choices: readonly SlotChoiceOption[];
};

export type SlotChoices = {
  declared: Readonly<Record<string, SlotDeclView>>;
  values: Readonly<Record<string, string>>;
  onChange: (name: string, value: string) => void;
};

export type ChatComposerBarProps = {
  iface: ComposerProfileInterface;
  draftText: string;
  pendingFiles: readonly File[];
  pendingVoice: readonly File[];
  pendingMessages: readonly ComposerPendingMessage[];
  /** Files the last send refused, one per reason; worded with the profile's labels. */
  issues: readonly AttachmentValidationIssue[];
  phase: ComposerRunPhase;
  failure: ClientFailure | null;
  selectedModel?: string;
  selectedEffort?: string;
  placeholder?: string;
  /** Imperative handle for the editor (focus, insert). */
  inputRef?: React.Ref<ChatComposerInputHandle>;
  onDraftTextChange: (text: string) => void;
  onFilesSelected: (files: File[]) => void;
  onAttachmentRemove: (index: number) => void;
  onVoiceStaged: (file: File) => void;
  onVoiceClear: () => void;
  onSubmit: () => void;
  onStop: () => void;
  onMenuAction: (action: ComposerMenuAction) => void;
  onGenerationChange?: (next: { modelId: string; effort?: string }) => void;
  /** Stands in for the model and effort selectors, for a bar whose choices are not one chat's. */
  generationSelect?: ReactNode;
  /** The profile's `inputs.slots` with the value chosen for each; one selector per slot, beside the model's. */
  slotChoices?: SlotChoices;
  onPendingMove: (id: string, direction: 'up' | 'down') => void;
  onPendingRemove: (id: string) => void;
  onPendingQueue: (id: string) => void;
  onPendingRestore: (id: string) => void;
  onPendingSendNow: (id: string) => void;
};

/** A Live call's text line: it is sent as typed, so there is nothing to attach, queue, or stop. */
export type LiveComposerBarProps = Omit<
  Pick<
    ChatComposerBarProps,
    'draftText' | 'placeholder' | 'inputRef' | 'onDraftTextChange' | 'onSubmit'
  >,
  'onSubmit'
> & {
  /** The typed line. The button reads the field, so this is the text, not the click. */
  onSubmit: (text: string) => void;
  /** The live profile, when the host has one. The placeholder uses its handle. */
  iface?: LiveProfileInterface;
  /** Profile handle, when the host has no interface object. Wins over `iface`. */
  handle?: string;
  /** Off while no call is connected. */
  isDisabled: boolean;
};

const isImage = (file: File) => file.type.startsWith('image/');
const anyFile = () => true;

/**
 * Object URLs for the files `keep` (a module-level predicate) accepts, revoked when the files change.
 * why: Each URL is made in the effect that revokes it, so a remount (strict mode, a moved subtree)
 * makes fresh ones instead of keeping revoked ones; until the effect runs the files have none.
 */
function useObjectUrls(
  files: readonly File[],
  keep: (file: File) => boolean,
): (string | undefined)[] {
  const [made, setMade] = useState<{ files: readonly File[]; urls: (string | undefined)[] }>();
  useEffect(() => {
    const urls = files.map((file) => (keep(file) ? URL.createObjectURL(file) : undefined));
    setMade({ files, urls });
    return () => {
      for (const url of urls) if (url) URL.revokeObjectURL(url);
    };
  }, [files, keep]);
  return made?.files === files ? made.urls : [];
}

/** Each way to send, by the same icon in the send menu and on a waiting message. */
const SEND_ICON: Record<ComposerMenuAction, typeof IconX> = {
  queue: IconListNumbers,
  steer: IconSteeringWheel,
  send_now: IconArrowBigRightLines,
  stash: IconArchive,
};

function PendingRow(props: {
  message: ComposerPendingMessage;
  moves: { up: boolean; down: boolean };
  onMove: ChatComposerBarProps['onPendingMove'];
  onRemove: ChatComposerBarProps['onPendingRemove'];
  onQueue: ChatComposerBarProps['onPendingQueue'];
  onRestore: ChatComposerBarProps['onPendingRestore'];
  onSendNow: ChatComposerBarProps['onPendingSendNow'];
}) {
  const { message } = props;
  const t = useLabels();
  const icon = (Glyph: typeof IconX) => <Glyph size={14} />;
  const edit = t('@theorem.composer.pending.edit');
  const queue = t('@theorem.composer.pending.queue_action');
  const sendNow = t('@theorem.composer.pending.send_now');
  const moveUp = t('@theorem.composer.pending.move_up');
  const moveDown = t('@theorem.composer.pending.move_down');
  const remove = t('@theorem.composer.pending.remove');
  const Kind = SEND_ICON[message.kind];
  return (
    <HStack gap={1} align="center" width="100%">
      <HoverTip content={t(`@theorem.composer.pending.${message.kind}.description`)}>
        <Token
          label={t(`@theorem.composer.pending.${message.kind}`)}
          isLabelHidden
          color={message.kind === 'steer' ? 'blue' : 'default'}
          icon={<Kind size={14} />}
        />
      </HoverTip>
      {/* why: A zero basis keeps the text out of the row's width, so it truncates before the actions instead of widening the drawer. */}
      <StackItem size="fill" style={{ width: 0 }}>
        <Text size="sm" maxLines={1} hasTruncateTooltip>
          {composerPendingPreview(message)}
        </Text>
      </StackItem>
      <HStack gap={0.5}>
        <IconButton
          label={edit}
          tooltip={edit}
          size="sm"
          variant="ghost"
          icon={icon(IconPencil)}
          onClick={() => props.onRestore(message.id)}
        />
        {message.kind === 'stash' ? (
          <IconButton
            label={queue}
            tooltip={queue}
            size="sm"
            variant="ghost"
            icon={icon(IconCornerDownLeft)}
            onClick={() => props.onQueue(message.id)}
          />
        ) : null}
        <IconButton
          label={sendNow}
          tooltip={sendNow}
          size="sm"
          variant="ghost"
          icon={icon(IconSend)}
          onClick={() => props.onSendNow(message.id)}
        />
        {props.moves.up ? (
          <IconButton
            label={moveUp}
            tooltip={moveUp}
            size="sm"
            variant="ghost"
            icon={icon(IconArrowUp)}
            onClick={() => props.onMove(message.id, 'up')}
          />
        ) : null}
        {props.moves.down ? (
          <IconButton
            label={moveDown}
            tooltip={moveDown}
            size="sm"
            variant="ghost"
            icon={icon(IconArrowDown)}
            onClick={() => props.onMove(message.id, 'down')}
          />
        ) : null}
        <IconButton
          label={remove}
          tooltip={remove}
          size="sm"
          variant="ghost"
          icon={icon(IconX)}
          onClick={() => props.onRemove(message.id)}
        />
      </HStack>
    </HStack>
  );
}

type ModelOption = ReturnType<typeof interfaceModelOptions>[number];
type EffortOption = ReturnType<typeof interfaceEffortOptions>[number];

/** The model and effort choices this profile offers; efforts only for a chosen model. */
export function generationOptions(iface: ComposerProfileInterface, selectedModel?: string) {
  const models = modelSelectEnabled(iface) ? interfaceModelOptions(iface) : [];
  const efforts =
    selectedModel && effortSelectEnabled(iface, selectedModel)
      ? interfaceEffortOptions(iface, selectedModel)
      : [];
  return { models, efforts };
}

function ModelSelector(props: {
  label: string;
  models: readonly ModelOption[];
  value?: string;
  isDisabled: boolean;
  onChange: (modelId: string) => void;
}) {
  if (props.models.length === 0) return null;
  return (
    <Selector
      label={props.label}
      isLabelHidden
      size="sm"
      variant="ghost"
      startIcon={<IconInputAi size={14} />}
      placement="above"
      isDisabled={props.isDisabled}
      value={props.value ?? ''}
      options={props.models.map((m) => ({
        value: m.id,
        label: m.id,
        description: m.label !== m.id ? m.label : undefined,
      }))}
      onChange={props.onChange}
    />
  );
}

function EffortSelector(props: {
  label: string;
  efforts: readonly EffortOption[];
  value?: string;
  isDisabled: boolean;
  onChange: (effort: string) => void;
}) {
  if (props.efforts.length === 0) return null;
  return (
    <Selector
      label={props.label}
      isLabelHidden
      size="sm"
      variant="ghost"
      startIcon={<EFFORT_ICON size={14} />}
      placement="above"
      isDisabled={props.isDisabled}
      value={props.value ?? ''}
      options={props.efforts.map((e) => ({ value: e.alias, label: e.alias, description: e.level }))}
      onChange={props.onChange}
    />
  );
}

function SlotSelectors(props: { choices?: SlotChoices; isDisabled: boolean }) {
  if (!props.choices) return null;
  const { declared, values, onChange } = props.choices;
  return Object.entries(declared).map(([name, decl]) => {
    // why: Group title belongs in the open menu (section heading), not beside the
    // closed trigger — same chrome as Model/Effort. Descriptions stay Astryx
    // secondary + one-line ellipsis; wrap would blow the composer dropdown open.
    const title = decl.label?.trim() || name;
    const choices = decl.choices.map((choice) => ({
      value: choice.value,
      label: choice.value,
      description: choice.description,
    }));
    return (
      <Selector
        key={name}
        label={title}
        isLabelHidden
        size="sm"
        variant="ghost"
        startIcon={<IconAdjustmentsHorizontal size={14} />}
        placement="above"
        isDisabled={props.isDisabled}
        value={values[name] ?? ''}
        options={[{ type: 'section', title, options: choices }]}
        onChange={(value) => onChange(name, value)}
      />
    );
  });
}

function GenerationSelect(props: {
  iface: ComposerProfileInterface;
  slotChoices?: SlotChoices;
  selectedModel?: string;
  selectedEffort?: string;
  isDisabled: boolean;
  onChange: ChatComposerBarProps['onGenerationChange'];
  control?: ReactNode;
}) {
  const { models, efforts } = generationOptions(props.iface, props.selectedModel);
  const slotCount = Object.keys(props.slotChoices?.declared ?? {}).length;
  if (props.control)
    return (
      <HStack gap={1}>
        {props.control}
        <SlotSelectors choices={props.slotChoices} isDisabled={props.isDisabled} />
      </HStack>
    );
  if (models.length + efforts.length + slotCount === 0) return null;
  return (
    <HStack gap={1}>
      <ModelSelector
        label={labelText('composer.model', {}, props.iface.labels)}
        models={models}
        value={props.selectedModel}
        isDisabled={props.isDisabled}
        onChange={(modelId) => props.onChange?.({ modelId })}
      />
      <EffortSelector
        label={labelText('composer.effort', {}, props.iface.labels)}
        efforts={efforts}
        value={props.selectedEffort}
        isDisabled={props.isDisabled}
        onChange={(effort) => {
          if (props.selectedModel) props.onChange?.({ modelId: props.selectedModel, effort });
        }}
      />
      <SlotSelectors choices={props.slotChoices} isDisabled={props.isDisabled} />
    </HStack>
  );
}

function composerStatus(args: {
  failure: ClientFailure | null;
  issues: readonly AttachmentValidationIssue[];
  voiceFailure: VoiceFailure | null;
  labels: LabelOverrides;
}): ChatComposerStatus | undefined {
  if (args.failure) return { type: 'error', message: args.failure.error };
  const warning = [
    ...args.issues.map((issue) => attachmentIssueText(issue, args.labels)),
    args.voiceFailure?.error,
  ]
    .filter(Boolean)
    .join(' ');
  return warning ? { type: 'warning', message: warning } : undefined;
}

type StagedFile = { file: File; index: number; preview?: string };

/** Pending messages, then two uniform rows: 64px tiles (images, voice notes), then file tokens. */
function PendingDrawer(props: {
  summary: ComposerDrawerSummary;
  messages: readonly ComposerPendingMessage[];
  imageFiles: readonly StagedFile[];
  otherFiles: readonly StagedFile[];
  voiceFiles: readonly File[];
  voiceUrls: readonly (string | undefined)[];
  pendingActions: Omit<Parameters<typeof PendingRow>[0], 'message' | 'moves'>;
  onAttachmentRemove: (index: number) => void;
  onVoiceRemove: () => void;
}) {
  const t = useLabels();
  return (
    <ChatComposerDrawer count={props.summary.count} label={composerDrawerLabel(t, props.summary)}>
      <VStack gap={2} width="100%">
        {props.messages.map((message) => (
          <PendingRow
            key={message.id}
            message={message}
            moves={composerPendingMoves(props.messages, message.id)}
            {...props.pendingActions}
          />
        ))}
        {props.imageFiles.length + props.voiceFiles.length > 0 ? (
          <HStack gap={2} wrap="wrap" vAlign="center">
            {props.imageFiles.map(({ file, index, preview }) => (
              <Thumbnail
                key={`${file.name}:${String(index)}`}
                src={preview}
                alt={file.name}
                label={file.name}
                onRemove={() => props.onAttachmentRemove(index)}
              />
            ))}
            {props.voiceFiles.map((file, index) => {
              const src = props.voiceUrls[index];
              // why: An empty src makes the browser fetch the page again; a note draws once it has its URL.
              return src === undefined ? null : (
                <VoiceNote
                  key={`voice:${file.name}`}
                  src={src}
                  mimeType={file.type || undefined}
                  onRemove={props.onVoiceRemove}
                />
              );
            })}
          </HStack>
        ) : null}
        {props.otherFiles.length > 0 ? (
          <HStack gap={2} wrap="wrap">
            {props.otherFiles.map(({ file, index }) => (
              <Token
                key={`${file.name}:${String(index)}`}
                label={file.name}
                onRemove={() => props.onAttachmentRemove(index)}
              />
            ))}
          </HStack>
        ) : null}
      </VStack>
    </ChatComposerDrawer>
  );
}

/** A hidden file input behind the paperclip button. */
function AttachFilesButton({
  accept,
  onFiles,
}: {
  accept?: string;
  onFiles: (files: File[]) => void;
}) {
  const t = useLabels();
  const label = t('@theorem.composer.attach');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const incoming = input.files ? [...input.files] : [];
    input.value = '';
    if (incoming.length > 0) onFiles(incoming);
  }
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={handleChange}
      />
      <IconButton
        label={label}
        tooltip={label}
        size="sm"
        variant="ghost"
        icon={<IconPaperclip size={16} />}
        onClick={() => fileInputRef.current?.click()}
      />
    </>
  );
}

function SendMenu({
  actions,
  onAction,
}: {
  actions: readonly ComposerMenuAction[];
  onAction: (action: ComposerMenuAction) => void;
}) {
  const t = useLabels();
  if (actions.length === 0) return null;
  return (
    <DropdownMenu
      button={{
        label: t('@theorem.composer.send_options'),
        isIconOnly: true,
        icon: <IconStack2 size={16} />,
        variant: 'ghost',
      }}
      hasChevron={false}
      placement="above"
      items={actions.map((action) => {
        const Glyph = SEND_ICON[action];
        return {
          id: action,
          label: t(`@theorem.composer.menu.${action}`),
          description: t(`@theorem.composer.menu.${action}.description`),
          icon: <Glyph size={16} />,
          ...(action === 'stash' ? { endContent: <Kbd keys={STASH_SHORTCUT} /> } : {}),
          onClick: () => onAction(action),
        };
      })}
    />
  );
}

function RecordButton({ recording, onToggle }: { recording: boolean; onToggle: () => void }) {
  const t = useLabels();
  const label = t(recording ? '@theorem.composer.stop_recording' : '@theorem.composer.record');
  return (
    <IconButton
      label={label}
      tooltip={label}
      size="md"
      variant={recording ? 'destructive' : 'ghost'}
      icon={recording ? <IconPlayerRecordFilled size={16} /> : <IconMicrophone size={16} />}
      onClick={onToggle}
    />
  );
}

/** Astryx's slot for contextual info (header, right side). */
function ComposerHint({ hint, onAction }: { hint: ComposerHintData; onAction: () => void }) {
  const t = useLabels();
  return (
    <HStack gap={2} vAlign="center">
      <Text size="sm" color="secondary">
        {t(`@theorem.composer.hint.${hint.id}.message`)}
      </Text>
      <Button
        label={t(`@theorem.composer.hint.${hint.id}.action`)}
        size="sm"
        variant="ghost"
        onClick={onAction}
      />
      <Kbd keys={hint.shortcut} />
    </HStack>
  );
}

/** Staged files split into image tiles and file tokens, with object URLs for previews and voice notes. */
function useStagedFiles(pendingFiles: readonly File[], pendingVoice: readonly File[]) {
  const previews = useObjectUrls(pendingFiles, isImage);
  const voiceUrls = useObjectUrls(pendingVoice, anyFile);
  const staged: StagedFile[] = pendingFiles.map((file, index) => ({
    file,
    index,
    preview: previews[index],
  }));
  return {
    imageFiles: staged.filter((entry) => isImage(entry.file)),
    otherFiles: staged.filter((entry) => !isImage(entry.file)),
    voiceUrls,
  };
}

/** Stages picked files beside the ones already waiting, and keeps what could not be staged. */
function useFileStaging(
  pendingFiles: readonly File[],
  maxFiles: number | undefined,
  props: Pick<ChatComposerBarProps, 'pendingVoice' | 'onFilesSelected'>,
) {
  const [stagingIssues, setStagingIssues] = useState<AttachmentValidationIssue[]>([]);
  function stageFiles(incoming: File[]) {
    const staged = stageComposerFiles({
      existing: pendingFiles,
      incoming,
      maxFiles,
      voiceCount: props.pendingVoice.length,
    });
    const added = staged.files.slice(pendingFiles.length);
    if (added.length > 0) props.onFilesSelected(added);
    setStagingIssues(staged.issues);
  }
  return { stageFiles, stagingIssues };
}

/** The record button, when the profile takes voice. */
function ComposerRecordButton({
  hasVoice,
  voice,
}: {
  hasVoice: boolean;
  voice: ReturnType<typeof useComposerVoice>;
}) {
  if (!hasVoice) return null;
  return <RecordButton recording={voice.recording} onToggle={() => void voice.toggleRecording()} />;
}

/** The drawer of messages and files waiting to send; absent while nothing waits. */
function composerDrawer(
  props: ChatComposerBarProps,
  stagedFiles: ReturnType<typeof useStagedFiles>,
  onVoiceRemove: () => void,
): ReactNode {
  const summary = composerDrawerSummary({
    pendingMessages: props.pendingMessages,
    attachmentCount: props.pendingFiles.length + props.pendingVoice.length,
  });
  if (!summary) return undefined;
  return (
    <PendingDrawer
      summary={summary}
      messages={props.pendingMessages}
      {...stagedFiles}
      voiceFiles={props.pendingVoice}
      pendingActions={{
        onMove: props.onPendingMove,
        onRemove: props.onPendingRemove,
        onQueue: props.onPendingQueue,
        onRestore: props.onPendingRestore,
        onSendNow: props.onPendingSendNow,
      }}
      onAttachmentRemove={props.onAttachmentRemove}
      onVoiceRemove={onVoiceRemove}
    />
  );
}

/** The text field, with Seance's stash shortcut while it has focus; `onStash` is absent when there is nothing to stash. */
function ComposerTextInput({
  editorRef,
  handleRef,
  onStash,
}: {
  editorRef: React.Ref<HTMLDivElement>;
  handleRef: ChatComposerBarProps['inputRef'];
  onStash: (() => void) | undefined;
}) {
  return (
    <ChatComposerInput
      ref={editorRef}
      handleRef={handleRef}
      onKeyDown={(event) => {
        if (!isStashShortcut(event)) return;
        event.preventDefault();
        onStash?.();
      }}
    />
  );
}

function isLiveComposer(
  props: ChatComposerBarProps | LiveComposerBarProps,
): props is LiveComposerBarProps {
  return 'isDisabled' in props;
}

/**
 * Astryx composer wired to Theorem's send / stop / queue / steer / stash matrix.
 * For a Live profile it is the text field and send button alone.
 */
export function ChatComposerBar(props: ChatComposerBarProps | LiveComposerBarProps) {
  return (
    <TheoremLabelsProvider>
      {isLiveComposer(props) ? (
        <LiveComposerBarBody {...props} />
      ) : (
        <ChatComposerBarBody {...props} />
      )}
    </TheoremLabelsProvider>
  );
}

function LiveComposerBarBody(props: LiveComposerBarProps) {
  const t = useLabels();
  const editorRef = useRef<ChatComposerInputHandle>(null);
  const setEditor = useCallback(
    (node: ChatComposerInputHandle | null) => {
      editorRef.current = node;
      const outer = props.inputRef;
      if (typeof outer === 'function') outer(node);
      else if (outer) outer.current = node;
    },
    [props.inputRef],
  );
  // why: The button used to send only the React draft. Typing lives in the field first, so an
  // empty draft left the button dead. Read the field.
  const submitTyped = () => {
    const text = (editorRef.current?.getValue() ?? props.draftText).trim();
    if (!text || props.isDisabled) return;
    props.onSubmit(text);
    props.onDraftTextChange('');
  };
  return (
    <ChatComposer
      style={NO_FOCUS_RING}
      value={props.draftText}
      onChange={props.onDraftTextChange}
      onSubmit={props.onSubmit}
      isDisabled={props.isDisabled}
      placeholder={
        props.placeholder ??
        t('@theorem.composer.placeholder', {
          handle: props.handle ?? props.iface?.identity.handle ?? '',
        })
      }
      input={<ChatComposerInput handleRef={setEditor} />}
      sendButton={<ChatSendButton isDisabled={props.isDisabled} onSend={submitTyped} />}
    />
  );
}

function ChatComposerBarBody(props: ChatComposerBarProps) {
  const { iface, phase } = props;
  const t = useLabels();
  const inputs = iface.inputs;
  const pendingFiles = useMemo(() => [...props.pendingFiles], [props.pendingFiles]);
  const voice = useComposerVoice({
    inputs,
    labels: iface.labels,
    pendingFiles,
    onVoiceStaged: props.onVoiceStaged,
    onVoiceClear: props.onVoiceClear,
  });
  const stagedFiles = useStagedFiles(props.pendingFiles, props.pendingVoice);

  useEffect(() => () => voice.disposeRecorder(), [voice.disposeRecorder]);

  const { primary, menuActions, primaryDisabled } = composerActionState({
    iface,
    phase,
    draftText: props.draftText,
    pendingFiles: props.pendingFiles,
    pendingVoice: props.pendingVoice,
    recording: voice.recording,
  });
  const canStash = menuActions.includes('stash');
  const editorRef = useRef<HTMLDivElement | null>(null);
  const hint = resolveComposerHint({
    draftText: props.draftText,
    selectedText: useEditorSelection(editorRef),
    canStash,
  });

  function runPrimary() {
    if (primaryDisabled) return;
    if (primary === 'stop') props.onStop();
    else props.onSubmit();
  }

  const { stageFiles, stagingIssues } = useFileStaging(pendingFiles, inputs.maxFiles, props);

  return (
    <ChatComposer
      // why: No keyboard focus ring on the composer (product choice): zero Astryx's
      // focus-outline token for this subtree. The editor still shows its caret.
      style={NO_FOCUS_RING}
      value={props.draftText}
      onChange={props.onDraftTextChange}
      onSubmit={runPrimary}
      onStop={props.onStop}
      isStopShown={primary === 'stop'}
      placeholder={
        voice.recording
          ? t('@theorem.composer.listening')
          : (props.placeholder ??
            t('@theorem.composer.placeholder', { handle: iface.identity.handle }))
      }
      // why: A profile that takes no text has no text field (false, not null: null gets Astryx's default one).
      input={
        inputs.text && (
          <ComposerTextInput
            editorRef={editorRef}
            handleRef={props.inputRef}
            onStash={canStash ? () => props.onMenuAction('stash') : undefined}
          />
        )
      }
      drawer={composerDrawer(props, stagedFiles, () => voice.discardRecordingOrVoice())}
      headerActions={
        inputs.attachments ? (
          <AttachFilesButton accept={inputs.attachments.acceptAttr} onFiles={stageFiles} />
        ) : undefined
      }
      headerContext={
        hint ? <ComposerHint hint={hint} onAction={() => props.onMenuAction('stash')} /> : undefined
      }
      footerActions={
        <GenerationSelect
          iface={iface}
          slotChoices={props.slotChoices}
          selectedModel={props.selectedModel}
          selectedEffort={props.selectedEffort}
          isDisabled={phase === 'streaming'}
          onChange={props.onGenerationChange}
          control={props.generationSelect}
        />
      }
      // why: Astryx: sendActions render to the left of the send button, at size="md".
      sendActions={
        <>
          <SendMenu actions={menuActions} onAction={props.onMenuAction} />
          <ComposerRecordButton hasVoice={Boolean(inputs.voice)} voice={voice} />
        </>
      }
      sendButton={
        <ChatSendButton
          isStopShown={primary === 'stop'}
          isDisabled={primaryDisabled}
          onSend={runPrimary}
          onStop={props.onStop}
        />
      }
      status={composerStatus({
        failure: props.failure,
        issues: [...props.issues, ...stagingIssues],
        voiceFailure: voice.failure,
        labels: iface.labels,
      })}
    />
  );
}
