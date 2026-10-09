import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { ComplexSelector } from '@astryxdesign/core/ComplexSelector';
import { FileInput } from '@astryxdesign/core/FileInput';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { pixel, proportional, Table } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
	IconAbc,
	IconAdjustmentsHorizontal,
	IconAlertTriangle,
	IconAlignLeft,
	IconAntennaBars1,
	IconAntennaBars2,
	IconAntennaBars3,
	IconAntennaBars4,
	IconAntennaBars5,
	IconAntennaBarsOff,
	IconArrowDown,
	IconArrowLeft,
	IconArrowUp,
	IconBan,
	IconBandage,
	IconBiohazard,
	IconBolt,
	IconBraces,
	IconBulb,
	IconBulbOff,
	IconCertificate,
	IconChartBar,
	IconChevronRight,
	IconCircleDashed,
	IconDatabase,
	IconDatabaseOff,
	IconDeviceDesktop,
	IconEraser,
	IconEye,
	IconEyeOff,
	IconFeather,
	IconFlag,
	IconFlame,
	IconFlask,
	IconGauge,
	IconGitBranch,
	IconHandOff,
	IconHandStop,
	IconHeadset,
	IconHourglass,
	IconHttpDelete,
	IconHttpGet,
	IconHttpPatch,
	IconHttpPost,
	IconHttpPut,
	IconInfoCircle,
	IconInputAi,
	IconKey,
	IconLayersUnion,
	IconLetterT,
	IconLink,
	IconListCheck,
	IconLockOpen,
	IconMathFunction,
	IconMessage,
	IconMessageForward,
	IconMicrophone,
	IconNumber,
	IconPackage,
	IconPaperclip,
	IconPencil,
	IconPhoto,
	IconPlayerPause,
	IconPlayerPlay,
	IconPlayerTrackNext,
	IconPlugConnected,
	IconPlus,
	IconRefresh,
	IconRegex,
	IconSearch,
	IconSend,
	IconServer,
	IconShieldLock,
	IconShieldOff,
	IconSquareRoundedNumber0,
	IconSquareRoundedNumber2,
	IconTool,
	IconTrash,
	IconUser,
	IconUserCheck,
	IconVolume,
	IconWaveSine,
	IconWorld,
	IconWriting,
	IconX,
} from '@tabler/icons-react';
import {
	ATTACHMENT_ACCEPT_MIMES,
	type AuthUnauthenticatedPolicy,
	type BlockedReplyOnBlock,
	CONTINUE_STOP_KINDS,
	type ContinueStopKind,
	type CustomToolType,
	fieldMeta,
	GOOGLE_BUILTIN_TOOLS,
	GOOGLE_IMAGE_ASPECT_RATIOS,
	GOOGLE_IMAGE_OUTPUT_MIMES,
	GOOGLE_IMAGE_RESOLUTIONS,
	GOOGLE_SPEECH_VOICES,
	HTTP_METHODS,
	type HttpMethod,
	IMAGE_ATTACHMENT_ACCEPT_MIMES,
	LEXICON_KEYS,
	type LexiconKey,
	lexiconDefault,
	PROFILE_HANDLE_MAX_CHARS,
	PROFILE_ID_MAX_CHARS,
	PROFILE_TYPE_PROTOCOLS,
	PROTOCOL_PROVIDERS,
	type ProfileGraphFacetId,
	type Protocol,
	type Provider,
	profileGraphFacet,
	type StudioAuthType,
	THINKING_LEVELS,
	type ThinkingLevel,
	type ToolAccess,
	type ToolLoadTier,
	type ToolPermission,
	VOICE_ACCEPT_MIMES,
} from '../../mod.ts';
import {
	BOUNDARIES,
	BOUNDARY_META,
	type Boundary,
	DETECT_ACTION_META,
	DETECT_ACTIONS,
	DETECTOR_BOUNDARIES,
	DETECTOR_GROUP_META,
	DETECTOR_GROUPS,
	DETECTOR_META,
	DETECTORS,
	type DetectAction,
	type Detector,
	TOOL_BOUNDARIES,
	TOOL_KINDS,
} from '../../src/guardrails/mod.ts';
import {
	type AcceptSection,
	acceptSections,
	agentToolTarget,
	allowedBuiltinsForGemini,
	COMPACTION_DRAFT_DEFAULTS,
	type DecisionQuestionDraft,
	type DecisionQuestionType,
	defaultBindingForProfileType,
	defaultEffortRequired,
	defaultModelRequired,
	draftAllows,
	draftKey,
	expandAccept,
	GEMINI_STUDIO_DEFAULT_API_ID,
	GEMINI_STUDIO_LIVE_INPUT_TOKENS,
	GEMINI_STUDIO_MODELS,
	type GuardrailsDraft,
	type ImageReferenceDraft,
	INLINE_WORDING,
	includableFacets,
	includeFacet,
	inputLimitsRequired,
	isGoogleTransport,
	isOpenRouterTransport,
	JEV_STUDIO_API_ID,
	keySlotRequired,
	type ModelBindingDraft,
	modelBindingNodeId,
	newCriteria,
	newDecisionQuestion,
	newModelBinding,
	newOwnDetector,
	newPattern,
	newToolSpec,
	nextAccept,
	type ObservabilityDraft,
	OPENROUTER_DECISION_MODELS,
	OPENROUTER_STUDIO_API_ID,
	type OutputsDraft,
	type OwnDetectorDraft,
	type PatternDraft,
	type PatternSourceDraft,
	plantsCanary,
	removeModelBinding,
	STUDIO_DECISION_MAX_CRITERIA,
	STUDIO_DECISION_MAX_QUESTIONS,
	STUDIO_DECISION_MAX_STATE_BYTES,
	STUDIO_DECISION_TIMEOUT_MS,
	STUDIO_TAINT_NOTE,
	STUDIO_TRACE_DESTINATION,
	type StudioAsks,
	type StudioDraft,
	type StudioIssue,
	type StudioProfileType,
	type StudioTurnProfileType,
	sampleToolInput,
	sectionNote,
	setProfileType,
	studioNetworkNote,
	studioNodeRef,
	studioRunsTransport,
	type ToolSpecDraft,
	takesContinueInstruction,
	toolSpecNodeId,
	updateModelBinding,
	writeAsk,
} from '../mod.ts';
import type { ListedProfileType } from '../browser.ts';
import {
	type ContextType,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { CONTEXT_PLACEHOLDER, contextErrorOf, draftSlots, usePageValues } from './lib/studio-page.ts';
import {
	setToolCredential,
	subscribeToolCredentials,
	toolCredential,
} from './lib/tool-credentials.ts';
import { type ProbeResult, runToolProbe } from './lib/tool-probe.ts';
import { IconGemini, IconGoogle, IconOpenAi, IconOpenRouter } from './brand-icons.tsx';
import { DetectorTester } from './guardrail-tester.tsx';
import {
	type Choice,
	ChoiceRow,
	InspectorGroupTitle,
	InspectorRow,
	InspectorSection,
	ListRow,
	NamesRow,
	NumberRow,
	OriginLine,
	type Segment,
	SegmentedRow,
	SetInCode,
	SliderRow,
	SwitchRow,
	TextAreaRow,
	TextRow,
} from './inspector.tsx';
import {
	ConfirmWrite,
	ConnectionMode,
	ISSUE_ROW_ATTRIBUTE,
	LeavePage,
	ListBadges,
	LocalConnection,
	NodeIssues,
	ProjectAsks,
	RowOrigins,
	SaidOrigin,
	useFieldStatus,
	useRowOrigin,
	type WorkspaceAgent,
	WorkspaceContext,
} from './inspector-context.ts';
import { IconMcp } from './mcp-icon.tsx';
import { slotDescription, useProviderModels } from './studio-connection.tsx';
import { IconTheorem } from './theorem-mark.tsx';

export type SetDraft = Dispatch<SetStateAction<StudioDraft>>;

/** The draft's sections that are one object of settings, rather than a list. */
type SettingsSection = Exclude<keyof StudioDraft, 'included' | 'modelBindings' | 'toolSpecs'>;

/** Sets fields of one section of the draft, leaving the rest as it is. */
function patch<K extends SettingsSection>(setDraft: SetDraft, key: K) {
	return (change: Partial<StudioDraft[K]>) => {
		setDraft((draft) => ({ ...draft, [key]: { ...draft[key], ...change } }));
	};
}

/** The setter `patch` returns for one section, as a section's component takes it. */
type SetSection<K extends SettingsSection> = (change: Partial<StudioDraft[K]>) => void;

/** Each profile type's icon: the Type control's segments and the tree's Identity row. */
export const PROFILE_TYPE_ICON = {
	text: IconLetterT,
	image: IconPhoto,
	speech: IconVolume,
	live: IconHeadset,
	decision: IconGitBranch,
	host: IconServer,
} satisfies Record<StudioProfileType, unknown>;

const PROFILE_TYPE_SEGMENTS: Segment<StudioProfileType>[] = [
	{ value: 'text', label: 'Text', icon: PROFILE_TYPE_ICON.text },
	{ value: 'image', label: 'Image', icon: PROFILE_TYPE_ICON.image },
	{ value: 'speech', label: 'Speech', icon: PROFILE_TYPE_ICON.speech },
	{ value: 'live', label: 'Live', icon: PROFILE_TYPE_ICON.live },
	{ value: 'decision', label: 'Decision', icon: PROFILE_TYPE_ICON.decision },
	{ value: 'host', label: 'Host', icon: PROFILE_TYPE_ICON.host },
];

const PROTOCOL_SEGMENT = {
	geminiInteractions: {
		value: 'geminiInteractions',
		label: 'Gemini Interactions',
		icon: IconGemini,
	},
	geminiLive: { value: 'geminiLive', label: 'Gemini Live', icon: IconGemini },
	openAi: { value: 'openAi', label: 'OpenAI-compatible', icon: IconOpenAi },
	decision: { value: 'decision', label: 'Decision', icon: IconGitBranch },
} satisfies { [P in Protocol]: Segment<P> };

const PROVIDER_SEGMENT = {
	google: { value: 'google', label: 'Google', icon: IconGoogle },
	openrouter: { value: 'openrouter', label: 'OpenRouter', icon: IconOpenRouter },
	local: { value: 'local', label: 'Local', icon: IconDeviceDesktop },
	typesafe: { value: 'typesafe', label: 'TypeSafe', icon: IconGitBranch },
} satisfies { [P in Provider]: Segment<P> };

const LEVEL_SEGMENT = {
	none: { label: 'None', icon: IconAntennaBarsOff },
	minimal: { label: 'Minimal', icon: IconAntennaBars1 },
	low: { label: 'Low', icon: IconAntennaBars2 },
	medium: { label: 'Medium', icon: IconAntennaBars3 },
	high: { label: 'High', icon: IconAntennaBars4 },
	xhigh: { label: 'Extra high', icon: IconAntennaBars5 },
	max: { label: 'Max', icon: IconFlame },
} satisfies Record<ThinkingLevel, Omit<Segment<ThinkingLevel>, 'value'>>;

const LEVEL_SEGMENTS: Segment<ThinkingLevel>[] = THINKING_LEVELS.map((value) => ({
	value,
	...LEVEL_SEGMENT[value],
}));

/** Thought summaries: on, off, or left to the provider (`null` in the draft). */
const SUMMARIES_SEGMENTS: Segment<'default' | 'on' | 'off'>[] = [
	{ value: 'default', label: 'Provider default', icon: IconCircleDashed },
	{ value: 'on', label: 'On', icon: IconBulb },
	{ value: 'off', label: 'Off', icon: IconBulbOff },
];
/** A setting left to the provider (`null` in the draft), on, or off. */
const PROVIDER_DEFAULT_SEGMENT = { default: null, on: true, off: false } as const;

function providerDefaultSegment(value: boolean | null): keyof typeof PROVIDER_DEFAULT_SEGMENT {
	if (value === null) return 'default';
	return value ? 'on' : 'off';
}

/** Gemini Interactions storage: on, off, or left to Google (`null` in the draft). */
const STORAGE_SEGMENTS: Segment<'default' | 'on' | 'off'>[] = [
	{ value: 'default', label: 'Provider default', icon: IconCircleDashed },
	{ value: 'on', label: 'On', icon: IconDatabase },
	{ value: 'off', label: 'Off', icon: IconDatabaseOff },
];

/** Gemini Interactions context: the draft's `persistViaInteractionId`, false or true. */
const CONTEXT_SEGMENTS: Segment<'history' | 'chain'>[] = [
	{ value: 'history', label: 'Resend history', icon: IconRefresh },
	{ value: 'chain', label: 'Google chains', icon: IconLink },
];

const KIND_TITLE: Record<AcceptSection['kind'], string> = {
	image: 'Image',
	video: 'Video',
	document: 'Document',
	audio: 'Audio',
};

/** A MIME allowlist's picker: a section per media kind, its wildcard first. */
function acceptPicker(mimes: readonly string[]) {
	const sections = acceptSections(mimes);
	const options = sections.map(({ kind, wildcard, mimes: kindMimes }) => ({
		type: 'section' as const,
		title: KIND_TITLE[kind],
		options: [
			...(wildcard ? [{ value: wildcard, description: `Every ${kind} type` }] : []),
			...kindMimes.map((value) => ({ value })),
		],
	}));
	return { sections, options };
}

const ATTACHMENT_PICKER = acceptPicker(ATTACHMENT_ACCEPT_MIMES);
const IMAGE_ATTACHMENT_PICKER = acceptPicker(IMAGE_ATTACHMENT_ACCEPT_MIMES);
const VOICE_PICKER = acceptPicker(VOICE_ACCEPT_MIMES);

/** The wire model a binding starts on after its transport changes. */
function defaultApiId(type: StudioTurnProfileType, protocol: Protocol, provider: Provider): string {
	if (isOpenRouterTransport(protocol, provider)) return OPENROUTER_STUDIO_API_ID;
	if (!isGoogleTransport(protocol, provider)) return '';
	const seed = defaultBindingForProfileType(type);
	return seed.provider === 'google' ? seed.apiId : GEMINI_STUDIO_DEFAULT_API_ID;
}

/** Moves a binding to a new transport and its default model, dropping builtins that model lacks. */
function retransport(
	binding: ModelBindingDraft,
	type: StudioTurnProfileType,
	protocol: Protocol,
	provider: Provider,
): Partial<ModelBindingDraft> {
	const apiId = defaultApiId(type, protocol, provider);
	const allowed = new Set(allowedBuiltinsForGemini(apiId));
	return {
		protocol,
		provider,
		apiId,
		builtInTools: binding.builtInTools.filter((id) => allowed.has(id)),
	};
}

/**
 * A type change turns on each optional section the new type brings that the old one didn't: the
 * first pick shows them all. One the author took out under the old type stays out.
 */
function withNewSections(before: StudioDraft, after: StudioDraft): StudioDraft {
	const leftOut = new Set(includableFacets(before));
	return includableFacets(after)
		.filter((facet) => !leftOut.has(facet))
		.reduce(includeFacet, after);
}

function SystemPromptSection({
	identity,
	set,
}: {
	identity: StudioDraft['identity'];
	set: SetSection<'identity'>;
}) {
	return (
		<InspectorSection title="System prompt">
			<TextArea
				label="System prompt"
				isLabelHidden
				size="sm"
				rows={8}
				value={identity.system}
				placeholder={fieldMeta('identity.system')?.unset}
				onChange={(system) => {
					set({ system });
				}}
			/>
			<TextAreaRow
				label="By role"
				path="identity.systemByRole"
				field="systemByRoleJson"
				value={identity.systemByRoleJson}
				rows={4}
				hasSpellCheck={false}
				placeholder={SYSTEM_BY_ROLE_PLACEHOLDER}
				onChange={(systemByRoleJson) => {
					set({ systemByRoleJson });
				}}
			/>
		</InspectorSection>
	);
}

function IdentityEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const { identity } = draft;
	const set = patch(setDraft, 'identity');
	return (
		<>
			<InspectorSection title="Profile">
				<TextRow
					label="Id"
					path="id"
					field="agentId"
					value={identity.agentId}
					placeholder="my.agent"
					maxLength={PROFILE_ID_MAX_CHARS}
					onChange={(agentId) => {
						set({ agentId });
					}}
				/>
				<SegmentedRow
					label="Type"
					path="type"
					field="profileType"
					value={identity.profileType}
					segments={PROFILE_TYPE_SEGMENTS}
					onChange={(type) => {
						if (type)
							setDraft((current) => withNewSections(current, setProfileType(current, type)));
					}}
				/>
				{/* A host runs no model: nothing speaks, so it has no handle. */}
				{identity.profileType !== 'host' && (
					<TextRow
						label="Handle"
						path="identity.handle"
						field="handle"
						value={identity.handle}
						placeholder="agent"
						maxLength={PROFILE_HANDLE_MAX_CHARS}
						onChange={(handle) => {
							set({ handle });
						}}
					/>
				)}
			</InspectorSection>
			{identity.profileType !== 'speech' &&
				identity.profileType !== 'decision' &&
				identity.profileType !== 'host' && <SystemPromptSection identity={identity} set={set} />}
		</>
	);
}

/** The policy every model of the profile shares: default, switching, steps and key slots. */
function ModelPolicySection({ draft, set }: { draft: StudioDraft; set: SetSection<'models'> }) {
	const { models } = draft;
	return (
		<InspectorSection title="Policy">
			<ChoiceRow
				label="Default"
				path="defaultModel"
				field="defaultModel"
				value={models.defaultModel}
				isRequired={defaultModelRequired(draft)}
				options={draft.modelBindings.map((binding) => binding.modelId)}
				onChange={(defaultModel) => {
					set({ defaultModel });
				}}
			/>
			<SwitchRow
				label="Switching"
				path="allowModelSelect"
				field="allowModelSelect"
				value={models.allowModelSelect}
				isDisabled={draft.modelBindings.length < 2}
				disabledMessage="Add a second model to let people switch."
				onChange={(allowModelSelect) => {
					set({ allowModelSelect });
				}}
			/>
			<ChoiceRow
				label="Incompatible saved state"
				path="providerContinuation.onMismatch"
				field="providerStateMismatch"
				value={models.providerStateMismatch ?? 'rebuild'}
				options={[
					{ value: 'rebuild', label: 'Continue from history' },
					{ value: 'error', label: 'Stop with an error' },
				]}
				onChange={(value) => {
					if (value === 'rebuild' || value === 'error') set({ providerStateMismatch: value });
				}}
			/>
			<NumberRow
				label="Max steps"
				path="maxSteps"
				units="steps"
				field="maxSteps"
				value={models.maxSteps}
				min={1}
				isIntegerOnly
				onChange={(maxSteps) => {
					set({ maxSteps });
				}}
			/>
			<SlotRow
				label="Key slot"
				path="models.*.keySlot"
				field="key"
				value={models.key}
				isRequired={keySlotRequired(draft)}
				onChange={(key) => {
					set({ key });
				}}
			/>
			<SlotRow
				label="Fallback slot"
				path="models.*.fallbackKeySlot"
				field="fallbackKey"
				value={models.fallbackKey ?? ''}
				onChange={(fallbackKey) => {
					set({ fallbackKey });
				}}
			/>
		</InspectorSection>
	);
}

function ModelsEditor({
	draft,
	setDraft,
	onSelect,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	onSelect: (id: string) => void;
}) {
	const set = patch(setDraft, 'models');
	const addModel = () => {
		const binding = newModelBinding(draft);
		setDraft((current) => ({ ...current, modelBindings: [...current.modelBindings, binding] }));
		onSelect(modelBindingNodeId(binding.key));
	};
	return (
		<>
			<InspectorSection
				note={
					draft.identity.profileType === 'decision'
						? sectionNote('models.decision')
						: sectionNote('models')
				}
			>
				<Button
					label="Add model"
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconPlus} size="sm" />}
					isDisabled={draft.identity.profileType === 'decision' && draft.modelBindings.length >= 1}
					onClick={addModel}
				/>
			</InspectorSection>
			{draft.identity.profileType !== 'decision' && <ModelPolicySection draft={draft} set={set} />}
		</>
	);
}

/** A decision binding's wire model: picked from the demo's list, typed outside the demo. */
function DecisionApiModelRow({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	const mode = useContext(ConnectionMode);
	if (mode !== 'demo')
		return (
			<TextRow
				label="API model"
				path="models.*.apiId"
				field="apiId"
				value={binding.apiId}
				isRequired
				onChange={(apiId) => {
					set({ apiId });
				}}
			/>
		);
	return (
		<ChoiceRow
			label="API model"
			path="models.*.apiId"
			field="apiId"
			value={binding.apiId}
			options={(binding.provider === 'typesafe'
				? [{ id: JEV_STUDIO_API_ID, label: 'Jev' }]
				: OPENROUTER_DECISION_MODELS
			).map((model) => ({
				value: model.id,
				label: model.label,
				description: model.id,
			}))}
			onChange={(apiId) => {
				set({ apiId });
			}}
		/>
	);
}

function DecisionTransportRows({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	return (
		<>
			<SegmentedRow<Protocol>
				label="Protocol"
				path="models.*.provider"
				field="protocol"
				value={binding.protocol}
				segments={[PROTOCOL_SEGMENT.decision]}
				onChange={(protocol) => {
					set({ protocol });
				}}
			/>
			<SegmentedRow<Provider>
				label="Provider"
				path="models.*.provider"
				field="provider"
				value={binding.provider}
				segments={[PROVIDER_SEGMENT.typesafe, PROVIDER_SEGMENT.openrouter]}
				onChange={(provider) => {
					set({
						provider,
						apiId: provider === 'typesafe' ? JEV_STUDIO_API_ID : OPENROUTER_DECISION_MODELS[0].id,
					});
				}}
			/>
			<DecisionApiModelRow binding={binding} set={set} />
		</>
	);
}

/** Decision model binding, using the same protocol/provider/API id symbols as other models. */
function DecisionModelEditor({
	draft,
	setDraft,
	bindingKey,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	bindingKey: string;
}) {
	const binding = draft.modelBindings.find((candidate) => candidate.key === bindingKey);
	if (!binding) return null;
	const set = (change: Partial<ModelBindingDraft>) => {
		setDraft((current) => updateModelBinding(current, bindingKey, change));
	};
	return (
		<InspectorSection title="Decision model" note={sectionNote('decisionModel')}>
			<TextRow
				label="Id"
				path="models.*"
				field="modelId"
				value={binding.modelId}
				isRequired
				onChange={(modelId) => {
					set({ modelId });
				}}
			/>
			<DecisionTransportRows binding={binding} set={set} />
			<SlotRow
				label="Key slot"
				path="models.*.keySlot"
				value={draft.models.key}
				onChange={(key) => {
					setDraft((current) => ({ ...current, models: { ...current.models, key } }));
				}}
			/>
			<NumberRow
				label="Timeout"
				path="models.*.timeoutMs"
				units="ms"
				field="timeoutMs"
				value={binding.timeoutMs}
				min={1}
				max={STUDIO_DECISION_TIMEOUT_MS}
				hint={`${String(STUDIO_DECISION_TIMEOUT_MS)} by default`}
				isIntegerOnly
				onChange={(timeoutMs) => {
					set({ timeoutMs });
				}}
			/>
		</InspectorSection>
	);
}

/** A key slot, chosen from the slots the keys panel holds; each says which service its key is for. */
function SlotRow({
	label,
	path,
	field,
	value,
	isRequired,
	onChange,
}: {
	label: string;
	path: string;
	field?: string;
	value: string;
	isRequired?: boolean;
	onChange: (slot: string) => void;
}) {
	const connection = useContext(LocalConnection);
	if (!connection)
		return (
			<TextRow
				label={label}
				path={path}
				field={field}
				value={value}
				isRequired={isRequired}
				onChange={onChange}
			/>
		);
	// A slot the profile names but the panel doesn't hold yet stays choosable.
	const slots =
		value && !connection.slots.includes(value) ? [...connection.slots, value] : connection.slots;
	return (
		<ChoiceRow
			label={label}
			path={path}
			field={field}
			value={value}
			isRequired={isRequired}
			options={slots.map((slot) => ({
				value: slot,
				label: slot,
				description: slotDescription(connection.vault[slot]),
			}))}
			emptyText="Add a key under Keys first."
			onChange={onChange}
		/>
	);
}

/**
 * The provider's model, picked from what it lists for this profile type with the key in the
 * model's slot. Until there is a list (a Gemini model with no key, or a list that failed), the id
 * is typed.
 */
function ProviderModelRow({
	provider,
	type,
	slot,
	value,
	onChange,
}: {
	provider: Provider;
	type: ListedProfileType;
	slot: string;
	value: string;
	onChange: (apiId: string) => void;
}) {
	const connection = useContext(LocalConnection);
	const listed = provider === 'google' || provider === 'openrouter' ? provider : undefined;
	const models = useProviderModels(listed, type, slot ? connection?.vault[slot] : undefined);
	if (models.status === 'idle' || models.status === 'error')
		return (
			<TextRow
				label="API model"
				path="models.*.apiId"
				field="apiId"
				value={value}
				isRequired
				placeholder={listed === 'google' ? 'Choose a key to list models' : 'Provider model id'}
				status={models.status === 'error' ? { type: 'error', message: models.error } : undefined}
				onChange={onChange}
			/>
		);
	const options = models.models.map((model) => ({
		value: model.id,
		label: model.label,
		description: model.id,
	}));
	// A model the list leaves out stays chosen, so a list never rewrites the profile.
	if (value && !models.models.some((model) => model.id === value))
		options.unshift({ value, label: value, description: 'Not in the list' });
	return (
		<ChoiceRow
			label="API model"
			path="models.*.apiId"
			field="apiId"
			value={value}
			options={options}
			isLoading={models.status === 'loading'}
			emptyText={`No ${type} models listed.`}
			hasSearch
			isRequired
			onChange={onChange}
		/>
	);
}

type LocalConnectionValue = NonNullable<ContextType<typeof LocalConnection>>;

/** The profile type a model runs as: a decision has its own binding editor; a host has no model. */
function bindingProfileType(chosen: StudioDraft['identity']['profileType']): ListedProfileType {
	return chosen && chosen !== 'decision' && chosen !== 'host' ? chosen : 'text';
}

/** A provider's segment, disabled with the reason when the studio can't run it here. */
function providerSegment(
	provider: keyof typeof PROVIDER_SEGMENT,
	binding: ModelBindingDraft,
	type: ListedProfileType,
	mode: ContextType<typeof ConnectionMode>,
) {
	const local = provider === 'local';
	return {
		...PROVIDER_SEGMENT[provider],
		isDisabled: !studioRunsTransport(type, binding.protocol, provider, local ? 'local' : mode),
		disabledMessage:
			mode === 'demo' && !local
				? 'Add your own key under Keys to use it.'
				: `It doesn't run ${type} agents.`,
	};
}

/** The protocol's providers, each enabled only where the studio runs it. */
function ProviderRow({
	binding,
	type,
	set,
}: {
	binding: ModelBindingDraft;
	type: ListedProfileType;
	set: SetBinding;
}) {
	const mode = useContext(ConnectionMode);
	return (
		<SegmentedRow<Provider>
			label="Provider"
			path="models.*.provider"
			field="provider"
			value={binding.provider}
			segments={PROTOCOL_PROVIDERS[binding.protocol].map((provider) =>
				providerSegment(provider, binding, type, mode),
			)}
			onChange={(provider) => {
				set(retransport(binding, type, binding.protocol, provider));
			}}
		/>
	);
}

/** A local model's endpoint, with help when the page's origin can't reach it. */
function LocalEndpointRows({ set }: { set: SetBinding }) {
	const localConnection = useContext(LocalConnection);
	if (!localConnection) return null;
	const failed = localConnection.localModels.status === 'error';
	return (
		<>
			<TextRow
				label="Endpoint"
				path="local.baseUrl"
				value={localConnection.local.baseUrl}
				placeholder="http://127.0.0.1:11434"
				status={
					failed ? { type: 'error', message: localConnection.localModels.error ?? '' } : undefined
				}
				onChange={(baseUrl) => {
					localConnection.setLocal((current) => ({ ...current, baseUrl }));
					set({ apiId: '' });
				}}
			/>
			{failed && !isLocalPage() && <LocalOriginHelp />}
		</>
	);
}

/** A hosted model's key slot and fallback slot. */
function KeySlotRows({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	return (
		<>
			<SlotRow
				label="Key slot"
				path="models.*.keySlot"
				field="keySlot"
				value={binding.keySlot ?? ''}
				onChange={(keySlot) => {
					set({ keySlot });
				}}
			/>
			<SlotRow
				label="Fallback slot"
				path="models.*.fallbackKeySlot"
				field="fallbackKeySlot"
				value={binding.fallbackKeySlot ?? ''}
				onChange={(fallbackKeySlot) => {
					set({ fallbackKeySlot });
				}}
			/>
		</>
	);
}

/** Why a local model can't be picked yet, if it can't. */
function localModelsPlaceholder(status: LocalConnectionValue['localModels']['status']) {
	if (status === 'error') return "Can't reach the endpoint";
	if (status === 'idle') return 'Enter the endpoint first';
	return undefined;
}

/** A local model, picked from what the endpoint lists. */
function LocalApiModelRow({
	binding,
	localConnection,
	set,
}: {
	binding: ModelBindingDraft;
	localConnection: LocalConnectionValue;
	set: SetBinding;
}) {
	const { status } = localConnection.localModels;
	return (
		<ChoiceRow
			label="API model"
			path="models.*.apiId"
			field="apiId"
			value={binding.apiId}
			options={localConnection.localModels.ids}
			isDisabled={status === 'idle' || status === 'error'}
			isLoading={status === 'loading'}
			placeholder={localModelsPlaceholder(status)}
			emptyText="This server has no models."
			hasSearch
			isRequired
			onChange={(apiId) => {
				set({ apiId });
			}}
		/>
	);
}

/** The demo's models for the transport: its Gemini models for the type, or OpenRouter's one. */
function demoModelOptions(google: boolean, type: ListedProfileType) {
	if (!google) return [OPENROUTER_STUDIO_API_ID];
	return GEMINI_STUDIO_MODELS.filter((model) => model.profileType === type).map((model) => ({
		value: model.id,
		label: model.label,
		description: model.id,
	}));
}

/** A demo model, from the demo's own list; built-ins the model doesn't allow are dropped. */
function DemoApiModelRow({
	binding,
	type,
	google,
	set,
}: {
	binding: ModelBindingDraft;
	type: ListedProfileType;
	google: boolean;
	set: SetBinding;
}) {
	return (
		<ChoiceRow
			label="API model"
			path="models.*.apiId"
			field="apiId"
			value={binding.apiId}
			options={demoModelOptions(google, type)}
			onChange={(apiId) => {
				const allowed = new Set(allowedBuiltinsForGemini(apiId));
				set({ apiId, builtInTools: binding.builtInTools.filter((id) => allowed.has(id)) });
			}}
		/>
	);
}

/** The model's API id: from the local endpoint, the demo's list, or the provider's list. */
function ApiModelRow({
	draft,
	binding,
	type,
	google,
	set,
}: {
	draft: StudioDraft;
	binding: ModelBindingDraft;
	type: ListedProfileType;
	google: boolean;
	set: SetBinding;
}) {
	const mode = useContext(ConnectionMode);
	const localConnection = useContext(LocalConnection);
	if (binding.provider === 'local' && localConnection)
		return <LocalApiModelRow binding={binding} localConnection={localConnection} set={set} />;
	if (mode === 'demo')
		return <DemoApiModelRow binding={binding} type={type} google={google} set={set} />;
	return (
		<ProviderModelRow
			provider={binding.provider}
			type={type}
			slot={binding.keySlot || draft.models.key}
			value={binding.apiId}
			onChange={(apiId) => {
				set({ apiId });
			}}
		/>
	);
}

/** A local model's remote tools switch and server. */
function LocalServerRows({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	const localConnection = useContext(LocalConnection);
	return (
		<>
			{localConnection && (
				<SwitchRow
					label="Remote tools"
					path="studio.remoteTools"
					value={localConnection.remoteTools}
					onChange={localConnection.setRemoteTools}
				/>
			)}
			<TextRow
				label="Server"
				path="models.*.providerOptions.server"
				field="server"
				value={binding.server ?? ''}
				placeholder="ollama"
				onChange={(server) => {
					set({ server });
				}}
			/>
		</>
	);
}

/** A Google model's built-ins: in the demo, those its model allows. */
function BuiltinsRow({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	const mode = useContext(ConnectionMode);
	const builtins =
		mode === 'demo'
			? allowedBuiltinsForGemini(binding.apiId)
			: GOOGLE_BUILTIN_TOOLS.map((tool) => tool.name);
	return (
		<ListRow
			label="Built-ins"
			path="models.*.builtInTools"
			field="builtInTools"
			value={binding.builtInTools}
			options={builtins}
			onChange={(builtInTools) => {
				set({ builtInTools });
			}}
		/>
	);
}

/** Which model the binding runs: its id, transport, key slots and API model. */
function ModelSection({
	draft,
	binding,
	type,
	set,
}: {
	draft: StudioDraft;
	binding: ModelBindingDraft;
	type: ListedProfileType;
	set: SetBinding;
}) {
	const google = isGoogleTransport(binding.protocol, binding.provider);
	const local = binding.provider === 'local';
	return (
		<InspectorSection path="models.*">
			<TextRow
				label="Id"
				path="models.*"
				field="modelId"
				// A model\'s id is its key in the profile\'s models, so it can\'t be left out.
				isRequired
				value={binding.modelId}
				placeholder="fast"
				onChange={(modelId) => {
					set({ modelId });
				}}
			/>
			<SegmentedRow<Protocol>
				label="Protocol"
				path="models.*.provider"
				field="protocol"
				value={binding.protocol}
				segments={PROFILE_TYPE_PROTOCOLS[type].map((protocol) => PROTOCOL_SEGMENT[protocol])}
				onChange={(protocol) => {
					const provider = PROTOCOL_PROVIDERS[protocol][0];
					set(retransport(binding, type, protocol, provider));
				}}
			/>
			<ProviderRow binding={binding} type={type} set={set} />
			{local ? <LocalEndpointRows set={set} /> : <KeySlotRows binding={binding} set={set} />}
			<ApiModelRow draft={draft} binding={binding} type={type} google={google} set={set} />

			{local && <LocalServerRows binding={binding} set={set} />}

			{google && <BuiltinsRow binding={binding} set={set} />}
		</InspectorSection>
	);
}

/** How the model generates: its output cap, temperature and summaries. */
function GenerationSection({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	return (
		<InspectorSection title="Generation">
			<NumberRow
				label="Max output"
				path="models.*.maxOutputTokens"
				units="tokens"
				field="maxOutputTokens"
				value={binding.maxOutputTokens}
				min={1}
				isIntegerOnly
				onChange={(maxOutputTokens) => {
					set({ maxOutputTokens });
				}}
			/>
			<NumberRow
				label="Temperature"
				path="models.*.temperature"
				field="temperature"
				value={binding.temperature}
				min={0}
				step={0.1}
				onChange={(temperature) => {
					set({ temperature });
				}}
			/>
			<SegmentedRow
				label="Summaries"
				path="models.*.summaries"
				value={providerDefaultSegment(binding.summaries)}
				segments={SUMMARIES_SEGMENTS}
				onChange={(segment) => {
					set({ summaries: PROVIDER_DEFAULT_SEGMENT[segment] });
				}}
			/>
		</InspectorSection>
	);
}

/** A Gemini Interactions model's context and Google storage. */
function ConversationStateSection({
	binding,
	set,
}: {
	binding: ModelBindingDraft;
	set: SetBinding;
}) {
	return (
		<InspectorSection title="Conversation state">
			<SegmentedRow
				label="Context"
				path="models.*.providerOptions.persistViaInteractionId"
				field="persistViaInteractionId"
				value={binding.persistViaInteractionId ? 'chain' : 'history'}
				segments={CONTEXT_SEGMENTS}
				onChange={(segment) => {
					set({ persistViaInteractionId: segment === 'chain' });
				}}
			/>
			<SegmentedRow
				label="Google storage"
				path="models.*.providerOptions.store"
				field="store"
				value={providerDefaultSegment(binding.store)}
				segments={STORAGE_SEGMENTS}
				onChange={(segment) => {
					set({ store: PROVIDER_DEFAULT_SEGMENT[segment] });
				}}
			/>
		</InspectorSection>
	);
}

type SetEfforts = (
	efforts: ModelBindingDraft['efforts'],
	renamed?: { from: string; to: string },
) => void;

/** One effort: its alias, a remove button and its level. */
function EffortRow({
	efforts,
	index,
	setEfforts,
}: {
	efforts: ModelBindingDraft['efforts'];
	index: number;
	setEfforts: SetEfforts;
}) {
	const statusAt = useFieldStatus();
	const status = statusAt('efforts', index);
	const effort = efforts[index];
	return (
		<VStack gap={3}>
			<InspectorRow
				label={`Effort ${String(index + 1)}`}
				path="models.*.efforts"
				hasIssue={status !== undefined}
			>
				<StackItem size="fill">
					<TextInput
						label={`Effort ${String(index + 1)} alias`}
						isLabelHidden
						size="sm"
						status={status}
						value={effort.alias}
						placeholder="Alias"
						onChange={(alias) => {
							setEfforts(
								efforts.map((e, i) => (i === index ? { ...e, alias } : e)),
								{ from: effort.alias, to: alias },
							);
						}}
					/>
				</StackItem>
				<IconButton
					label={`Remove effort ${String(index + 1)}`}
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconX} size="sm" />}
					onClick={() => {
						setEfforts(efforts.filter((_, i) => i !== index));
					}}
				/>
			</InspectorRow>
			<SegmentedRow
				label="Level"
				path="models.*.efforts.*"
				value={effort.level}
				segments={LEVEL_SEGMENTS}
				onChange={(level) => {
					setEfforts(efforts.map((e, i) => (i === index ? { ...e, level } : e)));
				}}
			/>
		</VStack>
	);
}

/** The model's named efforts, its default effort and whether people can switch. */
function EffortsSection({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	const aliases = binding.efforts.map((effort) => effort.alias).filter(Boolean);
	/**
	 * Sets the efforts and keeps the settings that depend on them valid: the default follows its
	 * alias through a rename (`renamed`) and is cleared when the alias goes, and effort switching
	 * turns off below two aliases, where its switch is disabled and couldn't be turned off.
	 */
	const setEfforts: SetEfforts = (efforts, renamed) => {
		const next = new Set(efforts.map((effort) => effort.alias).filter(Boolean));
		const defaultEffort =
			renamed && binding.defaultEffort === renamed.from ? renamed.to : binding.defaultEffort;
		set({
			efforts,
			defaultEffort: next.has(defaultEffort) ? defaultEffort : '',
			allowEffortSelect: binding.allowEffortSelect && next.size >= 2,
		});
	};
	return (
		<InspectorSection title="Efforts" path="models.*.efforts">
			{binding.efforts.map((_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: efforts have no id and are only appended or removed
				<EffortRow key={index} efforts={binding.efforts} index={index} setEfforts={setEfforts} />
			))}
			<Button
				label="Add effort"
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconPlus} size="sm" />}
				onClick={() => {
					setEfforts([...binding.efforts, { alias: '', level: 'medium' }]);
				}}
			/>
			<ChoiceRow
				label="Default"
				path="models.*.defaultEffort"
				field="defaultEffort"
				value={binding.defaultEffort}
				isRequired={defaultEffortRequired(binding)}
				options={aliases}
				onChange={(defaultEffort) => {
					set({ defaultEffort });
				}}
			/>
			<SwitchRow
				label="Switching"
				path="models.*.allowEffortSelect"
				field="allowEffortSelect"
				value={binding.allowEffortSelect}
				isDisabled={aliases.length < 2}
				disabledMessage="Add a second effort to let people switch."
				onChange={(allowEffortSelect) => {
					set({ allowEffortSelect });
				}}
			/>
		</InspectorSection>
	);
}

function ModelBindingEditor({
	draft,
	setDraft,
	bindingKey,
	onSelect,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	bindingKey: string;
	onSelect: (id: string) => void;
}) {
	const binding = draft.modelBindings.find((candidate) => candidate.key === bindingKey);
	if (!binding) return null;
	const type = bindingProfileType(draft.identity.profileType);
	const set = (change: Partial<ModelBindingDraft>) => {
		setDraft((current) => updateModelBinding(current, bindingKey, change));
	};
	const google = isGoogleTransport(binding.protocol, binding.provider);

	return (
		<>
			<ModelSection draft={draft} binding={binding} type={type} set={set} />
			<GenerationSection binding={binding} set={set} />
			{google && binding.protocol === 'geminiInteractions' && (
				<ConversationStateSection binding={binding} set={set} />
			)}
			{binding.provider === 'openrouter' && binding.protocol === 'openAi' && (
				<PromptCacheSection binding={binding} set={set} />
			)}
			{type === 'text' && <CompactionSection binding={binding} set={set} />}
			<EffortsSection binding={binding} set={set} />
			{/* A profile runs on at least one model, so the last one stays. */}
			{draft.modelBindings.length > 1 && (
				<Section variant="transparent" padding={3}>
					<Button
						label="Remove model"
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconTrash} size="sm" />}
						onClick={() => {
							setDraft((current) => removeModelBinding(current, bindingKey));
							onSelect('models');
						}}
					/>
				</Section>
			)}
		</>
	);
}

/** The inputs slice of the draft and its setter, for each inputs section. */
interface InputsSectionProps {
	inputs: StudioDraft['inputs'];
	set: SetSection<'inputs'>;
}

function InputAcceptsSection({ inputs, set, image }: InputsSectionProps & { image: boolean }) {
	const attachmentPicker = image ? IMAGE_ATTACHMENT_PICKER : ATTACHMENT_PICKER;
	return (
		<InspectorSection title="Accepts" path="inputs">
			<SwitchRow
				label="Text"
				path="inputs.text"
				value={inputs.text}
				onChange={(text) => {
					set({ text });
				}}
			/>
			<ListRow
				label="Attachments"
				path="inputs.attachments.accept"
				value={expandAccept(inputs.attachmentsAccept, attachmentPicker.sections)}
				options={attachmentPicker.options}
				onChange={(selected) => {
					set({
						attachmentsAccept: nextAccept(
							inputs.attachmentsAccept,
							selected,
							attachmentPicker.sections,
						),
					});
				}}
			/>
			{!image && (
				<ListRow
					label="Voice"
					path="inputs.voice.accept"
					value={expandAccept(inputs.voiceAccept, VOICE_PICKER.sections)}
					options={VOICE_PICKER.options}
					onChange={(selected) => {
						set({ voiceAccept: nextAccept(inputs.voiceAccept, selected, VOICE_PICKER.sections) });
					}}
				/>
			)}
		</InspectorSection>
	);
}

function InputLimitsSection({ inputs, set }: InputsSectionProps) {
	const limitsRequired = inputLimitsRequired(inputs);
	return (
		<InspectorSection title="Limits">
			<NumberRow
				label="Max files"
				path="inputs.maxFiles"
				units="files"
				field="maxFiles"
				isRequired={limitsRequired}
				value={inputs.maxFiles}
				min={0}
				isIntegerOnly
				onChange={(maxFiles) => {
					set({ maxFiles });
				}}
			/>
			<NumberRow
				label="Max bytes"
				path="inputs.maxBytes"
				units="bytes"
				field="maxBytes"
				isRequired={limitsRequired}
				value={inputs.maxBytes}
				min={0}
				isIntegerOnly
				onChange={(maxBytes) => {
					set({ maxBytes });
				}}
			/>
			<NumberRow
				label="Turn bytes"
				path="inputs.maxTurnBytes"
				units="bytes"
				field="maxTurnBytes"
				isRequired={limitsRequired}
				value={inputs.maxTurnBytes}
				min={0}
				isIntegerOnly
				onChange={(maxTurnBytes) => {
					set({ maxTurnBytes });
				}}
			/>
			<TextAreaRow
				label="By type"
				path="inputs.limitsByMime"
				field="limitsByMimeJson"
				value={inputs.limitsByMimeJson}
				rows={3}
				hasSpellCheck={false}
				placeholder={LIMITS_BY_MIME_PLACEHOLDER}
				onChange={(limitsByMimeJson) => {
					set({ limitsByMimeJson });
				}}
			/>
		</InspectorSection>
	);
}

type ContextSender = StudioDraft['inputs']['contextFrom'][number];

const CONTEXT_SENDER_LABELS: Record<ContextSender, string> = {
	client: 'The page',
	server: 'The server',
};

const CONTEXT_SENDERS = Object.keys(CONTEXT_SENDER_LABELS) as ContextSender[];

/** The size a context starts with when its first sender is ticked. */
const CONTEXT_MAX_CHARS_START = 4000;

/** Who may tell the agent what the page shows, and how much. */
function InputContextSection({ inputs, set }: InputsSectionProps) {
	return (
		<InspectorSection title="Context" path="inputs.context" note={sectionNote('context')}>
			<InspectorRow label="From" path="inputs.context.from">
				<StackItem size="fill">
					<CheckboxList
						label="From"
						isLabelHidden
						density="compact"
						value={inputs.contextFrom}
						onChange={(checked) => {
							set({
								contextFrom: CONTEXT_SENDERS.filter((sender) => checked.includes(sender)),
								// why: The kernel has no default size; the first sender starts with one to edit.
								contextMaxChars: inputs.contextMaxChars ?? CONTEXT_MAX_CHARS_START,
							});
						}}
					>
						{CONTEXT_SENDERS.map((sender) => (
							<CheckboxListItem key={sender} value={sender} label={CONTEXT_SENDER_LABELS[sender]} />
						))}
					</CheckboxList>
				</StackItem>
			</InspectorRow>
			{inputs.contextFrom.length > 0 && (
				<NumberRow
					label="Max size"
					path="inputs.context.maxChars"
					units="characters"
					field="contextMaxChars"
					isRequired
					value={inputs.contextMaxChars}
					min={1}
					isIntegerOnly
					onChange={(contextMaxChars) => {
						set({ contextMaxChars });
					}}
				/>
			)}
			{inputs.contextFrom.includes('client') && <ContextPreviewRow />}
		</InspectorSection>
	);
}

/** The context the studio's page sends the open agent. Kept in this tab, not in the profile. */
function ContextPreviewRow() {
	const [values, setValues] = usePageValues(useContext(WorkspaceContext)?.self ?? '');
	const error = contextErrorOf(values.contextJson);
	return (
		<TextAreaRow
			label="Preview"
			path="inputs.context"
			isRequired={false}
			value={values.contextJson}
			rows={3}
			hasSpellCheck={false}
			placeholder={CONTEXT_PLACEHOLDER}
			status={error ? { type: 'error', message: error } : undefined}
			onChange={(contextJson) => {
				setValues({ ...values, contextJson });
			}}
		/>
	);
}

/** The value the studio's page sends for each slot declared so far. Kept in this tab. */
function SlotPreviewRows({ slotsJson }: { slotsJson: string }) {
	const [values, setValues] = usePageValues(useContext(WorkspaceContext)?.self ?? '');
	const slots = draftSlots(slotsJson);
	return Object.entries(slots).map(([name, allowed]) => (
		<ChoiceRow
			key={name}
			label={name}
			path="inputs.slots"
			isRequired
			value={allowed.find((value) => value === values.slots[name]) ?? allowed[0]}
			options={allowed}
			onChange={(next) => {
				if (next) setValues({ ...values, slots: { ...values.slots, [name]: next } });
			}}
		/>
	));
}

function InputsEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const { inputs } = draft;
	const set = patch(setDraft, 'inputs');
	/** An image profile takes images, video and PDF as references, and no voice. */
	const image = draft.identity.profileType === 'image';
	return (
		<>
			{draftAllows(draft, 'inputs.attachments.accept') && (
				<InputAcceptsSection inputs={inputs} set={set} image={image} />
			)}
			{draftAllows(draft, 'inputs.maxFiles') && <InputLimitsSection inputs={inputs} set={set} />}
			{draftAllows(draft, 'inputs.context') && <InputContextSection inputs={inputs} set={set} />}
			<InspectorSection path="inputs.slots" note={sectionNote('slots')}>
				<TextAreaRow
					label="Slots"
					path="inputs.slots"
					field="slotsJson"
					value={inputs.slotsJson}
					rows={3}
					hasSpellCheck={false}
					placeholder={SLOTS_PLACEHOLDER}
					onChange={(slotsJson) => {
						set({ slotsJson });
					}}
				/>
				<SlotPreviewRows slotsJson={inputs.slotsJson} />
			</InspectorSection>
		</>
	);
}

const SYSTEM_BY_ROLE_PLACEHOLDER = `{
  "support": "Answer as the support desk."
}`;

const LIMITS_BY_MIME_PLACEHOLDER = `{
  "application/pdf": 5000000
}`;

const SLOTS_PLACEHOLDER = `{
  "language": ["en", "fr"]
}`;

type SetBinding = (change: Partial<ModelBindingDraft>) => void;

/** Prompt caching, on OpenRouter's openAi route only. */
function PromptCacheSection({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	return (
		<InspectorSection title="Prompt cache" path="models.*.providerOptions.cache">
			<ChoiceRow
				label="Cache"
				path="models.*.providerOptions.cache.mode"
				field="cacheMode"
				isRequired={false}
				placeholder={fieldMeta('models.*.providerOptions.cache')?.unset}
				value={binding.cacheMode ?? ''}
				options={catalogChoices<CacheMode>('models.*.providerOptions.cache.mode')}
				onChange={(cacheMode) => {
					set({ cacheMode });
				}}
			/>
			{binding.cacheMode && (
				<ChoiceRow
					label="Lasts"
					path="models.*.providerOptions.cache.ttl"
					field="cacheTtl"
					value={binding.cacheTtl ?? ''}
					options={catalogChoices<CacheTtl>('models.*.providerOptions.cache.ttl')}
					onChange={(cacheTtl) => {
						set({ cacheTtl });
					}}
				/>
			)}
		</InspectorSection>
	);
}

/** The agents another agent can name: every one but itself, each by its id. */
function otherAgents(
	agents: readonly WorkspaceAgent[],
	self: string,
	canName: (agent: WorkspaceAgent) => boolean,
): Choice<string>[] {
	return agents
		.filter((agent) => agent.key !== self)
		.map((agent) => ({
			value: agent.key,
			label: agent.agentId || 'Unnamed agent',
			disabled: !canName(agent),
		}));
}

/** The other text agent that writes the summary, where the workspace has one to name. */
function CompactionSummariserRow({
	binding,
	set,
}: {
	binding: ModelBindingDraft;
	set: SetBinding;
}) {
	const workspace = useContext(WorkspaceContext);
	// Kept while it names an agent, so a removed one can still be cleared here.
	if (!workspace || !(workspace.agents.length > 1 || binding.compactWith)) return null;
	return (
		<ChoiceRow
			label="Summarised by"
			path="models.*.compaction.profile"
			field="compactWith"
			isRequired={false}
			value={binding.compactWith ?? ''}
			options={otherAgents(workspace.agents, workspace.self, (agent) => agent.type === 'text')}
			onChange={(compactWith) => {
				set({ compactWith });
			}}
		/>
	);
}

/** How compaction runs once it has a timing: its budget, threshold, kept turns and meter. */
function CompactionRows({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	return (
		<>
			<NumberRow
				label="Budget"
				path="models.*.compaction.maxTokens"
				field="compactMaxTokens"
				value={binding.compactMaxTokens ?? null}
				min={1}
				isIntegerOnly
				units="tokens"
				onChange={(compactMaxTokens) => {
					set({ compactMaxTokens });
				}}
			/>
			<SliderRow
				label="Starts at"
				path="models.*.compaction.compactAt"
				field="compactAt"
				value={binding.compactAt ?? COMPACTION_DRAFT_DEFAULTS.compactAt}
				min={0.05}
				max={0.95}
				step={0.05}
				format={(at) => PERCENT.format(at)}
				onChange={(compactAt) => {
					set({ compactAt });
				}}
			/>
			<NumberRow
				label="Keep"
				path="models.*.compaction.previousExchanges"
				field="compactKeep"
				value={binding.compactKeep ?? null}
				min={0}
				onChange={(compactKeep) => {
					set({ compactKeep });
				}}
			/>
			<CompactionSummariserRow binding={binding} set={set} />
			<ChoiceRow
				label="Counts"
				path="models.*.compaction.meter"
				field="compactMeter"
				isRequired={false}
				placeholder={fieldMeta('models.*.compaction.meter')?.unset}
				value={binding.compactMeter ?? ''}
				options={catalogChoices<CompactionMeter>('models.*.compaction.meter')}
				onChange={(compactMeter) => {
					set({ compactMeter });
				}}
			/>
		</>
	);
}

/** Compaction, where the agent summarises its older history, or another text agent does. */
function CompactionSection({ binding, set }: { binding: ModelBindingDraft; set: SetBinding }) {
	return (
		<InspectorSection path="models.*.compaction" note={sectionNote('compaction')}>
			<ChoiceRow
				label="Compact"
				path="models.*.compaction.timing"
				field="compactTiming"
				isRequired={false}
				placeholder={fieldMeta('models.*.compaction')?.unset}
				value={binding.compactTiming ?? ''}
				options={catalogChoices<CompactionTiming>('models.*.compaction.timing')}
				onChange={(compactTiming) => {
					set({
						compactTiming,
						compactMaxTokens:
							binding.compactMaxTokens ?? COMPACTION_DRAFT_DEFAULTS.compactMaxTokens,
						compactAt: binding.compactAt ?? COMPACTION_DRAFT_DEFAULTS.compactAt,
						compactKeep: binding.compactKeep ?? COMPACTION_DRAFT_DEFAULTS.compactKeep,
					});
				}}
			/>
			{binding.compactTiming && <CompactionRows binding={binding} set={set} />}
		</InspectorSection>
	);
}

type CacheMode = Exclude<NonNullable<ModelBindingDraft['cacheMode']>, ''>;
type CacheTtl = Exclude<NonNullable<ModelBindingDraft['cacheTtl']>, ''>;
type CompactionTiming = Exclude<NonNullable<ModelBindingDraft['compactTiming']>, ''>;
type CompactionMeter = Exclude<NonNullable<ModelBindingDraft['compactMeter']>, ''>;

/** A closed set's options as the kernel's catalog lists them, each with its own description. */
function catalogChoices<T extends string>(path: string): Choice<T>[] {
	const meta = fieldMeta(path);
	return (meta?.options ?? []).map((value) => ({
		value: value as T,
		description: meta?.optionDescriptions?.[value],
	}));
}

/** The segment for a closed set left unset: the provider's default. */
const PROVIDER_DEFAULT = {
	value: 'default',
	label: 'Provider default',
	icon: IconCircleDashed,
} as const;

/** An unset pin (`''`) as the provider-default segment. */
function segmentOf<T extends string>(value: T | ''): T | 'default' {
	return value === '' ? 'default' : value;
}

/** The provider-default segment back to an unset pin. */
function pinOf<T extends string>(segment: T | 'default'): T | '' {
	return segment === 'default' ? '' : segment;
}

const BARGE_IN_SEGMENTS: Segment<'default' | 'START_OF_ACTIVITY_INTERRUPTS' | 'NO_INTERRUPTION'>[] =
	[
		PROVIDER_DEFAULT,
		{ value: 'START_OF_ACTIVITY_INTERRUPTS', label: 'Interrupts', icon: IconHandStop },
		{ value: 'NO_INTERRUPTION', label: 'No interruption', icon: IconHandOff },
	];

/** Gemini reads only a sensitivity's LOW or HIGH, so each end offers its own pair. */
const START_SENSITIVITY_SEGMENTS: Segment<
	'default' | 'START_SENSITIVITY_LOW' | 'START_SENSITIVITY_HIGH'
>[] = [
	PROVIDER_DEFAULT,
	{ value: 'START_SENSITIVITY_LOW', label: 'Low', icon: IconAntennaBars2 },
	{ value: 'START_SENSITIVITY_HIGH', label: 'High', icon: IconAntennaBars5 },
];
const END_SENSITIVITY_SEGMENTS: Segment<
	'default' | 'END_SENSITIVITY_LOW' | 'END_SENSITIVITY_HIGH'
>[] = [
	PROVIDER_DEFAULT,
	{ value: 'END_SENSITIVITY_LOW', label: 'Low', icon: IconAntennaBars2 },
	{ value: 'END_SENSITIVITY_HIGH', label: 'High', icon: IconAntennaBars5 },
];

/** Whether every model is on Google, so the Google preset's vocabularies apply to the pins. */
function allGoogle(draft: StudioDraft): boolean {
	return (
		draft.modelBindings.length > 0 &&
		draft.modelBindings.every((binding) => isGoogleTransport(binding.protocol, binding.provider))
	);
}

/**
 * A pin the kernel takes as any string: the Google preset's values when every model is on
 * Google, free text otherwise.
 */
function PresetRow({
	google,
	label,
	path,
	value,
	preset,
	hasSearch,
	onChange,
}: {
	google: boolean;
	label: string;
	path: string;
	value: string;
	preset: readonly string[];
	hasSearch?: boolean;
	onChange: (next: string) => void;
}) {
	return google ? (
		<ChoiceRow
			label={label}
			path={path}
			value={value}
			options={preset}
			hasSearch={hasSearch}
			onChange={onChange}
		/>
	) : (
		<TextRow label={label} path={path} value={value} onChange={onChange} />
	);
}

/** OpenRouter's image vocabularies; the kernel takes free strings, so these are the studio's. */
const OPENROUTER_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const;
const OPENROUTER_IMAGE_BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const;
/** A pinned file rides in every turn's request, so it stays small. */
const REFERENCE_MAX_BYTES = 4 * 1024 * 1024;

/** A picked image file as a pinned reference: its bytes in base64. */
async function referenceFromFile(file: File): Promise<ImageReferenceDraft> {
	const url = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			resolve(typeof reader.result === 'string' ? reader.result : '');
		};
		reader.onerror = () => {
			reject(reader.error ?? new Error('Couldn’t read the file.'));
		};
		reader.readAsDataURL(file);
	});
	return {
		key: draftKey('reference'),
		name: file.name,
		mimeType: file.type,
		data: url.slice(url.indexOf(',') + 1),
	};
}

/** The image slice of the draft and its setter, for each group of image rows. */
interface ImageRowsProps {
	image: StudioDraft['image'];
	set: SetSection<'image'>;
}

/** An image's aspect ratio, resolution and format. */
function ImageShapeRows({ image, set, google }: ImageRowsProps & { google: boolean }) {
	return (
		<>
			<PresetRow
				google={google}
				label="Aspect ratio"
				path="image.aspectRatio"
				value={image.aspectRatio}
				preset={GOOGLE_IMAGE_ASPECT_RATIOS}
				onChange={(aspectRatio) => {
					set({ aspectRatio });
				}}
			/>
			<PresetRow
				google={google}
				label="Resolution"
				path="image.resolution"
				value={image.resolution}
				preset={GOOGLE_IMAGE_RESOLUTIONS}
				onChange={(resolution) => {
					set({ resolution });
				}}
			/>
			<PresetRow
				google={google}
				label="Format"
				path="image.mimeType"
				value={image.mimeType}
				preset={GOOGLE_IMAGE_OUTPUT_MIMES}
				onChange={(mimeType) => {
					set({ mimeType });
				}}
			/>
		</>
	);
}

/** The pins only OpenRouter takes: quality, background, compression and image count. */
function OpenRouterImageRows({ image, set }: ImageRowsProps) {
	return (
		<>
			<ChoiceRow
				label="Quality"
				path="image.quality"
				field="quality"
				value={image.quality}
				options={OPENROUTER_IMAGE_QUALITIES}
				onChange={(quality) => {
					set({ quality });
				}}
			/>
			<ChoiceRow
				label="Background"
				path="image.background"
				field="background"
				value={image.background}
				options={OPENROUTER_IMAGE_BACKGROUNDS}
				onChange={(background) => {
					set({ background });
				}}
			/>
			<NumberRow
				label="Compression"
				path="image.outputCompression"
				field="outputCompression"
				value={image.outputCompression}
				min={0}
				max={100}
				isIntegerOnly
				onChange={(outputCompression) => {
					set({ outputCompression });
				}}
			/>
			<NumberRow
				label="Images"
				path="image.n"
				field="n"
				units="per turn"
				value={image.n}
				min={1}
				max={10}
				isIntegerOnly
				onChange={(n) => {
					set({ n });
				}}
			/>
		</>
	);
}

/** Image output pins. OpenRouter-only pins show when every model is on OpenRouter. */
function ImageEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const google = allGoogle(draft);
	const openRouter =
		draft.modelBindings.length > 0 &&
		draft.modelBindings.every((binding) =>
			isOpenRouterTransport(binding.protocol, binding.provider),
		);
	const { image } = draft;
	const set = patch(setDraft, 'image');
	return (
		<>
			<InspectorSection title="Output" path="image">
				<ImageShapeRows image={image} set={set} google={google} />
				{openRouter && <OpenRouterImageRows image={image} set={set} />}
				<NumberRow
					label="Seed"
					path="image.seed"
					field="seed"
					value={image.seed}
					min={0}
					isIntegerOnly
					onChange={(seed) => {
						set({ seed });
					}}
				/>
				<SwitchRow
					label="With text"
					path="image.includeText"
					value={image.includeText}
					onChange={(includeText) => {
						set({ includeText });
					}}
				/>
			</InspectorSection>
			<ImageReferencesEditor
				references={image.references}
				onChange={(references) => {
					set({ references });
				}}
			/>
		</>
	);
}

/** One reference: a pinned file's thumbnail and name, or a link's field, and a remove button. */
function ImageReferenceRow({
	reference,
	index,
	onReplace,
	onRemove,
}: {
	reference: ImageReferenceDraft;
	index: number;
	onReplace: (next: ImageReferenceDraft) => void;
	onRemove: () => void;
}) {
	const statusAt = useFieldStatus();
	const label = `Reference ${String(index + 1)}`;
	const status = statusAt('references', index);
	return (
		<InspectorRow label={label} path="image.references" hasIssue={status !== undefined}>
			{'data' in reference ? (
				<StackItem size="fill">
					<HStack gap={2} vAlign="center">
						<Thumbnail
							src={`data:${reference.mimeType};base64,${reference.data}`}
							alt={reference.name}
							label={reference.name}
						/>
						<Text size="sm" maxLines={1}>
							{reference.name}
						</Text>
					</HStack>
				</StackItem>
			) : (
				<StackItem size="fill">
					<TextInput
						label={`${label} link`}
						isLabelHidden
						size="sm"
						status={status}
						value={reference.uri}
						placeholder="https://…/image.png"
						onChange={(uri) => {
							onReplace({ ...reference, uri });
						}}
					/>
				</StackItem>
			)}
			<IconButton
				label={`Remove ${label.toLowerCase()}`}
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconX} size="sm" />}
				onClick={onRemove}
			/>
		</InspectorRow>
	);
}

/** Reference images sent with every turn, ahead of what the user attaches: files or links. */
function ImageReferencesEditor({
	references,
	onChange,
}: {
	references: ImageReferenceDraft[];
	onChange: (references: ImageReferenceDraft[]) => void;
}) {
	const [reading, setReading] = useState(false);
	const replace = (key: string, next: ImageReferenceDraft) => {
		onChange(references.map((reference) => (reference.key === key ? next : reference)));
	};
	return (
		<InspectorSection title="References" path="image.references">
			{references.map((reference, index) => (
				<ImageReferenceRow
					key={reference.key}
					reference={reference}
					index={index}
					onReplace={(next) => {
						replace(reference.key, next);
					}}
					onRemove={() => {
						onChange(references.filter((candidate) => candidate.key !== reference.key));
					}}
				/>
			))}
			<FileInput
				label="Add images"
				isLabelHidden
				mode="dropzone"
				accept="image/*"
				isMultiple
				maxSize={REFERENCE_MAX_BYTES}
				isLoading={reading}
				placeholder="Drop images or choose files, up to 4 MB each"
				value={null}
				changeAction={async (files) => {
					const picked = files === null ? [] : Array.isArray(files) ? files : [files];
					if (!picked.length) return;
					setReading(true);
					try {
						onChange([...references, ...(await Promise.all(picked.map(referenceFromFile)))]);
					} finally {
						setReading(false);
					}
				}}
				onChange={() => undefined}
			/>
			<Button
				label="Add link"
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconPlus} size="sm" />}
				onClick={() => {
					onChange([...references, { key: draftKey('reference'), uri: '' }]);
				}}
			/>
		</InspectorSection>
	);
}

/** Speech pins. mp3 is only on offer when every model's protocol can make it. */
function SpeechEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const google = allGoogle(draft);
	const { speech } = draft;
	const set = patch(setDraft, 'speech');
	// Only the OpenAI protocol makes mp3; Gemini refuses it.
	const mp3 = draft.modelBindings.every((binding) => binding.protocol === 'openAi');
	return (
		<InspectorSection path="speech">
			<PresetRow
				google={google}
				label="Voice"
				path="speech.voice"
				value={speech.voice}
				preset={GOOGLE_SPEECH_VOICES}
				hasSearch
				onChange={(voice) => {
					set({ voice });
				}}
			/>
			<TextAreaRow
				label="Style"
				path="speech.style"
				field="style"
				value={speech.style}
				rows={2}
				onChange={(style) => {
					set({ style });
				}}
			/>
			<NumberRow
				label="Speed"
				path="speech.speed"
				field="speed"
				value={speech.speed}
				step={0.1}
				onChange={(speed) => {
					set({ speed });
				}}
			/>
			<ChoiceRow
				label="Format"
				path="speech.format"
				field="format"
				value={speech.format}
				options={[
					'pcm',
					{
						value: 'mp3',
						label: 'mp3',
						...(mp3 ? {} : { description: 'Only openAi models make mp3', disabled: true }),
					},
				]}
				onChange={(format) => {
					set({ format });
				}}
			/>
		</InspectorSection>
	);
}

/** Compression sliders move in steps of 1,024 tokens, which divides the free key's cap. */
const COMPRESSION_STEP = 1024;

/**
 * Google's sliding window when left blank: it triggers at 80% of the context window and keeps half
 * of that. Shown against the free key's cap, since that is the window a studio session has.
 */
const COMPRESSION_TRIGGER_DEFAULT = Math.round(GEMINI_STUDIO_LIVE_INPUT_TOKENS * 0.8);
const COMPRESSION_TARGET_DEFAULT = Math.round(COMPRESSION_TRIGGER_DEFAULT / 2);

/** The live slice of the draft and its setter, for each live section. */
interface LiveSectionProps {
	live: StudioDraft['live'];
	set: SetSection<'live'>;
}

function LiveIngressSection({ live, set }: LiveSectionProps) {
	return (
		<InspectorSection title="Ingress" path="live.ingress">
			<SwitchRow
				label="Audio"
				path="live.ingress.audio"
				value={live.ingressAudio}
				onChange={(ingressAudio) => {
					set({ ingressAudio });
				}}
			/>
			<SwitchRow
				label="Video"
				path="live.ingress.video"
				value={live.ingressVideo}
				onChange={(ingressVideo) => {
					set({ ingressVideo });
				}}
			/>
			<SwitchRow
				label="Text"
				path="live.ingress.text"
				value={live.ingressText}
				onChange={(ingressText) => {
					set({ ingressText });
				}}
			/>
		</InspectorSection>
	);
}

function LiveVoiceSection({ live, set, google }: LiveSectionProps & { google: boolean }) {
	return (
		<InspectorSection path="live.voice">
			<PresetRow
				google={google}
				label="Voice"
				path="live.voice"
				value={live.voice}
				preset={GOOGLE_SPEECH_VOICES}
				hasSearch
				onChange={(voice) => {
					set({ voice });
				}}
			/>
		</InspectorSection>
	);
}

function LiveSessionSection({ live, set }: LiveSectionProps) {
	return (
		<InspectorSection title="Session" path="live.sessionResumption">
			<SwitchRow
				label="Resumption"
				path="live.sessionResumption"
				value={live.sessionResumption}
				onChange={(sessionResumption) => {
					set({ sessionResumption });
				}}
			/>
			{live.sessionResumption && (
				<TextAreaRow
					label="On resume"
					path="live.resumed.prompt"
					field="resumedPrompt"
					value={live.resumedPrompt}
					rows={2}
					onChange={(resumedPrompt) => {
						set({ resumedPrompt });
					}}
				/>
			)}
			{live.sessionResumption && live.resumedPrompt.trim() !== '' && (
				<NumberRow
					label="Away for"
					path="live.resumed.afterMs"
					units="ms"
					field="resumedAfterMs"
					value={live.resumedAfterMs}
					min={0}
					isIntegerOnly
					onChange={(resumedAfterMs) => {
						set({ resumedAfterMs });
					}}
				/>
			)}
		</InspectorSection>
	);
}

/** What the agent is told to say when a call opens. */
function LiveGreetingSection({ live, set }: LiveSectionProps) {
	return (
		<InspectorSection path="live.greeting">
			<TextAreaRow
				label="Greeting"
				path="live.greeting"
				field="greeting"
				value={live.greeting}
				rows={2}
				onChange={(greeting) => {
					set({ greeting });
				}}
			/>
		</InspectorSection>
	);
}

/** The sliding window: in the demo its sizes are sliders, capped at the free key's window. */
function LiveCompressionSection({ live, set }: LiveSectionProps) {
	const mode = useContext(ConnectionMode);
	return (
		<InspectorSection path="live.contextCompression">
			<SwitchRow
				label="Sliding window"
				path="live.contextCompression"
				value={live.contextCompression}
				onChange={(contextCompression) => {
					set({ contextCompression });
				}}
			/>
			{live.contextCompression &&
				(mode === 'demo' ? (
					<CompressionSliderRows live={live} set={set} />
				) : (
					<CompressionNumberRows live={live} set={set} />
				))}
		</InspectorSection>
	);
}

function CompressionSliderRows({ live, set }: LiveSectionProps) {
	return (
		<>
			<SliderRow
				label="Trigger"
				path="live.contextCompression.triggerTokens"
				field="compressionTriggerTokens"
				value={live.compressionTriggerTokens}
				fallback={COMPRESSION_TRIGGER_DEFAULT}
				min={COMPRESSION_STEP}
				max={GEMINI_STUDIO_LIVE_INPUT_TOKENS}
				step={COMPRESSION_STEP}
				onChange={(compressionTriggerTokens) => {
					set({ compressionTriggerTokens });
				}}
			/>
			<SliderRow
				label="Keep"
				path="live.contextCompression.slidingWindow.targetTokens"
				field="compressionTargetTokens"
				value={live.compressionTargetTokens}
				fallback={COMPRESSION_TARGET_DEFAULT}
				min={COMPRESSION_STEP}
				max={GEMINI_STUDIO_LIVE_INPUT_TOKENS - COMPRESSION_STEP}
				step={COMPRESSION_STEP}
				onChange={(compressionTargetTokens) => {
					set({ compressionTargetTokens });
				}}
			/>
		</>
	);
}

function CompressionNumberRows({ live, set }: LiveSectionProps) {
	return (
		<>
			<NumberRow
				label="Trigger"
				path="live.contextCompression.triggerTokens"
				field="compressionTriggerTokens"
				value={live.compressionTriggerTokens}
				min={1}
				isIntegerOnly
				onChange={(compressionTriggerTokens) => {
					set({ compressionTriggerTokens });
				}}
			/>
			<NumberRow
				label="Keep"
				path="live.contextCompression.slidingWindow.targetTokens"
				field="compressionTargetTokens"
				value={live.compressionTargetTokens}
				min={1}
				isIntegerOnly
				onChange={(compressionTargetTokens) => {
					set({ compressionTargetTokens });
				}}
			/>
		</>
	);
}

function LiveTranscriptsSection({ live, set }: LiveSectionProps) {
	return (
		<InspectorSection title="Transcripts" path="live.transcription">
			<SwitchRow
				label="Input"
				path="live.transcription.input"
				value={live.transcriptionInput}
				onChange={(transcriptionInput) => {
					set({ transcriptionInput });
				}}
			/>
			<SwitchRow
				label="Output"
				path="live.transcription.output"
				value={live.transcriptionOutput}
				onChange={(transcriptionOutput) => {
					set({ transcriptionOutput });
				}}
			/>
		</InspectorSection>
	);
}

function LiveVadSection({ live, set }: LiveSectionProps) {
	return (
		<InspectorSection title="Voice activity" path="live.vad">
			<SegmentedRow
				label="Barge-in"
				path="live.vad.activityHandling"
				value={segmentOf(live.vadActivityHandling)}
				segments={BARGE_IN_SEGMENTS}
				onChange={(segment) => {
					set({ vadActivityHandling: pinOf(segment) });
				}}
			/>
			<SegmentedRow
				label="Start"
				path="live.vad.startSensitivity"
				value={segmentOf(live.vadStartSensitivity)}
				segments={START_SENSITIVITY_SEGMENTS}
				onChange={(segment) => {
					set({ vadStartSensitivity: pinOf(segment) });
				}}
			/>
			<SegmentedRow
				label="End"
				path="live.vad.endSensitivity"
				value={segmentOf(live.vadEndSensitivity)}
				segments={END_SENSITIVITY_SEGMENTS}
				onChange={(segment) => {
					set({ vadEndSensitivity: pinOf(segment) });
				}}
			/>
			<NumberRow
				label="Padding"
				path="live.vad.prefixPaddingMs"
				field="vadPrefixPaddingMs"
				value={live.vadPrefixPaddingMs}
				min={0}
				units="ms"
				isIntegerOnly
				onChange={(vadPrefixPaddingMs) => {
					set({ vadPrefixPaddingMs });
				}}
			/>
			<NumberRow
				label="Silence"
				path="live.vad.silenceDurationMs"
				field="vadSilenceDurationMs"
				value={live.vadSilenceDurationMs}
				min={0}
				units="ms"
				isIntegerOnly
				onChange={(vadSilenceDurationMs) => {
					set({ vadSilenceDurationMs });
				}}
			/>
		</InspectorSection>
	);
}

function LiveEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const google = allGoogle(draft);
	const { live } = draft;
	const set = patch(setDraft, 'live');
	return (
		<>
			<LiveIngressSection live={live} set={set} />
			<LiveVoiceSection live={live} set={set} google={google} />
			<LiveGreetingSection live={live} set={set} />
			<LiveSessionSection live={live} set={set} />
			<LiveCompressionSection live={live} set={set} />
			<LiveTranscriptsSection live={live} set={set} />
			<LiveVadSection live={live} set={set} />
		</>
	);
}

const OUTPUT_MODE_SEGMENTS: Segment<OutputsDraft['mode']>[] = [
	{ value: 'text', label: 'Free text', icon: IconAlignLeft },
	{ value: 'structured', label: 'Structured', icon: IconBraces },
];

type StreamMode = Exclude<OutputsDraft['streamMode'], ''>;

/** The kernel streams over SSE when the mode is left out, so SSE stands for the unset pin. */
const STREAM_MODE_SEGMENTS: Segment<StreamMode>[] = [
	{ value: 'sse', label: 'Streamed', icon: IconWaveSine },
	{ value: 'buffered', label: 'Buffered', icon: IconPackage },
];

const SCHEMA_PLACEHOLDER = `{
  "type": "object",
  "properties": { "answer": { "type": "string" } },
  "required": ["answer"]
}`;

/** The outputs slice of the draft and its setter, for each outputs section. */
interface OutputsSectionProps {
	outputs: OutputsDraft;
	set: SetSection<'outputs'>;
}

/** Free text or structured, and a structured reply's schema. */
function OutputShapeSection({
	outputs,
	set,
	structured,
}: OutputsSectionProps & { structured: boolean }) {
	return (
		<InspectorSection title="Shape" path="outputs.structured">
			<SegmentedRow
				label="Mode"
				path="outputs.structured"
				value={outputs.mode}
				segments={OUTPUT_MODE_SEGMENTS}
				onChange={(mode) => {
					set({ mode });
				}}
			/>
			{structured && (
				<>
					<TextRow
						label="Schema id"
						path="outputs.structured"
						field="schemaId"
						isRequired
						value={outputs.schemaId}
						placeholder="reply"
						onChange={(schemaId) => {
							set({ schemaId });
						}}
					/>
					<TextAreaRow
						label="JSON Schema"
						path="outputs.structured"
						field="schemaJson"
						isRequired
						rows={8}
						hasSpellCheck={false}
						value={outputs.schemaJson}
						placeholder={SCHEMA_PLACEHOLDER}
						onChange={(schemaJson) => {
							set({ schemaJson });
						}}
					/>
				</>
			)}
		</InspectorSection>
	);
}

function OutputRepairSection({ outputs, set }: OutputsSectionProps) {
	return (
		<InspectorSection title="Repair" path="outputs.validation">
			<SwitchRow
				label="Repair"
				path="outputs.validation"
				value={outputs.validationEnabled}
				onChange={(validationEnabled) => {
					set({ validationEnabled });
				}}
			/>
			{outputs.validationEnabled && (
				<>
					<NumberRow
						label="Retries"
						path="outputs.validation.maxRetries"
						units="retries"
						field="maxRetries"
						value={outputs.maxRetries}
						min={0}
						isIntegerOnly
						onChange={(maxRetries) => {
							set({ maxRetries });
						}}
					/>
					<TextAreaRow
						label="Guidance"
						path="lexicon.repair.default_guidance"
						field="repairGuidance"
						value={outputs.repairGuidance}
						placeholder={lexiconDefault('repair.default_guidance')}
						onChange={(repairGuidance) => {
							set({ repairGuidance });
						}}
					/>
				</>
			)}
		</InspectorSection>
	);
}

function OutputsEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const { outputs } = draft;
	const set = patch(setDraft, 'outputs');
	const shaped = draftAllows(draft, 'outputs.structured');
	const structured = shaped && outputs.mode === 'structured';
	return (
		<>
			{shaped && <OutputShapeSection outputs={outputs} set={set} structured={structured} />}
			{structured && <OutputRepairSection outputs={outputs} set={set} />}
			<InspectorSection title="Streaming" path="outputs.streaming">
				<SegmentedRow
					label="Delivery"
					path="outputs.streaming.mode"
					value={outputs.streamMode || 'sse'}
					segments={STREAM_MODE_SEGMENTS}
					onChange={(mode) => {
						set({ streamMode: mode === 'sse' ? '' : mode });
					}}
				/>
				<SwitchRow
					label="Thoughts"
					path="outputs.streaming.streamThoughts"
					value={outputs.streamThoughts}
					onChange={(streamThoughts) => {
						set({ streamThoughts });
					}}
				/>
			</InspectorSection>
		</>
	);
}

const STOP_KIND_LABEL: Record<ContinueStopKind, string> = {
	length: 'Length',
	stream_incomplete: 'Dropped stream',
	provider_error: 'Provider error',
};

/** Which stops a reply is continued after: `allow` offers a Continue, `auto` continues unasked. */
interface Resumption {
	allow: ContinueStopKind[];
	auto: ContinueStopKind[];
}

/**
 * The picks after one box of the grid changes. Continuing on its own implies it may be continued,
 * so checking Auto checks Offer, and unchecking Offer unchecks Auto.
 */
function pickKind(
	current: Resumption,
	kind: ContinueStopKind,
	column: 'offer' | 'auto',
	checked: boolean,
): Resumption {
	const offer = column === 'offer' ? checked : checked || current.allow.includes(kind);
	const auto = column === 'auto' ? checked : checked && current.auto.includes(kind);
	const set = (kinds: ContinueStopKind[], on: boolean) =>
		CONTINUE_STOP_KINDS.filter((candidate) =>
			candidate === kind ? on : kinds.includes(candidate),
		);
	return { allow: set(current.allow, offer), auto: set(current.auto, auto) };
}

/**
 * The trigger's tokens: each stop offered, a bolt on the ones that continue on their own, the
 * first few shown and the rest counted, as the list rows do.
 */
function ResumptionTokens({ allow, auto }: Resumption) {
	const maxBadges = useContext(ListBadges);
	const rest = allow.length - maxBadges;
	return (
		<HStack gap={1} vAlign="center">
			{allow.slice(0, maxBadges).map((kind) => (
				<Token
					key={kind}
					size="sm"
					label={STOP_KIND_LABEL[kind]}
					icon={auto.includes(kind) ? <Icon icon={IconBolt} size="sm" /> : undefined}
					description={auto.includes(kind) ? 'Continues on its own' : 'Offers Continue'}
				/>
			))}
			{rest > 0 && <Token size="sm" label={`+${String(rest)}`} />}
		</HStack>
	);
}

/** The picks in the open picker, and the callback that changes them. */
interface ResumptionGridProps {
	current: Resumption;
	change: (next: Resumption) => void;
}

/** One box of the grid: whether a stop kind is offered, or continues on its own. */
function ResumptionBox({
	current,
	change,
	kind,
	column,
}: ResumptionGridProps & { kind: ContinueStopKind; column: 'offer' | 'auto' }) {
	return (
		<CheckboxInput
			label={`${column === 'offer' ? 'Offer Continue' : 'Continue on its own'} after ${STOP_KIND_LABEL[kind].toLowerCase()}`}
			isLabelHidden
			value={(column === 'offer' ? current.allow : current.auto).includes(kind)}
			onChange={(checked) => {
				change(pickKind(current, kind, column, checked));
			}}
		/>
	);
}

/** The picker's grid: a row per stop kind, with an Offer box and an Auto box. */
function ResumptionGrid({ current, change }: ResumptionGridProps) {
	const kinds = fieldMeta('turnBehaviour.resumption.allowContinue')?.optionDescriptions;
	const offerDoc = fieldMeta('turnBehaviour.resumption.allowContinue')?.doc;
	const autoDoc = fieldMeta('turnBehaviour.resumption.autoContinue')?.doc;
	const box = (kind: ContinueStopKind, column: 'offer' | 'auto') => (
		<ResumptionBox current={current} change={change} kind={kind} column={column} />
	);
	return (
		<VStack width={280} padding={2}>
			<Table
				density="compact"
				dividers="rows"
				idKey="kind"
				data={CONTINUE_STOP_KINDS.map((kind) => ({ kind }))}
				columns={[
					{
						key: 'kind',
						header: 'After',
						width: proportional(1),
						renderCell: ({ kind }) => (
							<Tooltip content={kinds?.[kind]} hasHoverIndication={false}>
								{STOP_KIND_LABEL[kind]}
							</Tooltip>
						),
					},
					{
						key: 'offer',
						header: (
							<Tooltip content={offerDoc} hasHoverIndication={false}>
								Offer
							</Tooltip>
						),
						width: pixel(64),
						align: 'center',
						renderCell: ({ kind }) => box(kind, 'offer'),
					},
					{
						key: 'auto',
						header: (
							<Tooltip content={autoDoc} hasHoverIndication={false}>
								Auto
							</Tooltip>
						),
						width: pixel(64),
						align: 'center',
						renderCell: ({ kind }) => box(kind, 'auto'),
					},
				]}
			/>
		</VStack>
	);
}

/**
 * Resumption as one picker, a checklist per stop kind. Picking anything turns resumption on, and
 * clearing everything turns it off, so there is no separate switch.
 */
function ResumptionRow({
	value,
	onChange,
}: {
	value: Resumption;
	onChange: (next: Resumption) => void;
}) {
	return (
		<InspectorRow label="Continue after" path="turnBehaviour.resumption">
			<StackItem size="fill">
				<ComplexSelector
					label="Continue after"
					isLabelHidden
					size="sm"
					placement="below"
					value={value}
					triggerLabel={value.allow.length ? <ResumptionTokens {...value} /> : undefined}
					placeholder="Never"
					onChange={onChange}
				>
					{(current, change) => <ResumptionGrid current={current} change={change} />}
				</ComplexSelector>
			</StackItem>
		</InspectorRow>
	);
}

function ResumptionSection({
	draft,
	set,
}: {
	draft: StudioDraft;
	set: SetSection<'turnBehaviour'>;
}) {
	const turn = draft.turnBehaviour;
	return (
		<InspectorSection title="Resumption" path="turnBehaviour.resumption">
			<ResumptionRow
				value={
					turn.resumeEnabled
						? { allow: turn.allowContinue, auto: turn.autoContinue }
						: { allow: [], auto: [] }
				}
				onChange={({ allow, auto }) => {
					set({ resumeEnabled: allow.length > 0, allowContinue: allow, autoContinue: auto });
				}}
			/>
			{turn.resumeEnabled && (
				<>
					<NumberRow
						label="Max rounds"
						path="turnBehaviour.resumption.maxContinues"
						units="rounds"
						field="maxContinues"
						value={turn.maxContinues}
						min={1}
						isIntegerOnly
						onChange={(maxContinues) => {
							set({ maxContinues });
						}}
					/>
					{takesContinueInstruction(draft) && (
						<TextAreaRow
							label="Instruction"
							path="lexicon.continue.instruction"
							field="continueInstruction"
							value={turn.continueInstruction}
							placeholder={lexiconDefault('continue.instruction')}
							onChange={(continueInstruction) => {
								set({ continueInstruction });
							}}
						/>
					)}
				</>
			)}
		</InspectorSection>
	);
}

function TurnBehaviourEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const turn = draft.turnBehaviour;
	const set = patch(setDraft, 'turnBehaviour');
	return (
		<>
			{draftAllows(draft, 'turnBehaviour.resumption') && (
				<ResumptionSection draft={draft} set={set} />
			)}
			{draftAllows(draft, 'turnBehaviour.allowSteering') && (
				<InspectorSection path="turnBehaviour.allowSteering">
					<SwitchRow
						label="Steering"
						path="turnBehaviour.allowSteering"
						value={turn.allowSteering}
						onChange={(allowSteering) => {
							set({ allowSteering });
						}}
					/>
				</InspectorSection>
			)}
		</>
	);
}

/** The kernel retries when on-block is left out, so retry stands for the unset pin. */
const ON_BLOCK_SEGMENTS: Segment<BlockedReplyOnBlock>[] = [
	{ value: 'retry', label: 'Retry', icon: IconRefresh },
	{ value: 'refuse', label: 'Refuse', icon: IconHandStop },
];

type TaintGate = Exclude<GuardrailsDraft['taintAfterRemoteRead'], ''>;

/** Each threshold wears the icon of the tool access it starts refusing; none is the guard off. */
const TAINT_SEGMENTS: Segment<TaintGate>[] = [
	{ value: 'off', label: 'None', icon: IconShieldOff },
	{ value: 'destructive', label: 'Destructive', icon: IconFlame },
	{ value: 'write', label: 'Writes', icon: IconPencil },
];

type DestinationGate = Exclude<GuardrailsDraft['taintRemoteDestination'], ''>;

const DESTINATION_SEGMENTS: Segment<DestinationGate>[] = [
	{ value: 'off', label: 'Log', icon: IconFlag },
	{ value: 'confirm', label: 'Ask', icon: IconUserCheck },
	{ value: 'block', label: 'Refuse', icon: IconBan },
];

type UrlDetector = keyof GuardrailsDraft['allow'];
type UrlAllowDraft = GuardrailsDraft['allow'][UrlDetector];

/** The addresses an image or link detector lets through besides the ones the model was given. */
function UrlAllowRows({
	detector,
	allow,
	onChange,
}: {
	detector: UrlDetector;
	allow: UrlAllowDraft;
	onChange: (next: UrlAllowDraft) => void;
}) {
	return (
		<>
			<NamesRow
				label="Allowed hosts"
				path={`guardrails.detect.${detector}.allow.hosts`}
				field={`allow.${detector}.hosts`}
				value={allow.hosts}
				onChange={(hosts) => {
					onChange({ ...allow, hosts });
				}}
			/>
			<SwitchRow
				label="Tool URLs"
				path={`guardrails.detect.${detector}.allow.fromTools`}
				value={allow.fromTools}
				onChange={(fromTools) => {
					onChange({ ...allow, fromTools });
				}}
			/>
		</>
	);
}

/** The guardrails slice of the draft and its setter, for each guardrails section. */
interface GuardrailsSectionProps {
	guardrails: GuardrailsDraft;
	set: (change: Partial<GuardrailsDraft>) => void;
}

/** The note that binds the canary, on the canary leak detector's page while it reads somewhere. */
function CanarySection({ guardrails, set }: GuardrailsSectionProps) {
	return (
		<InspectorSection>
			<TextAreaRow
				label="Bind note"
				path="lexicon.canary.bind_note"
				field="canaryBindNote"
				value={guardrails.canaryBindNote}
				placeholder={lexiconDefault('canary.bind_note')}
				onChange={(canaryBindNote) => {
					set({ canaryBindNote });
				}}
			/>
		</InspectorSection>
	);
}

/**
 * Retries and guidance, shown when a blocked reply goes back to the agent. At no retries nothing goes
 * back, so the row says what the visitor reads in place of the reply, and guidance has no reader.
 */
function BlockedReplyRetryRows({
	guardrails,
	withheld,
	set,
}: GuardrailsSectionProps & {
	/** The line a visitor reads when a reply is withheld. */
	withheld: string;
}) {
	const isNever = guardrails.blockedReplyMaxRetries === 0;
	return (
		<>
			<NumberRow
				label="Retries"
				path="guardrails.blockedReply.maxRetries"
				units="retries"
				field="blockedReplyMaxRetries"
				value={guardrails.blockedReplyMaxRetries}
				min={0}
				isIntegerOnly
				status={
					isNever
						? {
								type: 'warning',
								message: `At 0 a blocked reply is not rewritten. The visitor reads: \u201c${withheld}\u201d`,
							}
						: undefined
				}
				onChange={(blockedReplyMaxRetries) => {
					set({ blockedReplyMaxRetries });
				}}
			/>
			{!isNever && (
				<TextAreaRow
					label="Guidance"
					path="lexicon.egress.default_repair_guidance"
					field="egressRepairGuidance"
					value={guardrails.egressRepairGuidance}
					placeholder={lexiconDefault('egress.default_repair_guidance')}
					onChange={(egressRepairGuidance) => {
						set({ egressRepairGuidance });
					}}
				/>
			)}
		</>
	);
}

/** What happens to a reply a detector blocks. */
function BlockedReplySection({
	guardrails,
	withheld,
	set,
}: GuardrailsSectionProps & { withheld: string }) {
	return (
		<InspectorSection path="guardrails.blockedReply">
			<SegmentedRow
				label="On block"
				path="guardrails.blockedReply.onBlock"
				value={guardrails.blockedReplyOnBlock || 'retry'}
				segments={ON_BLOCK_SEGMENTS}
				onChange={(onBlock) => {
					set({ blockedReplyOnBlock: onBlock === 'retry' ? '' : onBlock });
				}}
			/>
			{guardrails.blockedReplyOnBlock === 'refuse' ? (
				<TextAreaRow
					label="Message"
					path="lexicon.egress.refusal"
					field="egressRefusal"
					value={guardrails.egressRefusal}
					placeholder={lexiconDefault('egress.refusal')}
					onChange={(egressRefusal) => {
						set({ egressRefusal });
					}}
				/>
			) : (
				<BlockedReplyRetryRows guardrails={guardrails} withheld={withheld} set={set} />
			)}
		</InspectorSection>
	);
}

function NetworkSection({ guardrails, set }: GuardrailsSectionProps) {
	const mode = useContext(ConnectionMode);
	const runtime = useContext(LocalConnection)?.runtime ?? { mode };
	return (
		<InspectorSection title="Network" path="guardrails.network" note={studioNetworkNote(runtime)}>
			<SwitchRow
				label="Private"
				path="guardrails.network.allowPrivateNetworks"
				value={guardrails.allowPrivateNetworks}
				onChange={(allowPrivateNetworks) => {
					set({ allowPrivateNetworks });
				}}
			/>
			<NamesRow
				label="Allow hosts"
				path="guardrails.network.allowedHosts"
				field="allowedHosts"
				value={guardrails.allowedHosts}
				placeholder="None: private hosts stay blocked"
				isDisabled={guardrails.allowPrivateNetworks}
				disabledMessage="Every private host is already allowed."
				onChange={(allowedHosts) => {
					set({ allowedHosts });
				}}
			/>
			<NamesRow
				label="Schemes"
				path="guardrails.network.allowedSchemes"
				field="allowedSchemes"
				value={guardrails.allowedSchemes}
				onChange={(allowedSchemes) => {
					set({ allowedSchemes });
				}}
			/>
		</InspectorSection>
	);
}

function QuotaSection({ guardrails, set }: GuardrailsSectionProps) {
	return (
		<InspectorSection title="Quota" path="guardrails.quota" note={sectionNote('quota')}>
			<SwitchRow
				label="Daily cap"
				path="guardrails.quota"
				value={guardrails.quotaEnabled}
				onChange={(quotaEnabled) => {
					set({ quotaEnabled });
				}}
			/>
			{guardrails.quotaEnabled && (
				<>
					<NumberRow
						label="Per day"
						path="guardrails.quota.perDay"
						field="quotaPerDay"
						isRequired
						value={guardrails.quotaPerDay}
						min={1}
						units="turns"
						isIntegerOnly
						onChange={(quotaPerDay) => {
							set({ quotaPerDay });
						}}
					/>
					<TextAreaRow
						label="Message"
						path="lexicon.quota.exhausted"
						field="quotaMessage"
						value={guardrails.quotaMessage}
						placeholder={lexiconDefault('quota.exhausted', {
							perDay: guardrails.quotaPerDay ?? '{perDay}',
						})}
						onChange={(quotaMessage) => {
							set({ quotaMessage });
						}}
					/>
				</>
			)}
		</InspectorSection>
	);
}

/** Every action, so one the kernel adds fails the type check until it has an icon. */
const DETECT_ACTION_ICON: Record<DetectAction, IconType> = {
	ignore: IconEyeOff,
	flag: IconFlag,
	redact: IconEraser,
	block: IconBan,
};
/** Every action, with the one the kernel recommends marked. */
function detectSegments(recommended?: DetectAction): Segment<DetectAction>[] {
	return DETECT_ACTIONS.map((action) => ({
		value: action,
		label: DETECT_ACTION_META[action].label,
		icon: DETECT_ACTION_ICON[action],
		isRecommended: action === recommended,
	}));
}
/** "Mixed": the pick a detector shows while its boundaries differ. Offered only then, already picked. */
const MIXED_SEGMENT: Segment<'mixed'> = {
	value: 'mixed',
	label: 'Mixed',
	icon: IconAdjustmentsHorizontal,
	description: sectionNote('detect.mixed'),
};

type ToolKind = (typeof TOOL_KINDS)[number];
const TOOL_KIND_LABEL: Record<ToolKind, string> = {
	function: 'Function',
	http: 'HTTP',
	mcp: 'MCP',
	agent: 'Agent',
};
/** Where a tool's text crosses, with the boundary each kind of tool has there. */
const TOOL_CROSSINGS: { title: string; boundary: (kind: ToolKind) => Boundary }[] = [
	{ title: 'Tool arguments', boundary: (kind) => `tool_arguments_${kind}` },
	{ title: 'Tool output', boundary: (kind) => `tool_output_${kind}` },
	{ title: 'Tool errors', boundary: (kind) => `tool_failure_${kind}` },
];
const TOOL_BOUNDARY_SET: ReadonlySet<Boundary> = new Set(TOOL_BOUNDARIES);

/** A detector's catalog key: Theorem's by name, and `*` for any of the builder's own. */
type DetectorPath = Detector | '*';

/** One boundary of one detector: what happens to a match there. */
function BoundaryRow({
	label,
	detector,
	boundary,
	actions,
	recommended,
	onChange,
}: {
	label: string;
	detector: DetectorPath;
	boundary: Boundary;
	actions: Record<Boundary, DetectAction>;
	recommended?: DetectAction;
	onChange: (next: Record<Boundary, DetectAction>) => void;
}) {
	return (
		<SegmentedRow
			label={label}
			path={`guardrails.detect.${detector}.at.${boundary}`}
			value={actions[boundary]}
			segments={detectSegments(recommended)}
			onChange={(action) => {
				onChange({ ...actions, [boundary]: action });
			}}
		/>
	);
}

/**
 * One control for a detector's every boundary: it shows the action they share, or "Mixed" when
 * they differ, and a pick sets them all.
 */
function ActionRow({
	detector,
	label,
	defaults,
	boundaries,
	actions,
	status,
	trailing,
	onChange,
}: {
	detector: DetectorPath;
	label: string;
	/** What the kernel does at each boundary left alone; a builder's own detector has none. */
	defaults?: Readonly<Partial<Record<Boundary, DetectAction>>>;
	boundaries: readonly Boundary[];
	actions: Record<Boundary, DetectAction>;
	status?: ReturnType<ReturnType<typeof useFieldStatus>>;
	trailing?: ReactNode;
	onChange: (next: Record<Boundary, DetectAction>) => void;
}) {
	const taken = [...new Set(boundaries.map((boundary) => actions[boundary]))];
	const uniform = taken.length === 1;
	// One action is recommended for the whole detector only when every boundary recommends the same.
	const recommended = [...new Set(boundaries.map((boundary) => defaults?.[boundary]))];
	const segments = detectSegments(recommended.length === 1 ? recommended[0] : undefined);
	return (
		<SegmentedRow
			label={label}
			path={`guardrails.detect.${detector}.action`}
			value={uniform ? taken[0] : 'mixed'}
			segments={uniform ? segments : [...segments, MIXED_SEGMENT]}
			status={status}
			trailing={trailing}
			onChange={(action) => {
				if (action === 'mixed') return;
				const next = { ...actions };
				for (const boundary of boundaries) next[boundary] = action;
				onChange(next);
			}}
		/>
	);
}

/** Every boundary of one detector, in the kernel's order, a tool's under the crossing it is. */
function BoundaryRows({
	detector,
	defaults,
	boundaries,
	actions,
	onChange,
}: {
	detector: DetectorPath;
	defaults?: Readonly<Partial<Record<Boundary, DetectAction>>>;
	boundaries: readonly Boundary[];
	actions: Record<Boundary, DetectAction>;
	onChange: (next: Record<Boundary, DetectAction>) => void;
}) {
	const has = new Set(boundaries);
	// The boundaries that are not a tool's, which sit either side of the tool ones in the kernel's order.
	const plain = boundaries.filter((boundary) => !TOOL_BOUNDARY_SET.has(boundary));
	const firstTool = BOUNDARIES.findIndex((boundary) => TOOL_BOUNDARY_SET.has(boundary));
	const row = (boundary: Boundary, label: string) => (
		<BoundaryRow
			key={boundary}
			label={label}
			detector={detector}
			boundary={boundary}
			actions={actions}
			recommended={defaults?.[boundary]}
			onChange={onChange}
		/>
	);
	return (
		<>
			{plain
				.filter((boundary) => BOUNDARIES.indexOf(boundary) < firstTool)
				.map((boundary) => row(boundary, BOUNDARY_META[boundary].label))}
			{TOOL_CROSSINGS.filter((crossing) =>
				TOOL_KINDS.some((kind) => has.has(crossing.boundary(kind))),
			).map((crossing) => (
				<VStack key={crossing.title} gap={2}>
					<InspectorGroupTitle title={crossing.title} />
					{TOOL_KINDS.filter((kind) => has.has(crossing.boundary(kind))).map((kind) =>
						row(crossing.boundary(kind), TOOL_KIND_LABEL[kind]),
					)}
				</VStack>
			))}
			{plain
				.filter((boundary) => BOUNDARIES.indexOf(boundary) > firstTool)
				.map((boundary) => row(boundary, BOUNDARY_META[boundary].label))}
		</>
	);
}

/**
 * What a detector does with a match: one control for every boundary, and each boundary's own
 * under it, shut until opened. It starts open while the boundaries differ.
 */
function ActionSection({
	detector,
	defaults,
	boundaries,
	actions,
	status,
	onChange,
}: {
	detector: DetectorPath;
	defaults?: Readonly<Partial<Record<Boundary, DetectAction>>>;
	boundaries: readonly Boundary[];
	actions: Record<Boundary, DetectAction>;
	status?: ReturnType<ReturnType<typeof useFieldStatus>>;
	onChange: (next: Record<Boundary, DetectAction>) => void;
}) {
	const uniform = new Set(boundaries.map((boundary) => actions[boundary])).size === 1;
	return (
		<InspectorSection>
			<ActionRow
				detector={detector}
				label="On a match"
				defaults={defaults}
				boundaries={boundaries}
				actions={actions}
				status={status}
				onChange={onChange}
			/>
			{boundaries.length > 1 && (
				<CollapsibleGroup type="multiple" density="compact" defaultValue={uniform ? [] : ['each']}>
					<Collapsible value="each" trigger={<Text type="supporting">Each boundary</Text>}>
						<VStack gap={3}>
							<BoundaryRows
								detector={detector}
								defaults={defaults}
								boundaries={boundaries}
								actions={actions}
								onChange={onChange}
							/>
						</VStack>
					</Collapsible>
				</CollapsibleGroup>
			)}
		</InspectorSection>
	);
}

const PATTERN_KIND_SEGMENTS: Segment<PatternDraft['kind']>[] = [
	{ value: 'words', label: 'Words', icon: IconAbc },
	{ value: 'pattern', label: 'Regular expression', icon: IconRegex },
];

/** The flags a regular expression takes, each by what it does. */
const REGEX_FLAGS = [
	{ flag: 'i', label: 'Ignore case' },
	{ flag: 'm', label: '^ and $ match each line' },
	{ flag: 's', label: '. matches line breaks' },
	{ flag: 'u', label: 'Unicode' },
];

/** A regular expression's flags as a checklist: the ones set are checked. */
function RegexFlagsRow({
	detector,
	flags,
	onChange,
}: {
	detector: DetectorPath;
	flags: string;
	onChange: (next: string) => void;
}) {
	return (
		<InspectorRow label="Options" path={`guardrails.detect.${detector}.patterns.*.flags`}>
			<StackItem size="fill">
				<CheckboxList
					label="Options"
					isLabelHidden
					density="compact"
					value={REGEX_FLAGS.filter(({ flag }) => flags.includes(flag)).map(({ flag }) => flag)}
					onChange={(checked) => {
						onChange(
							REGEX_FLAGS.filter(({ flag }) => checked.includes(flag))
								.map(({ flag }) => flag)
								.join(''),
						);
					}}
				>
					{REGEX_FLAGS.map(({ flag, label }) => (
						<CheckboxListItem key={flag} value={flag} label={label} />
					))}
				</CheckboxList>
			</StackItem>
		</InspectorRow>
	);
}

/** One of the builder's patterns: its name, and the words or the regular expression it matches. */
function PatternRows({
	detector,
	pattern,
	index,
	status,
	onChange,
	onRemove,
}: {
	detector: DetectorPath;
	pattern: PatternDraft;
	index: number;
	status?: ReturnType<ReturnType<typeof useFieldStatus>>;
	onChange: (next: PatternDraft) => void;
	onRemove: () => void;
}) {
	const remove = `Remove ${pattern.name.trim() || `pattern ${String(index + 1)}`}`;
	return (
		<VStack gap={2}>
			<InspectorRow
				label="Name"
				path={`guardrails.detect.${detector}.patterns.*.name`}
				hasIssue={status !== undefined}
			>
				<StackItem size="fill">
					<TextInput
						label={`Pattern ${String(index + 1)} name`}
						isLabelHidden
						size="sm"
						status={status}
						value={pattern.name}
						placeholder="codenames"
						onChange={(name) => {
							onChange({ ...pattern, name });
						}}
					/>
				</StackItem>
				<Tooltip content={remove}>
					<IconButton
						label={remove}
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconX} size="sm" />}
						onClick={onRemove}
					/>
				</Tooltip>
			</InspectorRow>
			<SegmentedRow
				label="Matches"
				path={`guardrails.detect.${detector}.patterns`}
				value={pattern.kind}
				segments={PATTERN_KIND_SEGMENTS}
				onChange={(kind) => {
					onChange({ ...pattern, kind });
				}}
			/>
			{pattern.kind === 'words' ? (
				<NamesRow
					label="Words"
					path={`guardrails.detect.${detector}.patterns.*.words`}
					value={pattern.words}
					placeholder="Bluebird"
					onChange={(words) => {
						onChange({ ...pattern, words });
					}}
				/>
			) : (
				<>
					<TextRow
						label="Expression"
						path={`guardrails.detect.${detector}.patterns.*.pattern`}
						value={pattern.pattern}
						hint="ORD-\d{6}"
						onChange={(source) => {
							onChange({ ...pattern, pattern: source });
						}}
					/>
					<RegexFlagsRow
						detector={detector}
						flags={pattern.flags}
						onChange={(flags) => {
							onChange({ ...pattern, flags });
						}}
					/>
				</>
			)}
		</VStack>
	);
}

/** The builder's own patterns for one detector; `field` is the draft field their issues are reported at. */
function PatternList({
	detector,
	field,
	patterns,
	onChange,
}: {
	detector: DetectorPath;
	field: string;
	patterns: PatternDraft[];
	onChange: (next: PatternDraft[]) => void;
}) {
	const status = useFieldStatus()(field);
	return (
		<>
			{patterns.map((pattern, index) => (
				<PatternRows
					// biome-ignore lint/suspicious/noArrayIndexKey: patterns have no id and are only appended or removed
					key={index}
					detector={detector}
					pattern={pattern}
					index={index}
					status={status}
					onChange={(next) => {
						onChange(patterns.map((each, at) => (at === index ? next : each)));
					}}
					onRemove={() => {
						onChange(patterns.filter((_, at) => at !== index));
					}}
				/>
			))}
			<Button
				label="Add pattern"
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconPlus} size="sm" />}
				onClick={() => {
					onChange([...patterns, newPattern()]);
				}}
			/>
		</>
	);
}

type PatternUse = 'theorem' | 'mine' | 'both';
const PATTERN_USE_SEGMENTS: Segment<PatternUse>[] = [
	{
		value: 'theorem',
		label: "theorem's",
		icon: IconTheorem,
		description: sectionNote('detect.source.theorem'),
	},
	{
		value: 'mine',
		label: 'Mine',
		icon: IconWriting,
		description: sectionNote('detect.source.mine'),
	},
	{
		value: 'both',
		label: 'Both',
		icon: IconLayersUnion,
		description: sectionNote('detect.source.both'),
	},
];

/**
 * Whose patterns one of Theorem's detectors reads with, and the builder's when it reads with them.
 * Patterns set aside by a move to Theorem's alone come back on a move away, while the page is open.
 */
function PatternSourceSection({
	detector,
	source,
	onChange,
}: {
	detector: Detector;
	source: PatternSourceDraft;
	onChange: (next: PatternSourceDraft) => void;
}) {
	const setAside = useRef<PatternDraft[]>([]);
	const mine = source.patterns.length > 0;
	const use: PatternUse = source.theorem ? (mine ? 'both' : 'theorem') : 'mine';
	return (
		<InspectorSection title="Patterns">
			<SegmentedRow
				label="Read with"
				path={`guardrails.detect.${detector}.theorem`}
				value={use}
				segments={PATTERN_USE_SEGMENTS}
				onChange={(next) => {
					if (next === 'theorem') {
						setAside.current = source.patterns;
						onChange({ ...source, theorem: true, patterns: [] });
						return;
					}
					const kept = setAside.current.length ? setAside.current : [newPattern()];
					onChange({
						...source,
						theorem: next === 'both',
						patterns: mine ? source.patterns : kept,
					});
				}}
			/>
			{use !== 'theorem' && (
				<PatternList
					detector={detector}
					field={`sources.${detector}.patterns`}
					patterns={source.patterns}
					onChange={(patterns) => {
						onChange({ ...source, patterns });
					}}
				/>
			)}
			{/* A hint speaks for the builder's patterns, so it shows once there is one. */}
			{mine && (
				<TextRow
					label="Retry hint"
					path={`guardrails.detect.${detector}.hint`}
					field={`sources.${detector}.hint`}
					value={source.hint}
					onChange={(hint) => {
						onChange({ ...source, hint });
					}}
				/>
			)}
		</InspectorSection>
	);
}

function isUrlDetector(detector: Detector): detector is UrlDetector {
	return DETECTOR_META[detector].allow === 'urls';
}

/** The detector the editor has open: one of Theorem's by name, or one of the builder's by position. */
type OpenDetector = { detector: Detector } | { own: number };

/** A problem with the detectors as a whole, such as a key of the builder's the kernel refuses. */
function DetectIssue() {
	const status = useFieldStatus()('detect');
	return status?.message ? <Banner status="error" title={status.message} /> : null;
}

/**
 * What a detector's row says when a field on its page has an issue, so the list shows where: the
 * issue when there is one, a count when there are more, since the page says each on its own row.
 */
function usePageIssues(): (
	onPage: (issue: StudioIssue) => boolean,
) => ReturnType<ReturnType<typeof useFieldStatus>> | undefined {
	const issues = useContext(NodeIssues);
	return (onPage) => {
		const messages = issues.filter(onPage).map((issue) => issue.message);
		if (messages.length === 0) return undefined;
		const [only] = messages;
		return {
			type: 'error',
			message: messages.length === 1 ? only : `${String(messages.length)} things to fix`,
		};
	};
}

/** The button at the end of a detector's row that opens its page. */
function OpenDetectorButton({ label, onOpen }: { label: string; onOpen: () => void }) {
	const open = `Open ${label}: patterns and boundaries`;
	return (
		<Tooltip content={open}>
			<IconButton
				label={open}
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconChevronRight} size="sm" />}
				onClick={onOpen}
			/>
		</Tooltip>
	);
}

/** What an own detector is called before it has a label. */
const ownName = (detector: OwnDetectorDraft) =>
	detector.label.trim() || detector.key.trim() || 'New detector';

/**
 * Every detector on one line: its name and what it does with a match, then the button that opens
 * its page. Theorem's sit under their group, the builder's own under "Custom detectors", and one that applies
 * at no boundary the profile has is left out.
 */
function DetectSection({
	guardrails,
	boundaries,
	set,
	onOpen,
}: GuardrailsSectionProps & {
	boundaries: readonly Boundary[];
	onOpen: (open: OpenDetector) => void;
}) {
	const { detect, own } = guardrails;
	const pageIssue = usePageIssues();
	const has = new Set(boundaries);
	const groups = DETECTOR_GROUPS.map((group) => ({
		group,
		rows: DETECTORS.filter((detector) => DETECTOR_META[detector].group === group)
			.map((detector) => ({
				detector,
				applies: DETECTOR_BOUNDARIES[detector].filter((boundary) => has.has(boundary)),
			}))
			.filter(({ applies }) => applies.length > 0),
	})).filter(({ rows }) => rows.length > 0);
	return (
		<InspectorSection title="Detect" path="guardrails.detect">
			<DetectIssue />
			{groups.map(({ group, rows }) => (
				<VStack key={group} gap={2}>
					<InspectorGroupTitle
						title={DETECTOR_GROUP_META[group].label}
						hint={DETECTOR_GROUP_META[group].doc}
					/>
					{rows.map(({ detector, applies }) => (
						<ActionRow
							key={detector}
							detector={detector}
							label={DETECTOR_META[detector].short ?? DETECTOR_META[detector].label}
							defaults={DETECTOR_META[detector].defaults}
							boundaries={applies}
							actions={detect[detector]}
							status={pageIssue(
								({ field }) =>
									field?.startsWith(`sources.${detector}.`) === true ||
									field?.startsWith(`allow.${detector}.`) === true ||
									(field === 'innocentNames' && DETECTOR_META[detector].allow === 'names'),
							)}
							trailing={
								<OpenDetectorButton
									label={DETECTOR_META[detector].label}
									onOpen={() => {
										onOpen({ detector });
									}}
								/>
							}
							onChange={(actions) => {
								set({ detect: { ...detect, [detector]: actions } });
							}}
						/>
					))}
				</VStack>
			))}
			<VStack gap={2}>
				<InspectorGroupTitle title="Custom detectors" hint={sectionNote('detect.own')} />
				{own.map((detector, index) => (
					<ActionRow
						// biome-ignore lint/suspicious/noArrayIndexKey: detectors are keyed by text the builder is typing
						key={index}
						detector="*"
						label={ownName(detector)}
						boundaries={boundaries}
						actions={detector.at}
						status={pageIssue(
							({ field, index: at }) =>
								(field === 'own' && at === index) ||
								field?.startsWith(`own.${String(index)}.`) === true,
						)}
						trailing={
							<OpenDetectorButton
								label={ownName(detector)}
								onOpen={() => {
									onOpen({ own: index });
								}}
							/>
						}
						onChange={(at) => {
							set({ own: own.map((each, i) => (i === index ? { ...detector, at } : each)) });
						}}
					/>
				))}
				<Button
					label="Add detector"
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconPlus} size="sm" />}
					onClick={() => {
						set({ own: [...own, newOwnDetector()] });
						onOpen({ own: own.length });
					}}
				/>
			</VStack>
		</InspectorSection>
	);
}

/**
 * The top of a detector's page: the way back to the list, its name, and what it finds.
 */
function DetectorHeader({
	title,
	doc,
	trailing,
	onBack,
}: {
	title: string;
	doc?: string;
	trailing?: ReactNode;
	onBack: () => void;
}) {
	return (
		<Section variant="transparent" padding={3}>
			<VStack gap={1}>
				<HStack gap={1} vAlign="center">
					<Tooltip content="Back to detectors">
						<IconButton
							label="Back to detectors"
							variant="ghost"
							size="sm"
							icon={<Icon icon={IconArrowLeft} size="sm" />}
							onClick={onBack}
						/>
					</Tooltip>
					<StackItem size="fill">
						<Text type="label" weight="semibold">
							{title}
						</Text>
					</StackItem>
					{trailing}
				</HStack>
				{doc && <Text type="supporting">{doc}</Text>}
				<DetectIssue />
			</VStack>
		</Section>
	);
}

/** One of Theorem's detectors: its action, whose patterns it reads with, what it lets through, its boundaries. */
function DetectorPage({
	detector,
	boundaries,
	hasCanary,
	guardrails,
	set,
	onBack,
}: GuardrailsSectionProps & {
	detector: Detector;
	/** The boundaries of the profile the detector applies at. */
	boundaries: readonly Boundary[];
	/** The profile plants a canary, so the note that binds it can be worded. */
	hasCanary: boolean;
	onBack: () => void;
}) {
	const { detect, allow, sources, innocentNames } = guardrails;
	const meta = DETECTOR_META[detector];
	const setActions = (actions: Record<Boundary, DetectAction>) => {
		set({ detect: { ...detect, [detector]: actions } });
	};
	return (
		<>
			<DetectorHeader title={meta.label} doc={meta.doc} onBack={onBack} />
			<ActionSection
				detector={detector}
				defaults={meta.defaults}
				boundaries={boundaries}
				actions={detect[detector]}
				onChange={setActions}
			/>
			{detector === 'canary_leak' && hasCanary && (
				<CanarySection guardrails={guardrails} set={set} />
			)}
			{meta.patterns && (
				<PatternSourceSection
					detector={detector}
					source={sources[detector]}
					onChange={(next) => {
						set({ sources: { ...sources, [detector]: next } });
					}}
				/>
			)}
			{isUrlDetector(detector) && (
				<InspectorSection title="Allow">
					<UrlAllowRows
						detector={detector}
						allow={allow[detector]}
						onChange={(next) => {
							set({ allow: { ...allow, [detector]: next } });
						}}
					/>
				</InspectorSection>
			)}
			{meta.allow === 'names' && (
				<InspectorSection title="Allow">
					<NamesRow
						label="Names"
						path={`guardrails.detect.${detector}.allow.names`}
						field="innocentNames"
						value={innocentNames}
						onChange={(names) => {
							set({ innocentNames: names });
						}}
					/>
				</InspectorSection>
			)}
			<DetectorTester only={detector} />
		</>
	);
}

/** One detector of the builder's own: its name and key, its action, its patterns, its boundaries. */
function OwnDetectorPage({
	detector,
	index,
	boundaries,
	onChange,
	onRemove,
	onBack,
}: {
	detector: OwnDetectorDraft;
	index: number;
	boundaries: readonly Boundary[];
	onChange: (next: OwnDetectorDraft) => void;
	onRemove: () => void;
	onBack: () => void;
}) {
	const statusAt = useFieldStatus();
	const status = statusAt('own', index);
	const remove = `Remove ${ownName(detector)}`;
	const setActions = (at: Record<Boundary, DetectAction>) => {
		onChange({ ...detector, at });
	};
	return (
		<>
			<DetectorHeader
				title={ownName(detector)}
				doc={fieldMeta('guardrails.detect.*')?.doc}
				trailing={
					<Tooltip content={remove}>
						<IconButton
							label={remove}
							variant="ghost"
							size="sm"
							icon={<Icon icon={IconTrash} size="sm" />}
							onClick={onRemove}
						/>
					</Tooltip>
				}
				onBack={onBack}
			/>
			<InspectorSection title="Detector">
				<TextRow
					label="Name"
					path="guardrails.detect.*.label"
					field={`own.${String(index)}.label`}
					value={detector.label}
					placeholder="Codenames"
					onChange={(label) => {
						onChange({ ...detector, label });
					}}
				/>
				<TextRow
					label="Key"
					path="guardrails.detect.*"
					status={status}
					value={detector.key}
					placeholder="acme.codenames"
					onChange={(key) => {
						onChange({ ...detector, key });
					}}
				/>
			</InspectorSection>
			<ActionSection
				detector="*"
				boundaries={boundaries}
				actions={detector.at}
				status={statusAt(`own.${String(index)}.at`)}
				onChange={setActions}
			/>
			<InspectorSection>
				<PatternList
					detector="*"
					field={`own.${String(index)}.patterns`}
					patterns={detector.patterns}
					onChange={(patterns) => {
						onChange({ ...detector, patterns });
					}}
				/>
				<TextRow
					label="Retry hint"
					path="guardrails.detect.*.hint"
					field={`own.${String(index)}.hint`}
					value={detector.hint}
					onChange={(hint) => {
						onChange({ ...detector, hint });
					}}
				/>
			</InspectorSection>
			<DetectorTester only={detector.key} />
		</>
	);
}

/** The page for `open`, or `undefined` when what it names is gone or applies nowhere in this profile. */
function openDetectorPage(
	open: OpenDetector | null,
	{ guardrails, set }: GuardrailsSectionProps,
	boundaries: readonly Boundary[],
	hasCanary: boolean,
	onBack: () => void,
): ReactNode {
	if (open === null) return undefined;
	if ('detector' in open) {
		const has = new Set(boundaries);
		const applies = DETECTOR_BOUNDARIES[open.detector].filter((boundary) => has.has(boundary));
		if (applies.length === 0) return undefined;
		return (
			<DetectorPage
				detector={open.detector}
				boundaries={applies}
				hasCanary={hasCanary}
				guardrails={guardrails}
				set={set}
				onBack={onBack}
			/>
		);
	}
	const { own } = guardrails;
	const detector = own.at(open.own);
	if (!detector) return undefined;
	return (
		<OwnDetectorPage
			detector={detector}
			index={open.own}
			boundaries={boundaries}
			onChange={(next) => {
				set({ own: own.map((each, at) => (at === open.own ? next : each)) });
			}}
			onRemove={() => {
				set({ own: own.filter((_, at) => at !== open.own) });
				onBack();
			}}
			onBack={onBack}
		/>
	);
}

/** The nearest element above `node` that scrolls it. */
function scrollerOf(node: HTMLElement): HTMLElement | null {
	for (let up = node.parentElement; up; up = up.parentElement) {
		if (/auto|scroll/.test(getComputedStyle(up).overflowY)) return up;
	}
	return null;
}

/** Fades `node` out at the theme's fast duration and standard curve, at once when motion is off. */
async function fadeOut(node: HTMLElement): Promise<void> {
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	const style = getComputedStyle(node);
	const time = style.getPropertyValue('--duration-fast').trim();
	const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], {
		duration: Number.parseFloat(time) * (time.endsWith('ms') ? 1 : 1000),
		easing: style.getPropertyValue('--ease-standard').trim(),
		fill: 'forwards',
	});
	await fade.finished.catch(() => undefined);
}

function GuardrailsEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const { guardrails } = draft;
	const set = patch(setDraft, 'guardrails');
	const boundaries = draft.identity.profileType === 'host' ? TOOL_BOUNDARIES : BOUNDARIES;
	const [open, setOpen] = useState<OpenDetector | null>(null);
	const view = useRef<HTMLDivElement>(null);
	// Where the list was scrolled to when a page opened, to put it back there.
	const listScroll = useRef(0);
	const leavePage = useContext(LeavePage);
	/** Fades the view out, then swaps it; the one that mounts fades in (`.detector-view`). */
	const show = (next: OpenDetector | null) => {
		const node = view.current;
		if (node && open === null) listScroll.current = scrollerOf(node)?.scrollTop ?? 0;
		const left = leavePage();
		const swap = () => {
			left();
			setOpen(next);
		};
		if (node) void fadeOut(node).then(swap);
		else swap();
	};
	const page = openDetectorPage(open, { guardrails, set }, boundaries, plantsCanary(draft), () => {
		show(null);
	});
	const viewKey = page ? JSON.stringify(open) : 'list';
	const shown = useRef(viewKey);
	// A page opens at its top, and the list comes back where it was left, before either fades in.
	useLayoutEffect(() => {
		const node = view.current;
		if (!node || shown.current === viewKey) return;
		shown.current = viewKey;
		if (viewKey === 'list') scrollerOf(node)?.scrollTo({ top: listScroll.current });
		else node.scrollIntoView({ block: 'start' });
	}, [viewKey]);
	if (page) {
		return (
			<div key={viewKey} ref={view} className="detector-view">
				{page}
			</div>
		);
	}
	return (
		<div key={viewKey} ref={view} className="detector-view">
			<DetectSection guardrails={guardrails} boundaries={boundaries} set={set} onOpen={show} />
			{draftAllows(draft, 'guardrails.blockedReply') && (
				<BlockedReplySection
					guardrails={guardrails}
					withheld={wordingValue(draft, 'error.safety') || lexiconDefault('error.safety')}
					set={set}
				/>
			)}
			<NetworkSection guardrails={guardrails} set={set} />
			{draftAllows(draft, 'guardrails.taint') && (
				<InspectorSection
					title="After a remote read"
					path="guardrails.taint"
					note={STUDIO_TAINT_NOTE}
				>
					<SegmentedRow
						label="Refuse calls"
						path="guardrails.taint.afterRemoteRead"
						value={guardrails.taintAfterRemoteRead || 'off'}
						segments={TAINT_SEGMENTS}
						onChange={(gate) => {
							set({ taintAfterRemoteRead: gate === 'off' ? '' : gate });
						}}
					/>
					<SegmentedRow
						label="New address"
						path="guardrails.taint.remoteDestination"
						value={guardrails.taintRemoteDestination || 'off'}
						segments={DESTINATION_SEGMENTS}
						onChange={(gate) => {
							set({ taintRemoteDestination: gate === 'off' ? '' : gate });
						}}
					/>
				</InspectorSection>
			)}
			<QuotaSection guardrails={guardrails} set={set} />
		</div>
	);
}

const TRACE_SEGMENTS: Segment<'studio' | 'off'>[] = [
	{ value: 'studio', label: 'Studio', icon: IconFlask },
	{ value: 'off', label: 'Off', icon: IconEyeOff },
];

/** One flag of a set, with what turning it on means. */
interface Flag<K extends string> {
	key: K;
	label: string;
}

const INCLUDE_FLAGS: Flag<keyof ObservabilityDraft['include']>[] = [
	{ key: 'upstreamLog', label: 'Upstream log' },
	{ key: 'outboundWire', label: 'Outbound wire' },
	{ key: 'evidenceRaw', label: 'Raw evidence' },
	{ key: 'usage', label: 'Usage' },
	{ key: 'guardrailDecisions', label: 'Decisions' },
	{ key: 'guardrailMatchPreview', label: 'Match preview' },
];

const SCRUB_FLAGS: Flag<keyof ObservabilityDraft['scrub']>[] = [
	{ key: 'sensitive', label: 'Sensitive' },
	{ key: 'injection', label: 'Injection' },
	{ key: 'canary', label: 'Canary' },
];

/** A set of on-or-off flags as one checklist: the ones on are checked. */
function FlagList<K extends string>({
	label,
	path,
	flags,
	value,
	onChange,
}: {
	label: string;
	/** The schema path the flags sit under; each flag's own entry shows under it. */
	path: string;
	flags: readonly Flag<K>[];
	value: Record<K, boolean>;
	onChange: (next: Record<K, boolean>) => void;
}) {
	return (
		<CheckboxList
			label={label}
			isLabelHidden
			density="compact"
			value={flags.filter((flag) => value[flag.key]).map((flag) => flag.key)}
			onChange={(checked) => {
				const next = { ...value };
				for (const flag of flags) next[flag.key] = checked.includes(flag.key);
				onChange(next);
			}}
		>
			{flags.map((flag) => (
				<CheckboxListItem
					key={flag.key}
					value={flag.key}
					label={flag.label}
					// A node, not a string, so the kernel's whole entry wraps instead of truncating.
					description={<Text type="supporting">{fieldMeta(`${path}.${flag.key}`)?.doc}</Text>}
				/>
			))}
		</CheckboxList>
	);
}

const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent' });

const RESOURCE_PLACEHOLDER = `{
  "service.name": "my-agent"
}`;

/** The observability slice of the draft and its setter, for each observability section. */
interface ObservabilitySectionProps {
	observability: ObservabilityDraft;
	set: SetSection<'observability'>;
}

/** Whether traces are written, and how many turns are sampled. */
function TracesSection({ observability, set }: ObservabilitySectionProps) {
	const on = observability.writeTo !== false;
	return (
		<InspectorSection title="Traces" path="observability">
			<SegmentedRow
				label="Write to"
				path="observability.writeTo"
				value={on ? 'studio' : 'off'}
				segments={TRACE_SEGMENTS}
				onChange={(segment) => {
					set({ writeTo: segment === 'off' ? false : STUDIO_TRACE_DESTINATION });
				}}
			/>
			{on && (
				<SliderRow
					label="Sample"
					path="observability.sampleRate"
					field="sampleRate"
					value={observability.sampleRate}
					min={0}
					max={1}
					step={0.05}
					format={(rate) => PERCENT.format(rate)}
					onChange={(sampleRate) => {
						set({ sampleRate });
					}}
				/>
			)}
		</InspectorSection>
	);
}

/** What a trace keeps, and what is scrubbed from it. */
function TraceContentSections({ observability, set }: ObservabilitySectionProps) {
	return (
		<>
			<InspectorSection path="observability.include">
				<FlagList
					label="Keep"
					path="observability.include"
					flags={INCLUDE_FLAGS}
					value={observability.include}
					onChange={(include) => {
						set({ include });
					}}
				/>
			</InspectorSection>
			<InspectorSection path="observability.scrub">
				<FlagList
					label="Scrub"
					path="observability.scrub"
					flags={SCRUB_FLAGS}
					value={observability.scrub}
					onChange={(scrub) => {
						set({ scrub });
					}}
				/>
			</InspectorSection>
		</>
	);
}

function TraceStorageSection({ observability, set }: ObservabilitySectionProps) {
	return (
		<InspectorSection title="Storage" note={sectionNote('traces.storage')}>
			<NumberRow
				label="Keep for"
				path="observability.retainForDays"
				field="retainForDays"
				units="days"
				value={observability.retainForDays}
				isIntegerOnly
				onChange={(retainForDays) => {
					set({ retainForDays });
				}}
			/>
			<NumberRow
				label="Rotate at"
				path="observability.rotateAfterMiB"
				field="rotateAfterMiB"
				units="MiB"
				value={observability.rotateAfterMiB}
				min={1}
				onChange={(rotateAfterMiB) => {
					set({ rotateAfterMiB });
				}}
			/>
			<TextAreaRow
				label="Resource"
				path="observability.resource"
				field="resourceJson"
				value={observability.resourceJson}
				rows={3}
				hasSpellCheck={false}
				placeholder={RESOURCE_PLACEHOLDER}
				onChange={(resourceJson) => {
					set({ resourceJson });
				}}
			/>
		</InspectorSection>
	);
}

/** Where traces go, what they keep, and how your host stores them. */
function ObservabilityEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const { observability } = draft;
	const set = patch(setDraft, 'observability');
	const on = observability.writeTo !== false;
	return (
		<>
			<TracesSection observability={observability} set={set} />
			{on && (
				<>
					<TraceContentSections observability={observability} set={set} />
					<TraceStorageSection observability={observability} set={set} />
				</>
			)}
		</>
	);
}

/** Each custom tool type's icon: the Type control's segments and the tree's tool rows. */
export const TOOL_TYPE_ICON = {
	function: IconMathFunction,
	http: IconWorld,
	mcp: IconMcp,
	agent: IconMessageForward,
} satisfies Record<CustomToolType, IconType>;

/** The icon for a tool type, or the plain tool icon when the type is not one of those. */
export function toolTypeIcon(type: string): IconType {
	if (Object.hasOwn(TOOL_TYPE_ICON, type)) return TOOL_TYPE_ICON[type as CustomToolType];
	return IconTool;
}

const TOOL_TYPE_SEGMENTS: Segment<CustomToolType>[] = [
	{ value: 'function', label: 'Function', icon: TOOL_TYPE_ICON.function },
	{ value: 'http', label: 'HTTP', icon: TOOL_TYPE_ICON.http },
	{ value: 'mcp', label: 'MCP', icon: TOOL_TYPE_ICON.mcp },
	{ value: 'agent', label: 'Agent', icon: TOOL_TYPE_ICON.agent },
];

/** The agents an agent tool can run. */
const CALLABLE_TYPES = new Set(['text', 'image', 'speech']);

const ACCESS_SEGMENTS: Segment<ToolAccess>[] = [
	{ value: 'read-only', label: 'Read only', icon: IconEye },
	{ value: 'read-write', label: 'Read and write', icon: IconPencil },
	{ value: 'destructive', label: 'Destructive', icon: IconFlame },
];

const PERMISSION_SEGMENTS: Segment<ToolPermission>[] = [
	{ value: 'auto', label: 'Runs', icon: IconPlayerPlay },
	{ value: 'session_consent', label: 'Once a session', icon: IconUserCheck },
	{ value: 'always_confirm', label: 'Every call', icon: IconHandStop },
];

const METHOD_SEGMENTS: Segment<HttpMethod>[] = [
	{ value: 'GET', label: 'GET', icon: IconHttpGet },
	{ value: 'POST', label: 'POST', icon: IconHttpPost },
	{ value: 'PUT', label: 'PUT', icon: IconHttpPut },
	{ value: 'PATCH', label: 'PATCH', icon: IconHttpPatch },
	{ value: 'DELETE', label: 'DELETE', icon: IconHttpDelete },
];

const LOAD_TIER_SEGMENTS: Segment<ToolLoadTier>[] = [
	{ value: 'T0', label: 'T0', icon: IconSquareRoundedNumber0 },
	{ value: 'T2', label: 'T2', icon: IconSquareRoundedNumber2 },
];

const AUTH_TYPE_SEGMENTS: Segment<StudioAuthType>[] = [
	{ value: 'none', label: 'None', icon: IconLockOpen },
	{ value: 'bearer', label: 'Bearer', icon: IconCertificate },
	{ value: 'api_key', label: 'API key', icon: IconKey },
	{ value: 'oauth2', label: 'OAuth 2', icon: IconShieldLock },
];

const UNAUTHENTICATED_SEGMENTS: Segment<AuthUnauthenticatedPolicy>[] = [
	{ value: 'gate', label: 'Stop the turn', icon: IconPlayerPause },
	{ value: 'report_to_model', label: 'Tell the model', icon: IconMessage },
];

/** The prefix the kernel puts before the credential when none is set, by auth type. */
const AUTH_HEADER_PREFIX: Record<Exclude<StudioAuthType, 'none'>, string> = {
	bearer: 'Bearer ',
	api_key: '',
	oauth2: 'Bearer ',
};

/**
 * Why a tool on `tier` never loads on this draft: the studio can't write a T1 policy, so a
 * T2 tool loads only through the T2 loader.
 */
function loadTierWarning(draft: StudioDraft, tier: ToolLoadTier): string | undefined {
	if (tier === 'T2' && draftAllows(draft, 'tools.t2Loader') && !draft.tools.t2Loader.trim()) {
		return 'No T2 loader is set under Tools, so this tool never loads.';
	}
	return undefined;
}

function placeholderHint(schemas: string[]): string | undefined {
	const names = new Set<string>();
	for (const json of schemas) {
		try {
			const schema: unknown = JSON.parse(json);
			const properties: unknown =
				schema && typeof schema === 'object' && 'properties' in schema
					? schema.properties
					: undefined;
			if (properties && typeof properties === 'object') {
				for (const name of Object.keys(properties)) names.add(`{${name}}`);
			}
		} catch {
			// A schema mid-edit names nothing yet.
		}
	}
	return names.size ? `Can use ${[...names].join(' ')}` : undefined;
}

const HEADERS_PLACEHOLDER = `{
  "Accept": "application/json"
}`;

/** Adds a new tool to the draft and opens it. */
export function addToolSpec(
	draft: StudioDraft,
	setDraft: SetDraft,
	onSelect: (id: string) => void,
) {
	const tool = newToolSpec(draft);
	setDraft((current) => ({ ...current, toolSpecs: [...current.toolSpecs, tool] }));
	onSelect(toolSpecNodeId(tool.key));
}

/** The library's tools as a checklist, the ones this agent may use checked. A row's pencil opens the tool. */
function AllowedToolsList({
	tools,
	allowed,
	workspace,
	onSelect,
}: {
	tools: ToolSpecDraft[];
	allowed: ToolSpecDraft[];
	workspace: Workspace;
	onSelect: (id: string) => void;
}) {
	return (
		<CheckboxList
			label="Allowed"
			isLabelHidden
			density="compact"
			value={allowed.map((tool) => tool.key)}
			onChange={(checked) => {
				for (const tool of tools) {
					workspace.setAllowed(tool.key, checked.includes(tool.key));
				}
			}}
		>
			{tools.map((tool) => {
				// A tool that runs this agent can't be turned on here; one already on can still be turned off.
				const runsSelf =
					tool.toolType === 'agent' &&
					tool.agentKey === workspace.self &&
					!workspace.allowed.includes(tool.key);
				const name = tool.toolName.trim() || 'Unnamed tool';
				const description = runsSelf
					? 'Runs this agent, so this agent can’t use it.'
					: tool.description.trim();
				return (
					<CheckboxListItem
						key={tool.key}
						value={tool.key}
						label={name}
						isDisabled={runsSelf}
						endContent={
							<span className="row-reveal">
								<Tooltip content={`Edit ${name}`}>
									<IconButton
										label={`Edit ${name}`}
										variant="ghost"
										size="sm"
										icon={<Icon icon={IconPencil} size="sm" />}
										onClick={() => {
											onSelect(toolSpecNodeId(tool.key));
										}}
									/>
								</Tooltip>
							</span>
						}
						description={description ? <Text type="supporting">{description}</Text> : undefined}
					/>
				);
			})}
		</CheckboxList>
	);
}

/** An agent's own tools, each opening its editor. */
function ToolList({ tools, onSelect }: { tools: ToolSpecDraft[]; onSelect: (id: string) => void }) {
	return (
		<List density="compact">
			{tools.map((tool) => (
				<ListItem
					key={tool.key}
					label={tool.toolName.trim() || 'Unnamed tool'}
					description={tool.description.trim() || undefined}
					startContent={<Icon icon={toolTypeIcon(tool.toolType)} size="sm" color="secondary" />}
					endContent={<Token label={tool.loadTier} size="sm" />}
					onClick={() => {
						onSelect(toolSpecNodeId(tool.key));
					}}
				/>
			))}
		</List>
	);
}

/** The tools, each opening its own editor, and the T2 loader. */
function ToolsEditor({
	draft,
	setDraft,
	onSelect,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	onSelect: (id: string) => void;
}) {
	const set = patch(setDraft, 'tools');
	const workspace = useContext(WorkspaceContext);
	const isHost = draft.identity.profileType === 'host';
	/** In a workspace, the library's tools this agent allows; on its own, every tool it has. */
	const allowed = workspace
		? draft.toolSpecs.filter((tool) => workspace.allowed.includes(tool.key))
		: draft.toolSpecs;
	const unused = workspace
		? draft.toolSpecs.filter((tool) => !workspace.allowed.includes(tool.key))
		: [];
	// Any custom tool it allows can load T2 tools: one that answers with the ids to load.
	const loaders = allowed.map((tool) => tool.toolName.trim()).filter(Boolean);
	const note = isHost ? sectionNote('tools.host') : undefined;
	const addTool = (
		<Button
			label="Add tool"
			variant="ghost"
			size="sm"
			icon={<Icon icon={IconPlus} size="sm" />}
			onClick={() => {
				addToolSpec(draft, setDraft, onSelect);
			}}
		/>
	);
	return (
		<>
			{workspace ? (
				// This agent's tools. Ones it does not use stay in the library, closed.
				<InspectorSection path="tools.allow" note={note}>
					{allowed.length > 0 && (
						<AllowedToolsList
							tools={allowed}
							allowed={allowed}
							workspace={workspace}
							onSelect={onSelect}
						/>
					)}
					{unused.length > 0 && (
						<CollapsibleGroup type="multiple" density="compact">
							<Collapsible
								value="library"
								trigger={
									<Text type="supporting">
										Library, not used by this agent ({String(unused.length)})
									</Text>
								}
							>
								<AllowedToolsList
									tools={unused}
									allowed={[]}
									workspace={workspace}
									onSelect={onSelect}
								/>
							</Collapsible>
						</CollapsibleGroup>
					)}
					{addTool}
				</InspectorSection>
			) : (
				<InspectorSection path={isHost ? undefined : 'tools'} note={note}>
					{draft.toolSpecs.length > 0 && <ToolList tools={draft.toolSpecs} onSelect={onSelect} />}
					{addTool}
				</InspectorSection>
			)}
			{draftAllows(draft, 'tools.t2Loader') && (
				<ToolLoadingSection value={draft.tools.t2Loader} loaders={loaders} set={set} />
			)}
		</>
	);
}

/** The tool that loads T2 tools, picked from the custom tools the agent allows. */
function ToolLoadingSection({
	value,
	loaders,
	set,
}: {
	value: string;
	loaders: string[];
	set: SetSection<'tools'>;
}) {
	return (
		<InspectorSection path="tools.t2Loader">
			<ChoiceRow
				label="T2 loader"
				path="tools.t2Loader"
				field="t2Loader"
				value={value}
				options={loaders}
				onChange={(t2Loader) => {
					set({ t2Loader });
				}}
			/>
		</InspectorSection>
	);
}

const MS = new Intl.NumberFormat('en-US', { style: 'unit', unit: 'millisecond' });

/** The result's headline: the status line, or for an MCP server, what it offers. */
function probeTitle(result: ProbeResult, tool: ToolSpecDraft): string {
	const took = result.elapsedMs === undefined ? '' : ` · ${MS.format(result.elapsedMs)}`;
	if (!result.ok && result.error) return result.error;
	if (tool.toolType === 'mcp' && result.tools) {
		// The route only checks for the remote tool when one is named.
		const name = tool.mcpToolName?.trim() ?? '';
		if (result.targetToolFound === false) return `Connected, but the server has no ${name}${took}`;
		if (result.targetToolFound) return `Connected, and ${name} is there${took}`;
		return `Connected: ${String(result.tools.length)} tools${took}`;
	}
	return `${String(result.status ?? '')} ${result.statusText ?? ''}`.trim() + took;
}

/** The sample input for the tool, which follows its input schema, as JSON; blank without one. */
function defaultSampleInput(tool: ToolSpecDraft): string {
	const sample = sampleToolInput(tool.toolName, tool.inputJson);
	return sample ? JSON.stringify(sample, null, 2) : '';
}

/** What a test reaches and sends, as one comparable string. */
function probeTarget(tool: ToolSpecDraft, method: string): string {
	return JSON.stringify([
		tool.toolType,
		tool.endpoint,
		method,
		tool.serverUrl,
		tool.mcpToolName,
		tool.headersJson,
		tool.authType,
		tool.authHeaderName,
		tool.authHeaderPrefix,
	]);
}

/** The result's banner status: a missing remote tool warns even though the server answered. */
function probeStatus(result: ProbeResult): 'warning' | 'success' | 'error' {
	if (result.ok && result.targetToolFound === false) return 'warning';
	return result.ok ? 'success' : 'error';
}

/** The result's detail: an MCP server's tools, or the start of the response. */
function probeDetails(result: ProbeResult): ReactNode {
	if (result.tools?.length)
		return (
			<HStack gap={1} wrap="wrap">
				{result.tools.map((name) => (
					<Token key={name} label={name} size="sm" />
				))}
			</HStack>
		);
	if (!result.preview) return undefined;
	return (
		<CodeBlock
			code={result.preview}
			language={result.preview.trimStart().startsWith('{') ? 'json' : 'text'}
			hasLanguageLabel={false}
			isWrapped
			size="sm"
			maxHeight={200}
		/>
	);
}

/** The test's credential, typed for this test only. */
function TestCredentialRow({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<InspectorRow label="Credential" path="studio.testCredential">
			<StackItem size="fill">
				<TextInput
					label="Credential"
					isLabelHidden
					size="sm"
					type="password"
					autoComplete="off"
					value={value}
					placeholder="Used once, never saved"
					onChange={onChange}
				/>
			</StackItem>
		</InspectorRow>
	);
}

/** The input an HTTP tool's test sends. */
function SampleInputRow({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	return (
		<TextAreaRow
			label="Sample input"
			path="studio.sampleInput"
			value={value}
			rows={4}
			hasSpellCheck={false}
			placeholder="{}"
			onChange={onChange}
		/>
	);
}

function TestConnectionButton({ isLoading, onClick }: { isLoading: boolean; onClick: () => void }) {
	return (
		<HStack>
			<Button
				label="Test connection"
				variant="secondary"
				size="sm"
				icon={<Icon icon={IconPlugConnected} size="sm" />}
				isLoading={isLoading}
				onClick={onClick}
			/>
		</HStack>
	);
}

/**
 * Tries the tool's endpoint or MCP server once, from the server, which reaches public hosts only.
 * The sample input and credential live here only: neither is saved to the draft.
 */
function ToolTest({ tool }: { tool: ToolSpecDraft }) {
	/** What the user typed; until then, the sample for the tool, which follows its input schema. */
	const [typedInput, setTypedInput] = useState<string>();
	const sampleInput = typedInput ?? defaultSampleInput(tool);
	const credential = useSyncExternalStore(
		subscribeToolCredentials,
		() => toolCredential(tool.key),
		() => '',
	);
	const setCredential = (value: string) => {
		setToolCredential(tool.key, value);
	};
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<ProbeResult>();
	const http = tool.toolType === 'http';
	const method = tool.method ?? HTTP_METHODS[0];
	// A result answers the request as it was: once what it reaches or sends changes, it's dropped.
	const target = probeTarget(tool, method);
	const [testedTarget, setTestedTarget] = useState(target);
	if (target !== testedTarget) {
		setTestedTarget(target);
		setResult(undefined);
	}

	const confirmWrite = useContext(ConfirmWrite);
	const run = async () => {
		// A tool that writes runs only once the builder read the input and said so.
		const ask = writeAsk(tool, sampleInput);
		if (ask && !(await confirmWrite(ask))) return;
		setPending(true);
		try {
			setResult(await runToolProbe(tool, sampleInput, credential));
		} finally {
			setPending(false);
		}
	};

	return (
		<InspectorSection
			title="Test"
			note={http ? sectionNote('tool.test.http', { method }) : sectionNote('tool.test.mcp')}
		>
			{http && <SampleInputRow value={sampleInput} onChange={setTypedInput} />}
			{(tool.authType ?? 'none') !== 'none' && (
				<TestCredentialRow value={credential} onChange={setCredential} />
			)}
			<TestConnectionButton
				isLoading={pending}
				onClick={() => {
					void run();
				}}
			/>
			{result && (
				<Banner
					status={probeStatus(result)}
					title={probeTitle(result, tool)}
					description={probeDetails(result)}
				/>
			)}
		</InspectorSection>
	);
}

type SetTool = (change: Partial<ToolSpecDraft>) => void;
type Workspace = NonNullable<ContextType<typeof WorkspaceContext>>;

/** The tool types offered: an agent tool only where there are agents to run. */
function toolTypeSegments(workspace: ContextType<typeof WorkspaceContext>) {
	return workspace
		? TOOL_TYPE_SEGMENTS
		: TOOL_TYPE_SEGMENTS.filter((segment) => segment.value !== 'agent');
}

/** Renames a tool; the T2 loader names this tool, so it follows the rename. */
function renameToolSpec(
	draft: StudioDraft,
	toolKey: string,
	from: string,
	toolName: string,
): StudioDraft {
	return {
		...draft,
		tools:
			draft.tools.t2Loader === from.trim()
				? { ...draft.tools, t2Loader: toolName.trim() }
				: draft.tools,
		toolSpecs: draft.toolSpecs.map((candidate) =>
			candidate.key === toolKey ? { ...candidate, toolName } : candidate,
		),
	};
}

/** Removes a tool, and the T2 loader with it when it names the tool. */
function removeToolSpec(draft: StudioDraft, toolKey: string, name: string): StudioDraft {
	return {
		...draft,
		tools: draft.tools.t2Loader === name.trim() ? { ...draft.tools, t2Loader: '' } : draft.tools,
		toolSpecs: draft.toolSpecs.filter((candidate) => candidate.key !== toolKey),
	};
}

/** The tool's type, from the types on offer here. */
function ToolTypeRow({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	const workspace = useContext(WorkspaceContext);
	return (
		<SegmentedRow
			label="Type"
			path="registerTool.type"
			field="toolType"
			value={tool.toolType}
			segments={toolTypeSegments(workspace)}
			onChange={(toolType) => {
				set({ toolType });
			}}
		/>
	);
}

/** What the tool is: its name, type, description and category. */
function ToolSection({
	draft,
	setDraft,
	tool,
	set,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	tool: ToolSpecDraft;
	set: SetTool;
}) {
	return (
		<InspectorSection
			note={draft.identity.profileType === 'host' ? sectionNote('tool.host') : undefined}
		>
			<TextRow
				label="Name"
				path="name"
				field="toolName"
				isRequired
				value={tool.toolName}
				placeholder="search_flights"
				onChange={(toolName) => {
					setDraft((current) => renameToolSpec(current, tool.key, tool.toolName, toolName));
				}}
			/>
			<ToolTypeRow tool={tool} set={set} />
			<TextAreaRow
				label="Description"
				path="description"
				field="description"
				isRequired
				value={tool.description}
				placeholder="Finds flights between two airports on a date."
				onChange={(description) => {
					set({ description });
				}}
			/>
			<TextRow
				label="Category"
				path="category"
				field="category"
				value={tool.category}
				placeholder="studio"
				onChange={(category) => {
					set({ category });
				}}
			/>
		</InspectorSection>
	);
}

/** The tool's input and output schemas. */
function ContractSection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<InspectorSection title="Contract">
			<TextAreaRow
				label="Input"
				path="studio.inputSchema"
				field="inputJson"
				value={tool.inputJson}
				rows={8}
				hasSpellCheck={false}
				onChange={(inputJson) => {
					set({ inputJson });
				}}
			/>
			<TextAreaRow
				label="Output"
				path="studio.outputSchema"
				field="outputJson"
				value={tool.outputJson}
				rows={8}
				hasSpellCheck={false}
				onChange={(outputJson) => {
					set({ outputJson });
				}}
			/>
		</InspectorSection>
	);
}

/** What the chat says while the tool runs, once it's done and when it asks. */
function ActivitySection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<InspectorSection title="Activity" path="labels">
			<TextRow
				label="Running"
				path="labels.activity"
				field="activity"
				value={tool.activity ?? ''}
				hint={placeholderHint([tool.inputJson])}
				onChange={(activity) => {
					set({ activity });
				}}
			/>
			<TextRow
				label="Done"
				path="labels.activityPast"
				field="activityPast"
				value={tool.activityPast ?? ''}
				hint={placeholderHint([tool.inputJson, tool.outputJson])}
				onChange={(activityPast) => {
					set({ activityPast });
				}}
			/>
			<TextRow
				label="Asking"
				path="labels.request"
				field="request"
				value={tool.request ?? ''}
				hint={placeholderHint([tool.inputJson])}
				onChange={(request) => {
					set({ request });
				}}
			/>
		</InspectorSection>
	);
}

/** What a function tool returns in the studio, and whether the page answers it on a host. */
function StubSection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<InspectorSection title="Stub" path="studio.stubOutput">
			<SwitchRow
				label="Page answers"
				path="answeredBy"
				value={tool.answeredBy === 'page'}
				onChange={(page) => {
					set({ answeredBy: page ? 'page' : undefined });
				}}
			/>
			<TextAreaRow
				label="Returns"
				path="studio.stubOutput"
				field="stubOutputJson"
				value={tool.stubOutputJson ?? ''}
				rows={6}
				hasSpellCheck={false}
				hint="Left blank, a stand-in built from the output schema."
				onChange={(stubOutputJson) => {
					set({ stubOutputJson });
				}}
			/>
		</InspectorSection>
	);
}

/** The static headers HTTP and MCP tools both send. */
function HeadersRow({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<TextAreaRow
			label="Headers"
			path="headers"
			field="headersJson"
			value={tool.headersJson ?? ''}
			rows={4}
			hasSpellCheck={false}
			placeholder={HEADERS_PLACEHOLDER}
			onChange={(headersJson) => {
				set({ headersJson });
			}}
		/>
	);
}

/** An HTTP tool's request, and how its input maps onto it. */
function HttpSections({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<>
			<HttpRequestSection tool={tool} set={set} />
			<HttpMappingSection tool={tool} set={set} />
		</>
	);
}

function HttpRequestSection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<InspectorSection title="Request" note={sectionNote('tool.headers')}>
			<TextRow
				label="Endpoint"
				path="endpoint"
				field="endpoint"
				isRequired
				value={tool.endpoint ?? ''}
				placeholder="https://api.example.com/flights/{id}"
				onChange={(endpoint) => {
					set({ endpoint });
				}}
			/>
			<SegmentedRow
				label="Method"
				path="method"
				field="method"
				value={tool.method ?? HTTP_METHODS[0]}
				segments={METHOD_SEGMENTS}
				onChange={(method) => {
					set({ method });
				}}
			/>
			<HeadersRow tool={tool} set={set} />
		</InspectorSection>
	);
}

function HttpMappingSection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<InspectorSection title="Mapping" path="mapping">
			<NamesRow
				label="Path"
				path="mapping.pathParams"
				field="pathParams"
				value={tool.pathParams ?? []}
				placeholder="Names in {braces}"
				onChange={(pathParams) => {
					set({ pathParams });
				}}
			/>
			<NamesRow
				label="Query"
				path="mapping.queryParams"
				field="queryParams"
				value={tool.queryParams ?? []}
				placeholder="None"
				onChange={(queryParams) => {
					set({ queryParams });
				}}
			/>
			<TextRow
				label="Body"
				path="mapping.bodyParam"
				field="bodyParam"
				value={tool.bodyParam ?? ''}
				hint="None"
				onChange={(bodyParam) => {
					set({ bodyParam });
				}}
			/>
		</InspectorSection>
	);
}

/** The agent an agent tool runs, and how often a turn may call it. */
function AgentSection({
	tool,
	set,
	workspace,
}: {
	tool: ToolSpecDraft;
	set: SetTool;
	workspace: Workspace;
}) {
	return (
		<InspectorSection title="Agent">
			<ChoiceRow
				label="Runs"
				path="profile"
				field="agentKey"
				isRequired
				value={tool.agentKey ?? ''}
				options={otherAgents(workspace.agents, workspace.self, (agent) =>
					CALLABLE_TYPES.has(agent.type),
				)}
				onChange={(agentKey) => {
					const agentId = workspace.agents.find((agent) => agent.key === agentKey)?.agentId ?? '';
					set(agentToolTarget(tool, agentKey, agentId));
				}}
			/>
			<NumberRow
				label="Calls per turn"
				path="maxCallsPerTurn"
				field="maxCallsPerTurn"
				value={tool.maxCallsPerTurn ?? null}
				min={1}
				isIntegerOnly
				onChange={(maxCallsPerTurn) => {
					set({ maxCallsPerTurn });
				}}
			/>
		</InspectorSection>
	);
}

/** An MCP tool's server and the tool it calls there. */
function McpServerSection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<InspectorSection title="Server" note={sectionNote('tool.headers')}>
			<TextRow
				label="Server"
				path="serverUrl"
				field="serverUrl"
				isRequired
				value={tool.serverUrl ?? ''}
				placeholder="https://mcp.example.com/mcp"
				onChange={(serverUrl) => {
					set({ serverUrl });
				}}
			/>
			<TextRow
				label="Remote tool"
				path="mcpToolName"
				field="mcpToolName"
				isRequired
				value={tool.mcpToolName ?? ''}
				placeholder="search_flights"
				onChange={(mcpToolName) => {
					set({ mcpToolName });
				}}
			/>
			<HeadersRow tool={tool} set={set} />
		</InspectorSection>
	);
}

/** Where an authenticated tool's credential comes from, how it's sent, and what signed out does. */
function AuthCredentialRows({
	tool,
	authType,
	set,
}: {
	tool: ToolSpecDraft;
	authType: Exclude<NonNullable<ToolSpecDraft['authType']>, 'none'>;
	set: SetTool;
}) {
	return (
		<>
			<TextRow
				label="Slot"
				path="auth.slot"
				field="authSlot"
				value={tool.authSlot ?? ''}
				placeholder="default"
				onChange={(authSlot) => {
					set({ authSlot });
				}}
			/>
			<TextRow
				label="Header"
				path="auth.headerName"
				field="authHeaderName"
				value={tool.authHeaderName ?? ''}
				placeholder="Authorization"
				onChange={(authHeaderName) => {
					set({ authHeaderName });
				}}
			/>
			<TextRow
				label="Prefix"
				path="auth.headerPrefix"
				field="authHeaderPrefix"
				value={tool.authHeaderPrefix ?? ''}
				placeholder={AUTH_HEADER_PREFIX[authType] || undefined}
				hint="None"
				onChange={(prefix) => {
					// Blank is the kernel's prefix for the type, which the placeholder shows.
					set({ authHeaderPrefix: prefix || undefined });
				}}
			/>
			<SegmentedRow
				label="Signed out"
				path="auth.onUnauthenticated"
				field="authUnauthenticated"
				value={tool.authUnauthenticated ?? 'gate'}
				segments={UNAUTHENTICATED_SEGMENTS}
				onChange={(authUnauthenticated) => {
					set({ authUnauthenticated });
				}}
			/>
		</>
	);
}

/** An OAuth tool's scopes, client id and redirect. */
function OAuthRows({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	return (
		<>
			<NamesRow
				label="Scopes"
				path="auth.scopes"
				field="authScopes"
				value={tool.authScopes ?? []}
				placeholder="None"
				onChange={(authScopes) => {
					set({ authScopes });
				}}
			/>
			<TextRow
				label="Client id"
				path="auth.clientId"
				field="authClientId"
				value={tool.authClientId ?? ''}
				onChange={(authClientId) => {
					set({ authClientId });
				}}
			/>
			<TextRow
				label="Redirect"
				path="auth.redirectUri"
				field="authRedirectUri"
				value={tool.authRedirectUri ?? ''}
				placeholder="https://example.com/oauth/callback"
				onChange={(authRedirectUri) => {
					set({ authRedirectUri });
				}}
			/>
		</>
	);
}

/** How a remote tool authenticates. */
function AuthSection({ tool, set }: { tool: ToolSpecDraft; set: SetTool }) {
	const authType = tool.authType ?? 'none';
	return (
		<InspectorSection path="auth" note={sectionNote('tool.auth')}>
			<SegmentedRow
				label="Type"
				path="studio.authType"
				field="authType"
				value={authType}
				segments={AUTH_TYPE_SEGMENTS}
				onChange={(next) => {
					set({ authType: next });
				}}
			/>
			{authType !== 'none' && <AuthCredentialRows tool={tool} authType={authType} set={set} />}
			{authType === 'oauth2' && <OAuthRows tool={tool} set={set} />}
		</InspectorSection>
	);
}

/** What the studio does about a tool that writes, when that is not what Permission says. */
function studioAskNote(asks: StudioAsks, tool: string): string | undefined {
	if (asks.asked.includes(tool))
		return 'In the studio this tool asks before every run, because it writes. Your application runs it as Permission says.';
	if (asks.inside.includes(tool))
		return 'This tool writes, and the studio cannot make it ask: a called agent runs it, and a question inside a called agent has no one to answer it. The call to that agent asks instead.';
	return undefined;
}

/** Who may call the tool, whether it asks first, when it loads and on which paths. */
function PolicySection({
	draft,
	tool,
	set,
}: {
	draft: StudioDraft;
	tool: ToolSpecDraft;
	set: SetTool;
}) {
	const note = studioAskNote(useContext(ProjectAsks), tool.toolName);
	return (
		<InspectorSection title="Policy" note={note}>
			<SegmentedRow
				label="Access"
				path="access"
				field="access"
				value={tool.access}
				segments={ACCESS_SEGMENTS}
				onChange={(access) => {
					set({ access });
				}}
			/>
			<SegmentedRow
				label="Permission"
				path="permission"
				field="permission"
				value={tool.permission}
				segments={PERMISSION_SEGMENTS}
				onChange={(permission) => {
					set({ permission });
				}}
			/>
			<SegmentedRow
				label="Load tier"
				path="loadTier"
				field="loadTier"
				value={tool.loadTier}
				segments={LOAD_TIER_SEGMENTS}
				warning={loadTierWarning(draft, tool.loadTier)}
				onChange={(loadTier) => {
					set({ loadTier });
				}}
			/>
			<NamesRow
				label="Paths"
				path="paths"
				field="paths"
				value={tool.paths}
				placeholder="Every path (*)"
				onChange={(paths) => {
					set({ paths });
				}}
			/>
		</InspectorSection>
	);
}

function ToolSpecEditor({
	draft,
	setDraft,
	toolKey,
	onSelect,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	toolKey: string;
	onSelect: (id: string) => void;
}) {
	const workspace = useContext(WorkspaceContext);
	const tool = draft.toolSpecs.find((candidate) => candidate.key === toolKey);
	if (!tool) return null;
	const set = (change: Partial<ToolSpecDraft>) => {
		setDraft((current) => ({
			...current,
			toolSpecs: current.toolSpecs.map((candidate) =>
				candidate.key === toolKey ? { ...candidate, ...change } : candidate,
			),
		}));
	};
	const remote = tool.toolType === 'http' || tool.toolType === 'mcp';

	return (
		<>
			<ToolSection draft={draft} setDraft={setDraft} tool={tool} set={set} />
			<ContractSection tool={tool} set={set} />
			<ActivitySection tool={tool} set={set} />
			{tool.toolType === 'function' && <StubSection tool={tool} set={set} />}
			{tool.toolType === 'http' && <HttpSections tool={tool} set={set} />}
			{tool.toolType === 'agent' && workspace && (
				<AgentSection tool={tool} set={set} workspace={workspace} />
			)}
			{tool.toolType === 'mcp' && <McpServerSection tool={tool} set={set} />}
			{remote && <AuthSection tool={tool} set={set} />}
			{remote && <ToolTest key={tool.key} tool={tool} />}
			<PolicySection draft={draft} tool={tool} set={set} />
			<Section variant="transparent" padding={3}>
				<Button
					label="Remove tool"
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconTrash} size="sm" />}
					onClick={() => {
						setDraft((current) => removeToolSpec(current, toolKey, tool.toolName));
						onSelect('tools');
					}}
				/>
			</Section>
		</>
	);
}

/** Wording's areas, by lexicon key prefix: what visitors read first, then what the model reads. */
/** Who reads a line: the visitor, in the chat, or the model, in its context. */
type WordingAudience = 'visitor' | 'model';

const WORDING_AREAS: readonly {
	prefix: string;
	title: string;
	note: string;
	icon: IconType;
	audience: WordingAudience;
}[] = [
	{
		prefix: 'error',
		title: 'Errors',
		note: 'When a turn fails.',
		icon: IconAlertTriangle,
		audience: 'visitor',
	},
	{
		prefix: 'attachments',
		title: 'Attachments',
		note: "When a file can't be sent.",
		icon: IconPaperclip,
		audience: 'visitor',
	},
	{
		prefix: 'voice',
		title: 'Voice',
		note: "When a voice note can't be recorded or used.",
		icon: IconMicrophone,
		audience: 'visitor',
	},
	{
		prefix: 'session',
		title: 'Session',
		note: 'Waits, approvals, and signing in.',
		icon: IconHourglass,
		audience: 'visitor',
	},
	{
		prefix: 'live',
		title: 'Live',
		note: 'When a live session ends.',
		icon: IconHeadset,
		audience: 'visitor',
	},
	{
		prefix: 'quota',
		title: 'Quota',
		note: 'When the daily limit is reached.',
		icon: IconGauge,
		audience: 'visitor',
	},
	{
		prefix: 'tool',
		title: 'Tools',
		note: "When a tool call can't run.",
		icon: IconTool,
		audience: 'model',
	},
	{
		prefix: 'repair',
		title: 'Repair',
		note: 'Fixing a reply that failed its schema.',
		icon: IconBandage,
		audience: 'model',
	},
	{
		prefix: 'egress',
		title: 'Egress',
		note: 'A reply that fails its check, sent back or refused.',
		icon: IconSend,
		audience: 'model',
	},
	{
		prefix: 'continue',
		title: 'Resumption',
		note: 'Picking up a reply that stopped short.',
		icon: IconPlayerTrackNext,
		audience: 'model',
	},
	{
		prefix: 'canary',
		title: 'Canary',
		note: "The note that binds each turn's canary.",
		icon: IconFeather,
		audience: 'model',
	},
	{
		prefix: 'taint',
		title: 'Untrusted content',
		note: 'Why a tool call was refused after reading it.',
		icon: IconBiohazard,
		audience: 'model',
	},
	{
		prefix: 'advisory',
		title: 'Advisories',
		note: 'Notes beside content that tries to direct it.',
		icon: IconInfoCircle,
		audience: 'model',
	},
];

const WORDING_AUDIENCES: readonly {
	value: WordingAudience;
	label: string;
	icon: IconType;
	note: string;
}[] = [
	{
		value: 'visitor',
		label: 'Visitor reads',
		icon: IconUser,
		note: 'Shown in the chat when something fails or needs a wait.',
	},
	{
		value: 'model',
		label: 'Model reads',
		icon: IconInputAi,
		note: 'Put in front of the model; the visitor never sees these.',
	},
];

/** Row names for keys whose own name reads as code. */
const WORDING_LABELS: Partial<Record<LexiconKey, string>> = {
	'attachments.mime_not_allowed': 'File type not allowed',
	'attachments.limits_unconfigured': 'Files turned off',
	'quota.exhausted': 'Limit reached',
};

/** `rate_limit` → "Rate limit". */
function wordingLabel(key: LexiconKey): string {
	const named = WORDING_LABELS[key];
	if (named) return named;
	const words = key.slice(key.indexOf('.') + 1).replaceAll('_', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The kernel's line for `key`, worded with the draft's own limits where it takes them. */
function wordingPlaceholder(draft: StudioDraft, key: LexiconKey): string {
	const { inputs, guardrails } = draft;
	const text = lexiconDefault(key, {
		maxFiles: inputs.maxFiles ?? '{maxFiles}',
		maxBytes: inputs.maxBytes ?? Number.NaN,
		maxTurnBytes: inputs.maxTurnBytes ?? Number.NaN,
		perDay: guardrails.quotaPerDay ?? '{perDay}',
	});
	// A size the draft leaves unset formats as NaN: show the placeholder the template takes instead.
	return text.replace(
		'NaN MB',
		key === 'attachments.turn_too_large' ? '{maxTurnBytes}' : '{maxBytes}',
	);
}

/**
 * The lines that also sit beside their setting: one value, edited from either place. `isOn` is when
 * the kernel uses the line; off, Wording links to the setting that turns it on.
 */
const SHARED_WORDING: Partial<
	Record<
		LexiconKey,
		{
			setting: string;
			read: (draft: StudioDraft) => string;
			write: (setDraft: SetDraft, text: string) => void;
			isOn: (draft: StudioDraft) => boolean;
		}
	>
> = {
	'continue.instruction': {
		setting: 'Resumption',
		read: (draft) => draft.turnBehaviour.continueInstruction,
		write: (setDraft, continueInstruction) => {
			patch(setDraft, 'turnBehaviour')({ continueInstruction });
		},
		isOn: (draft) => takesContinueInstruction(draft) && draft.turnBehaviour.resumeEnabled,
	},
	'canary.bind_note': {
		setting: 'Canary',
		read: (draft) => draft.guardrails.canaryBindNote,
		write: (setDraft, canaryBindNote) => {
			patch(setDraft, 'guardrails')({ canaryBindNote });
		},
		isOn: plantsCanary,
	},
	'quota.exhausted': {
		setting: 'Daily cap',
		read: (draft) => draft.guardrails.quotaMessage,
		write: (setDraft, quotaMessage) => {
			patch(setDraft, 'guardrails')({ quotaMessage });
		},
		isOn: (draft) => draft.guardrails.quotaEnabled,
	},
	'repair.default_guidance': {
		setting: 'Repair',
		read: (draft) => draft.outputs.repairGuidance,
		write: (setDraft, repairGuidance) => {
			patch(setDraft, 'outputs')({ repairGuidance });
		},
		isOn: (draft) => draft.outputs.validationEnabled,
	},
	'egress.default_repair_guidance': {
		setting: 'Blocked reply',
		read: (draft) => draft.guardrails.egressRepairGuidance,
		write: (setDraft, egressRepairGuidance) => {
			patch(setDraft, 'guardrails')({ egressRepairGuidance });
		},
		isOn: (draft) => draft.guardrails.blockedReplyOnBlock !== 'refuse',
	},
	'egress.refusal': {
		setting: 'Blocked reply',
		read: (draft) => draft.guardrails.egressRefusal,
		write: (setDraft, egressRefusal) => {
			patch(setDraft, 'guardrails')({ egressRefusal });
		},
		isOn: (draft) => draft.guardrails.blockedReplyOnBlock === 'refuse',
	},
};

/** The text a line holds in the draft: its own setting's field, or Wording's. */
function wordingValue(draft: StudioDraft, key: LexiconKey): string {
	return SHARED_WORDING[key]?.read(draft) ?? draft.wording[key] ?? '';
}

/** A line that also sits beside its setting; while that setting is off, a link to turn it on. */
function SharedWordingRow({
	lexiconKey,
	facet,
	draft,
	setDraft,
	onSelect,
}: {
	lexiconKey: LexiconKey;
	facet: ProfileGraphFacetId;
	draft: StudioDraft;
	setDraft: SetDraft;
	onSelect: (id: string) => void;
}) {
	const shared = SHARED_WORDING[lexiconKey];
	if (!shared) return null;
	return (
		<VStack gap={1}>
			<TextAreaRow
				label={wordingLabel(lexiconKey)}
				path={`lexicon.${lexiconKey}`}
				rows={2}
				value={shared.read(draft)}
				placeholder={wordingPlaceholder(draft, lexiconKey)}
				onChange={(text) => {
					shared.write(setDraft, text);
				}}
			/>
			{!shared.isOn(draft) && (
				<HStack gap={1} align="center">
					<Text type="supporting">Used once {shared.setting} is on.</Text>
					<Button
						label={`Open ${profileGraphFacet(facet)?.label ?? facet}`}
						variant="ghost"
						size="sm"
						onClick={() => {
							// A section left out of the profile has no node to open until it's back in.
							setDraft((current) => includeFacet(current, facet));
							onSelect(facet);
						}}
					/>
				</HStack>
			)}
		</VStack>
	);
}

/** Every line the kernel says, by area; left blank, a line keeps the kernel's own. */
function WordingEditor({
	draft,
	setDraft,
	onSelect,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	onSelect: (id: string) => void;
}) {
	const [audience, setAudience] = useState<WordingAudience>('visitor');
	const [query, setQuery] = useState('');
	const needle = query.trim().toLowerCase();
	const areas = wordingAreas(draft, needle, audience);
	const note = WORDING_AUDIENCES.find((entry) => entry.value === audience)?.note;
	return (
		<Section variant="transparent" padding={3}>
			<VStack gap={3}>
				<TextInput
					label="Search wording"
					isLabelHidden
					placeholder="Search names, defaults and text"
					value={query}
					onChange={setQuery}
					startIcon={IconSearch}
					hasClear
				/>
				{!needle && <WordingAudiencePicker value={audience} onChange={setAudience} />}
				{!needle && <Text type="supporting">{note}</Text>}
				{needle && areas.length === 0 && (
					<Text type="supporting">No wording matches “{query.trim()}”.</Text>
				)}
				<CollapsibleGroup
					// Searching opens every area with a match; clearing the search goes back to all closed.
					key={needle ? `search:${areas.map((area) => area.prefix).join()}` : audience}
					type="multiple"
					hasDividers
					density="compact"
					defaultValue={needle ? areas.map((area) => area.prefix) : undefined}
				>
					{areas.map((area) => (
						<Collapsible
							key={area.prefix}
							value={area.prefix}
							trigger={<WordingAreaTrigger area={area} />}
						>
							<WordingAreaLines
								keys={area.keys}
								draft={draft}
								setDraft={setDraft}
								onSelect={onSelect}
							/>
						</Collapsible>
					))}
				</CollapsibleGroup>
			</VStack>
		</Section>
	);
}

/**
 * The areas on show, each with its lines. A search spans both readers: a line matches on its area,
 * its name, its default or its text.
 */
function wordingAreas(draft: StudioDraft, needle: string, audience: WordingAudience) {
	return WORDING_AREAS.filter((area) => needle || area.audience === audience)
		.map((area) => {
			const all = LEXICON_KEYS.filter((key) => key.startsWith(`${area.prefix}.`));
			const keys = needle
				? all.filter((key) =>
						[
							area.title,
							wordingLabel(key),
							wordingPlaceholder(draft, key),
							wordingValue(draft, key),
						].some((text) => text.toLowerCase().includes(needle)),
					)
				: all;
			const edited = all.filter((key) => wordingValue(draft, key)).length;
			return { ...area, keys, edited };
		})
		.filter((area) => area.keys.length > 0);
}

/** Who reads the lines on show: the visitor, or the model. */
function WordingAudiencePicker({
	value,
	onChange,
}: {
	value: WordingAudience;
	onChange: (audience: WordingAudience) => void;
}) {
	return (
		<SegmentedControl
			label="Who reads it"
			size="sm"
			layout="fill"
			value={value}
			onChange={(next) => {
				const picked = WORDING_AUDIENCES.find((entry) => entry.value === next);
				if (picked) onChange(picked.value);
			}}
		>
			{WORDING_AUDIENCES.map((entry) => (
				<Tooltip key={entry.value} content={entry.label}>
					<SegmentedControlItem
						value={entry.value}
						label={entry.label}
						isLabelHidden
						icon={<Icon icon={entry.icon} size="sm" />}
					/>
				</Tooltip>
			))}
		</SegmentedControl>
	);
}

/** An area's heading: its icon, title and note, and how many of its lines are edited. */
function WordingAreaTrigger({ area }: { area: ReturnType<typeof wordingAreas>[number] }) {
	return (
		<HStack gap={2} align="center">
			<Icon icon={area.icon} size="sm" color="secondary" />
			<StackItem size="fill">
				<VStack gap={0}>
					<Text type="supporting" weight="semibold" color="primary">
						{area.title}
					</Text>
					<Text type="supporting" color="secondary">
						{area.note}
					</Text>
				</VStack>
			</StackItem>
			{area.edited > 0 && <Badge variant="info" label={`${String(area.edited)} edited`} />}
		</HStack>
	);
}

/** An area's lines; one that also sits beside its setting edits that setting's field. */
function WordingAreaLines({
	keys,
	draft,
	setDraft,
	onSelect,
}: {
	keys: LexiconKey[];
	draft: StudioDraft;
	setDraft: SetDraft;
	onSelect: (id: string) => void;
}) {
	const set = patch(setDraft, 'wording');
	return (
		<VStack gap={3} paddingBlock={2}>
			{keys.map((key) => {
				const facet = INLINE_WORDING[key];
				if (facet)
					return (
						<SharedWordingRow
							key={key}
							lexiconKey={key}
							facet={facet}
							draft={draft}
							setDraft={setDraft}
							onSelect={onSelect}
						/>
					);
				return (
					<TextAreaRow
						key={key}
						label={wordingLabel(key)}
						path={`lexicon.${key}`}
						field={key}
						rows={2}
						value={draft.wording[key] ?? ''}
						placeholder={wordingPlaceholder(draft, key)}
						onChange={(text) => {
							set({ [key]: text });
						}}
					/>
				);
			})}
		</VStack>
	);
}

const QUESTION_TYPE_SEGMENTS: Segment<DecisionQuestionType>[] = [
	{ value: 'choice', label: 'Choice', icon: IconListCheck },
	{ value: 'score', label: 'Score', icon: IconChartBar },
	{ value: 'noul', label: 'Noul', icon: IconNumber },
];

/** What a question's rows are called, and what a new one's text says. */
const CRITERIA_COPY = {
	choice: {
		title: 'Options',
		row: 'Option',
		note: 'Each answer it may pick, and when to pick it.',
	},
	score: { title: 'Levels', row: 'Level', note: 'The scale from 0 up, each level described.' },
	noul: { title: 'Criteria', row: 'Criterion', note: 'Optional named things the number weighs.' },
} satisfies Record<DecisionQuestionType, { title: string; row: string; note: string }>;

/** One question: its id and answer type, what to ask, and its options or levels. */
function DecisionQuestionEditor({
	question,
	index,
	count,
	onChange,
	onMove,
	onRemove,
}: {
	question: DecisionQuestionDraft;
	index: number;
	count: number;
	onChange: (change: Partial<DecisionQuestionDraft>) => void;
	onMove: (to: number) => void;
	onRemove: () => void;
}) {
	const status = useFieldStatus()('questions', index);
	return (
		<Section variant="transparent" padding={3}>
			<VStack gap={3} {...{ [ISSUE_ROW_ATTRIBUTE]: status !== undefined || undefined }}>
				<QuestionHeader
					question={question}
					index={index}
					count={count}
					status={status}
					onChange={onChange}
					onMove={onMove}
					onRemove={onRemove}
				/>
				<SegmentedRow
					label="Answer"
					path="decision.questions.type"
					value={question.type}
					segments={QUESTION_TYPE_SEGMENTS}
					onChange={(type) => {
						// Options carry over between choice and number; a score's levels are a different list.
						const keeps = type !== 'score' && question.type !== 'score';
						onChange({ type, ...(keeps ? {} : { criteria: newCriteria(type) }) });
					}}
				/>
				<TextArea
					label="Instructions"
					size="sm"
					rows={3}
					value={question.instructions}
					placeholder="What should the model decide, given the state?"
					onChange={(instructions) => {
						onChange({ instructions });
					}}
				/>
				<CriteriaList question={question} onChange={onChange} />
			</VStack>
		</Section>
	);
}

/** A question's id, and the buttons that move and remove it. */
function QuestionHeader({
	question,
	index,
	count,
	status,
	onChange,
	onMove,
	onRemove,
}: {
	question: DecisionQuestionDraft;
	index: number;
	count: number;
	status: ReturnType<ReturnType<typeof useFieldStatus>>;
	onChange: (change: Partial<DecisionQuestionDraft>) => void;
	onMove: (to: number) => void;
	onRemove: () => void;
}) {
	return (
		<HStack gap={1} vAlign="center">
			<StackItem size="fill">
				<TextInput
					label={`Question ${String(index + 1)} id`}
					isLabelHidden
					size="sm"
					status={status}
					value={question.id}
					placeholder="verdict"
					onChange={(id) => {
						onChange({ id });
					}}
				/>
			</StackItem>
			<QuestionActions
				name={question.id || `question ${String(index + 1)}`}
				index={index}
				count={count}
				onMove={onMove}
				onRemove={onRemove}
			/>
		</HStack>
	);
}

function QuestionActions({
	name,
	index,
	count,
	onMove,
	onRemove,
}: {
	name: string;
	index: number;
	count: number;
	onMove: (to: number) => void;
	onRemove: () => void;
}) {
	return (
		<>
			<IconButton
				label={`Move ${name} up`}
				variant="ghost"
				size="sm"
				isDisabled={index === 0}
				icon={<Icon icon={IconArrowUp} size="sm" />}
				onClick={() => {
					onMove(index - 1);
				}}
			/>
			<IconButton
				label={`Move ${name} down`}
				variant="ghost"
				size="sm"
				isDisabled={index === count - 1}
				icon={<Icon icon={IconArrowDown} size="sm" />}
				onClick={() => {
					onMove(index + 1);
				}}
			/>
			<IconButton
				label={`Remove ${name}`}
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconTrash} size="sm" />}
				onClick={onRemove}
			/>
		</>
	);
}

/** One row of a question's options, levels or criteria, and the setter for the whole list. */
interface CriterionProps {
	question: DecisionQuestionDraft;
	row: DecisionQuestionDraft['criteria'][number];
	at: number;
	setCriteria: (criteria: DecisionQuestionDraft['criteria']) => void;
}

/** What a row leads with: a score level's number, or the label of an option or criterion. */
function CriterionLabel({ question, row, at, setCriteria }: CriterionProps) {
	const copy = CRITERIA_COPY[question.type];
	return question.type === 'score' ? (
		<StackItem size="static">
			<Text type="supporting" color="secondary" hasTabularNumbers>
				{String(at)}
			</Text>
		</StackItem>
	) : (
		<div className="criterion-label">
			<TextInput
				label={`${copy.row} ${String(at + 1)} label`}
				isLabelHidden
				size="sm"
				value={row.label}
				placeholder="label"
				onChange={(label) => {
					setCriteria(question.criteria.map((r) => (r.key === row.key ? { ...r, label } : r)));
				}}
			/>
		</div>
	);
}

function CriterionRow({ question, row, at, setCriteria }: CriterionProps) {
	const copy = CRITERIA_COPY[question.type];
	return (
		<HStack gap={1} vAlign="center">
			<CriterionLabel question={question} row={row} at={at} setCriteria={setCriteria} />
			<StackItem size="fill">
				<TextInput
					label={`${copy.row} ${String(at + 1)} description`}
					isLabelHidden
					size="sm"
					value={row.text}
					placeholder={question.type === 'score' ? 'What this level means' : 'When to pick it'}
					onChange={(text) => {
						setCriteria(question.criteria.map((r) => (r.key === row.key ? { ...r, text } : r)));
					}}
				/>
			</StackItem>
			<IconButton
				label={`Remove ${copy.row.toLowerCase()} ${String(at + 1)}`}
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconX} size="sm" />}
				onClick={() => {
					setCriteria(question.criteria.filter((r) => r.key !== row.key));
				}}
			/>
		</HStack>
	);
}

/** A question's options, levels or criteria, and the button that adds one. */
function CriteriaList({
	question,
	onChange,
}: {
	question: DecisionQuestionDraft;
	onChange: (change: Partial<DecisionQuestionDraft>) => void;
}) {
	const copy = CRITERIA_COPY[question.type];
	const setCriteria = (criteria: DecisionQuestionDraft['criteria']) => {
		onChange({ criteria });
	};
	return (
		<VStack gap={2}>
			<VStack gap={0}>
				<Text type="supporting" weight="semibold" color="primary">
					{copy.title}
				</Text>
				<Text type="supporting" color="secondary">
					{copy.note}
				</Text>
			</VStack>
			{question.criteria.map((row, at) => (
				<CriterionRow
					key={row.key}
					question={question}
					row={row}
					at={at}
					setCriteria={setCriteria}
				/>
			))}
			<HStack>
				<Button
					label={`Add ${copy.row.toLowerCase()}`}
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconPlus} size="sm" />}
					isDisabled={question.criteria.length >= STUDIO_DECISION_MAX_CRITERIA}
					onClick={() => {
						setCriteria([...question.criteria, ...newCriteria('score').slice(0, 1)]);
					}}
				/>
			</HStack>
		</VStack>
	);
}

/** The decision slice of the draft and its setter, for each decision section. */
interface DecisionSectionProps {
	decision: StudioDraft['decision'];
	set: SetSection<'decision'>;
}

function DecisionContractSection({ decision, set }: DecisionSectionProps) {
	return (
		<InspectorSection path="decision.contract">
			<TextRow
				label="Contract"
				path="decision.contract"
				field="contract"
				value={decision.contract}
				placeholder="guardrails.tool_call.v1"
				onChange={(contract) => {
					set({ contract });
				}}
			/>
		</InspectorSection>
	);
}

function DecisionStateSection({ decision, set }: DecisionSectionProps) {
	return (
		<InspectorSection note={sectionNote('decision.state')}>
			<NumberRow
				label="Max state"
				path="inputs.maxStateBytes"
				units="bytes"
				field="maxStateBytes"
				value={decision.maxStateBytes}
				min={1}
				max={STUDIO_DECISION_MAX_STATE_BYTES}
				hint={`${String(STUDIO_DECISION_MAX_STATE_BYTES)} by default`}
				isIntegerOnly
				onChange={(maxStateBytes) => {
					set({ maxStateBytes });
				}}
			/>
		</InspectorSection>
	);
}

/** A decision: the contract it answers to, how much state it takes, and the questions it asks of it. */
function DecisionEditor({ draft, setDraft }: { draft: StudioDraft; setDraft: SetDraft }) {
	const { decision } = draft;
	const set = patch(setDraft, 'decision');
	const listStatus = useFieldStatus()('questions');
	const setQuestions = (
		change: (questions: DecisionQuestionDraft[]) => DecisionQuestionDraft[],
	) => {
		setDraft((current) => ({
			...current,
			decision: { ...current.decision, questions: change(current.decision.questions) },
		}));
	};
	// A project's files hold the questions outside the profile: the studio shows them and says where.
	const inFiles = useRowOrigin('decision.questions');
	const rows = (
		<>
			{decision.questions.map((question, index) => (
				<DecisionQuestionEditor
					key={question.key}
					question={question}
					index={index}
					count={decision.questions.length}
					onChange={(change) => {
						setQuestions((questions) =>
							questions.map((q) => (q.key === question.key ? { ...q, ...change } : q)),
						);
					}}
					onMove={(to) => {
						setQuestions((questions) => {
							const next = questions.filter((q) => q.key !== question.key);
							next.splice(to, 0, question);
							return next;
						});
					}}
					onRemove={() => {
						setQuestions((questions) => questions.filter((q) => q.key !== question.key));
					}}
				/>
			))}
			<AddQuestionSection count={decision.questions.length} setDraft={setDraft} />
		</>
	);
	return (
		<>
			<DecisionContractSection decision={decision} set={set} />
			<DecisionStateSection decision={decision} set={set} />
			<InspectorSection title="Questions" note={sectionNote('decision.questions')}>
				{inFiles && !inFiles.said && (
					<OriginLine origin={inFiles.origin} onOpen={inFiles.open} />
				)}
				{listStatus && <Banner status="error" title={listStatus.message} />}
			</InspectorSection>
			{inFiles ? (
				<SaidOrigin value={inFiles.origin}>
					<SetInCode>{rows}</SetInCode>
				</SaidOrigin>
			) : (
				rows
			)}
		</>
	);
}

/** Adds a question, up to the most a decision takes. */
function AddQuestionSection({ count, setDraft }: { count: number; setDraft: SetDraft }) {
	return (
		<Section variant="transparent" padding={3}>
			<HStack>
				<Button
					label="Add question"
					variant="ghost"
					size="sm"
					icon={<Icon icon={IconPlus} size="sm" />}
					isDisabled={count >= STUDIO_DECISION_MAX_QUESTIONS}
					onClick={() => {
						setDraft((current) => ({
							...current,
							decision: {
								...current.decision,
								questions: [...current.decision.questions, newDecisionQuestion(current)],
							},
						}));
					}}
				/>
			</HStack>
		</Section>
	);
}

/** The editor for a node's facet: one per section of the profile, model and tool. */
function facetEditor(
	ref: NonNullable<ReturnType<typeof studioNodeRef>>,
	draft: StudioDraft,
	setDraft: SetDraft,
	onSelect: (id: string) => void,
): ReactNode {
	const props = { draft, setDraft };
	switch (ref.facet) {
		case 'identity':
			return <IdentityEditor {...props} />;
		case 'models':
			return <ModelsEditor {...props} onSelect={onSelect} />;
		case 'modelBinding':
			return draft.identity.profileType === 'decision' ? (
				<DecisionModelEditor {...props} bindingKey={ref.key} />
			) : (
				<ModelBindingEditor {...props} bindingKey={ref.key} onSelect={onSelect} />
			);
		case 'tools':
			return <ToolsEditor {...props} onSelect={onSelect} />;
		case 'toolSpec':
			return <ToolSpecEditor {...props} toolKey={ref.key} onSelect={onSelect} />;
		case 'inputs':
			return <InputsEditor {...props} />;
		case 'image':
			return <ImageEditor {...props} />;
		case 'speech':
			return <SpeechEditor {...props} />;
		case 'live':
			return <LiveEditor {...props} />;
		case 'outputs':
			return <OutputsEditor {...props} />;
		case 'turnBehaviour':
			return <TurnBehaviourEditor {...props} />;
		case 'guardrails':
			return <GuardrailsEditor {...props} />;
		case 'observability':
			return <ObservabilityEditor {...props} />;
		case 'wording':
			return <WordingEditor {...props} onSelect={onSelect} />;
		case 'decision':
			return <DecisionEditor {...props} />;
	}
}

/**
 * The editor for the tree node `selectedId`. The compile's issues for that node show on the rows
 * of the fields they name; the rest show above it.
 * Edits go straight to the draft; the page compiles it.
 */
export function ProfileEditor({
	draft,
	setDraft,
	selectedId,
	onSelect,
	issues,
}: {
	draft: StudioDraft;
	setDraft: SetDraft;
	selectedId: string;
	/** Selects another tree node: a tool, once added or picked from the list, or Tools once removed. */
	onSelect: (id: string) => void;
	issues: readonly StudioIssue[];
}) {
	const ref = studioNodeRef(draft, selectedId);
	if (!ref) return null;
	const nodeIssues = issues.filter((issue) => issue.nodeId === selectedId);
	const banners = nodeIssues.filter((issue) => issue.field === undefined);
	// One place in the project's files sets the whole node: the page says so over it, and no row takes an edit.
	const setInCode = useContext(RowOrigins)?.scope.section !== undefined;
	const editor = facetEditor(ref, draft, setDraft, onSelect);
	return (
		<NodeIssues value={nodeIssues}>
			<VStack>
				{banners.length > 0 && (
					<Section variant="transparent" padding={3}>
						<VStack gap={2}>
							{banners.map((issue) => (
								<Banner key={issue.message} status="error" title={issue.message} />
							))}
						</VStack>
					</Section>
				)}
				{setInCode ? <SetInCode>{editor}</SetInCode> : editor}
			</VStack>
		</NodeIssues>
	);
}

/** Local servers answer local pages only; a hosted page needs its origin allowed. */
const isLocalPage = () =>
	typeof window !== 'undefined' &&
	/^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location.hostname);

/** Allows the page the builder is on, wherever it's hosted. */
const ollamaOriginsCommand = () => `launchctl setenv OLLAMA_ORIGINS "${globalThis.location.origin}"`;

/** Why a hosted page can't list local models, and the one command that fixes it. */
function LocalOriginHelp() {
	return (
		<Banner
			status="warning"
			title="Your local server must allow this site"
			description={
				<VStack gap={2}>
					<Text type="supporting">
						Ollama only answers pages on your own machine. Run this, then quit and reopen Ollama. LM
						Studio: turn on CORS in its server settings.
					</Text>
					<CodeBlock
						code={ollamaOriginsCommand()}
						language="bash"
						hasLanguageLabel={false}
						isWrapped
						size="sm"
					/>
				</VStack>
			}
		/>
	);
}
