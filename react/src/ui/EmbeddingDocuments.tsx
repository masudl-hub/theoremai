import { FileInput } from '@astryxdesign/core/FileInput';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
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
  IconFile,
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

/** Documents the list shows; the rest are counted. */
const LISTED = 50;
const THUMB_PX = 40;

/** What the check says is wrong, about the input it names. */
export function inputIssue(t: LabelText, check: EmbeddingInputCheck, name: string): string | null {
  if (check.ok) return null;
  switch (check.reason) {
    case 'invalid_json':
    case 'no_inputs':
    case 'empty_input':
      return t('@theorem.embedding.empty', { name });
    case 'text_off':
      return t('@theorem.embedding.text_off', { name });
    case 'attachments':
      return `${name}: ${check.issues.map((issue) => attachmentIssueText(issue)).join(' ')}`;
  }
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
    json: json ?? JSON.stringify(inputs, null, 2),
    jsonInvalid,
    setJson: (next: string) => {
      setJson(next);
      const parsed = readEmbeddingInputs(next);
      if (parsed === undefined) return;
      setText('');
      setAdded(parsed.map((input) => ({ input })));
    },
    addFiles,
    remove: (at: number) => {
      const shift = documents.length - added.length;
      setAdded((previous) => previous.filter((_, other) => other !== at - shift));
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

/** A document's picture: the image itself when it is one sent inline, else a file icon. */
function DocumentThumb({ input }: { input: EmbeddingInput }) {
  const media = mediaOf(input);
  if (!media) return null;
  if (media.type === 'media' && media.mimeType.startsWith('image/'))
    return (
      <Thumbnail
        src={`data:${media.mimeType};base64,${media.data}`}
        alt=""
        style={{ width: THUMB_PX, height: THUMB_PX }}
      />
    );
  return <IconFile size={20} aria-hidden />;
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

/** One document in a list: its picture, its words or name, and where it came from. */
function DocumentItem({
  document,
  number,
  note,
  end,
}: {
  document: EmbeddingDocument;
  number: number;
  note?: string;
  end?: ReactNode;
}) {
  const t = useLabels();
  const bytes = useBytes();
  const { label, detail } = documentLabel(t, bytes, document, number);
  const description = [detail, note].filter(Boolean).join(' · ');
  return (
    <ListItem
      label={<Text maxLines={2}>{label}</Text>}
      description={description || undefined}
      startContent={<DocumentThumb input={document.input} />}
      endContent={end}
    />
  );
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
      mode={isMultiple ? 'dropzone' : 'input'}
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

/** The documents in order: the text's pieces, then files and JSON, which can be taken off. */
function DocumentList({ form }: { form: EmbeddingDocumentsForm }) {
  const t = useLabels();
  const shown = form.documents.slice(0, LISTED);
  if (shown.length === 0) return null;
  return (
    <VStack gap={1}>
      <List density="compact" hasDividers>
        {shown.map((document, at) => {
          const number = at + 1;
          const removable = at >= form.fromText;
          return (
            <DocumentItem
              // why: Documents have no ids; the text's pieces re-split on every keystroke, so place is identity.
              key={String(at)}
              document={document}
              number={number}
              note={
                document.from
                  ? t('@theorem.embedding.from_file', { name: document.from })
                  : removable
                    ? undefined
                    : t('@theorem.embedding.from_text')
              }
              end={
                removable ? (
                  <IconButton
                    label={t('@theorem.embedding.remove', {
                      name: document.from ?? t('@theorem.embedding.document', { number }),
                    })}
                    size="sm"
                    variant="ghost"
                    icon={<IconX size={14} />}
                    onClick={() => {
                      form.remove(at);
                    }}
                  />
                ) : undefined
              }
            />
          );
        })}
      </List>
      {form.documents.length > LISTED ? (
        <Text type="supporting" color="secondary">
          {t('@theorem.embedding.more', { count: form.documents.length - LISTED })}
        </Text>
      ) : null}
    </VStack>
  );
}

/** Text to split, files to add, and the documents they make. */
function DocumentFields({ form, rules }: { form: EmbeddingDocumentsForm; rules: Rules }) {
  const t = useLabels();
  const accept = [
    ...(rules.attachments?.accept ?? []),
    ...(rules.text ? ['text/*', '.md', '.csv', '.json'] : []),
  ];
  return (
    <VStack gap={3}>
      {rules.text ? (
        <>
          <TextArea
            label={t('@theorem.embedding.text')}
            isLabelHidden
            value={form.text}
            placeholder={t('@theorem.embedding.text_placeholder')}
            rows={textRows(form.text, 4, 12)}
            onChange={form.setText}
          />
          <SplitFields form={form} />
        </>
      ) : null}
      {accept.length > 0 ? (
        <EmbeddingFileDrop
          label={t('@theorem.embedding.files')}
          placeholder={t('@theorem.embedding.drop_files')}
          accept={accept}
          isMultiple
          onFiles={form.addFiles}
        />
      ) : null}
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
