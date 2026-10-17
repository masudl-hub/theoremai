import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FileInput } from '@astryxdesign/core/FileInput';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconPlus, IconX } from '@tabler/icons-react';
import { attachmentIssueText, base64Bytes, type EmbeddingResult } from '@theoremjs/agents';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import {
  checkEmbeddingInputs,
  type EmbeddingInputCheck,
  type EmbeddingMediaPart,
  type EmbeddingRow,
  embeddingPairs,
  embeddingRows,
  readEmbeddingInputs,
  rowInput,
  vectorBins,
  vectorNorm,
} from '../client/embedding-input.ts';
import {
  createEmbeddingTransport,
  type EmbeddingInterface,
  type EmbeddingTransport,
} from '../client/embedding-transport.ts';
import { encodeFiles } from '../client/encode-files.ts';
import { useTheoremEmbedding } from '../hooks/use-theorem-embedding.ts';
import { Arrive } from './arrive.tsx';
import {
  ConsoleFrame,
  type ConsolePageProps,
  type ConsoleView,
  JsonRequest,
  RequestCard,
  ResponseColumn,
  RunBar,
  useBytes,
} from './ConsoleFrame.tsx';
import { ResultStack, Share, useNumbers } from './DecisionAnswers.tsx';
import type { LabelText } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { PaneFailure, PaneLoading } from './PaneState.tsx';
import { textRows } from './StateFields.tsx';
import { useTraceInspector } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';
import { ChartCard, TRACE_RADIUS, traceFill } from './trace-patterns.tsx';

export type TheoremEmbeddingProps = ConsolePageProps & {
  /** Where `createTheoremEmbeddingHandler` is mounted. Default `/api/embedding`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Bring your own transport (tests, studios, non-HTTP hosts). */
  transport?: EmbeddingTransport;
  /** The inputs the form starts with, as the JSON list a request sends. Default one empty text. */
  defaultInput?: string;
};

const EASE = 'var(--duration-medium) var(--ease-standard)';
/** Bars a vector is drawn in: its values averaged into this many runs. */
const STRIP_BINS = 64;
const STRIP_PX = 48;
/** Pairs the similarity card lists, most alike first. */
const PAIRS_SHOWN = 8;

/** What the inputs still lack, or the shortcut once they're ready. */
function inputNote(t: LabelText, check: EmbeddingInputCheck): string {
  if (check.ok) return t('@theorem.embedding.shortcut');
  switch (check.reason) {
    case 'invalid_json':
      return t('@theorem.embedding.invalid_json');
    case 'no_inputs':
      return t('@theorem.embedding.no_inputs');
    case 'empty_input':
      return t('@theorem.embedding.empty_input', { number: check.index + 1 });
    case 'text_off':
      return t('@theorem.embedding.text_off', { number: check.index + 1 });
    case 'attachments':
      return check.issues.map((issue) => attachmentIssueText(issue)).join(' ');
  }
}

type BodyProps = Omit<
  TheoremEmbeddingProps,
  'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels'
> & {
  transport: EmbeddingTransport;
  iface: EmbeddingInterface;
  embedding: ReturnType<typeof useTheoremEmbedding>;
};

type Embedding = BodyProps['embedding'];

/** Where an embedding stands: nothing asked, asked with nothing back yet, or answered or failed. */
function embeddingPhase(embedding: Embedding): 'idle' | 'waiting' | 'settled' {
  if (embedding.failure || embedding.result) return 'settled';
  return embedding.status === 'embedding' ? 'waiting' : 'idle';
}

/** The inputs, held as the JSON a request sends, and the view they are edited in. */
function useEmbeddingInputs(defaultInput: string, rules: EmbeddingInterface['inputs']) {
  const [text, setText] = useState(defaultInput);
  const check = checkEmbeddingInputs(text, rules);
  const rows = useMemo(() => {
    const inputs = readEmbeddingInputs(text);
    return inputs ? embeddingRows(inputs) : null;
  }, [text]);
  const [view, setView] = useState<ConsoleView>(() => (rows === null ? 'json' : 'fields'));
  const shown: ConsoleView = rows === null ? 'json' : view;
  const setRows = (next: EmbeddingRow[]) => {
    setText(JSON.stringify(next.map(rowInput), null, 2));
  };
  return { text, setText, check, rows, setRows, shown, setView };
}

/** A file on an input: its type and size, or that the provider holds it. */
function MediaToken({ part, onRemove }: { part: EmbeddingMediaPart; onRemove: () => void }) {
  const t = useLabels();
  const bytes = useBytes();
  return (
    <Token
      label={part.mimeType}
      size="sm"
      description={
        part.type === 'media' ? bytes(base64Bytes(part.data)) : t('@theorem.embedding.held_file')
      }
      onRemove={onRemove}
    />
  );
}

/** One input: its text, its files, and a way to add more. */
function InputRow({
  index,
  row,
  rules,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: EmbeddingRow;
  rules: EmbeddingInterface['inputs'];
  canRemove: boolean;
  onChange: (next: EmbeddingRow) => void;
  onRemove: () => void;
}) {
  const t = useLabels();
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const name = t('@theorem.embedding.input', { number: index + 1 });
  const accept = rules.attachments?.accept;
  const add = (files: File | File[] | null) => {
    const list = files === null ? [] : Array.isArray(files) ? files : [files];
    if (list.length === 0) return;
    setUnreadable(null);
    encodeFiles(list).then(
      (encoded) => {
        onChange({
          ...row,
          media: [
            ...row.media,
            ...encoded.map(({ mimeType, data }) => ({ type: 'media' as const, mimeType, data })),
          ],
        });
      },
      () => {
        setUnreadable(
          t('@theorem.embedding.unreadable', { name: list.map((file) => file.name).join(', ') }),
        );
      },
    );
  };
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting" color="secondary">
            {name}
          </Text>
        </StackItem>
        {canRemove ? (
          <IconButton
            label={t('@theorem.embedding.remove_input', { number: index + 1 })}
            size="sm"
            variant="ghost"
            icon={<IconX size={14} />}
            onClick={onRemove}
          />
        ) : null}
      </HStack>
      {rules.text ? (
        <TextArea
          label={name}
          isLabelHidden
          value={row.text}
          placeholder={t('@theorem.embedding.placeholder')}
          rows={textRows(row.text, 2, 8)}
          onChange={(text) => {
            onChange({ ...row, text });
          }}
        />
      ) : null}
      {row.media.length > 0 ? (
        <HStack gap={2} wrap="wrap">
          {row.media.map((part, at) => (
            <MediaToken
              // why: A file has no name in the request; its place on the input is its identity.
              key={`${String(at)}:${part.mimeType}`}
              part={part}
              onRemove={() => {
                onChange({ ...row, media: row.media.filter((_, other) => other !== at) });
              }}
            />
          ))}
        </HStack>
      ) : null}
      {accept ? (
        <FileInput
          label={t('@theorem.embedding.files')}
          isLabelHidden
          mode="input"
          isMultiple
          accept={accept.join(',')}
          value={null}
          placeholder={t('@theorem.embedding.choose_files')}
          status={unreadable ? { type: 'error', message: unreadable } : undefined}
          onChange={add}
        />
      ) : null}
    </VStack>
  );
}

/** The inputs as rows, and one more on request. */
function EmbeddingFields({
  rows,
  rules,
  onChange,
}: {
  rows: EmbeddingRow[];
  rules: EmbeddingInterface['inputs'];
  onChange: (next: EmbeddingRow[]) => void;
}) {
  const t = useLabels();
  const keys = useRef<number[]>([]);
  const minted = useRef(0);
  while (keys.current.length < rows.length) keys.current.push(minted.current++);
  keys.current.length = rows.length;
  return (
    <VStack gap={4}>
      {rows.map((row, index) => (
        <InputRow
          key={keys.current[index]}
          index={index}
          row={row}
          rules={rules}
          canRemove={rows.length > 1}
          onChange={(next) => {
            onChange(rows.map((other, at) => (at === index ? next : other)));
          }}
          onRemove={() => {
            keys.current.splice(index, 1);
            onChange(rows.filter((_, at) => at !== index));
          }}
        />
      ))}
      <HStack>
        <Button
          label={t('@theorem.embedding.add_input')}
          size="sm"
          variant="ghost"
          icon={<IconPlus size={14} />}
          onClick={() => {
            onChange([...rows, { text: '', media: [] }]);
          }}
        />
      </HStack>
    </VStack>
  );
}

/** The inputs, as fields or JSON, and Embed. */
function EmbeddingRequest({
  iface,
  form,
  isRunning,
  onRun,
  onStop,
}: {
  iface: EmbeddingInterface;
  form: ReturnType<typeof useEmbeddingInputs>;
  isRunning: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const t = useLabels();
  const { text, setText, check, rows, setRows, shown, setView } = form;
  return (
    <RequestCard
      title={t('@theorem.embedding.inputs')}
      view={shown}
      hasFields={rows !== null}
      onView={setView}
      onRun={onRun}
    >
      {shown === 'fields' && rows !== null ? (
        <EmbeddingFields rows={rows} rules={iface.inputs} onChange={setRows} />
      ) : (
        <JsonRequest
          label={t('@theorem.embedding.inputs')}
          text={text}
          isInvalid={!check.ok}
          onChange={setText}
        />
      )}
      <RunBar
        note={inputNote(t, check)}
        isReady={check.ok}
        isRunning={isRunning}
        runLabel={t('@theorem.embedding.embed')}
        runningLabel={t('@theorem.embedding.embedding')}
        stopLabel={t('@theorem.embedding.stop')}
        onRun={onRun}
        onStop={onStop}
      />
    </RequestCard>
  );
}

/** A vector's values by dimension, averaged into runs: above the line positive, below it negative. */
function VectorStrip({ values, label }: { values: readonly number[]; label: string }) {
  const bins = vectorBins(values, STRIP_BINS);
  const peak = Math.max(...bins.map(Math.abs)) || 1;
  const bar = (share: number, fill: string, edge: 'flex-end' | 'flex-start') => (
    <div style={{ flex: 1, display: 'flex', alignItems: edge }}>
      {share > 0 ? (
        <div
          style={{
            width: '100%',
            height: `${String(share * 100)}%`,
            borderRadius: TRACE_RADIUS / 2,
            background: fill,
            transition: `height ${EASE}`,
          }}
        />
      ) : null}
    </div>
  );
  return (
    <div role="img" aria-label={label} style={{ display: 'flex', gap: 1, height: STRIP_PX }}>
      {bins.map((value, at) => (
        // why: A bin is a fixed run of dimensions; its place is all there is to key it by.
        <div key={String(at)} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {bar(Math.max(value, 0) / peak, traceFill('clear'), 'flex-end')}
          {bar(Math.max(-value, 0) / peak, traceFill('shade2'), 'flex-start')}
        </div>
      ))}
    </div>
  );
}

function VectorCard({ name, values }: { name: string; values: readonly number[] }) {
  const t = useLabels();
  const n = useNumbers();
  return (
    <ChartCard
      title={name}
      value={t('@theorem.embedding.dimensions', { count: values.length })}
      note={t('@theorem.embedding.norm', { norm: n.decimal.format(vectorNorm(values)) })}
    >
      <VectorStrip
        values={values}
        label={t('@theorem.embedding.values', {
          name,
          min: n.decimal.format(Math.min(...values)),
          max: n.decimal.format(Math.max(...values)),
        })}
      />
    </ChartCard>
  );
}

/** How alike each pair of inputs points, most alike first. */
function SimilarityCard({
  result,
  name,
}: {
  result: EmbeddingResult;
  name: (index: number) => string;
}) {
  const t = useLabels();
  const n = useNumbers();
  const pairs = embeddingPairs(result);
  const lead = pairs[0];
  if (!lead) return null;
  const shown = pairs.slice(0, PAIRS_SHOWN);
  return (
    <ChartCard
      title={t('@theorem.embedding.similarity')}
      value={n.decimal.format(lead.similarity)}
      note={
        pairs.length > shown.length
          ? t('@theorem.embedding.pairs_shown', { shown: shown.length, count: pairs.length })
          : t('@theorem.embedding.pair', { a: name(lead.a), b: name(lead.b) })
      }
    >
      <VStack gap={2} role="list">
        {shown.map((pair, at) => {
          const label = t('@theorem.embedding.pair', { a: name(pair.a), b: name(pair.b) });
          return (
            <VStack
              key={`${String(pair.a)}:${String(pair.b)}`}
              gap={1}
              role="listitem"
              aria-label={`${label}: ${n.decimal.format(pair.similarity)}`}
            >
              <HStack gap={2} hAlign="between" aria-hidden>
                <Text type="supporting" color="secondary" maxLines={1}>
                  {label}
                </Text>
                <Text type="supporting" hasTabularNumbers>
                  {n.decimal.format(pair.similarity)}
                </Text>
              </HStack>
              <Share value={Math.max(pair.similarity, 0)} isLead={at === 0} />
            </VStack>
          );
        })}
      </VStack>
    </ChartCard>
  );
}

/**
 * An embedding's vectors, one card per input in the order they were sent, how
 * alike they point when there are two or more, and one quiet line for the
 * model, time, tokens, and cost.
 */
function EmbeddingVectors({
  result,
  elapsedMs,
  isStale,
}: {
  result: EmbeddingResult;
  elapsedMs: number | null;
  isStale: boolean;
}) {
  const t = useLabels();
  const name = (index: number) => t('@theorem.embedding.input', { number: index + 1 });
  return (
    <ResultStack
      model={result.model}
      usage={result.usage}
      elapsedMs={elapsedMs}
      isStale={isStale}
      tokens={(count) => t('@theorem.embedding.tokens', { count })}
    >
      {result.embeddings.length > 1 ? (
        <Arrive>
          <SimilarityCard result={result} name={name} />
        </Arrive>
      ) : null}
      <Grid columns={{ minWidth: 260, repeat: 'fill' }} gap={3}>
        {result.embeddings.map((vector) => (
          <Arrive key={vector.index}>
            <VectorCard name={name(vector.index)} values={vector.values} />
          </Arrive>
        ))}
      </Grid>
    </ResultStack>
  );
}

/** What came back: the failure, the vectors, or a spinner until the first of either. */
function EmbeddingAnswered({ embedding }: { embedding: Embedding }) {
  const t = useLabels();
  const running = embedding.status === 'embedding';
  return (
    <>
      {embedding.failure ? (
        <Banner status="error" role="alert" title={embedding.failure.error} />
      ) : null}
      {running && !embedding.result ? (
        <PaneLoading label={t('@theorem.embedding.embedding')} />
      ) : null}
      {embedding.result ? (
        <EmbeddingVectors
          result={embedding.result}
          elapsedMs={embedding.elapsedMs}
          isStale={running}
        />
      ) : null}
    </>
  );
}

/**
 * The frame's second child. A call, not a component: the frame counts its
 * children to choose a layout, and no response yet has to count as none.
 */
function embeddingResponse(
  columns: boolean,
  phase: ReturnType<typeof embeddingPhase>,
  labels: { vectors: string; embedding: string },
  vectors: ReactNode,
): ReactNode {
  if (phase === 'idle') return null;
  if (!columns) return vectors;
  const waiting = phase === 'waiting';
  return (
    <ResponseColumn label={labels.vectors} fill={waiting}>
      {waiting ? <PaneLoading label={labels.embedding} /> : vectors}
    </ResponseColumn>
  );
}

function EmbeddingBody({
  transport,
  iface,
  embedding,
  defaultInput = '[""]',
  maxWidth = '960px',
  trace,
  flush,
  columns = false,
  className,
  style,
}: BodyProps) {
  const t = useLabels();
  const form = useEmbeddingInputs(defaultInput, iface.inputs);
  const { check } = form;
  const inspector = useTraceInspector(iface, transport.traces, trace);

  const embed = () => {
    if (check.ok) void embedding.embed(check.inputs);
  };

  return (
    <ConsoleFrame
      inspector={inspector}
      maxWidth={maxWidth}
      flush={flush}
      columns={columns}
      requestLabel={t('@theorem.embedding.inputs')}
      className={className}
      style={style}
    >
      <EmbeddingRequest
        iface={iface}
        form={form}
        isRunning={embedding.status === 'embedding'}
        onRun={embed}
        onStop={embedding.cancel}
      />
      {embeddingResponse(
        columns,
        embeddingPhase(embedding),
        { vectors: t('@theorem.embedding.vectors'), embedding: t('@theorem.embedding.embedding') },
        <EmbeddingAnswered embedding={embedding} />,
      )}
    </ConsoleFrame>
  );
}

function EmbeddingForTransport(props: Omit<BodyProps, 'iface' | 'embedding'>) {
  const t = useLabels();
  const embedding = useTheoremEmbedding(props.transport);
  if (embedding.describeFailure) return <PaneFailure title={embedding.describeFailure.error} />;
  if (!embedding.iface) return <PaneLoading label={t('@theorem.chat.loading')} />;
  return <EmbeddingBody {...props} iface={embedding.iface} embedding={embedding} />;
}

/**
 * Drop-in surface for an embedding profile served by `createTheoremEmbeddingHandler`:
 * the inputs as fields or JSON, an Embed button (⌘/Ctrl+Enter), and the vectors.
 *
 * ```tsx
 * <TheoremEmbedding endpoint="/api/embedding" />
 * ```
 */
export function TheoremEmbedding({
  endpoint,
  http,
  transport,
  theme,
  mode,
  labels,
  ...rest
}: TheoremEmbeddingProps) {
  const httpRef = useRef(http);
  httpRef.current = http;
  const resolved = useMemo(
    () => transport ?? createEmbeddingTransport({ ...httpRef.current, endpoint }),
    [transport, endpoint],
  );
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <EmbeddingForTransport {...rest} transport={resolved} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
