import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import type { IconType } from '@astryxdesign/core/Icon';
import { useLocale } from '@astryxdesign/core/i18n';
import { List, ListItem } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import { IconMathFunction, IconWorld } from '@tabler/icons-react';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  type HostCallStatus,
  hostCallFailure,
  hostCallStatus,
  hostConsoleView,
} from '../client/host-call.ts';
import {
  createHostTransport,
  type HostInterface,
  type HostToolKind,
  type HostToolView,
  type HostTransport,
} from '../client/host-transport.ts';
import { missingFields } from '../client/schema-fields.ts';
import { isRow, json } from '../client/shaped-data.ts';
import { toolCallLabel } from '../client/transcript-groups.ts';
import type { HttpOptions } from '../client/transport.ts';
import { type TheoremHostCall, useTheoremHost } from '../hooks/use-theorem-host.ts';
import { Arrive, Stream } from './arrive.tsx';
import {
  ConsoleFrame,
  type ConsoleView,
  JsonRequest,
  RequestCard,
  ResponseColumn,
  RunBar,
} from './ConsoleFrame.tsx';
import { type LabelText, liveDuration, type TheoremLabels, workDuration } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { IconMcp } from './mcp-icon.tsx';
import { SchemaFields } from './SchemaFields.tsx';
import { ApprovalCard, AuthChallengeCard } from './ToolGateCard.tsx';
import { ToolResult } from './ToolResult.tsx';
import { useTraceInspector } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type TheoremHostProps = {
  /** Where `createTheoremHostHandler` is mounted. Default `/api/host`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Extra fetch options for the default HTTP transport (auth headers, custom fetch). */
  http?: HttpOptions;
  /** Bring your own transport (tests, playgrounds, non-HTTP hosts). */
  transport?: HostTransport;
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  /** Replacement lines by locale, for any `@theorem.*` or `@astryx.*` key. */
  labels?: TheoremLabels;
  /** Widest the column may grow, as a CSS length. Default `960px`. */
  maxWidth?: string;
  /**
   * Drive the trace from the host's own control. The built-in toggle hides.
   * The open trace takes the console's place, unless this page is inside
   * `TracePlacement value="panel"`, where it docks. Omit to keep the toggle.
   * Needs a profile that records traces.
   */
  trace?: boolean;
  /**
   * The page is already a raised panel. The console sits in it instead of
   * painting the ground it uses on a flat page.
   */
  flush?: boolean;
  /** The request on the left and the response on the right. */
  columns?: boolean;
  className?: string;
  style?: CSSProperties;
};

/** Calls listed under the console before older ones drop off the page. */
const MAX_EARLIER = 8;

const STATUS_DOT: Readonly<Record<HostCallStatus, StatusDotVariant>> = {
  running: 'accent',
  gate: 'warning',
  complete: 'success',
  error: 'error',
  cancel: 'neutral',
};

type RequestCheck =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; note: string; input?: Record<string, unknown> };

/** The request's text as the input a call sends, and what it still lacks. */
function checkRequest(t: LabelText, tool: HostToolView, text: string): RequestCheck {
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, note: t('@theorem.decision.invalid_json') };
  }
  if (!isRow(input)) return { ok: false, note: t('@theorem.decision.invalid_json') };
  const missing = missingFields(tool.inputSchema, input);
  if (missing.length > 0)
    return { ok: false, note: t('@theorem.host.missing', { fields: missing.join(', ') }), input };
  return { ok: true, input };
}

/** The kind's icon. The same glyphs the playground uses for a tool's type. */
const KIND_ICON: Record<HostToolKind, IconType> = {
  function: IconMathFunction,
  http: IconWorld,
  mcp: IconMcp,
};

/** Kind and description, shown on the dropdown row and nowhere else. */
function toolOptionDescription(t: LabelText, tool: HostToolView): string {
  const kind = t(`@theorem.host.kind.${tool.kind}`);
  return tool.description ? `${kind} · ${tool.description}` : kind;
}

/** A tool's access when it can change things. Its kind stays in the dropdown. */
function ToolTokens({ tool }: { tool: HostToolView }) {
  const t = useLabels();
  if (tool.access === 'read-only') return null;
  return (
    <HStack gap={1} wrap="wrap">
      <Token
        label={t(`@theorem.tool.access.${tool.access}`)}
        size="sm"
        color={tool.access === 'destructive' ? 'red' : 'orange'}
      />
    </HStack>
  );
}

/** Whole seconds while a call runs, so the activity line can tick. */
function useSecondTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The tool's activity while it runs, and its activityPast once it has finished, with the clock beside it. */
function callActivity(
  t: LabelText,
  call: TheoremHostCall,
  now: number,
): {
  label: string;
  duration: string | null;
} {
  const label = call.call ? toolCallLabel(call.call) : call.name;
  const duration = call.isRunning
    ? liveDuration(t, now - call.startedAt)
    : call.elapsedMs == null
      ? null
      : workDuration(t, call.elapsedMs);
  return { label, duration };
}

/** The gate a call paused on, answered in place. */
function CallGate({
  call,
  onAnswer,
}: {
  call: TheoremHostCall;
  onAnswer: ReturnType<typeof useTheoremHost>['answer'];
}) {
  const state = call.call?.state;
  if (state?.phase !== 'gate') return null;
  if (state.gate.kind === 'auth') {
    return (
      <AuthChallengeCard
        gate={state.gate}
        toolName={call.name}
        submitted={call.answering === 'auth'}
        onAuthenticated={(secret) => void onAnswer(call.id, { action: 'auth', secret })}
      />
    );
  }
  return (
    <ApprovalCard
      gate={state.gate}
      toolName={call.name}
      input={call.input}
      decided={call.answering === 'auth' ? null : call.answering}
      onDecision={(action) => void onAnswer(call.id, { action })}
    />
  );
}

/** A call is settled once it failed, completed, or stopped running. */
function callSettled(call: TheoremHostCall): boolean {
  const state = call.call?.state;
  return Boolean(hostCallFailure(call)) || state?.phase === 'complete' || !call.isRunning;
}

/** A running call with nothing else in the column fills the card, the way an empty trace does. */
function responseFills(call: TheoremHostCall): boolean {
  const state = call.call?.state;
  return !callSettled(call) && state?.phase !== 'gate';
}

/** A call still running: its activity and the clock, centred in the card. */
function CallWaiting({ label, duration }: { label: string; duration: string | null }) {
  return (
    <VStack height="100%" vAlign="center" padding={4}>
      <EmptyState
        icon={<Spinner size="lg" />}
        title={label}
        description={duration ?? undefined}
        isCompact
      />
    </VStack>
  );
}

/** A settled call: its failure or its output, then the activity line once it has stopped. */
function CallSettled({ call, activity }: { call: TheoremHostCall; activity: ReactNode }) {
  const state = call.call?.state;
  const failure = hostCallFailure(call);
  return (
    <Stream>
      <VStack gap={3}>
        {failure ? (
          <Arrive>
            <Banner status="error" title={failure.title} description={failure.description} />
          </Arrive>
        ) : null}
        {state?.phase === 'complete' ? (
          <ToolResult output={state.output} parts={state.parts} />
        ) : null}
        {call.isRunning ? null : <Arrive>{activity}</Arrive>}
      </VStack>
    </Stream>
  );
}

/** One call's outcome: its gate, its failure, or its output, then the tool's activity and the time. */
function CallOutcome({
  call,
  onAnswer,
}: {
  call: TheoremHostCall;
  onAnswer: ReturnType<typeof useTheoremHost>['answer'];
}) {
  const t = useLabels();
  const now = useSecondTicker(call.isRunning);
  const { label, duration } = callActivity(t, call, now);
  if (responseFills(call)) return <CallWaiting label={label} duration={duration} />;
  const activity = (
    <Text size="sm" color="secondary">
      {duration ? `${label} ${duration}` : label}
    </Text>
  );
  return (
    <VStack gap={3}>
      <CallGate call={call} onAnswer={onAnswer} />
      {callSettled(call) ? <CallSettled call={call} activity={activity} /> : null}
    </VStack>
  );
}

/** This page's earlier calls, newest first; picking one shows it again with its request. */
function EarlierCalls({
  calls,
  onPick,
}: {
  calls: readonly TheoremHostCall[];
  onPick: (call: TheoremHostCall) => void;
}) {
  const t = useLabels();
  const locale = useLocale();
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }), [locale]);
  if (calls.length === 0) return null;
  return (
    <VStack gap={1}>
      <Text type="supporting" color="secondary" as="h3">
        {t('@theorem.host.earlier')}
      </Text>
      <List hasDividers density="compact">
        {calls.slice(0, MAX_EARLIER).map((call) => {
          const status = hostCallStatus(call);
          return (
            <ListItem
              key={call.id}
              label={call.name}
              startContent={
                <StatusDot
                  variant={STATUS_DOT[status]}
                  label={t(`@theorem.host.status.${status}`)}
                  isPulsing={call.isRunning}
                />
              }
              endContent={
                <Text type="supporting" color="secondary" hasTabularNumbers>
                  {time.format(call.startedAt)}
                </Text>
              }
              onClick={() => onPick(call)}
            />
          );
        })}
      </List>
    </VStack>
  );
}

type ToolRequestProps = {
  tools: readonly HostToolView[];
  tool: HostToolView;
  check: RequestCheck;
  text: string;
  view: ConsoleView;
  shown: TheoremHostCall | null;
  onText: (next: string) => void;
  onPick: (name: string) => void;
  onView: (next: ConsoleView) => void;
  onRun: () => void;
  onStop: (id: string) => void;
};

/** The picked tool's request, as fields or JSON, and Run. */
function ToolRequest({
  tools,
  tool,
  check,
  text,
  view,
  shown,
  onText,
  onPick,
  onView,
  onRun,
  onStop,
}: ToolRequestProps) {
  const t = useLabels();
  const fieldsInput = 'input' in check ? check.input : undefined;
  const showFields = view === 'fields' && fieldsInput !== undefined;
  return (
    <RequestCard
      title={t('@theorem.host.request')}
      view={showFields ? 'fields' : 'json'}
      hasFields={fieldsInput !== undefined}
      onView={onView}
      onRun={onRun}
    >
      <VStack gap={2}>
        <Selector
          label={t('@theorem.host.tool')}
          size="sm"
          options={tools.map((option) => ({
            value: option.name,
            label: option.name,
            icon: KIND_ICON[option.kind],
            description: toolOptionDescription(t, option),
          }))}
          value={tool.name}
          hasSearch={tools.length > 8}
          onChange={onPick}
        />
        <ToolTokens tool={tool} />
      </VStack>
      {showFields ? (
        <SchemaFields
          // why: A new tool starts a new form, so inputs don't carry state across schemas.
          key={tool.name}
          schema={tool.inputSchema}
          value={fieldsInput}
          onChange={(next) => {
            onText(json(next));
          }}
        />
      ) : (
        <JsonRequest
          label={t('@theorem.host.request')}
          text={text}
          isInvalid={fieldsInput === undefined}
          onChange={onText}
        />
      )}
      <RunBar
        note={check.ok ? t('@theorem.host.shortcut') : check.note}
        isReady={check.ok}
        isRunning={shown?.isRunning === true}
        runLabel={t('@theorem.host.run')}
        runningLabel={t('@theorem.host.running')}
        stopLabel={t('@theorem.host.stop')}
        onRun={onRun}
        onStop={() => {
          if (shown) onStop(shown.id);
        }}
      />
    </RequestCard>
  );
}

type BodyProps = Omit<
  TheoremHostProps,
  'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels'
> & {
  transport: HostTransport;
  iface: HostInterface;
  host: ReturnType<typeof useTheoremHost>;
};

type Host = BodyProps['host'];

/** Starts the request as a call, and returns its id. Nothing starts while one is on screen running. */
function startCall(
  host: Host,
  tool: HostToolView | undefined,
  check: RequestCheck | null,
  shown: TheoremHostCall | null,
): string | null {
  if (!tool || !check?.ok || shown?.isRunning) return null;
  return host.run(tool.name, check.input);
}

/** What the console is showing: the picked tool, its request, and the call on screen. */
function useHostConsole(iface: HostInterface, host: Host) {
  const t = useLabels();
  const [picked, setPicked] = useState(iface.tools[0]?.name);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [shownId, setShownId] = useState<string | null>(null);
  const [view, setView] = useState<ConsoleView>('fields');
  const { tool, text, shown, earlier } = hostConsoleView({
    tools: iface.tools,
    picked,
    drafts,
    calls: host.calls,
    shownId,
  });
  const check = tool ? checkRequest(t, tool, text) : null;

  const setText = (next: string) => {
    if (tool) setDrafts((previous) => ({ ...previous, [tool.name]: next }));
  };
  const run = () => {
    const id = startCall(host, tool, check, shown);
    if (id !== null) setShownId(id);
  };
  const pick = (call: TheoremHostCall) => {
    setPicked(call.name);
    setDrafts((previous) => ({ ...previous, [call.name]: json(call.input) }));
    setShownId(call.id);
  };
  return { tool, text, shown, earlier, check, view, setView, setPicked, setText, run, pick };
}

/** The call on screen, then this page's earlier ones. */
function HostCalls({
  shown,
  earlier,
  onAnswer,
  onPick,
}: {
  shown: TheoremHostCall | null;
  earlier: readonly TheoremHostCall[];
  onAnswer: Host['answer'];
  onPick: (call: TheoremHostCall) => void;
}) {
  return (
    <>
      {shown ? <CallOutcome call={shown} onAnswer={onAnswer} /> : null}
      <EarlierCalls calls={earlier} onPick={onPick} />
    </>
  );
}

/**
 * The frame's second child. A call, not a component: the frame counts its
 * children to choose a layout, and no calls yet has to count as none.
 */
function hostResponse(
  columns: boolean,
  label: string,
  shown: TheoremHostCall | null,
  earlier: readonly TheoremHostCall[],
  calls: ReactNode,
): ReactNode {
  if (!columns) return calls;
  const alone = earlier.length === 0;
  if (!shown && alone) return null;
  return (
    <ResponseColumn label={label} fill={shown != null && responseFills(shown) && alone}>
      {calls}
    </ResponseColumn>
  );
}

function HostBody({
  transport,
  iface,
  host,
  maxWidth = '960px',
  trace,
  flush,
  columns = false,
  className,
  style,
}: BodyProps) {
  const t = useLabels();
  const inspector = useTraceInspector(iface, transport.traces, trace);
  const desk = useHostConsole(iface, host);
  const { tool, check, shown, earlier } = desk;

  return (
    <ConsoleFrame
      inspector={inspector}
      maxWidth={maxWidth}
      flush={flush}
      columns={columns}
      requestLabel={t('@theorem.host.request')}
      className={className}
      style={style}
    >
      {tool && check ? (
        <ToolRequest
          tools={iface.tools}
          tool={tool}
          check={check}
          text={desk.text}
          view={desk.view}
          shown={shown}
          onText={desk.setText}
          onPick={desk.setPicked}
          onView={desk.setView}
          onRun={desk.run}
          onStop={host.cancel}
        />
      ) : (
        <EmptyState title={t('@theorem.host.no_tools')} />
      )}
      {hostResponse(
        columns,
        t('@theorem.host.response'),
        shown,
        earlier,
        <HostCalls shown={shown} earlier={earlier} onAnswer={host.answer} onPick={desk.pick} />,
      )}
    </ConsoleFrame>
  );
}

function HostForTransport(props: Omit<BodyProps, 'iface' | 'host'>) {
  const t = useLabels();
  const host = useTheoremHost(props.transport);
  if (host.describeFailure) return <Banner status="error" title={host.describeFailure.error} />;
  if (!host.iface) return <Spinner size="lg" label={t('@theorem.chat.loading')} />;
  return <HostBody {...props} iface={host.iface} host={host} />;
}

/**
 * Drop-in console for a host profile served by `createTheoremHostHandler`:
 * pick a tool, fill in the request its input schema draws, Run (⌘/Ctrl+Enter),
 * and read the response laid out from what it returned — figures, charts,
 * images, and the data itself. Gates are answered in place.
 *
 * ```tsx
 * <TheoremHost endpoint="/api/host" />
 * ```
 */
export function TheoremHost({
  endpoint,
  http,
  transport,
  theme,
  mode,
  labels,
  ...rest
}: TheoremHostProps) {
  const httpRef = useRef(http);
  httpRef.current = http;
  const resolved = useMemo(
    () => transport ?? createHostTransport({ ...httpRef.current, endpoint }),
    [transport, endpoint],
  );
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <HostForTransport {...rest} transport={resolved} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
