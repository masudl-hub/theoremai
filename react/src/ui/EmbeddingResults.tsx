import { Banner } from '@astryxdesign/core/Banner';
import { HStack } from '@astryxdesign/core/HStack';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { EmbeddingResult } from '@theoremjs/agents';
import { rankMatches } from '../client/embedding-input.ts';
import type { ClientFailure } from '../client/failure.ts';
import type { EmbeddingIndex, IndexProgress } from '../hooks/use-embedding-index.ts';
import type { OneCallState } from '../hooks/use-one-call.ts';
import { Arrive } from './arrive.tsx';
import { useBytes } from './ConsoleFrame.tsx';
import { ResultStack, Share, useNumbers } from './DecisionAnswers.tsx';
import { documentLabel, type EmbeddingDocument } from './EmbeddingDocuments.tsx';
import { useLabels } from './labels-provider.tsx';
import { ChartCard } from './trace-patterns.tsx';

/** Matches the card lists, best first. */
const MATCHES_SHOWN = 10;

type IndexRun = OneCallState<'indexing', EmbeddingIndex> & { progress: IndexProgress | null };
type SearchRun = OneCallState<'embedding', EmbeddingResult>;

function Failure({ failure }: { failure: ClientFailure | null }) {
  return failure ? <Banner status="error" role="alert" title={failure.error} /> : null;
}

/** The documents most like the query, each with its cosine similarity, best first. */
function MatchesCard({
  query,
  index,
  documents,
}: {
  query: readonly number[];
  index: EmbeddingIndex;
  documents: readonly EmbeddingDocument[];
}) {
  const t = useLabels();
  const n = useNumbers();
  const bytes = useBytes();
  const matches = rankMatches(query, index.vectors);
  const lead = matches[0];
  if (!lead) return <Banner status="warning" title={t('@theorem.embedding.no_matches')} />;
  const shown = matches.slice(0, MATCHES_SHOWN);
  const label = (at: number) =>
    documentLabel(t, bytes, documents[at] ?? { input: index.inputs[at] }, at + 1).label;
  return (
    <ChartCard
      title={t('@theorem.embedding.matches')}
      value={n.decimal.format(lead.score)}
      note={
        matches.length > shown.length
          ? t('@theorem.embedding.matches_shown', { shown: shown.length, count: matches.length })
          : t('@theorem.embedding.best', { name: label(lead.index) })
      }
    >
      <VStack gap={3} role="list">
        {shown.map((match, at) => {
          const name = label(match.index);
          const score = n.decimal.format(match.score);
          return (
            <VStack key={match.index} gap={1} role="listitem" aria-label={`${name}: ${score}`}>
              <HStack gap={3} vAlign="start" aria-hidden>
                <StackItem size="fill">
                  <Text type="supporting" maxLines={2}>
                    {name}
                  </Text>
                </StackItem>
                <Text type="supporting" color="secondary" hasTabularNumbers>
                  {score}
                </Text>
              </HStack>
              <Share value={Math.max(match.score, 0)} isLead={at === 0} />
            </VStack>
          );
        })}
      </VStack>
    </ChartCard>
  );
}

/** The index: its progress while it runs, then how many documents it holds and how wide. */
function IndexCard({ run }: { run: IndexRun }) {
  const t = useLabels();
  const { progress, result } = run;
  if (progress && (!result || run.status === 'indexing'))
    return (
      <ChartCard
        title={t('@theorem.embedding.indexing')}
        value={t('@theorem.embedding.progress', { done: progress.done, total: progress.total })}
      >
        <ProgressBar
          label={t('@theorem.embedding.indexing')}
          isLabelHidden
          value={progress.done}
          max={Math.max(progress.total, 1)}
        />
      </ChartCard>
    );
  if (!result) return null;
  return (
    <ResultStack
      model={result.model}
      usage={result.usage}
      elapsedMs={run.elapsedMs}
      tokens={(count) => t('@theorem.embedding.tokens', { count })}
    >
      <ChartCard
        title={t('@theorem.embedding.index')}
        value={t('@theorem.embedding.indexed', { count: result.vectors.length })}
        note={t('@theorem.embedding.indexed_note', {
          dimensions: result.vectors[0]?.length ?? 0,
          requests: result.requests,
        })}
      />
    </ResultStack>
  );
}

/**
 * What came back: the matches for the last query, best first, then the index
 * they were ranked in. Each keeps one quiet line for the model, time, tokens,
 * and cost of its own calls.
 */
export function EmbeddingResults({
  index,
  search,
  documents,
}: {
  index: IndexRun;
  search: SearchRun;
  documents: readonly EmbeddingDocument[];
}) {
  const t = useLabels();
  const query = search.result?.embeddings[0]?.values;
  return (
    <VStack gap={4}>
      <Failure failure={search.failure} />
      {query && index.result ? (
        <ResultStack
          model={search.result?.model ?? ''}
          usage={search.result?.usage}
          elapsedMs={search.elapsedMs}
          isStale={search.status === 'embedding'}
          tokens={(count) => t('@theorem.embedding.tokens', { count })}
        >
          <Arrive>
            <MatchesCard query={query} index={index.result} documents={documents} />
          </Arrive>
        </ResultStack>
      ) : null}
      <Failure failure={index.failure} />
      <IndexCard run={index} />
    </VStack>
  );
}
