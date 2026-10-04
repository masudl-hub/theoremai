import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot, type StatusDotVariant } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useLocale } from '@astryxdesign/core/i18n';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { type CSSProperties, useMemo, useState } from 'react';
import { type HostCallStatus, hostCallFailure, hostCallStatus, hostConsoleView } from '../client/host-call.ts';
import { createHostTransport, type HostInterface, type HostToolView, type HostTransport } from '../client/host-transport.ts';
import { missingFields } from '../client/schema-fields.ts';
import { isRow, json } from '../client/shaped-data.ts';
import type { HttpOptions } from '../client/transport.ts';
import { type TheoremHostCall, useTheoremHost } from '../hooks/use-theorem-host.ts';
import { type LabelText, type TheoremLabels, workDuration } from './labels.ts';
import { ConsoleFrame, type ConsoleView, JsonRequest, RequestCard, RunBar } from './ConsoleFrame.tsx';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { SchemaFields } from './SchemaFields.tsx';
import { TheoremThemeProvider } from './theme.tsx';
import { ApprovalCard, AuthChallengeCard } from './ToolGateCard.tsx';
import { ToolResult } from './ToolResult.tsx';
import { useTraceInspector } from './TraceInspectorPanel.tsx';

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
	 * Show the trace in place of the console, from the host's own control; the
	 * built-in trace toggle then hides. Omit to keep the toggle. Needs a profile
	 * that records traces.
	 */
	trace?: boolean;
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

type RequestCheck = { ok: true; input: Record<string, unknown> } | { ok: false; note: string; input?: Record<string, unknown> };

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
	if (missing.length > 0) return { ok: false, note: t('@theorem.host.missing', { fields: missing.join(', ') }), input };
	return { ok: true, input };
}

/** A tool's kind, and its access when it can change things. */
function ToolTokens({ tool }: { tool: HostToolView }) {
	const t = useLabels();
	return (
		<HStack gap={1} wrap="wrap">
			<Token label={t(`@theorem.host.kind.${tool.kind}`)} size="sm" color="gray" />
			{tool.access === 'read-only' ? null : (
				<Token label={t(`@theorem.tool.access.${tool.access}`)} size="sm" color={tool.access === 'destructive' ? 'red' : 'orange'} />
			)}
		</HStack>
	);
}

/** The gate a call paused on, answered in place. */
function CallGate({ call, onAnswer }: { call: TheoremHostCall; onAnswer: ReturnType<typeof useTheoremHost>['answer'] }) {
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

/** One call's outcome: its gate, its failure, or its output, then a line for the tool, time, and status. */
function CallOutcome({ call, onAnswer }: { call: TheoremHostCall; onAnswer: ReturnType<typeof useTheoremHost>['answer'] }) {
	const t = useLabels();
	const state = call.call?.state;
	const failure = hostCallFailure(call);
	const meta = [call.name, call.elapsedMs == null ? null : workDuration(t, call.elapsedMs), t(`@theorem.host.status.${hostCallStatus(call)}`)].filter(Boolean);
	return (
		<VStack gap={3}>
			<CallGate call={call} onAnswer={onAnswer} />
			{failure ? <Banner status="error" title={failure.title} description={failure.description} /> : null}
			{state?.phase === 'complete' ? <ToolResult output={state.output} parts={state.parts} /> : null}
			{call.isRunning ? null : (
				<Text type="supporting" color="secondary" hasTabularNumbers>
					{meta.join(' · ')}
				</Text>
			)}
		</VStack>
	);
}

/** This page's earlier calls, newest first; picking one shows it again with its request. */
function EarlierCalls({ calls, onPick }: { calls: readonly TheoremHostCall[]; onPick: (call: TheoremHostCall) => void }) {
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
							startContent={<StatusDot variant={STATUS_DOT[status]} label={t(`@theorem.host.status.${status}`)} isPulsing={call.isRunning} />}
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
function ToolRequest({ tools, tool, check, text, view, shown, onText, onPick, onView, onRun, onStop }: ToolRequestProps) {
	const t = useLabels();
	const fieldsInput = 'input' in check ? check.input : undefined;
	const showFields = view === 'fields' && fieldsInput !== undefined;
	return (
		<RequestCard title={t('@theorem.host.request')} view={showFields ? 'fields' : 'json'} hasFields={fieldsInput !== undefined} onView={onView} onRun={onRun}>
			<VStack gap={2}>
				<Selector
					label={t('@theorem.host.tool')}
					size="sm"
					options={tools.map((option) => ({ value: option.name, label: option.name, description: option.description }))}
					value={tool.name}
					hasSearch={tools.length > 8}
					description={tool.description}
					onChange={onPick}
				/>
				<ToolTokens tool={tool} />
			</VStack>
			{showFields ? (
				<SchemaFields
					// A new tool starts a new form, so inputs don't carry state across schemas.
					key={tool.name}
					schema={tool.inputSchema}
					value={fieldsInput}
					onChange={(next) => {
						onText(json(next));
					}}
				/>
			) : (
				<JsonRequest label={t('@theorem.host.request')} text={text} isInvalid={fieldsInput === undefined} onChange={onText} />
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

type BodyProps = Omit<TheoremHostProps, 'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels'> & {
	transport: HostTransport;
	iface: HostInterface;
	host: ReturnType<typeof useTheoremHost>;
};

function HostBody({ transport, iface, host, maxWidth = '960px', trace, className, style }: BodyProps) {
	const t = useLabels();
	const [picked, setPicked] = useState(iface.tools[0]?.name);
	// Each tool keeps its own request while you move between them.
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [shownId, setShownId] = useState<string | null>(null);
	const [view, setView] = useState<ConsoleView>('fields');
	const inspector = useTraceInspector(iface, transport.traces, trace);
	const { tool, text, shown, earlier } = hostConsoleView({ tools: iface.tools, picked, drafts, calls: host.calls, shownId });
	const check = tool ? checkRequest(t, tool, text) : null;

	const setText = (next: string) => {
		if (tool) setDrafts((previous) => ({ ...previous, [tool.name]: next }));
	};
	const run = () => {
		if (tool && check?.ok && !shown?.isRunning) setShownId(host.run(tool.name, check.input));
	};
	const pick = (call: TheoremHostCall) => {
		setPicked(call.name);
		setDrafts((previous) => ({ ...previous, [call.name]: json(call.input) }));
		setShownId(call.id);
	};

	return (
		<ConsoleFrame inspector={inspector} maxWidth={maxWidth} className={className} style={style}>
			{tool && check ? (
				<ToolRequest
					tools={iface.tools}
					tool={tool}
					check={check}
					text={text}
					view={view}
					shown={shown}
					onText={setText}
					onPick={setPicked}
					onView={setView}
					onRun={run}
					onStop={host.cancel}
				/>
			) : (
				<EmptyState title={t('@theorem.host.no_tools')} />
			)}
			{shown ? <CallOutcome call={shown} onAnswer={host.answer} /> : null}
			<EarlierCalls calls={earlier} onPick={pick} />
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
export function TheoremHost({ endpoint, http, transport, theme, mode, labels, ...rest }: TheoremHostProps) {
	const resolved = useMemo(
		() => transport ?? createHostTransport({ ...http, endpoint }),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `http` identity is caller-owned; endpoint drives reconnection.
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
