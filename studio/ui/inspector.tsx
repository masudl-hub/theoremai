import type { InputStatus } from '@astryxdesign/core/Field';
import { FieldStatus } from '@astryxdesign/core/FieldStatus';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { MultiSelector } from '@astryxdesign/core/MultiSelector';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector, type SelectorOptionType } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { Tokenizer } from '@astryxdesign/core/Tokenizer';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { IconArrowBackUp } from '@tabler/icons-react';
import { fieldMeta } from '../../mod.ts';
import { originLabel, originPlace, STUDIO_PROFILE_TYPES } from '../mod.ts';
import type { SettingOrigin } from '../server/save-wire.ts';
import { type ReactNode, useContext } from 'react';
import { tabFills } from './lib/tab-fills.ts';
import {
	ISSUE_ROW_ATTRIBUTE,
	ListBadges,
	SaidOrigin,
	useFieldStatus,
	useRowOrigin,
} from './inspector-context.ts';

/**
 * Inspector building blocks: captioned sections of label-and-control rows, after Astryx's
 * canvas editor template. Every control is `sm` and hides its own label, because the row's
 * label column names it; that column is one fixed width, so every control starts on one edge.
 */

/**
 * The label column, wide enough for the longest label ("Temperature", "Attachments") on one line.
 * The template's is 80, which fits its shorter labels.
 */
const LABEL_COLUMN = 96;

/**
 * Whether the field at `path` must be set, and what leaving it out does, from the kernel's catalog.
 * `isRequired` overrides it for a field required only in some cases, saying whether it is now.
 */
function presence(path: string, isRequired?: boolean) {
	const meta = fieldMeta(path);
	const required = isRequired ?? meta?.required === true;
	return { required, unset: required ? undefined : meta?.unset };
}

/**
 * Controls the project's files set in code: they show their value and take no edit. A disabled
 * fieldset turns off every control inside it, whatever kind it is.
 */
export function SetInCode({ children }: { children: ReactNode }) {
	return (
		<fieldset disabled className="inspector-set-in-code">
			{children}
		</fieldset>
	);
}

/**
 * Under a value the files set in code: what sets it and where, and the way to that line in the
 * builder's editor. The place is text, so it can be copied when no editor opens.
 */
export function OriginLine({ origin, onOpen }: { origin: SettingOrigin; onOpen: () => void }) {
	const place = originPlace(origin);
	return (
		<HStack gap={2} vAlign="center">
			<StackItem size="fill">
				<Text type="supporting" color="secondary">
					{place ? `${originLabel(origin)} · ${place}` : originLabel(origin)}
				</Text>
			</StackItem>
			{place && (
				<StackItem size="static">
					<Button label="Open" variant="ghost" size="sm" onClick={onOpen} />
				</StackItem>
			)}
		</HStack>
	);
}

/**
 * A captioned group of rows. The panel stays at zero padding and each section carries the gutter.
 * Transparent, so the panel's own surface shows through. The title shows the catalog entry of the
 * field the section edits (`path`) on hover, as a row's label does. Under it, `note`: only what
 * the catalog does not say, such as how the editor or the studio treats the field.
 */
export function InspectorSection({
	title,
	path,
	note,
	children,
}: {
	title?: string;
	path?: string;
	note?: string;
	children: ReactNode;
}) {
	const heading = title && (
		<Text type="label" weight="semibold">
			{title}
		</Text>
	);
	// A section whose own field the files set in code says so once, and its rows take no edit.
	const found = useRowOrigin(path);
	const says = found && !found.said ? found : undefined;
	return (
		<Section variant="transparent" padding={3}>
			<VStack gap={3}>
				<VStack gap={1} hAlign="start">
					{heading && title && path !== undefined ? (
						<CatalogHover label={title} path={path}>
							{heading}
						</CatalogHover>
					) : (
						heading
					)}
					{note && <Text type="supporting">{note}</Text>}
				</VStack>
				{says ? (
					<SaidOrigin value={says.origin}>
						<OriginLine origin={says.origin} onOpen={says.open} />
						<SetInCode>
							<VStack gap={3}>{children}</VStack>
						</SetInCode>
					</SaidOrigin>
				) : (
					children
				)}
			</VStack>
		</Section>
	);
}

/**
 * The name of a group of rows inside a section. Astryx's ladder, top down: the page title is 14
 * bold, a section title 14 semibold, this 12 semibold in primary, a row label 12 regular in
 * secondary. `hint` says what the group is, on hover.
 */
export function InspectorGroupTitle({ title, hint }: { title: string; hint?: string }) {
	const heading = (
		<Text type="supporting" weight="semibold" color="primary">
			{title}
		</Text>
	);
	return hint ? <Tooltip content={hint}>{heading}</Tooltip> : heading;
}

/**
 * `children`, with the schema's entry for `path` on hover: what it does, then its options as
 * tokens (or its type, when it has none), when it's required or what leaving it out does. The
 * profile types that take it are only named when one the studio offers can't.
 */
function CatalogHover({
	label,
	path,
	children,
}: {
	label: string;
	path: string;
	children: ReactNode;
}) {
	const meta = fieldMeta(path);
	if (!meta) return children;
	const scope = meta.profileTypes;
	// why: Decisions are the odd one out: they take little of the schema, so "not on decisions" is
	// assumed, and only a narrower scope is worth saying.
	const agents = STUDIO_PROFILE_TYPES.filter((type) => type !== 'decision');
	const takes = agents.filter((type) => !scope || scope.includes(type));
	const scoped = takes.length < agents.length ? takes : undefined;
	return (
		<HoverCard
			label={label}
			content={
				<VStack gap={2} maxWidth={280}>
					<Text>{meta.doc}</Text>
					<HStack gap={1} wrap="wrap">
						{(meta.options ?? [meta.type]).map((option) => (
							<Token key={option} label={option} size="sm" />
						))}
					</HStack>
					{meta.optionNote && (
						<Text type="supporting" color="secondary">
							{meta.optionNote}
						</Text>
					)}
					{typeof meta.required === 'string' && (
						<Text type="supporting" color="secondary">{`Required ${meta.required}.`}</Text>
					)}
					{meta.unset && (
						<Text type="supporting" color="secondary">{`Left out: ${meta.unset}.`}</Text>
					)}
					{scoped && (
						<Text
							type="supporting"
							color="secondary"
						>{`Only on ${scoped.join(', ')} profiles.`}</Text>
					)}
				</VStack>
			}
		>
			{children}
		</HoverCard>
	);
}

/** A row's label, 12 regular in secondary, with "Required" under it when `isRequired`, and its catalog entry on hover. */
function RowLabel({
	label,
	path,
	isRequired,
}: {
	label: string;
	path: string;
	isRequired: boolean;
}) {
	return (
		<CatalogHover label={label} path={path}>
			<VStack gap={0}>
				<Text type="supporting" color="secondary">
					{label}
				</Text>
				{isRequired && (
					<Text type="supporting" color="placeholder">
						Required
					</Text>
				)}
			</VStack>
		</CatalogHover>
	);
}

/** The height of a row's control, which its label centres on when a note makes the row taller. */
const CONTROL_HEIGHT = 28;

/**
 * One row: the label column, then the controls for it. `path` is the field's schema catalog path;
 * `hasIssue` marks the row for the issue pill. With `hasNote`, a note sits under the control, so the
 * label stays beside the control and not halfway down the note.
 */
export function InspectorRow({
	label,
	path,
	isRequired = false,
	hasIssue,
	hasNote = false,
	children,
}: {
	label: string;
	path: string;
	/** Notes "Required" under the label. */
	isRequired?: boolean;
	hasIssue?: boolean;
	hasNote?: boolean;
	children: ReactNode;
}) {
	// A value the files set in code shows, takes no edit, and says where it is set. A row inside a
	// section or a node that already said so only takes no edit.
	const found = useRowOrigin(path);
	const set = found && !found.said ? found : undefined;
	const tall = hasNote || set !== undefined;
	const row = (
		<HStack gap={1} vAlign={hasNote ? 'start' : 'center'}>
			{children}
		</HStack>
	);
	const controls = found ? <SetInCode>{row}</SetInCode> : row;
	return (
		<HStack
			gap={2}
			vAlign={tall ? 'start' : 'center'}
			{...{ [ISSUE_ROW_ATTRIBUTE]: hasIssue || undefined }}
		>
			<StackItem size="static">
				<HStack width={LABEL_COLUMN} minHeight={tall ? CONTROL_HEIGHT : undefined} vAlign="center">
					<RowLabel label={label} path={path} isRequired={isRequired} />
				</HStack>
			</StackItem>
			<StackItem size="fill">
				{set ? (
					<VStack gap={1}>
						{controls}
						<OriginLine origin={set.origin} onOpen={set.open} />
					</VStack>
				) : (
					controls
				)}
			</StackItem>
		</HStack>
	);
}

/** Says whether the row's field is required now, for one required only in some cases. */
export type IsRequired = { isRequired?: boolean };

/** What a field row takes: its label, its catalog path, and the draft field whose issues show on it. */
export type FieldRowProps = {
	label: string;
	path: string;
	/** The draft field whose issues show on this row. */
	field?: string;
} & IsRequired;

/**
 * A field row's issue status and presence, and the props its one control shares: labelled but with
 * the label hidden, since the row shows it.
 */
function useFieldRow({ label, path, field, isRequired }: FieldRowProps) {
	const status = useFieldStatus()(field);
	const { required, unset } = presence(path, isRequired);
	const control = { label, status, isLabelHidden: true, isRequired: required, size: 'sm' as const };
	return { status, required, unset, control };
}

/** A field row whose one control fills the width beside the label. */
function FillRow({
	label,
	path,
	required,
	status,
	note,
	children,
}: {
	label: string;
	path: string;
	required: boolean;
	status?: InputStatus;
	/** A note of the row's own, shown under the control when the field has no issue. */
	note?: InputStatus;
	children: ReactNode;
}) {
	return (
		<InspectorRow
			label={label}
			path={path}
			isRequired={required}
			hasIssue={status !== undefined}
			hasNote={Boolean((status ?? note)?.message)}
		>
			<StackItem size="fill">{children}</StackItem>
		</InspectorRow>
	);
}

/**
 * Free text. Left blank, it shows `placeholder`, a value Tab takes up to edit (an example, or the
 * default); else `hint`, or what leaving it out does.
 */
export function TextRow(
	props: FieldRowProps & {
		value: string;
		status?: InputStatus;
		placeholder?: string;
		hint?: string;
		/** The most characters the field takes; typing stops there. */
		maxLength?: number;
		onChange: (next: string) => void;
	},
) {
	const { status: fieldStatus, required, unset, control } = useFieldRow(props);
	const status = props.status ?? fieldStatus;
	return (
		<FillRow label={props.label} path={props.path} required={required} status={status}>
			<TextInput
				{...control}
				status={status}
				value={props.value}
				placeholder={props.placeholder ?? props.hint ?? unset}
				onKeyDown={tabFills(props.value, props.placeholder, props.onChange)}
				// why: TextInput takes no maxLength, so what is typed or pasted past it is dropped here.
				onChange={(next) => {
					props.onChange(Array.from(next).slice(0, props.maxLength).join(''));
				}}
			/>
		</FillRow>
	);
}

/**
 * Longer text, under its label rather than beside it: wording and JSON. Left blank, it shows
 * `placeholder` (for wording, the kernel's own default line) for Tab to take up, else `hint`.
 */
export function TextAreaRow(
	props: FieldRowProps & {
		value: string;
		placeholder?: string;
		hint?: string;
		rows?: number;
		hasSpellCheck?: boolean;
		/** A status of the row's own, such as text that is not JSON; the field's issues win. */
		status?: InputStatus;
		onChange: (next: string) => void;
	},
) {
	const { label, path, value, placeholder, hint, rows = 3, hasSpellCheck = true, onChange } = props;
	const { status: fieldStatus, required, unset, control } = useFieldRow(props);
	const status = fieldStatus ?? props.status;
	return (
		<VStack gap={1} {...{ [ISSUE_ROW_ATTRIBUTE]: fieldStatus !== undefined || undefined }}>
			<RowLabel label={label} path={path} isRequired={required} />
			<TextArea
				{...control}
				status={status}
				rows={rows}
				hasSpellCheck={hasSpellCheck}
				value={value}
				placeholder={placeholder ?? hint ?? unset}
				onKeyDown={tabFills(value, placeholder, onChange)}
				onChange={onChange}
			/>
		</VStack>
	);
}

/** A number the kernel leaves unset when cleared: it gives `null`, shown as what leaving it out does. */
export function NumberRow(
	props: FieldRowProps & {
		value: number | null;
		min?: number;
		max?: number;
		step?: number;
		isIntegerOnly?: boolean;
		/** Shown at the end of the input, e.g. `ms`. */
		units?: string;
		/** Shown while blank, in place of what leaving it out does. */
		hint?: string;
		/** A note of the row's own, such as what the value set does; the field's issues win. */
		status?: InputStatus;
		onChange: (next: number | null) => void;
	},
) {
	const { status, required, unset, control } = useFieldRow(props);
	return (
		<FillRow
			label={props.label}
			path={props.path}
			required={required}
			status={status}
			note={props.status}
		>
			<NumberInput
				{...control}
				status={status ?? props.status}
				value={props.value}
				placeholder={props.hint ?? unset}
				min={props.min}
				max={props.max}
				step={props.step}
				isIntegerOnly={props.isIntegerOnly}
				units={props.units}
				isWheelEnabled={false}
				hasClear
				onChange={props.onChange}
			/>
		</FillRow>
	);
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact' });

/**
 * A slider's value: one that is always set, or one that can be blank, whose thumb sits at
 * `fallback` while it is.
 */
export type SliderValue =
	| { value: number; fallback?: undefined; onChange: (next: number) => void }
	| { value: number | null; fallback: number; onChange: (next: number | null) => void };

/**
 * A number on a slider, shown by `format` (compact by default). One that can be blank sits at
 * `fallback`, where the provider puts it, and reads "Default" until moved; reset puts it back.
 */
export function SliderRow(
	props: {
		label: string;
		path: string;
		/** The draft field whose issues show on this row. */
		field?: string;
		min: number;
		max: number;
		step: number;
		format?: (value: number) => string;
	} & SliderValue,
) {
	const {
		label,
		path,
		field,
		min,
		max,
		step,
		format = (next: number) => COMPACT.format(next),
	} = props;
	const status = useFieldStatus()(field);
	const { required } = presence(path);
	return (
		<InspectorRow
			label={label}
			path={path}
			isRequired={required}
			hasIssue={status !== undefined}
			hasNote={Boolean(status?.message)}
		>
			<StackItem size="fill">
				<Slider
					label={label}
					status={status}
					isLabelHidden
					value={props.fallback === undefined ? props.value : (props.value ?? props.fallback)}
					min={min}
					max={max}
					step={step}
					valueDisplay="text"
					formatValue={(next) => (props.value === null ? 'Default' : format(next))}
					onChange={props.onChange}
				/>
			</StackItem>
			{props.fallback !== undefined && (
				<IconButton
					label={`Reset ${label.toLowerCase()} to the provider default`}
					variant="ghost"
					size="sm"
					isDisabled={props.value === null}
					icon={<Icon icon={IconArrowBackUp} size="sm" />}
					onClick={() => {
						props.onChange(null);
					}}
				/>
			)}
		</InspectorRow>
	);
}

/** On or off. What leaving it out does shows on hover. */
export function SwitchRow({
	label,
	path,
	field,
	value,
	isDisabled,
	disabledMessage,
	onChange,
}: {
	label: string;
	path: string;
	/** The draft field whose issues show on this row. */
	field?: string;
	value: boolean;
	isDisabled?: boolean;
	/** Why it's off limits, on hover and focus, when `isDisabled`. */
	disabledMessage?: string;
	onChange: (next: boolean) => void;
}) {
	const status = useFieldStatus()(field);
	return (
		<InspectorRow
			label={label}
			path={path}
			hasIssue={status !== undefined}
			hasNote={Boolean(status?.message)}
		>
			<Switch
				label={label}
				status={status}
				isLabelHidden
				size="sm"
				value={value}
				isDisabled={isDisabled}
				disabledMessage={disabledMessage}
				onChange={onChange}
			/>
		</InspectorRow>
	);
}

export interface Segment<T extends string> {
	value: T;
	label: string;
	icon: IconType;
	/** What it means, on hover, for a segment the catalog has no option for. */
	description?: string;
	isDisabled?: boolean;
	/** Why it can't be picked, on hover, when `isDisabled`. */
	disabledMessage?: string;
	/** The pick the kernel recommends here: its name says so, on hover and to a screen reader. */
	isRecommended?: boolean;
}

export type SegmentedRowProps<T extends string> = {
	label: string;
	path: string;
	/** The draft field whose issues show on this row. */
	field?: string;
	value: T;
	segments: readonly Segment<T>[];
	isDisabled?: boolean;
	warning?: string;
	/** A status of the row's own, such as an issue on a page the row opens; the field's issues win. */
	status?: InputStatus;
	/** A control after the segments, on the same line. */
	trailing?: ReactNode;
	onChange: (next: T) => void;
} & IsRequired;

/**
 * A closed set, as icon segments. Each
 * segment's label is its accessible name, and on hover it shows with the schema's description of
 * that option. `warning` says, under it, when the pick is valid but won't do what it looks like; a
 * compile issue on the row shows instead.
 */
export function SegmentedRow<T extends string>({
	label,
	path,
	field,
	value,
	segments,
	isDisabled,
	isRequired,
	warning,
	status: given,
	trailing,
	onChange,
}: SegmentedRowProps<T>) {
	const options = fieldMeta(path)?.optionDescriptions;
	const issue = useFieldStatus()(field) ?? given;
	const status = issue ?? (warning ? { type: 'warning' as const, message: warning } : undefined);
	const { required } = presence(path, isRequired);
	return (
		<InspectorRow
			label={label}
			path={path}
			isRequired={required}
			hasIssue={issue !== undefined}
			hasNote={Boolean(status?.message)}
		>
			<StackItem size="fill">
				<SegmentedControl
					label={label}
					size="sm"
					layout="fill"
					value={value}
					isDisabled={isDisabled}
					onChange={(next) => {
						const segment = segments.find((candidate) => candidate.value === next);
						if (segment) onChange(segment.value);
					}}
				>
					{segments.map((segment) => {
						const description =
							(segment.isDisabled && segment.disabledMessage) ||
							options?.[segment.value] ||
							segment.description;
						const name = segment.isRecommended ? `${segment.label} (recommended)` : segment.label;
						return (
							<Tooltip key={segment.value} content={description ? `${name}: ${description}` : name}>
								<SegmentedControlItem
									value={segment.value}
									label={name}
									isLabelHidden
									isDisabled={segment.isDisabled}
									icon={<Icon icon={segment.icon} size="sm" />}
								/>
							</Tooltip>
						);
					})}
				</SegmentedControl>
				{status?.message && (
					<FieldStatus type={status.type} message={status.message} variant="detached" />
				)}
			</StackItem>
			{trailing}
		</InspectorRow>
	);
}

/** One option of a `ChoiceRow`: its value alone, or with a label, a description, or disabled. */
export type Choice<T extends string> =
	| T
	| { value: T; label?: string; description?: string; disabled?: boolean };

export type ChoiceRowProps<T extends string> = {
	label: string;
	path: string;
	/** The draft field whose issues show on this row. */
	field?: string;
	value: T | '';
	options: readonly Choice<T>[];
	isDisabled?: boolean;
	hasSearch?: boolean;
	/** The options are still arriving. */
	isLoading?: boolean;
	/** What an empty list says. */
	emptyText?: string;
	/** What the blank row says, in place of what leaving the field out does. */
	placeholder?: string;
	/** A status of the row's own, such as a list that failed to load; the field's issues win. */
	status?: InputStatus;
	onChange: (next: T | '') => void;
} & IsRequired;

/**
 * A choice from a list, `''` when none is chosen. An optional one can be cleared, and shows what
 * leaving it out does while blank. `hasSearch` filters a long list.
 */
export function ChoiceRow<T extends string>({
	label,
	path,
	field,
	value,
	options,
	isDisabled,
	isRequired,
	hasSearch,
	isLoading,
	emptyText,
	placeholder,
	status: given,
	onChange,
}: ChoiceRowProps<T>) {
	const status = useFieldStatus()(field) ?? given;
	const { required, unset } = presence(path, isRequired);
	// The Selector hands back a plain string; take the option's own value for it.
	const choose = (next: string | null) => {
		const chosen = options
			.map((option) => (typeof option === 'string' ? option : option.value))
			.find((candidate) => candidate === next);
		onChange(chosen ?? '');
	};
	const shared = {
		label,
		status,
		isLabelHidden: true,
		size: 'sm' as const,
		options: [...options],
		placement: 'below' as const,
		isDisabled,
		hasSearch,
		isLoading,
		emptyText,
	};
	return (
		<InspectorRow
			label={label}
			path={path}
			isRequired={required}
			hasIssue={status !== undefined}
			hasNote={Boolean(status?.message)}
		>
			<StackItem size="fill">
				{required ? (
					<Selector
						{...shared}
						isRequired
						value={value}
						placeholder={placeholder}
						onChange={choose}
					/>
				) : (
					<Selector
						{...shared}
						value={value || null}
						placeholder={placeholder ?? unset}
						hasClear
						onChange={choose}
					/>
				)}
			</StackItem>
		</InspectorRow>
	);
}

/**
 * Several choices from a list, the first few as badges and the rest counted (`ListBadges`): the
 * trigger is one line tall, and Astryx wraps badges past it. Left empty, it shows what leaving it
 * out does.
 */
export function ListRow({
	label,
	path,
	field,
	value,
	options,
	onChange,
}: {
	label: string;
	path: string;
	/** The draft field whose issues show on this row. */
	field?: string;
	value: string[];
	options: SelectorOptionType[];
	onChange: (next: string[]) => void;
}) {
	const status = useFieldStatus()(field);
	const { unset } = presence(path);
	const maxBadges = useContext(ListBadges);
	return (
		<InspectorRow
			label={label}
			path={path}
			hasIssue={status !== undefined}
			hasNote={Boolean(status?.message)}
		>
			<StackItem size="fill">
				<MultiSelector
					label={label}
					status={status}
					isLabelHidden
					size="sm"
					value={value}
					options={options}
					placeholder={unset}
					hasSearch
					triggerDisplay="badges"
					maxBadges={maxBadges}
					className="inspector-list"
					onChange={onChange}
				/>
			</StackItem>
		</InspectorRow>
	);
}

/** A names row suggests nothing; every token is one the user typed. */
const NO_SUGGESTIONS = { search: () => [], bootstrap: () => [] };

/**
 * Free-form names, typed and committed with Enter, each a token. Duplicates and blanks never make
 * it in. `disabledMessage` says why, when `isDisabled`.
 */
export function NamesRow({
	label,
	path,
	field,
	value,
	placeholder,
	isDisabled,
	disabledMessage,
	onChange,
}: {
	label: string;
	path: string;
	/** The draft field whose issues show on this row. */
	field?: string;
	value: string[];
	placeholder?: string;
	isDisabled?: boolean;
	disabledMessage?: string;
	onChange: (next: string[]) => void;
}) {
	const status = useFieldStatus()(field);
	const { unset } = presence(path);
	return (
		<InspectorRow
			label={label}
			path={path}
			hasIssue={status !== undefined}
			hasNote={Boolean(status?.message)}
		>
			<StackItem size="fill">
				<Tokenizer
					label={label}
					status={status}
					isLabelHidden
					size="sm"
					value={value.map((name) => ({ id: name, label: name }))}
					searchSource={NO_SUGGESTIONS}
					hasCreate
					debounceMs={0}
					placeholder={placeholder ?? unset}
					isDisabled={isDisabled}
					disabledMessage={disabledMessage}
					tokenOverflowBehavior="unfocusedInline"
					onChange={(items) => {
						const names = items.map((item) => item.label.trim()).filter(Boolean);
						onChange([...new Set(names)]);
					}}
				/>
			</StackItem>
		</InspectorRow>
	);
}
