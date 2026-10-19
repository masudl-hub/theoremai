import { FileInput } from '@astryxdesign/core/FileInput';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
  IconBaselineDensityMedium,
  IconCsv,
  IconFileText,
  IconPilcrow,
  IconScissors,
  IconX,
} from '@tabler/icons-react';
import { attachmentIssueText, base64Bytes, type EmbeddingInput } from '@theoremjs/agents';
import { type ReactNode, useMemo, useState } from 'react';
import {
  checkInputs,
  type EmbeddingInputCheck,
  type EmbeddingMediaPart,
  type EmbeddingSplit,
  embeddingBatches,
  readEmbeddingInputs,
  readsAsText,
  splitText,
} from '../client/embedding-input.ts';
import type { EmbeddingInterface } from '../client/embedding-transport.ts';
import { encodeFiles } from '../client/encode-files.ts';
import { type ConsoleView, JsonRequest, RequestCard, RunBar, useBytes } from './ConsoleFrame.tsx';
import type { LabelText } from './labels.ts';
import { useLabels } from './labels-provider.tsx';
import { textRows } from './StateFields.tsx';

/** The profile's `inputs`, which every request is held to. */
export type Rules = EmbeddingInterface['inputs'];

/** A document as the list shows it: what it sends, and the file it came from. */
export type EmbeddingDocument = { input: EmbeddingInput; from?: string };

type SplitChoice = 'whole' | 'lines' | 'paragraphs' | 'commas' | 'custom';

/** The ways to split, coarsest first, each with its icon. */
const SPLITS: readonly { value: SplitChoice; icon: ReactNode }[] = [
  { value: 'whole', icon: <IconFileText size={16} /> },
  { value: 'paragraphs', icon: <IconPilcrow size={16} /> },
  { value: 'lines', icon: <IconBaselineDensityMedium size={16} /> },
  { value: 'commas', icon: <IconCsv size={16} /> },
  { value: 'custom', icon: <IconScissors size={16} /> },
];

const REASON_LABELS = {
  invalid_json: '@theorem.embedding.empty',
  no_inputs: '@theorem.embedding.empty',
  empty_input: '@theorem.embedding.empty',
  text_off: '@theorem.embedding.text_off',
} as const;

/** What the check says is wrong, about the input it names. */
export function inputIssue(t: LabelText, check: EmbeddingInputCheck, name: string): string | null {
  if (check.ok) return null;
  if (check.reason === 'attachments')
    return `${name}: ${check.issues.map((issue) => attachmentIssueText(issue)).join(' ')}`;
  if (check.reason === 'too_many_inputs')
    return t('@theorem.embedding.too_many', { max: check.max });
  return t(REASON_LABELS[check.reason], { name });
}

/**
 * The documents: pasted text split as chosen, then files and JSON, in that
 * order. Text files are split as the text is; any other file is one document.
 */
export function useEmbeddingDocuments(defaultText: string, rules: Rules) {
  const t = useLabels();
  const [text, setText] = useState(defaultText);
  const [choice, setChoice] = useState<SplitChoice>('paragraphs');
  const [separator, setSeparator] = useState('');
  const [added, setAdded] = useState<EmbeddingDocument[]>([]);
  const [view, setView] = useState<ConsoleView>('fields');
  const [json, setJson] = useState<string | null>(null);
  const split: EmbeddingSplit = choice === 'custom' ? { separator } : choice;

  const documents = useMemo<EmbeddingDocument[]>(
    () => [
      ...splitText(text, choice === 'custom' ? { separator } : choice).map((input) => ({ input })),
      ...added,
    ],
    [text, choice, separator, added],
  );
  const inputs = useMemo(() => documents.map((document) => document.input), [documents]);
  // why: The inputs hold every attachment as base64; writing them out on each render blocks the page.
  const shownJson = useMemo(
    () => (view === 'json' ? (json ?? JSON.stringify(inputs, null, 2)) : ''),
    [view, json, inputs],
  );
  const jsonInvalid = json !== null && readEmbeddingInputs(json) === undefined;
  const issue = useMemo(() => {
    for (const [at, input] of inputs.entries()) {
      const found = inputIssue(
        t,
        checkInputs([input], rules),
        t('@theorem.embedding.document', { number: at + 1 }),
      );
      if (found) return found;
    }
    return null;
  }, [inputs, rules, t]);
  const requests = useMemo(() => embeddingBatches(inputs, rules).length, [inputs, rules]);

  const addFiles = async (files: readonly File[]) => {
    const words = files.filter(readsAsText);
    const media = files.filter((file) => !readsAsText(file));
    const pieces = await Promise.all(
      words.map(async (file) =>
        splitText(await file.text(), split).map((input) => ({ input, from: file.name })),
      ),
    );
    const encoded = await encodeFiles(media);
    setAdded((previous) => [
      ...previous,
      ...pieces.flat(),
      ...encoded.map(({ name, mimeType, data }) => ({
        input: { parts: [{ type: 'media' as const, mimeType, data }] },
        from: name,
      })),
    ]);
  };

  return {
    text,
    setText,
    choice,
    setChoice,
    separator,
    setSeparator,
    documents,
    inputs,
    issue,
    requests,
    view,
    setView: (next: ConsoleView) => {
      setJson(null);
      setView(next);
    },
    json: shownJson,
    jsonInvalid,
    setJson: (next: string) => {
      setJson(next);
      const parsed = readEmbeddingInputs(next);
      if (parsed === undefined) return;
      setText('');
      setAdded(parsed.map((input) => ({ input })));
    },
    addFiles,
    remove: (at: readonly number[]) => {
      const shift = documents.length - added.length;
      setAdded((previous) => previous.filter((_, other) => !at.includes(other + shift)));
    },
    /** Where the pasted text's documents end and the removable ones begin. */
    fromText: documents.length - added.length,
  };
}

export type EmbeddingDocumentsForm = ReturnType<typeof useEmbeddingDocuments>;

function mediaOf(input: EmbeddingInput) {
  return typeof input === 'string' ? undefined : input.parts.find((part) => part.type !== 'text');
}

function textOf(input: EmbeddingInput): string {
  if (typeof input === 'string') return input;
  return input.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
}

/** What a document reads as in a list: its text, or its file's name, type, and size. */
export function documentLabel(
  t: LabelText,
  bytes: (count: number) => string,
  document: EmbeddingDocument,
  number: number,
): { label: string; detail: string | null } {
  const media = mediaOf(document.input);
  const words = textOf(document.input);
  if (!media) return { label: words, detail: null };
  const size =
    media.type === 'media' ? bytes(base64Bytes(media.data)) : t('@theorem.embedding.held_file');
  return {
    label: words || (document.from ?? t('@theorem.embedding.document', { number })),
    detail: `${media.mimeType} · ${size}`,
  };
}

/** Where the text is cut, and the separator when it is one of the user's own. */
/** A file field that reads what is dropped or chosen, and says which files it could not read. */
export function EmbeddingFileDrop({
  label,
  placeholder,
  accept,
  isMultiple = false,
  onFiles,
}: {
  label: string;
  placeholder: string;
  accept: readonly string[];
  isMultiple?: boolean;
  onFiles: (files: File[]) => Promise<void>;
}) {
  const t = useLabels();
  const [unreadable, setUnreadable] = useState<string | null>(null);
  return (
    <FileInput
      label={label}
      isLabelHidden
      mode="dropzone"
      isMultiple={isMultiple}
      accept={accept.join(',')}
      value={null}
      placeholder={placeholder}
      status={unreadable ? { type: 'error', message: unreadable } : undefined}
      onChange={(files) => {
        const list = files === null ? [] : Array.isArray(files) ? files : [files];
        if (list.length === 0) return;
        setUnreadable(null);
        onFiles(list).catch(() => {
          setUnreadable(
            t('@theorem.embedding.unreadable', { name: list.map((file) => file.name).join(', ') }),
          );
        });
      }}
    />
  );
}

function SplitFields({ form }: { form: EmbeddingDocumentsForm }) {
  const t = useLabels();
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type="supporting" color="secondary">
        {t('@theorem.embedding.split')}
      </Text>
      <SegmentedControl
        label={t('@theorem.embedding.split')}
        size="sm"
        value={form.choice}
        onChange={(next) => {
          form.setChoice(next as SplitChoice);
        }}
      >
        {SPLITS.map(({ value, icon }) => {
          const label = t(`@theorem.embedding.split_${value}`);
          return (
            <Tooltip key={value} content={label}>
              <SegmentedControlItem value={value} label={label} icon={icon} isLabelHidden />
            </Tooltip>
          );
        })}
      </SegmentedControl>
      {form.choice === 'custom' ? (
        <StackItem size="fill">
          <TextInput
            label={t('@theorem.embedding.separator')}
            isLabelHidden
            placeholder={t('@theorem.embedding.separator')}
            size="sm"
            value={form.separator}
            onChange={form.setSeparator}
          />
        </StackItem>
      ) : null}
    </HStack>
  );
}

/** How many pieces of a text a group previews; the rest are counted. */
const PREVIEWED = 3;

type DocumentGroup = { source: string; at: number[] };

/** The added documents that are words, grouped by where they came from; the pasted text is already on screen. */
function groupDocuments(form: EmbeddingDocumentsForm, t: LabelText): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();
  for (const [at, document] of form.documents.entries()) {
    if (mediaOf(document.input)) continue;
    if (at < form.fromText) continue;
    const source = document.from
      ? t('@theorem.embedding.from_file', { name: document.from })
      : t('@theorem.embedding.from_json');
    const group = groups.get(source) ?? { source, at: [] };
    group.at.push(at);
    groups.set(source, group);
  }
  return [...groups.values()];
}

/** The first few pieces of one source, with the source and how many it made. */
function TextGroup({ group, form }: { group: DocumentGroup; form: EmbeddingDocumentsForm }) {
  const t = useLabels();
  return (
    <VStack gap={1}>
      <HStack gap={1} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting" color="secondary">
            {t('@theorem.embedding.group', { source: group.source, count: group.at.length })}
          </Text>
        </StackItem>
        <IconButton
          label={t('@theorem.embedding.remove', { name: group.source })}
          size="sm"
          variant="ghost"
          icon={<IconX size={14} />}
          onClick={() => {
            form.remove(group.at);
          }}
        />
      </HStack>
      {group.at.slice(0, PREVIEWED).map((at) => (
        // why: Documents have no ids; the text's pieces re-split on every keystroke, so place is identity.
        <Text key={String(at)} maxLines={2}>
          {textOf(form.documents[at]?.input ?? '')}
        </Text>
      ))}
      {group.at.length > PREVIEWED ? (
        <Text type="supporting" color="secondary">
          {t('@theorem.embedding.more', { count: group.at.length - PREVIEWED })}
        </Text>
      ) : null}
    </VStack>
  );
}

/** One file: its picture above its type, with its name and size on hover and Remove. */
export function FileTile({
  part,
  name,
  label,
  onRemove,
}: {
  part: EmbeddingMediaPart;
  /** The file's name; a query's file keeps none, so its type stands in. */
  name?: string;
  label: string;
  onRemove: () => void;
}) {
  const image = part.type === 'media' && part.mimeType.startsWith('image/');
  return (
    <VStack gap={1} hAlign="center" style={{ width: TILE_PX, flexShrink: 0 }}>
      <Thumbnail
        {...(image && part.type === 'media'
          ? { src: `data:${part.mimeType};base64,${part.data}` }
          : {})}
        alt=""
        label={label}
        onRemove={onRemove}
      />
      <Text
        type="supporting"
        color="secondary"
        maxLines={1}
        style={{ width: '100%', textAlign: 'center' }}
      >
        {name ?? part.mimeType}
      </Text>
    </VStack>
  );
}

/** The width a tile keeps, so a long name is cut instead of widening it. */
const TILE_PX = 72;

const documentKeys = new WeakMap<object, number>();
let nextKey = 0;

/** A key that follows the document, not its place, so removing one leaves the others' images alone. */
function documentKey(document: EmbeddingDocument): string {
  let key = documentKeys.get(document);
  if (key === undefined) {
    key = nextKey;
    nextKey += 1;
    documentKeys.set(document, key);
  }
  return String(key);
}

/** Each file as a tile in a scrolling row. */
function FileTiles({ form }: { form: EmbeddingDocumentsForm }) {
  const t = useLabels();
  const bytes = useBytes();
  const files = form.documents.flatMap((document, at) => {
    const part = mediaOf(document.input);
    return part ? [{ document, part, at }] : [];
  });
  if (files.length === 0) return null;
  return (
    <HStack gap={2} wrap="nowrap" style={{ overflowX: 'auto' }}>
      {files.map(({ document, part, at }) => {
        const { label, detail } = documentLabel(t, bytes, document, at + 1);
        return (
          <FileTile
            key={documentKey(document)}
            name={document.from}
            part={part}
            label={[label, detail].filter(Boolean).join(' · ')}
            onRemove={() => {
              form.remove([at]);
            }}
          />
        );
      })}
    </HStack>
  );
}

/** A preview of the documents: a few pieces per source, and every file as a tile. */
function DocumentList({ form }: { form: EmbeddingDocumentsForm }) {
  const t = useLabels();
  const groups = groupDocuments(form, t);
  if (groups.length === 0 && form.documents.length === 0) return null;
  return (
    <VStack gap={3}>
      {groups.map((group) => (
        <TextGroup key={group.source} group={group} form={form} />
      ))}
      <FileTiles form={form} />
    </VStack>
  );
}

/** Text with its file beside it at two thirds and one third, or whichever of them there is. */
export function TextBesideFile({ text, file }: { text: ReactNode; file: ReactNode }) {
  if (!text || !file) return <>{text ?? file}</>;
  return (
    <Grid columns={3} gap={3}>
      <GridSpan columns={2}>{text}</GridSpan>
      <GridSpan columns={1}>{file}</GridSpan>
    </Grid>
  );
}

/** The file types the documents take: the profile's attachments, and text files when it takes text. */
function acceptedFiles(rules: Rules): string[] {
  const text = rules.text ? ['text/*', '.md', '.csv', '.json'] : [];
  return [...(rules.attachments?.accept ?? []), ...text];
}

/** The text to split, and how it splits. */
function DocumentText({ form }: { form: EmbeddingDocumentsForm }) {
  const t = useLabels();
  return (
    <VStack gap={3}>
      <TextArea
        label={t('@theorem.embedding.text')}
        isLabelHidden
        value={form.text}
        placeholder={t('@theorem.embedding.text_placeholder')}
        rows={textRows(form.text, 4, 12)}
        onChange={form.setText}
      />
      <SplitFields form={form} />
    </VStack>
  );
}

/** Text to split, files to add, and the documents they make. */
function DocumentFields({ form, rules }: { form: EmbeddingDocumentsForm; rules: Rules }) {
  const t = useLabels();
  const accept = acceptedFiles(rules);
  const drop =
    accept.length > 0 ? (
      <EmbeddingFileDrop
        label={t('@theorem.embedding.files')}
        placeholder={t('@theorem.embedding.drop_files')}
        accept={accept}
        isMultiple
        onFiles={form.addFiles}
      />
    ) : null;
  return (
    <VStack gap={3}>
      <TextBesideFile text={rules.text ? <DocumentText form={form} /> : null} file={drop} />
      <DocumentList form={form} />
    </VStack>
  );
}

/** What the documents still lack, or how many requests they make and the shortcut. */
function documentsNote(t: LabelText, form: EmbeddingDocumentsForm): string {
  if (form.jsonInvalid) return t('@theorem.embedding.invalid_json');
  if (form.inputs.length === 0) return t('@theorem.embedding.no_documents');
  return (
    form.issue ??
    t('@theorem.embedding.ready', { count: form.inputs.length, requests: form.requests })
  );
}

/** The documents card: text and files as fields, or the inputs as JSON, and Index. */
export function EmbeddingDocuments({
  form,
  rules,
  isRunning,
  onRun,
  onStop,
}: {
  form: EmbeddingDocumentsForm;
  rules: Rules;
  isRunning: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const t = useLabels();
  const isReady = !form.jsonInvalid && form.inputs.length > 0 && form.issue === null;
  return (
    <RequestCard
      title={t('@theorem.embedding.documents')}
      view={form.view}
      hasFields
      onView={form.setView}
      onRun={onRun}
    >
      {form.view === 'fields' ? (
        <DocumentFields form={form} rules={rules} />
      ) : (
        <JsonRequest
          label={t('@theorem.embedding.documents')}
          text={form.json}
          isInvalid={form.jsonInvalid}
          onChange={form.setJson}
        />
      )}
      <RunBar
        note={documentsNote(t, form)}
        isReady={isReady}
        isRunning={isRunning}
        runLabel={t('@theorem.embedding.index')}
        runningLabel={t('@theorem.embedding.indexing')}
        stopLabel={t('@theorem.embedding.stop')}
        onRun={onRun}
        onStop={onStop}
      />
    </RequestCard>
  );
}
