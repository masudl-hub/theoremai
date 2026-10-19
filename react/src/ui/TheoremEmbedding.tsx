import { VStack } from '@astryxdesign/core/VStack';
import type { EmbeddingInput } from '@theoremjs/agents';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import {
  createEmbeddingTransport,
  type EmbeddingInterface,
  type EmbeddingTransport,
} from '../client/embedding-transport.ts';
import { useEmbeddingIndex } from '../hooks/use-embedding-index.ts';
import { useTheoremEmbedding } from '../hooks/use-theorem-embedding.ts';
import { ConsoleFrame, type ConsolePageProps, ResponseColumn } from './ConsoleFrame.tsx';
import {
  type EmbeddingDocument,
  EmbeddingDocuments,
  useEmbeddingDocuments,
} from './EmbeddingDocuments.tsx';
import { EmbeddingQuery, type IndexState, useEmbeddingQuery } from './EmbeddingQuery.tsx';
import { EmbeddingResults, IndexCard } from './EmbeddingResults.tsx';
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

/**
 * The frame's second child. A call, not a component: the frame counts its
 * children to choose a layout, and nothing indexed yet has to count as none.
 */
function embeddingResponse(columns: boolean, label: string, results: ReactNode | null): ReactNode {
  if (results === null) return null;
  return columns ? <ResponseColumn label={label}>{results}</ResponseColumn> : results;
}

function EmbeddingBody({
  transport,
  iface,
  search,
  defaultText = '',
  defaultQuery = '',
  maxWidth = '960px',
  trace,
  flush,
  columns = false,
  className,
  style,
}: BodyProps) {
  const t = useLabels();
  const documents = useEmbeddingDocuments(defaultText, iface.inputs);
  const query = useEmbeddingQuery(defaultQuery, iface.inputs);
  const index = useEmbeddingIndex(transport);
  const [indexed, setIndexed] = useState<readonly EmbeddingDocument[]>([]);
  const inspector = useTraceInspector(iface, transport.traces, trace);

  const state: IndexState = !index.result
    ? 'none'
    : sameInputs(index.result.inputs, documents.inputs)
      ? 'fresh'
      : 'stale';
  const runIndex = () => {
    if (documents.jsonInvalid || documents.issue || documents.inputs.length === 0) return;
    setIndexed(documents.documents);
    void index.index(documents.inputs, iface.inputs);
  };
  const searched = search.status !== 'idle' || search.result !== null;

  return (
    <ConsoleFrame
      inspector={inspector}
      maxWidth={maxWidth}
      flush={flush}
      columns={columns}
      requestLabel={t('@theorem.embedding.search')}
      className={className}
      style={style}
    >
      <VStack gap={3}>
        <EmbeddingDocuments
          form={documents}
          rules={iface.inputs}
          isRunning={index.status === 'indexing'}
          onRun={runIndex}
          onStop={index.cancel}
        />
        <IndexCard run={index} />
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
      </VStack>
      {embeddingResponse(
        columns,
        t('@theorem.embedding.results'),
        searched ? <EmbeddingResults index={index} search={search} documents={indexed} /> : null,
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
