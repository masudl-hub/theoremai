import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { Link } from '@astryxdesign/core/Link';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import {
  pixel,
  proportional,
  Table,
  useTableSortable,
  useTableSortableState,
} from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconArrowLeft, IconHeartbeat, IconShieldSearch } from '@tabler/icons-react';
import {
  DETECT_ACTION_META,
  DETECT_RULES,
  DETECTOR_META,
  type Detector,
} from '@theoremjs/agents/guardrails';
import { PaneLayout, PanePanel, PaneState } from '@theoremjs/react/ui';
import { type ReactNode, useEffect, useState } from 'react';
import {
  BENCH_OUTCOMES,
  type BenchDatasetFacts,
  type BenchOutcome,
  type BenchProgress,
  type BenchRow,
  type BenchRunAnswer,
  type BenchSummary,
  type DatasetScore,
  type DetectorScore,
  ROLES,
  type Role,
} from '../guardrail-bench.ts';
import {
  PROBE_BOUNDARY_NOTES,
  PROBE_TEXT_LIMIT,
  type ProbeBoundary,
  type StudioRunPayload,
} from '../mod.ts';
import {
  GuardrailMatrix,
  MATRIX_FIGURE_LABELS,
  MATRIX_FIGURES,
  type MatrixFigure,
} from './guardrail-matrix.tsx';
import { GuardrailTester, type Outcome, sendProbe, Verdict } from './guardrail-tester.tsx';
import { useProject } from './lib/studio-project.ts';

const OUTCOME_LABELS: Record<BenchOutcome, string> = {
  false_alarm: 'False alarms',
  missed: 'Missed',
  caught: 'Caught',
};

const ROLE_LABELS: Record<Role, string> = {
  train: 'Train',
  validate: 'Validate',
  test: 'Test',
  holdout: 'Hold-out',
};

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
}

function milliseconds(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(2)} ms`;
}

/** A change in points since the run before, or nothing when either side has no rate. */
function change(now: number | undefined, before: number | undefined): string {
  if (now === undefined || before === undefined) return '';
  const points = (now - before) * 100;
  if (Math.abs(points) < 0.05) return '±0';
  return `${points > 0 ? '+' : ''}${points.toFixed(1)}`;
}

/** One row of the scores table: one detector on one dataset, beside the run before. */
type ScoreRow = {
  id: string;
  dataset: string;
  role: Role;
  boundary: ProbeBoundary;
  detector: Detector;
  recall?: number;
  falseAlarmRate?: number;
  p50?: number;
  p95?: number;
  recallBefore?: number;
  falseAlarmBefore?: number;
  thin: boolean;
  /** The dataset the run is on: its figures are the rows read so far. */
  running: boolean;
  score: DetectorScore;
};

function scoreRows(
  scores: readonly DatasetScore[],
  previous: BenchSummary | undefined,
  running?: string,
): ScoreRow[] {
  const before = new Map(
    (previous?.scores ?? []).flatMap((dataset) =>
      dataset.detectors.map((d) => [`${d.dataset}/${d.detector}`, d] as const),
    ),
  );
  return scores.flatMap((dataset) =>
    dataset.detectors.map((score) => {
      const id = `${score.dataset}/${score.detector}`;
      const prior = before.get(id);
      return {
        id,
        dataset: score.dataset,
        role: score.role,
        boundary: score.boundary,
        detector: score.detector,
        recall: score.recall,
        falseAlarmRate: score.falseAlarmRate,
        p50: score.ms?.p50,
        p95: score.ms?.p95,
        recallBefore: prior?.recall,
        falseAlarmBefore: prior?.falseAlarmRate,
        thin: score.thin,
        running: score.dataset === running,
        score,
      };
    }),
  );
}

/** A licence as short as it reads: the upstream's own words after the first are left to its page. */
function shortLicense(license: string): string {
  return license.startsWith('other') ? 'Other' : license;
}

/** A dataset's name, opening its source page, with its licence beside it. */
function DatasetName({ id, facts }: { id: string; facts: BenchDatasetFacts | undefined }) {
  return (
    <HStack gap={1} align="center" wrap="wrap">
      {facts?.source ? (
        <Link href={facts.source} isExternalLink label={id} />
      ) : (
        <Text type="supporting">{id}</Text>
      )}
      {facts?.license && (
        <Text type="supporting" color="secondary">
          {shortLicense(facts.license)}
        </Text>
      )}
    </HStack>
  );
}

function RateCell({ now, before }: { now: number | undefined; before: number | undefined }) {
  const moved = change(now, before);
  return (
    <HStack gap={1} align="center">
      <Text type="supporting">{percent(now)}</Text>
      {moved && (
        <Text type="supporting" color="secondary">
          {moved}
        </Text>
      )}
    </HStack>
  );
}

function ScoresTable({
  rows,
  facts,
  onOpen,
}: {
  rows: ScoreRow[];
  facts: ReadonlyMap<string, BenchDatasetFacts>;
  onOpen: (row: ScoreRow) => void;
}) {
  const { sortedData, sortConfig } = useTableSortableState({
    data: rows,
    defaultSort: [{ sortKey: 'falseAlarmRate', direction: 'descending' }],
  });
  const sortable = useTableSortable<ScoreRow>(sortConfig);
  return (
    <Table
      density="compact"
      dividers="rows"
      hasHover
      idKey="id"
      data={sortedData}
      plugins={{ sortable }}
      columns={[
        {
          key: 'detector',
          header: 'Detector',
          width: proportional(1, { minWidth: 120 }),
          sortable: true,
          renderCell: (row) => (
            <Button
              label={DETECTOR_META[row.detector].label}
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpen(row);
              }}
            />
          ),
        },
        {
          key: 'dataset',
          header: 'Dataset',
          width: proportional(1, { minWidth: 180 }),
          sortable: true,
          renderCell: (row) => (
            <HStack gap={1} align="center" wrap="wrap">
              <DatasetName id={row.dataset} facts={facts.get(row.dataset)} />
              {row.running && <Token label="Running" size="sm" color="blue" />}
              {row.thin && !row.running && <Token label="Few rows" size="sm" color="gray" />}
            </HStack>
          ),
        },
        {
          key: 'recall',
          header: 'Recall',
          width: pixel(110),
          sortable: true,
          renderCell: (row) => <RateCell now={row.recall} before={row.recallBefore} />,
        },
        {
          key: 'falseAlarmRate',
          header: 'False alarms',
          width: pixel(120),
          sortable: true,
          renderCell: (row) => <RateCell now={row.falseAlarmRate} before={row.falseAlarmBefore} />,
        },
        {
          key: 'p50',
          header: 'p50',
          width: pixel(90),
          sortable: true,
          renderCell: (row) => <Text type="supporting">{milliseconds(row.p50)}</Text>,
        },
        {
          key: 'p95',
          header: 'p95',
          width: pixel(90),
          sortable: true,
          renderCell: (row) => <Text type="supporting">{milliseconds(row.p95)}</Text>,
        },
      ]}
    />
  );
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0
    ? `${String(minutes)} min ${(seconds % 60).toFixed(0)} s`
    : `${seconds.toFixed(0)} s`;
}

function Skipped({ skipped }: { skipped: BenchSummary['skipped'] }) {
  if (skipped.length === 0) return null;
  return (
    <Banner
      status="warning"
      title={`${String(skipped.length)} datasets not run`}
      description={skipped.map((skip) => skip.dataset).join(', ')}
    />
  );
}

const RUN_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A run's name, the UTC time it started as a folder name, as a local date and time. */
function runLabel(run: string): string {
  const [day = '', time = ''] = run.split('T');
  const started = new Date(`${day}T${time.replace(/-/g, ':')}`);
  return Number.isNaN(started.getTime()) ? run : RUN_TIME.format(started);
}

/** The run in short: what it ran, on which commit, and what it could not read. */
function RunFacts({ summary, previous }: { summary: BenchSummary; previous?: BenchSummary }) {
  return (
    <VStack gap={2}>
      <MetadataList columns={2}>
        <MetadataListItem label="Run">{runLabel(summary.run)}</MetadataListItem>
        <MetadataListItem label="Commit">{summary.commit.slice(0, 8)}</MetadataListItem>
        <MetadataListItem label="Took">{duration(summary.seconds)}</MetadataListItem>
        <MetadataListItem label="Compared with">
          {previous ? runLabel(previous.run) : '—'}
        </MetadataListItem>
      </MetadataList>
      <Skipped skipped={summary.skipped} />
    </VStack>
  );
}

/** A run still going: how far through its datasets it is, and the one it is on. */
function LiveFacts({ live, previous }: { live: BenchProgress; previous?: BenchSummary }) {
  const finished = live.scores.length - (live.current ? 1 : 0) + live.skipped.length;
  return (
    <VStack gap={2}>
      <ProgressBar
        label={`Running: ${String(finished)} of ${String(live.datasets.length)} datasets`}
        value={finished}
        max={live.datasets.length}
        hasValueLabel
      />
      <MetadataList columns={2}>
        <MetadataListItem label="Run">{runLabel(live.run)}</MetadataListItem>
        <MetadataListItem label="Now">
          {live.current
            ? `${live.current.dataset} · ${live.current.rows.toLocaleString()} rows`
            : '—'}
        </MetadataListItem>
        <MetadataListItem label="Running for">{duration(live.seconds)}</MetadataListItem>
        <MetadataListItem label="Compared with">
          {previous ? runLabel(previous.run) : '—'}
        </MetadataListItem>
      </MetadataList>
      <Skipped skipped={live.skipped} />
    </VStack>
  );
}

/** `text` with each of `matches` marked where it occurs. */
function Marked({ text, matches }: { text: string; matches: readonly string[] }): ReactNode {
  const wanted = matches.filter((match) => match.length > 0);
  if (wanted.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  while (at < text.length) {
    let next = -1;
    let found = '';
    for (const match of wanted) {
      const index = text.indexOf(match, at);
      if (index >= 0 && (next < 0 || index < next)) {
        next = index;
        found = match;
      }
    }
    if (next < 0) break;
    parts.push(text.slice(at, next));
    parts.push(
      <mark key={next} className="studio-bench-mark">
        {found}
      </mark>,
    );
    at = next + found.length;
  }
  parts.push(text.slice(at));
  return parts;
}

function matchesOf(row: BenchRow, detector: Detector): string[] {
  const rule = DETECT_RULES[detector];
  return (row.events ?? []).flatMap((event) =>
    event.hits.flatMap((hit) => (hit.rule === rule && hit.match ? [hit.match] : [])),
  );
}

/** Why a row cannot go through the probe again, or undefined when it can. */
function unprobeable(row: BenchRow): string | undefined {
  if (row.text === undefined) return 'The run kept no text for this row.';
  if (row.text.length > PROBE_TEXT_LIMIT) return 'Longer than the probe takes.';
  return undefined;
}

/** A row the detector counted: its text, what matched, and the way to send it through the probe again. */
function BenchRowView({
  row,
  detector,
  payload,
}: {
  row: BenchRow;
  detector: Detector;
  payload: StudioRunPayload;
}) {
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState<Outcome | null>(null);
  const reason = unprobeable(row);
  const answer = again?.answers?.find((each) => each.boundary === row.boundary);
  return (
    <PanePanel title={`${row.category} · ${row.id}`}>
      <VStack gap={2}>
        <Text type="supporting" maxLines={8}>
          {row.text === undefined ? (
            '—'
          ) : (
            <Marked text={row.text} matches={matchesOf(row, detector)} />
          )}
        </Text>
        <HStack gap={2} align="center" wrap="wrap">
          <Button
            label="Probe the draft"
            size="sm"
            variant="ghost"
            tooltip={reason}
            isLoading={busy}
            isDisabled={reason !== undefined}
            onClick={() => {
              if (row.text === undefined) return;
              setBusy(true);
              void sendProbe(payload, row.text, detector).then((outcome) => {
                setAgain(outcome);
                setBusy(false);
              });
            }}
          />
          {answer && <Verdict answer={answer} />}
          {again?.error && <Text color="secondary">{again.error}</Text>}
        </HStack>
      </VStack>
    </PanePanel>
  );
}

function useBenchRows(
  endpoint: string,
  run: string,
  score: DetectorScore,
  outcome: BenchOutcome,
): BenchRow[] | 'failed' | undefined {
  const [rows, setRows] = useState<{ key: string; rows: BenchRow[] | 'failed' } | null>(null);
  const query = new URLSearchParams({
    run,
    dataset: score.dataset,
    detector: score.detector,
    outcome,
  });
  const key = query.toString();
  useEffect(() => {
    let live = true;
    fetch(`${endpoint}/bench/rows?${key}`)
      .then((response) => (response.ok ? response.json<{ rows: BenchRow[] }>() : null))
      .then((body) => {
        if (live) setRows({ key, rows: body?.rows ?? 'failed' });
      })
      .catch(() => {
        if (live) setRows({ key, rows: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [endpoint, key]);
  return rows?.key === key ? rows.rows : undefined;
}

/** The categories with the most of `outcome`, worst first. */
function worstCategories(score: DetectorScore, outcome: BenchOutcome) {
  if (outcome === 'false_alarm')
    return score.byCategory.filter((category) => category.fired > 0).slice(0, 8);
  if (outcome === 'missed')
    return score.attacksByCategory
      .filter((category) => category.fired < category.samples)
      .slice(0, 8);
  return [];
}

function OutcomeRows({
  endpoint,
  run,
  score,
  outcome,
  payload,
}: {
  endpoint: string;
  run: string;
  score: DetectorScore;
  outcome: BenchOutcome;
  payload: StudioRunPayload;
}) {
  const rows = useBenchRows(endpoint, run, score, outcome);
  if (rows === undefined) return null;
  if (rows === 'failed') return <Banner status="error" title="Couldn't read the run's rows." />;
  if (rows.length === 0) return <Text color="secondary">None.</Text>;
  return (
    <VStack gap={3}>
      {rows.map((row) => (
        <BenchRowView key={row.id} row={row} detector={score.detector} payload={payload} />
      ))}
    </VStack>
  );
}

/** One detector on one dataset: its figures, its worst categories, and the rows behind them. */
function ScoreDetail({
  row,
  facts,
  run,
  endpoint,
  payload,
  isClose,
  onBack,
}: {
  row: ScoreRow;
  facts: BenchDatasetFacts | undefined;
  run: string;
  endpoint: string;
  payload: StudioRunPayload;
  isClose: boolean;
  onBack: () => void;
}) {
  const { score } = row;
  const outcomes = BENCH_OUTCOMES.filter((each) => each === 'false_alarm' || score.attacks);
  const [outcome, setOutcome] = useState<BenchOutcome>('false_alarm');
  const categories = worstCategories(score, outcome);
  return (
    <VStack gap={4} padding={4}>
      <HStack>
        <Button
          label={isClose ? 'Close' : 'Back'}
          variant="ghost"
          size="sm"
          icon={<Icon icon={IconArrowLeft} />}
          onClick={onBack}
        />
      </HStack>
      <Item
        label={<Text weight="semibold">{DETECTOR_META[score.detector].label}</Text>}
        description={DETECTOR_META[score.detector].doc}
        align="start"
      />
      <MetadataList>
        <MetadataListItem label="Dataset">
          <DatasetName id={score.dataset} facts={facts} />
        </MetadataListItem>
        <MetadataListItem label="Boundary">
          {PROBE_BOUNDARY_NOTES[score.boundary].label}
        </MetadataListItem>
        <MetadataListItem label="Default action">
          {DETECT_ACTION_META[score.defaultAction].label}
        </MetadataListItem>
        <MetadataListItem label="Recall">
          {score.attacks === undefined
            ? '—'
            : `${percent(score.recall)} (${String(score.caught)} of ${String(score.attacks)})`}
        </MetadataListItem>
        <MetadataListItem label="False alarms">
          {`${percent(score.falseAlarmRate)} (${String(score.falseAlarms)} of ${String(score.benign)})`}
        </MetadataListItem>
        <MetadataListItem label="Time alone">
          {score.ms
            ? `p50 ${milliseconds(score.ms.p50)} · p95 ${milliseconds(score.ms.p95)} · max ${milliseconds(score.ms.max)}`
            : '—'}
        </MetadataListItem>
      </MetadataList>
      <SegmentedControl
        label="Rows"
        size="sm"
        value={outcome}
        onChange={(next) => {
          setOutcome(outcomes.find((each) => each === next) ?? 'false_alarm');
        }}
      >
        {outcomes.map((each) => (
          <SegmentedControlItem key={each} value={each} label={OUTCOME_LABELS[each]} />
        ))}
      </SegmentedControl>
      {categories.length > 0 && (
        <HStack gap={1} wrap="wrap">
          {categories.map((category) => (
            <Token
              key={category.category}
              size="sm"
              color="gray"
              label={`${category.category} ${String(outcome === 'missed' ? category.samples - category.fired : category.fired)}/${String(category.samples)}`}
            />
          ))}
        </HStack>
      )}
      <OutcomeRows
        endpoint={endpoint}
        run={run}
        score={score}
        outcome={outcome}
        payload={payload}
      />
    </VStack>
  );
}

function rolesIn(scores: readonly DatasetScore[]): Role[] {
  return ROLES.filter((role) => scores.some((score) => score.role === role));
}

type HealthView = 'table' | 'matrix';
type Place = { boundary: ProbeBoundary; detector: Detector };

/** What the view shows of an answer: a run still going against the last whole run, or a finished run against the run before it. */
function shownRun(answer: BenchRunAnswer) {
  const { live, summary } = answer;
  return {
    previous: live ? summary : answer.previous,
    scores: live?.scores ?? summary?.scores ?? [],
    run: live?.run ?? summary?.run ?? '',
    facts: new Map(
      [...(summary?.datasets ?? []), ...(live?.datasets ?? [])].map((each) => [each.id, each]),
    ),
  };
}

function RolePicker({
  roles,
  role,
  onChange,
}: {
  roles: readonly Role[];
  role: Role | 'all';
  onChange: (role: Role | 'all') => void;
}) {
  return (
    <SegmentedControl
      label="Datasets"
      size="sm"
      value={role}
      onChange={(next) => {
        onChange(roles.find((each) => each === next) ?? 'all');
      }}
    >
      <SegmentedControlItem value="all" label="All" />
      {roles.map((each) => (
        <SegmentedControlItem key={each} value={each} label={ROLE_LABELS[each]} />
      ))}
    </SegmentedControl>
  );
}

/** Table or matrix, what the matrix is shaded by, and the place a matrix cell narrowed the table to. */
function ViewPicker({
  view,
  figure,
  place,
  onView,
  onFigure,
  onClear,
}: {
  view: HealthView;
  figure: MatrixFigure;
  place: Place | null;
  onView: (view: HealthView) => void;
  onFigure: (figure: MatrixFigure) => void;
  onClear: () => void;
}) {
  return (
    <HStack gap={2} align="center" wrap="wrap">
      <SegmentedControl
        label="View"
        size="sm"
        value={view}
        onChange={(next) => {
          onView(next === 'matrix' ? 'matrix' : 'table');
        }}
      >
        <SegmentedControlItem value="table" label="Table" />
        <SegmentedControlItem value="matrix" label="Matrix" />
      </SegmentedControl>
      {view === 'matrix' && (
        <SegmentedControl
          label="Shaded by"
          size="sm"
          value={figure}
          onChange={(next) => {
            onFigure(MATRIX_FIGURES.find((each) => each === next) ?? 'recall');
          }}
        >
          {MATRIX_FIGURES.map((each) => (
            <SegmentedControlItem key={each} value={each} label={MATRIX_FIGURE_LABELS[each]} />
          ))}
        </SegmentedControl>
      )}
      {view === 'table' && place && (
        <Token
          size="sm"
          label={`${DETECTOR_META[place.detector].label} at ${PROBE_BOUNDARY_NOTES[place.boundary].label}`}
          onRemove={onClear}
        />
      )}
    </HStack>
  );
}

/**
 * The guardrails bench's last run: each detector's recall, false alarms and time on each dataset,
 * against the run before; a row opens on the texts behind its figures.
 */
function GuardrailHealth({
  answer,
  endpoint,
  payload,
  isWide,
  aside,
}: {
  answer: BenchRunAnswer;
  endpoint: string;
  payload: StudioRunPayload;
  isWide: boolean;
  aside: ReactNode;
}) {
  const { previous, scores, run, facts } = shownRun(answer);
  const [role, setRole] = useState<Role | 'all'>('all');
  const [view, setView] = useState<HealthView>('table');
  const [figure, setFigure] = useState<MatrixFigure>('recall');
  const [place, setPlace] = useState<Place | null>(null);
  const [open, setOpen] = useState<ScoreRow | null>(null);
  const inRole = scores.filter((dataset) => role === 'all' || dataset.role === role);
  const rows = scoreRows(inRole, previous, answer.live?.current?.dataset).filter(
    (row) => !place || (row.boundary === place.boundary && row.detector === place.detector),
  );
  const overview = (
    <VStack gap={4} padding={4}>
      <HStack gap={3} align="center">
        <StackItem size="fill">
          <Text weight="semibold">Guardrails health</Text>
        </StackItem>
        {aside}
      </HStack>
      {answer.live ? (
        <LiveFacts live={answer.live} previous={previous} />
      ) : (
        answer.summary && <RunFacts summary={answer.summary} previous={previous} />
      )}
      <RolePicker roles={rolesIn(scores)} role={role} onChange={setRole} />
      <ViewPicker
        view={view}
        figure={figure}
        place={place}
        onView={setView}
        onFigure={setFigure}
        onClear={() => {
          setPlace(null);
        }}
      />
      {view === 'matrix' ? (
        <GuardrailMatrix
          scores={inRole}
          figure={figure}
          onOpen={(boundary, detector) => {
            setPlace({ boundary, detector });
            setView('table');
          }}
        />
      ) : (
        <ScoresTable rows={rows} facts={facts} onOpen={setOpen} />
      )}
    </VStack>
  );
  return (
    <PaneLayout
      isWide={isWide}
      label="Guardrails health"
      detailLabel={open ? DETECTOR_META[open.detector].label : ''}
      overview={overview}
      detail={
        open && (
          <ScoreDetail
            key={open.id}
            row={open}
            facts={facts.get(open.dataset)}
            run={run}
            endpoint={endpoint}
            payload={payload}
            isClose={isWide}
            onBack={() => {
              setOpen(null);
            }}
          />
        )
      }
    />
  );
}

function askBench(endpoint: string): Promise<BenchRunAnswer | null> {
  return fetch(`${endpoint}/bench`)
    .then((response) => (response.ok ? response.json<BenchRunAnswer>() : null))
    .catch(() => null);
}

/**
 * The bench's last run, when the project's server has one: undefined while it is asked, null when
 * there is none. A run still going is followed as it goes, and the answer asked again once it ends.
 */
function useBenchRun(endpoint: string | undefined): BenchRunAnswer | null | undefined {
  const [answer, setAnswer] = useState<BenchRunAnswer | null | undefined>(
    endpoint ? undefined : null,
  );
  useEffect(() => {
    if (!endpoint) return;
    let mounted = true;
    void askBench(endpoint).then((body) => {
      if (mounted) setAnswer(body);
    });
    return () => {
      mounted = false;
    };
  }, [endpoint]);
  const following = answer?.live?.run;
  useEffect(() => {
    if (!endpoint || !following || typeof EventSource === 'undefined') return;
    const source = new EventSource(`${endpoint}/bench/live?run=${encodeURIComponent(following)}`);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const live = JSON.parse(event.data) as BenchProgress;
        setAnswer((before) => (before ? { ...before, live } : before));
      } catch {
        // why: A line cut short is followed by the next one, a second later.
      }
    };
    source.addEventListener('ended', () => {
      source.close();
      void askBench(endpoint).then(setAnswer);
    });
    return () => {
      source.close();
    };
  }, [endpoint, following]);
  return answer;
}

/**
 * The guardrail tester, and beside it the bench's Health view when the project's server has a
 * bench run: a checkout of Theorem that ran `deno task bench:guardrails`. Anywhere else it is the
 * tester alone.
 */
export function GuardrailPane({ payload, isWide }: { payload: StudioRunPayload; isWide: boolean }) {
  const endpoint = useProject()?.endpoint;
  const bench = useBenchRun(endpoint);
  const [mode, setMode] = useState<'test' | 'health'>('test');
  if (!bench || !endpoint) return <GuardrailTester payload={payload} isWide={isWide} />;
  const modes = (
    <SegmentedControl
      label="Guardrails"
      size="sm"
      value={mode}
      onChange={(next) => {
        setMode(next === 'health' ? 'health' : 'test');
      }}
    >
      <SegmentedControlItem
        value="test"
        label="Test"
        icon={<Icon icon={IconShieldSearch} size="sm" />}
      />
      <SegmentedControlItem
        value="health"
        label="Health"
        icon={<Icon icon={IconHeartbeat} size="sm" />}
      />
    </SegmentedControl>
  );
  if (mode === 'test') return <GuardrailTester payload={payload} isWide={isWide} aside={modes} />;
  if ((bench.live?.scores ?? bench.summary?.scores ?? []).length === 0) {
    return (
      <VStack gap={4} padding={4}>
        <HStack hAlign="end">{modes}</HStack>
        <PaneState
          icon={<Icon icon={IconHeartbeat} size="lg" color="secondary" />}
          title={bench.live ? 'The bench run is starting.' : 'The last bench run scored nothing.'}
        />
      </VStack>
    );
  }
  return (
    <GuardrailHealth
      answer={bench}
      endpoint={endpoint}
      payload={payload}
      isWide={isWide}
      aside={modes}
    />
  );
}
