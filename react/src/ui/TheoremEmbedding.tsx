import { VStack } from '@astryxdesign/core/VStack';
import type { EmbeddingInput } from '@theoremjs/agents';
import {
  createEmbeddingTransport,
  type EmbeddingInterface,
  type EmbeddingMatch,
  type EmbeddingTransport,
  rankMatches,
} from '@theoremjs/web/client';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { useEmbeddingIndex } from '../hooks/use-embedding-index.ts';
import { useTheoremEmbedding } from '../hooks/use-theorem-embedding.ts';
import {
  ConsoleFrame,
  type ConsolePageProps,
  ConsoleSection,
  ResponseColumn,
} from './ConsoleFrame.tsx';
import {
  type EmbeddingDocument,
  EmbeddingDocuments,
  useEmbeddingDocuments,
} from './EmbeddingDocuments.tsx';
import { EmbeddingQuery, type IndexState, useEmbeddingQuery } from './EmbeddingQuery.tsx';
import { EmbeddingResults, IndexCard, type Pointing } from './EmbeddingResults.tsx';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { PaneFailure, PaneLoading } from './PaneState.tsx';
import { useTraceInspector } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type TheoremEmbeddingProps = ConsolePageProps & {
  /** Where `createTheoremEmbeddingHandler` is mounted. Default `/api/embedding`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Bring your own transport (tests, studios, non-HTTP hosts). */
  transport?: EmbeddingTransport;
  /** The text the documents card starts with, split into paragraphs. Default none. */
  defaultText?: string;
  /** Documents the card starts with beside the text, each with the file it came from. Default none. */
  defaultDocuments?: readonly EmbeddingDocument[];
  /** The query the search starts with. Default none. */
  defaultQuery?: string;
};

type BodyProps = Omit<
  TheoremEmbeddingProps,
  'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels'
> & {
  transport: EmbeddingTransport;
  iface: EmbeddingInterface;
  search: ReturnType<typeof useTheoremEmbedding>;
};

/** The same documents: the same texts, and the very same files. */
function sameInputs(a: readonly EmbeddingInput[], b: readonly EmbeddingInput[]): boolean {
  return a.length === b.length && a.every((input, at) => input === b[at]);
}

/** Where the documents stand for the last query: embedded, changed since, or embedded by another model. */
function indexStateOf(
  indexed: { inputs: readonly EmbeddingInput[]; model: string } | null,
  queried: { model: string } | null,
  inputs: readonly EmbeddingInput[],
): IndexState {
  if (!indexed) return 'fresh';
  // why: A query from another model than the index's is in another space; no score between them means anything.
  if (queried && queried.model !== indexed.model) return 'model';
  return sameInputs(indexed.inputs, inputs) ? 'fresh' : 'stale';
}

type IndexRunState = ReturnType<typeof useEmbeddingIndex>;

function indexPhase(index: IndexRunState): 'idle' | 'indexing' | 'indexed' {
  if (index.status === 'indexing') return 'indexing';
  return index.result !== null || index.failure !== null ? 'indexed' : 'idle';
}

/**
 * The frame's second child. A call, not a component: the frame counts its
 * children to choose a layout, and nothing indexed yet has to count as none.
 */
function embeddingResponse(
  columns: boolean,
  label: string,
  phase: ReturnType<typeof indexPhase>,
  results: ReactNode,
): ReactNode {
  if (phase === 'idle') return null;
  return columns ? (
    <ResponseColumn label={label} fill={phase === 'indexing'}>
      {results}
    </ResponseColumn>
  ) : (
    results
  );
}

/** The spinner while the documents embed, counting the requests once there is more than one. */
function IndexingPane({ index }: { index: IndexRunState }) {
  const t = useLabels();
  const { progress } = index;
  return (
    <PaneLoading
      label={
        progress
          ? t('@theorem.embedding.indexing_progress', {
              done: Math.min(progress.done + 1, progress.total),
              total: progress.total,
            })
          : t('@theorem.embedding.indexing')
      }
      since={index.startedAt}
    />
  );
}

/** Where the last query stands against the index: whether it searched, and its vector while both share a model. */
function searchOf(
  index: IndexRunState,
  search: BodyProps['search'],
  inputs: readonly EmbeddingInput[],
) {
  const state = indexStateOf(index.result, search.result, inputs);
  if (state === 'model') return { state, searched: false, queried: null };
  return {
    state,
    searched: search.status !== 'idle' || search.result !== null,
    queried: search.result?.embeddings[0]?.values ?? null,
  };
}

type IndexedProps = {
  iface: EmbeddingInterface;
  index: IndexRunState;
  search: BodyProps['search'];
  query: ReturnType<typeof useEmbeddingQuery>;
  /** The documents as they were indexed. */
  indexed: readonly EmbeddingDocument[];
};

/** The query against the index, and once it ran, what it found. */
function IndexSearch({
  iface,
  index,
  search,
  query,
  indexed,
  state,
  searched,
  matches,
  pointing,
}: IndexedProps & {
  state: IndexState;
  searched: boolean;
  matches: readonly EmbeddingMatch[];
  pointing: Pointing;
}) {
  return (
    <ConsoleSection>
      <EmbeddingQuery
        form={query}
        rules={iface.inputs}
        index={state}
        isRunning={search.status === 'embedding'}
        onRun={(input) => {
          void search.embed([input], { task: 'query' });
        }}
        onStop={search.cancel}
      />
      {searched ? (
        <VStack padding={4}>
          <EmbeddingResults
            index={index}
            search={search}
            documents={indexed}
            matches={matches}
            pointing={pointing}
          />
        </VStack>
      ) : null}
    </ConsoleSection>
  );
}

/** The index, and once it holds vectors, the search over them. */
function EmbeddingIndexed({
  inputs,
  ...props
}: IndexedProps & {
  /** The documents as they stand now. */
  inputs: readonly EmbeddingInput[];
}) {
  const { index, indexed } = props;
  const { state, searched, queried } = searchOf(index, props.search, inputs);
  const vectors = index.result?.vectors;
  const matches = useMemo(
    () => (queried && vectors ? rankMatches(queried, vectors) : []),
    [queried, vectors],
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const pointing = useMemo(() => ({ hovered, onHover: setHovered }), [hovered]);
  return (
    <VStack gap={3}>
      <IndexCard
        run={index}
        documents={indexed}
        query={queried}
        matches={matches}
        pointing={pointing}
      />
      {index.result ? (
        <IndexSearch
          {...props}
          state={state}
          searched={searched}
          matches={matches}
          pointing={pointing}
        />
      ) : null}
    </VStack>
  );
}

function EmbeddingBody({
  transport,
  iface,
  search,
  defaultText = '',
  defaultDocuments,
  defaultQuery = '',
  maxWidth = '960px',
  trace,
  flush,
  columns = false,
  className,
  style,
}: BodyProps) {
  const t = useLabels();
  const documents = useEmbeddingDocuments(defaultText, iface.inputs, defaultDocuments);
  const query = useEmbeddingQuery(defaultQuery, iface.inputs);
  const index = useEmbeddingIndex(transport);
  const [indexed, setIndexed] = useState<readonly EmbeddingDocument[]>([]);
  const inspector = useTraceInspector(iface, transport.traces, trace);

  const runIndex = () => {
    if (documents.jsonInvalid || documents.issue || documents.inputs.length === 0) return;
    setIndexed(documents.documents);
    void index.index(documents.inputs, iface.inputs);
  };
  const phase = indexPhase(index);
  return (
    <ConsoleFrame
      inspector={inspector}
      maxWidth={maxWidth}
      flush={flush}
      columns={columns}
      requestLabel={t('@theorem.embedding.documents')}
      className={className}
      style={style}
    >
      <EmbeddingDocuments
        form={documents}
        rules={iface.inputs}
        isRunning={phase === 'indexing'}
        onRun={runIndex}
        onStop={index.cancel}
      />
      {embeddingResponse(
        columns,
        t('@theorem.embedding.results'),
        phase,
        phase === 'indexing' ? (
          <IndexingPane index={index} />
        ) : (
          <EmbeddingIndexed
            iface={iface}
            index={index}
            search={search}
            query={query}
            indexed={indexed}
            inputs={documents.inputs}
          />
        ),
      )}
    </ConsoleFrame>
  );
}

function EmbeddingForTransport(props: Omit<BodyProps, 'iface' | 'search'>) {
  const t = useLabels();
  const search = useTheoremEmbedding(props.transport);
  if (search.describeFailure) return <PaneFailure title={search.describeFailure.error} />;
  if (!search.iface) return <PaneLoading label={t('@theorem.chat.loading')} />;
  return <EmbeddingBody {...props} iface={search.iface} search={search} />;
}

/**
 * Drop-in search over an embedding profile served by `createTheoremEmbeddingHandler`:
 * paste text and split it, or drop files, and Index embeds them as documents
 * in as many requests as the profile's limits need. Then Search embeds a query
 * and ranks the documents by cosine similarity. Every request is shown as
 * JSON, and in the trace.
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
