import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
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
  type BenchOutcome,
  type BenchRow,
  type BenchRunAnswer,
  type DatasetScore,
  type DetectorScore,
  ROLES,
  type Role,
} from '../guardrail-bench.ts';
import { PROBE_BOUNDARY_NOTES, PROBE_TEXT_LIMIT, type StudioRunPayload } from '../mod.ts';
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
  detector: Detector;
  recall?: number;
  falseAlarmRate?: number;
  p50?: number;
  p95?: number;
  recallBefore?: number;
  falseAlarmBefore?: number;
  thin: boolean;
  score: DetectorScore;
};

function scoreRows(answer: BenchRunAnswer): ScoreRow[] {
  const before = new Map(
    (answer.previous?.scores ?? []).flatMap((dataset) =>
      dataset.detectors.map((d) => [`${d.dataset}/${d.detector}`, d] as const),
    ),
  );
  return answer.summary.scores.flatMap((dataset) =>
    dataset.detectors.map((score) => {
      const id = `${score.dataset}/${score.detector}`;
      const prior = before.get(id);
      return {
        id,
        dataset: score.dataset,
        role: score.role,
        detector: score.detector,
        recall: score.recall,
        falseAlarmRate: score.falseAlarmRate,
        p50: score.ms?.p50,
        p95: score.ms?.p95,
        recallBefore: prior?.recall,
        falseAlarmBefore: prior?.falseAlarmRate,
        thin: score.thin,
        score,
      };
    }),
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

function ScoresTable({ rows, onOpen }: { rows: ScoreRow[]; onOpen: (row: ScoreRow) => void }) {
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
          width: proportional(1, { minWidth: 140 }),
          sortable: true,
          renderCell: (row) => (
            <HStack gap={1} align="center">
              <Text type="supporting">{row.dataset}</Text>
              {row.thin && <Token label="Few rows" size="sm" color="gray" />}
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

/** The run in short: what it ran, on which commit, and what it could not read. */
function RunFacts({ answer }: { answer: BenchRunAnswer }) {
  const { summary, previous } = answer;
  return (
    <VStack gap={2}>
      <MetadataList>
        <MetadataListItem label="Run">{summary.run}</MetadataListItem>
        <MetadataListItem label="Commit">{summary.commit.slice(0, 8)}</MetadataListItem>
        <MetadataListItem label="Took">{`${summary.seconds.toFixed(0)} s`}</MetadataListItem>
        <MetadataListItem label="Compared with">{previous?.run ?? '—'}</MetadataListItem>
        {summary.limit !== undefined && (
          <MetadataListItem label="Rows per dataset">{String(summary.limit)}</MetadataListItem>
        )}
      </MetadataList>
      {summary.skipped.length > 0 && (
        <Banner
          status="warning"
          title={`${String(summary.skipped.length)} datasets not run`}
          description={summary.skipped.map((skip) => skip.dataset).join(', ')}
        />
      )}
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
  run,
  endpoint,
  payload,
  isClose,
  onBack,
}: {
  row: ScoreRow;
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
        <MetadataListItem label="Dataset">{score.dataset}</MetadataListItem>
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

/**
 * The guardrails bench's last run: each detector's recall, false alarms and time on each dataset,
 * against the run before; a row opens on the texts behind its figures.
 */
function GuardrailHealth({
  answer,
  endpoint,
  payload,
  isWide,
}: {
  answer: BenchRunAnswer;
  endpoint: string;
  payload: StudioRunPayload;
  isWide: boolean;
}) {
  const roles = rolesIn(answer.summary.scores);
  const [role, setRole] = useState<Role | 'all'>('all');
  const [open, setOpen] = useState<ScoreRow | null>(null);
  const rows = scoreRows(answer).filter((row) => role === 'all' || row.role === role);
  const overview = (
    <VStack gap={4} padding={4}>
      <RunFacts answer={answer} />
      <SegmentedControl
        label="Datasets"
        size="sm"
        value={role}
        onChange={(next) => {
          setRole(roles.find((each) => each === next) ?? 'all');
        }}
      >
        <SegmentedControlItem value="all" label="All" />
        {roles.map((each) => (
          <SegmentedControlItem key={each} value={each} label={ROLE_LABELS[each]} />
        ))}
      </SegmentedControl>
      <ScoresTable rows={rows} onOpen={setOpen} />
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
            run={answer.summary.run}
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

/** The bench's last run, when the project's server has one: undefined while it is asked, null when there is none. */
function useBenchRun(endpoint: string | undefined): BenchRunAnswer | null | undefined {
  const [answer, setAnswer] = useState<BenchRunAnswer | null | undefined>(
    endpoint ? undefined : null,
  );
  useEffect(() => {
    if (!endpoint) return;
    let live = true;
    fetch(`${endpoint}/bench`)
      .then((response) => (response.ok ? response.json<BenchRunAnswer>() : null))
      .then((body) => {
        if (live) setAnswer(body);
      })
      .catch(() => {
        if (live) setAnswer(null);
      });
    return () => {
      live = false;
    };
  }, [endpoint]);
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
  return (
    <VStack height="100%">
      <StackItem size="static">
        <HStack padding={2}>
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
        </HStack>
      </StackItem>
      <StackItem size="fill">
        {mode === 'test' ? (
          <GuardrailTester payload={payload} isWide={isWide} />
        ) : bench.summary.scores.length === 0 ? (
          <PaneState
            icon={<Icon icon={IconHeartbeat} size="lg" color="secondary" />}
            title="The last bench run scored nothing."
          />
        ) : (
          <GuardrailHealth answer={bench} endpoint={endpoint} payload={payload} isWide={isWide} />
        )}
      </StackItem>
    </VStack>
  );
}
