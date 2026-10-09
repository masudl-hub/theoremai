import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Item } from '@astryxdesign/core/Item';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
	IconArrowLeft,
	IconBiohazard,
	IconBraces,
	IconBrain,
	IconEye,
	IconEyeOff,
	IconFileText,
	IconHandStop,
	IconHistory,
	IconInfoCircle,
	IconListDetails,
	IconMessage,
	IconPlaylistAdd,
	IconShield,
	IconShieldSearch,
	IconTool,
	IconUser,
	IconWorld,
	IconX,
} from '@tabler/icons-react';
import { PaneLayout, PanePanel, Prose, TraceGuardrailsView } from '../../react/src/ui/index.ts';
import {
	type GuardrailProbeAnswer,
	PROBE_BATTERY,
	PROBE_BOUNDARY_NOTES,
	PROBE_STATUSES,
	type ProbeBatteryCase,
	type ProbeBoundary,
	type ProbeStatus,
	probeDraft,
	probeRefusal,
	type StudioRunPayload,
	sectionNote,
} from '../mod.ts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { InspectorSection } from './inspector.tsx';

const BOUNDARY_ICONS: Record<ProbeBoundary, typeof IconUser> = {
	user: IconUser,
	history: IconHistory,
	system: IconFileText,
	tool_result_local: IconTool,
	tool_result_remote: IconWorld,
	tool_arguments: IconBraces,
	reply: IconMessage,
	thought: IconBrain,
};

/** One text sent, and what came back: each boundary's answer, or why there is none. */
type Sent = {
	id: number;
	text: string;
	answers?: GuardrailProbeAnswer[];
	error?: string;
};

type Outcome = Pick<Sent, 'answers' | 'error'>;

/** Sends `text` across the draft's boundaries; given `only`, read with that detector alone. */
async function sendProbe(payload: StudioRunPayload, text: string, only?: string): Promise<Outcome> {
	try {
		const response = await fetch('/api/studio/probe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...probeDraft(payload), text, only }),
		});
		const body = await response.json<{ answers: GuardrailProbeAnswer[] } | { error?: string }>();
		if (response.ok && 'answers' in body) return { answers: body.answers };
		return { error: ('error' in body && body.error) || "The probe didn't run." };
	} catch {
		return { error: "Couldn't reach the studio server." };
	}
}

/** A status as its token: the label, colour and icon the trace's guardrail checks wear. */
const STATUS_TOKENS: Record<
	ProbeStatus,
	{ label: string; color: 'green' | 'blue' | 'orange' | 'red'; icon: typeof IconEye }
> = {
	passed: { label: 'Passed', color: 'green', icon: IconEye },
	flagged: { label: 'Flagged', color: 'blue', icon: IconInfoCircle },
	redacted: { label: 'Redacted', color: 'orange', icon: IconEyeOff },
	blocked: { label: 'Blocked', color: 'red', icon: IconHandStop },
};

function StatusToken({ status, count }: { status: ProbeStatus; count?: number }) {
	const { label, color, icon } = STATUS_TOKENS[status];
	return (
		<Token
			label={count === undefined ? label : `${label} ${String(count)}`}
			color={color}
			icon={<Icon icon={icon} size="sm" />}
		/>
	);
}

/** What one boundary's guardrails did, and whether its turn was tainted by what it read. */
function Verdict({ answer }: { answer: GuardrailProbeAnswer }) {
	return (
		<HStack gap={1} wrap="wrap">
			<StatusToken status={answer.status} />
			{answer.taint && (
				<Token
					label={answer.taint === 'steered' ? 'Steered' : 'Tainted'}
					color="yellow"
					icon={<Icon icon={IconBiohazard} size="sm" />}
				/>
			)}
		</HStack>
	);
}

/** A sent text's answers in short: how many boundaries did each thing, strongest first. */
function Tally({ sent }: { sent: Sent }) {
	const { answers } = sent;
	if (!answers) return <Token label={sent.error ?? ''} color="gray" />;
	return (
		<HStack gap={1} wrap="wrap">
			{PROBE_STATUSES.toReversed().map((status) => {
				const count = answers.filter((answer) => answer.status === status).length;
				return count > 0 && <StatusToken key={status} status={status} count={count} />;
			})}
		</HStack>
	);
}

/** Who reads the text once it is past `boundary`. */
function passedLabel(boundary: ProbeBoundary): string {
	if (boundary === 'reply' || boundary === 'thought') return 'The user got';
	return boundary === 'tool_arguments' ? 'The tool got' : 'The model read';
}

/**
 * A boundary on hover, as the editor's field labels show a field: what crosses it, then when the
 * kernel reads it and what the kernel does there.
 */
function BoundaryCard({ boundary, children }: { boundary: ProbeBoundary; children: ReactNode }) {
	const { label, note, when, checks } = PROBE_BOUNDARY_NOTES[boundary];
	return (
		<HoverCard
			label={label}
			content={
				<VStack gap={2} maxWidth={280}>
					<Text>{note}</Text>
					<HStack gap={1} wrap="wrap">
						<Token label={label} size="sm" />
					</HStack>
					<Text color="secondary">{when}</Text>
					<Text color="secondary">{checks}</Text>
				</VStack>
			}
		>
			{children}
		</HoverCard>
	);
}

/** A rule id as a phrase: `detect.injection` reads "Injection". */
function ruleName(rule: string): string {
	const name = (rule.split('.').at(-1) ?? rule).replaceAll(/[_-]/g, ' ');
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What exactly the guardrails matched, each hit with the text it matched and what was done with it. */
function Flagged({ answer }: { answer: GuardrailProbeAnswer }) {
	const hits = answer.guardrails.flatMap((event) =>
		event.hits.map((hit) => ({ hit, action: event.action })),
	);
	if (hits.length === 0) return null;
	return (
		<PanePanel title="Matched">
			<VStack gap={3}>
				{hits.map(({ hit, action }, at) => (
					<VStack key={`${hit.rule}-${String(at)}`} gap={1}>
						<HStack gap={2} align="center" wrap="wrap">
							<Text weight="medium">{hit.label ?? ruleName(hit.rule)}</Text>
							<Token label={hit.severity} size="sm" color="gray" />
							<Token label={action} size="sm" color="gray" />
						</HStack>
						{hit.match !== undefined && (
							<Text type="supporting" color="secondary">
								{`“${hit.match}”`}
							</Text>
						)}
					</VStack>
				))}
			</VStack>
		</PanePanel>
	);
}

/** The text past its boundary, when anything went on. */
function Crossed({ answer }: { answer: GuardrailProbeAnswer }) {
	if (answer.passed === undefined) return null;
	return (
		<PanePanel title={passedLabel(answer.boundary)}>
			<Prose text={answer.passed} />
		</PanePanel>
	);
}

/** The way out of a view: back to the tester, or closing it when it opened on its own. */
function BackButton({ isClose, onBack }: { isClose: boolean; onBack: () => void }) {
	return (
		<HStack>
			<Button
				label={isClose ? 'Close' : 'Back'}
				variant="ghost"
				size="sm"
				icon={<Icon icon={isClose ? IconX : IconArrowLeft} />}
				onClick={onBack}
			/>
		</HStack>
	);
}

/** A battery case: what it is and what makes it hard. */
function BatteryRow({
	entry,
	isDisabled,
	onSend,
}: {
	entry: ProbeBatteryCase;
	isDisabled: boolean;
	onSend: () => void;
}) {
	return (
		<Item
			startContent={<Icon icon={BOUNDARY_ICONS[entry.boundary]} size="sm" color="secondary" />}
			label={
				<Text weight="medium" maxLines={1}>
					{entry.title}
				</Text>
			}
			description={
				<Text type="supporting" color="secondary" maxLines={2}>
					{entry.why}
				</Text>
			}
			align="start"
			density="compact"
			isDisabled={isDisabled}
			onClick={onSend}
		/>
	);
}

/** The examples in the row: one hard text from each kind of boundary. */
const ROW_EXAMPLES = [
	'user.zero_width',
	'user.split_key',
	'tool_result_remote.approved',
	'tool_arguments.base64_key',
	'reply.image_reference',
].flatMap((id) => PROBE_BATTERY.filter((entry) => entry.id === id));

/** The battery as a row of tokens to scroll through, one click to send one; and the ways to all of them. */
function ExampleRow({
	isShown,
	isDisabled,
	onShow,
	onSend,
}: {
	isShown: boolean;
	isDisabled: boolean;
	onShow: () => void;
	onSend: (texts: readonly string[]) => void;
}) {
	return (
		<HStack gap={2} align="center">
			<StackItem size="fill">
				<ScrollableArea label="Examples" axis="inline" className="scrollbar-none">
					<HStack gap={1}>
						{ROW_EXAMPLES.map((entry) => (
							<Token
								key={entry.id}
								label={entry.title}
								size="sm"
								description={entry.why}
								isDisabled={isDisabled}
								onClick={() => {
									onSend([entry.text]);
								}}
							/>
						))}
					</HStack>
				</ScrollableArea>
			</StackItem>
			<StackItem size="static">
				<HStack gap={1}>
					<IconButton
						label={isShown ? 'Hide all examples' : 'Show all examples'}
						tooltip={isShown ? 'Hide all examples' : 'Show all examples'}
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconListDetails} size="sm" />}
						aria-pressed={isShown}
						onClick={onShow}
					/>
					<IconButton
						label="Load all examples"
						tooltip="Load all examples"
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconPlaylistAdd} size="sm" />}
						isDisabled={isDisabled}
						onClick={() => {
							onSend(PROBE_BATTERY.map((entry) => entry.text));
						}}
					/>
				</HStack>
			</StackItem>
		</HStack>
	);
}

/** The battery's texts, beside the results or in their place; one click sends one. */
function Examples({
	isClose,
	isDisabled,
	onBack,
	onSend,
}: {
	isClose: boolean;
	isDisabled: boolean;
	onBack: () => void;
	onSend: (texts: readonly string[]) => void;
}) {
	return (
		<VStack padding={4}>
			<VStack gap={4}>
				<VStack gap={2}>
					<BackButton isClose={isClose} onBack={onBack} />
					<Item
						startContent={<Icon icon={IconShieldSearch} size="sm" color="secondary" />}
						label={<Text weight="semibold">Examples</Text>}
						align="start"
					/>
				</VStack>
				<VStack gap={0}>
					{PROBE_BATTERY.map((entry) => (
						<BatteryRow
							key={entry.id}
							entry={entry}
							isDisabled={isDisabled}
							onSend={() => {
								onSend([entry.text]);
							}}
						/>
					))}
				</VStack>
			</VStack>
		</VStack>
	);
}

/** A row of the sent list: the text and its answers in short. */
function SentRow({ sent, onOpen }: { sent: Sent; onOpen: () => void }) {
	return (
		<Item
			startContent={<Icon icon={IconShield} size="sm" color="secondary" />}
			label={
				<Text weight="medium" maxLines={1}>
					{sent.text}
				</Text>
			}
			description={<Tally sent={sent} />}
			align="start"
			density="compact"
			onClick={onOpen}
		/>
	);
}

/** A boundary of an open text: where it went in and what the guardrails did there. */
function AnswerRow({ answer, onOpen }: { answer: GuardrailProbeAnswer; onOpen: () => void }) {
	return (
		<Item
			startContent={<Icon icon={BOUNDARY_ICONS[answer.boundary]} size="sm" color="secondary" />}
			label={
				<BoundaryCard boundary={answer.boundary}>
					<Text weight="medium">{PROBE_BOUNDARY_NOTES[answer.boundary].label}</Text>
				</BoundaryCard>
			}
			endContent={<Verdict answer={answer} />}
			density="compact"
			onClick={onOpen}
		/>
	);
}

/** An open text: the way back, the text as sent, and each boundary's answer. */
function SentOverview({
	sent,
	onBack,
	onOpen,
}: {
	sent: Sent;
	onBack: () => void;
	onOpen: (boundary: ProbeBoundary) => void;
}) {
	return (
		<VStack gap={5} padding={4}>
			<VStack gap={4}>
				<HStack>
					<Button
						label="All probes"
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconArrowLeft} />}
						onClick={onBack}
					/>
				</HStack>
				{sent.error && <Banner status="error" title={sent.error} />}
				<PanePanel title="Sent">
					<Prose text={sent.text} />
				</PanePanel>
			</VStack>
			{sent.answers && (
				<VStack gap={2}>
					<Text weight="semibold">Boundaries</Text>
					<VStack gap={0}>
						{sent.answers.map((answer) => (
							<AnswerRow
								key={answer.boundary}
								answer={answer}
								onOpen={() => {
									onOpen(answer.boundary);
								}}
							/>
						))}
					</VStack>
				</VStack>
			)}
		</VStack>
	);
}

/** What leads one boundary's answer: the way back, the boundary and its answer, and what got through. */
function AnswerHead({
	answer,
	isClose,
	onBack,
}: {
	answer: GuardrailProbeAnswer;
	isClose: boolean;
	onBack: () => void;
}) {
	const { label, checks } = PROBE_BOUNDARY_NOTES[answer.boundary];
	return (
		<VStack gap={4}>
			<VStack gap={2}>
				<BackButton isClose={isClose} onBack={onBack} />
				<Item
					startContent={<Icon icon={BOUNDARY_ICONS[answer.boundary]} size="sm" color="secondary" />}
					label={<Text weight="semibold">{label}</Text>}
					description={checks}
					align="start"
				/>
				<Verdict answer={answer} />
				{answer.refused?.message && <Text color="secondary">{answer.refused.message}</Text>}
			</VStack>
			<Flagged answer={answer} />
			<Crossed answer={answer} />
		</VStack>
	);
}

/**
 * Sends texts across every guardrail boundary of the compiled agent and lists what its guardrails
 * did with each, newest first. A sent text opens on its boundaries, and a boundary on what its
 * trace says of guardrails. The model is scripted, so a probe spends no key.
 */
export function GuardrailTester({
	payload,
	isWide,
}: {
	payload: StudioRunPayload;
	isWide: boolean;
}) {
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState<Sent[]>([]);
	const [openId, setOpenId] = useState<number | null>(null);
	const [boundary, setBoundary] = useState<ProbeBoundary | null>(null);
	const [examples, setExamples] = useState(false);
	const refusal = probeRefusal(payload.profile);
	if (refusal) {
		return (
			<VStack height="100%" vAlign="center" padding={4}>
				<EmptyState
					icon={<Icon icon={IconShieldSearch} size="lg" color="secondary" />}
					title={refusal}
					isCompact
				/>
			</VStack>
		);
	}
	const send = async (texts: readonly string[]) => {
		if (busy) return;
		setBusy(true);
		for (const each of texts) {
			const outcome = await sendProbe(payload, each);
			setSent((before) => [{ id: before.length, text: each, ...outcome }, ...before]);
		}
		setBusy(false);
	};
	const open = sent.find((entry) => entry.id === openId);
	if (open) {
		const answer = open.answers?.find((candidate) => candidate.boundary === boundary);
		return (
			<PaneLayout
				isWide={isWide}
				label="Test guardrails"
				detailLabel={answer ? PROBE_BOUNDARY_NOTES[answer.boundary].label : ''}
				overview={
					<SentOverview
						sent={open}
						onBack={() => {
							setOpenId(null);
							setBoundary(null);
						}}
						onOpen={setBoundary}
					/>
				}
				detail={
					answer && (
						<TraceGuardrailsView
							records={answer.traces}
							head={
								<AnswerHead
									answer={answer}
									isClose={isWide}
									onBack={() => {
										setBoundary(null);
									}}
								/>
							}
						/>
					)
				}
			/>
		);
	}
	const probe = text.trim();
	const overview = (
		<VStack gap={5} padding={4}>
			<Text weight="semibold">Test guardrails</Text>
			<VStack gap={3}>
				<ExampleRow
					isShown={examples}
					isDisabled={busy}
					onShow={() => {
						setExamples(!examples);
					}}
					onSend={(texts) => {
						void send(texts);
					}}
				/>
				<TextArea
					label="Text"
					isLabelHidden
					size="sm"
					rows={3}
					placeholder="Sent across every boundary"
					value={text}
					onChange={setText}
				/>
				<HStack hAlign="end">
					<Button
						label="Send"
						variant="primary"
						isLoading={busy}
						isDisabled={!probe}
						onClick={() => {
							void send([probe]);
						}}
					/>
				</HStack>
			</VStack>
			{sent.length > 0 && (
				<VStack gap={2}>
					<Text weight="semibold">Sent</Text>
					<VStack gap={0}>
						{sent.map((entry) => (
							<SentRow
								key={entry.id}
								sent={entry}
								onOpen={() => {
									setOpenId(entry.id);
								}}
							/>
						))}
					</VStack>
				</VStack>
			)}
		</VStack>
	);
	return (
		<PaneLayout
			isWide={isWide}
			label="Test guardrails"
			detailLabel="Examples"
			overview={overview}
			detail={
				examples && (
					<Examples
						isClose={isWide}
						isDisabled={busy}
						onBack={() => {
							setExamples(false);
						}}
						onSend={(texts) => {
							// Narrow, the examples sit over the results: sending one shows them again.
							if (!isWide) setExamples(false);
							void send(texts);
						}}
					/>
				)
			}
		/>
	);
}

/**
 * The agent the editor has open, as it compiles now: what a detector's page sends its sample to.
 * Null while the draft has issues.
 */
export const ProbedAgent = createContext<StudioRunPayload | null>(null);

/** A sample sent, the draft it was sent to and what came back. */
type Tried = Outcome & { payload: StudioRunPayload; text: string };

/** Why a sample can't be sent to `payload` yet, or undefined when it can. */
function unsendable(payload: StudioRunPayload | null): string | undefined {
	return payload ? probeRefusal(payload.profile) : 'Fix the issues first';
}

/** One detector's answers: each boundary it reads, and behind it what the trace says and what crossed. */
function ScopedAnswers({ answers }: { answers: readonly GuardrailProbeAnswer[] }) {
	if (answers.length === 0) {
		return (
			<Text type="supporting" color="secondary">
				{sectionNote('detect.try.off')}
			</Text>
		);
	}
	return (
		<CollapsibleGroup type="multiple" density="compact">
			{answers.map((answer) => (
				<Collapsible
					key={answer.boundary}
					value={answer.boundary}
					trigger={
						<HStack gap={2} align="center" justify="between">
							<HStack gap={2} align="center">
								<Icon icon={BOUNDARY_ICONS[answer.boundary]} size="sm" color="secondary" />
								<BoundaryCard boundary={answer.boundary}>
									<Text type="supporting">{PROBE_BOUNDARY_NOTES[answer.boundary].label}</Text>
								</BoundaryCard>
							</HStack>
							<Verdict answer={answer} />
						</HStack>
					}
				>
					<TraceGuardrailsView
						records={answer.traces}
						head={
							<VStack gap={4}>
								<Flagged answer={answer} />
								<Crossed answer={answer} />
							</VStack>
						}
					/>
				</Collapsible>
			))}
		</CollapsibleGroup>
	);
}

/**
 * The tester from a detector's page: the same probe of the open agent, read with the detector
 * `only` alone. An answer shows for the sample and the draft it was sent with, and goes when
 * either changes.
 */
export function DetectorTester({ only }: { only: string }) {
	const payload = useContext(ProbedAgent);
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState<Tried | null>(null);
	const probe = text.trim();
	const blocked = unsendable(payload);
	const shown = tried && tried.payload === payload && tried.text === probe ? tried : null;
	const send = async () => {
		if (!payload || busy) return;
		setBusy(true);
		const outcome = await sendProbe(payload, probe, only);
		setTried({ payload, text: probe, ...outcome });
		setBusy(false);
	};
	const button = (
		<Button
			label="Send"
			size="sm"
			isLoading={busy}
			isDisabled={!probe || blocked !== undefined}
			onClick={() => {
				void send();
			}}
		/>
	);
	return (
		<InspectorSection title="Try it" note={sectionNote('detect.try')}>
			<TextArea
				label="Sample text"
				isLabelHidden
				size="sm"
				rows={3}
				placeholder="Sent across each boundary this detector reads"
				value={text}
				onChange={setText}
			/>
			<HStack hAlign="end">
				{blocked ? <Tooltip content={blocked}>{button}</Tooltip> : button}
			</HStack>
			{shown?.error && <Banner status="error" title={shown.error} />}
			{shown?.answers && <ScopedAnswers answers={shown.answers} />}
		</InspectorSection>
	);
}
