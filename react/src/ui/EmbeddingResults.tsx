import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { useClipboard } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import type { EmbeddingInput, EmbeddingResult } from '@theoremjs/agents';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { EmbeddingMatch } from '../client/embedding-input.ts';
import {
  type EmbeddingSpace,
  layoutSpaceSoon,
  outlierThreshold,
  placeQuery,
} from '../client/embedding-space.ts';
import type { ClientFailure } from '../client/failure.ts';
import type { QueryMatch } from '../client/space-geometry.ts';
import type { EmbeddingIndex, IndexProgress } from '../hooks/use-embedding-index.ts';
import type { OneCallState } from '../hooks/use-one-call.ts';
import { Arrive } from './arrive.tsx';
import { useBytes } from './ConsoleFrame.tsx';
import { ResultStack, Share, useNumbers } from './DecisionAnswers.tsx';
import { documentLabel, type EmbeddingDocument } from './EmbeddingDocuments.tsx';
import { useLabels } from './labels-provider.tsx';
import { keyedByContent } from './row-keys.ts';
import { ChartCard } from './trace-patterns.tsx';

const EmbeddingSpaceView = lazy(() =>
  import('./EmbeddingSpace.tsx').then((module) => ({ default: module.EmbeddingSpaceView })),
);

/** Matches the card lists, best first; the space highlights the same ones. */
const MATCHES_SHOWN = 10;
/** The most the space or the list stands, in pixels. */
const SPACE_PX = 460;
/** Values a vector shows before the rest are counted. */
const PREVIEW_VALUES = 4;
/** A list that reads as one to a screen reader and looks like none: no bullets, no indent. */
const BARE_LIST = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
} as const;
/** Ground behind the document both views point at. */
const POINTED = 'var(--color-background-muted)';

/** Which document the space and the matches both point at, and how either changes it. */
export type Pointing = { hovered: number | null; onHover(index: number | null): void };

/** Where indexing is, as `useEmbeddingIndex` reports it. */
export type IndexRun = OneCallState<'indexing', EmbeddingIndex> & {
  progress: IndexProgress | null;
};
/** Where the search is, as `useTheoremEmbedding` reports it. */
export type SearchRun = OneCallState<'embedding', EmbeddingResult>;

function Failure({ failure }: { failure: ClientFailure | null }) {
  return failure ? <Banner status="error" role="alert" title={failure.error} /> : null;
}

/** A document's name as both cards word it: its words, its file's name, or its number. */
function useDocumentName(
  inputs: readonly EmbeddingInput[],
  documents: readonly EmbeddingDocument[],
): (at: number) => string {
  const t = useLabels();
  const bytes = useBytes();
  return (at) => documentLabel(t, bytes, documents[at] ?? { input: inputs[at] }, at + 1).label;
}

/** The documents most like the query, each with its cosine similarity, best first. */
function MatchesCard({
  matches,
  index,
  documents,
  pointing,
}: {
  matches: readonly EmbeddingMatch[];
  index: EmbeddingIndex;
  documents: readonly EmbeddingDocument[];
  pointing: Pointing;
}) {
  const t = useLabels();
  const n = useNumbers();
  const label = useDocumentName(index.inputs, documents);
  const lead = matches[0];
  if (!lead) return <Banner status="warning" title={t('@theorem.embedding.no_matches')} />;
  const shown = matches.slice(0, MATCHES_SHOWN);
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
      <ul style={BARE_LIST}>
        {shown.map((match, at) => {
          const name = label(match.index);
          const score = n.decimal.format(match.score);
          return (
            <li
              key={match.index}
              aria-label={`${name}: ${score}`}
              onPointerEnter={() => pointing.onHover(match.index)}
              onPointerLeave={() => pointing.onHover(null)}
              style={{
                borderRadius: 'var(--radius-container)',
                margin: '-4px -8px',
                padding: '4px 8px',
                background: pointing.hovered === match.index ? POINTED : undefined,
              }}
            >
              <VStack gap={1}>
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
            </li>
          );
        })}
      </ul>
    </ChartCard>
  );
}

/** Copies a text; the button says so for a moment after. */
function CopyText({ text, label, isIcon }: { text: string; label: string; isIcon?: boolean }) {
  const t = useLabels();
  const copied = t('@theorem.embedding.copied');
  const { copy, isCopied } = useClipboard({ announce: copied });
  const shown = isCopied ? copied : label;
  return isIcon ? (
    <IconButton
      label={shown}
      tooltip={shown}
      size="sm"
      variant="ghost"
      icon={<Icon icon={isCopied ? IconCheck : IconCopy} size="xsm" color="secondary" />}
      onClick={() => void copy(text)}
    />
  ) : (
    <Button label={shown} size="sm" variant="ghost" onClick={() => void copy(text)} />
  );
}

/** Every document with the first values of its vector, each vector copyable, or all of them at once. */
function VectorList({
  vectors,
  name,
  pointing,
}: {
  vectors: readonly (readonly number[])[];
  name: (at: number) => string;
  pointing: Pointing;
}) {
  const t = useLabels();
  const all = useMemo(() => JSON.stringify(vectors), [vectors]);
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting" color="secondary">
            {t('@theorem.embedding.width', { dimensions: vectors[0]?.length ?? 0 })}
          </Text>
        </StackItem>
        <CopyText text={all} label={t('@theorem.embedding.copy_vectors')} />
      </HStack>
      <ul style={{ ...BARE_LIST, gap: 0, maxHeight: SPACE_PX, overflowY: 'auto' }}>
        {keyedByContent(vectors, (vector) => vector.slice(0, PREVIEW_VALUES * 2).join()).map(
          ({ item: vector, index: at, key }) => (
            <li
              key={key}
              onPointerEnter={() => pointing.onHover(at)}
              onPointerLeave={() => pointing.onHover(null)}
              style={{
                borderRadius: 'var(--radius-container)',
                padding: '4px 8px',
                background: pointing.hovered === at ? POINTED : undefined,
              }}
            >
              <HStack gap={2} vAlign="center">
                <StackItem size="fill">
                  <VStack gap={0}>
                    <Text type="supporting" maxLines={1}>
                      {name(at)}
                    </Text>
                    <Text type="supporting" color="secondary" maxLines={1} hasTabularNumbers>
                      <code>
                        {`[${vector
                          .slice(0, PREVIEW_VALUES)
                          .map((v) => v.toFixed(4))
                          .join(', ')}${vector.length > PREVIEW_VALUES ? ', …' : ''}]`}
                      </code>
                    </Text>
                  </VStack>
                </StackItem>
                <CopyText
                  text={JSON.stringify(vector)}
                  label={t('@theorem.embedding.copy_vector')}
                  isIcon
                />
              </HStack>
            </li>
          ),
        )}
      </ul>
    </VStack>
  );
}

/** The space for an index, laid out in slices so a large one never freezes the page; `null` until it is ready. */
function useSpace(vectors: readonly (readonly number[])[]): EmbeddingSpace | null {
  const [space, setSpace] = useState<{ of: typeof vectors; space: EmbeddingSpace } | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    layoutSpaceSoon(vectors, stop.signal).then(
      (next) => setSpace({ of: vectors, space: next }),
      // why: only the abort rejects, when the vectors changed or the card went; the newer run answers.
      () => {},
    );
    return () => stop.abort();
  }, [vectors]);
  return space?.of === vectors ? space.space : null;
}

/**
 * The matches the space joins to the query: those shown whose similarity
 * stands out against the query's similarity to every document, each with how
 * far it passes that threshold, from 0 at it to 1 at identical.
 */
function closenessOf(matches: readonly EmbeddingMatch[]): QueryMatch[] {
  const threshold = outlierThreshold(matches.map((m) => m.score));
  return matches
    .slice(0, MATCHES_SHOWN)
    .filter((m) => m.score > threshold)
    .map((m) => ({
      index: m.index,
      closeness: threshold < 1 ? Math.min((m.score - threshold) / (1 - threshold), 1) : 1,
    }));
}

/** The index while it runs: how many documents are done. */
function IndexingCard({ progress }: { progress: IndexProgress }) {
  const t = useLabels();
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
}

const SPACE_ROOM = { width: '100%', aspectRatio: '1 / 1', maxHeight: SPACE_PX } as const;

/** The space, with the last query landed among its matches; an empty box of the same size until it is laid out. */
function IndexSpace({
  space,
  query,
  matches,
  name,
  pointing,
  onUnavailable,
}: {
  space: EmbeddingSpace | null;
  query: readonly number[] | null;
  matches: readonly EmbeddingMatch[];
  name(index: number): string;
  pointing: Pointing;
  onUnavailable(): void;
}) {
  const t = useLabels();
  const landed = useMemo(() => (space && query ? placeQuery(space, query) : null), [space, query]);
  const close = useMemo(() => (landed ? closenessOf(matches) : []), [landed, matches]);
  if (!space) return <div style={SPACE_ROOM} />;
  const label = t('@theorem.embedding.space_label', { count: space.documents.length });
  return (
    <Suspense fallback={<div style={SPACE_ROOM} />}>
      <EmbeddingSpaceView
        space={space}
        query={landed}
        matches={close}
        hovered={pointing.hovered}
        onHover={pointing.onHover}
        nameOf={name}
        label={landed ? `${label} ${t('@theorem.embedding.space_query')}` : label}
        onUnavailable={onUnavailable}
      />
    </Suspense>
  );
}

type IndexView = 'space' | 'list';

/** The switch between the space and the list. */
function ViewSwitch({ view, onChange }: { view: IndexView; onChange(view: IndexView): void }) {
  const t = useLabels();
  return (
    <SegmentedControl
      label={t('@theorem.embedding.view')}
      size="sm"
      value={view}
      onChange={(next) => onChange(next === 'list' ? 'list' : 'space')}
    >
      <SegmentedControlItem value="space" label={t('@theorem.embedding.space')} />
      <SegmentedControlItem value="list" label={t('@theorem.embedding.list')} />
    </SegmentedControl>
  );
}

/** The vectors listed, saying first when the space could not be drawn. */
function IndexList({
  vectors,
  name,
  pointing,
  isDrawable,
}: {
  vectors: readonly (readonly number[])[];
  name(index: number): string;
  pointing: Pointing;
  isDrawable: boolean;
}) {
  const t = useLabels();
  return (
    <VStack gap={2}>
      {isDrawable ? null : (
        <Text type="supporting" color="secondary">
          {t('@theorem.embedding.space_off')}
        </Text>
      )}
      <VectorList vectors={vectors} name={name} pointing={pointing} />
    </VStack>
  );
}

export type IndexCardProps = {
  run: IndexRun;
  /** The documents as they were indexed. */
  documents: readonly EmbeddingDocument[];
  /** The last query's vector, once a search has run. */
  query: readonly number[] | null;
  /** The documents ranked by the query, best first. */
  matches: readonly EmbeddingMatch[];
  pointing: Pointing;
};

/** The finished index, as a space or a list. */
function IndexedCard({
  run,
  result,
  documents,
  query,
  matches,
  pointing,
}: IndexCardProps & { result: EmbeddingIndex }) {
  const t = useLabels();
  const [view, setView] = useState<IndexView>('space');
  const [isDrawable, setDrawable] = useState(true);
  const space = useSpace(result.vectors);
  const name = useDocumentName(result.inputs, documents);
  return (
    <VStack gap={4}>
      <Failure failure={run.failure} />
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
          aside={isDrawable ? <ViewSwitch view={view} onChange={setView} /> : null}
        >
          {isDrawable && view === 'space' ? (
            <IndexSpace
              space={space}
              query={query}
              matches={matches}
              name={name}
              pointing={pointing}
              onUnavailable={() => setDrawable(false)}
            />
          ) : (
            <IndexList
              vectors={result.vectors}
              name={name}
              pointing={pointing}
              isDrawable={isDrawable}
            />
          )}
        </ChartCard>
      </ResultStack>
    </VStack>
  );
}

/** The index: its progress while it runs, then the documents as a space or a list, or why it failed. */
export function IndexCard(props: IndexCardProps) {
  const { progress, result, status, failure } = props.run;
  if (progress && (!result || status === 'indexing')) return <IndexingCard progress={progress} />;
  if (!result) return <Failure failure={failure} />;
  return <IndexedCard {...props} result={result} />;
}

/**
 * What the search found: the matches for the last query, ranked in the index,
 * best first. Each keeps one quiet line for the model, time, tokens,
 * and cost of its own calls.
 */
export function EmbeddingResults({
  index,
  search,
  documents,
  matches,
  pointing,
}: {
  index: IndexRun;
  search: SearchRun;
  documents: readonly EmbeddingDocument[];
  /** The documents ranked by the last query, best first. */
  matches: readonly EmbeddingMatch[];
  pointing: Pointing;
}) {
  const t = useLabels();
  const searched = search.result?.embeddings[0]?.values;
  return (
    <VStack gap={4}>
      <Failure failure={search.failure} />
      {searched && index.result ? (
        <ResultStack
          model={search.result?.model ?? ''}
          usage={search.result?.usage}
          elapsedMs={search.elapsedMs}
          isStale={search.status === 'embedding'}
          tokens={(count) => t('@theorem.embedding.tokens', { count })}
        >
          <Arrive>
            <MatchesCard
              matches={matches}
              index={index.result}
              documents={documents}
              pointing={pointing}
            />
          </Arrive>
        </ResultStack>
      ) : null}
    </VStack>
  );
}
