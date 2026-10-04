import { Button } from '@astryxdesign/core/Button';
import { FieldLabel } from '@astryxdesign/core/Field';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Tokenizer } from '@astryxdesign/core/Tokenizer';
import { VStack } from '@astryxdesign/core/VStack';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useId, useState } from 'react';
import type { DecisionJson } from '@theoremjs/agents';
import { humanize, isPlain } from '../client/shaped-data.ts';
import { blankLike, isWordList, tableColumns } from '../client/state-fields.ts';
import { useLabels } from './labels-provider.tsx';

export type Edit<T = DecisionJson> = { value: T; onChange: (next: T) => void };
type FieldProps = Edit & { label: string; isLabelHidden?: boolean };

const NO_SUGGESTIONS = { search: () => [], bootstrap: () => [] };
/** Text this long, or on several lines, gets a text area. */
const LONG_TEXT = 48;

/** A string, number, true/false, or null, as its input. */
function PlainField({ value, onChange, label, isLabelHidden }: FieldProps) {
	// Decided once, so the field doesn't swap inputs (and lose focus) as the text grows.
	const [isLong] = useState(() => typeof value === 'string' && (value.length > LONG_TEXT || value.includes('\n')));
	if (typeof value === 'boolean') return <Switch label={label} value={value} onChange={onChange} />;
	if (typeof value === 'number') {
		return <NumberInput label={label} isLabelHidden={isLabelHidden} size="sm" value={value} isWheelEnabled={false} onChange={onChange} />;
	}
	if (value === null) return <TextInput label={label} isLabelHidden={isLabelHidden} size="sm" value="" placeholder="null" isDisabled onChange={() => {}} />;
	const text = String(value);
	return isLong ? (
		<TextArea label={label} isLabelHidden={isLabelHidden} size="sm" rows={2} value={text} onChange={onChange} />
	) : (
		<TextInput label={label} isLabelHidden={isLabelHidden} size="sm" value={text} onChange={onChange} />
	);
}

export type GroupLabel = { label: string; isRequired?: boolean; description?: string };

/** Several fields under one name, in the same label a single field has. */
export function Labelled({ label, isRequired, description, children }: GroupLabel & { children: React.ReactNode }) {
	const id = useId();
	return (
		<VStack gap={2} role="group" aria-labelledby={id}>
			<FieldLabel label={label} inputID="" labelID={id} isGroupLabel isRequired={isRequired} description={description} />
			{children}
		</VStack>
	);
}

/** Nested fields sit under their name, set in by a rule. */
export function Group({ children, ...label }: GroupLabel & { children: React.ReactNode }) {
	return (
		<Labelled {...label}>
			<div style={{ paddingInlineStart: 12, borderInlineStart: '1px solid var(--color-border)' }}>{children}</div>
		</Labelled>
	);
}

/** One more row at the end of a list. */
export function AddRow({ field, onAdd }: { field: string; onAdd: () => void }) {
	const t = useLabels();
	return (
		<HStack>
			<Button label={t('@theorem.decision.add_item', { field })} size="sm" variant="ghost" icon={<IconPlus size={14} />} onClick={onAdd} />
		</HStack>
	);
}

/** Removes a list's row, named by its place. */
export function RemoveRow({ index, onRemove }: { index: number; onRemove: () => void }) {
	const t = useLabels();
	return (
		<IconButton
			label={t('@theorem.decision.remove_item', { item: t('@theorem.data.item', { index: String(index + 1) }) })}
			size="sm"
			variant="ghost"
			icon={<IconX size={14} />}
			onClick={onRemove}
		/>
	);
}

function ObjectFields({ value, onChange }: Edit<{ [key: string]: DecisionJson }>) {
	return (
		<VStack gap={3}>
			{Object.entries(value).map(([key, entry]) => (
				<Field key={key} label={humanize(key)} value={entry} onChange={(next) => onChange({ ...value, [key]: next })} />
			))}
		</VStack>
	);
}

/** A list of words as tokens; any other list as rows, each removable, with one more shaped like the last. */
function ListField({ value, onChange, label }: Edit<DecisionJson[]> & { label: string }) {
	const t = useLabels();
	if (isWordList(value)) {
		return (
			<Tokenizer
				label={label}
				size="sm"
				value={value.map((word, index) => ({ id: `${String(index)}:${word}`, label: word }))}
				searchSource={NO_SUGGESTIONS}
				hasCreate
				debounceMs={0}
				placeholder={t('@theorem.decision.add_value')}
				onChange={(items) => onChange(items.map((item) => item.label))}
			/>
		);
	}
	const columns = tableColumns(value);
	const add = <AddRow field={label} onAdd={() => onChange([...value, blankLike(value.at(-1))])} />;
	const remove = (index: number) => <RemoveRow index={index} onRemove={() => onChange(value.filter((_, at) => at !== index))} />;
	if (columns) {
		// Rows alike and flat, as ShapedData draws them: a table, one input per cell.
		const grid = { display: 'grid', gap: 8, alignItems: 'start', gridTemplateColumns: `${columns.map((column) => `minmax(0, ${String(column.weight)}fr)`).join(' ')} auto` };
		const rows = value as { [key: string]: DecisionJson }[];
		return (
			<Labelled label={label}>
				<div style={grid} aria-hidden>
					{columns.map((column) => (
						<Text key={column.key} type="supporting" color="secondary" maxLines={1}>
							{humanize(column.key)}
						</Text>
					))}
					<span style={{ width: 28 }} />
				</div>
				{rows.map((row, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: list rows have no identity of their own
					<div key={index} style={grid}>
						{columns.map((column) => (
							<PlainField
								key={column.key}
								label={`${humanize(column.key)} ${String(index + 1)}`}
								isLabelHidden
								value={row[column.key] ?? null}
								onChange={(next) => onChange(rows.map((old, at) => (at === index ? { ...old, [column.key]: next } : old)))}
							/>
						))}
						{remove(index)}
					</div>
				))}
				{add}
			</Labelled>
		);
	}
	return (
		<Group label={label}>
			<VStack gap={3}>
				{value.map((entry, index) => {
					const item = t('@theorem.data.item', { index: String(index + 1) });
					const set = (next: DecisionJson) => onChange(value.map((old, at) => (at === index ? next : old)));
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: list rows have no identity of their own
						<HStack key={index} gap={2} vAlign="start">
							<StackItem size="fill">
								{isPlain(entry) ? <PlainField label={item} isLabelHidden value={entry} onChange={set} /> : <Field label={item} value={entry} onChange={set} />}
							</StackItem>
							{remove(index)}
						</HStack>
					);
				})}
				{add}
			</VStack>
		</Group>
	);
}

function Field({ value, onChange, label }: FieldProps) {
	if (Array.isArray(value)) return <ListField label={label} value={value} onChange={onChange} />;
	if (value !== null && typeof value === 'object') {
		return (
			<Group label={label}>
				<ObjectFields value={value} onChange={onChange} />
			</Group>
		);
	}
	return <PlainField label={label} value={value} onChange={onChange} />;
}

/**
 * A decision's state edited field by field: objects as labelled fields, lists
 * of words as tokens, other lists as rows. The shape itself (new keys, other
 * types) is edited as JSON.
 */
export function StateFields({ value, onChange, label }: Edit & { label: string }) {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) return <ObjectFields value={value} onChange={onChange} />;
	return <Field label={label} value={value} onChange={onChange} />;
}
