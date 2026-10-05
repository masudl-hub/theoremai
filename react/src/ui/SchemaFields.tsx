import type { ISODateString } from '@astryxdesign/core/Calendar';
import { CheckboxList, CheckboxListItem } from '@astryxdesign/core/CheckboxList';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Tokenizer } from '@astryxdesign/core/Tokenizer';
import { VStack } from '@astryxdesign/core/VStack';
import { type CSSProperties, type ReactNode, useState } from 'react';
import {
  blankRow,
  type JsonSchema,
  type SchemaControl,
  type SchemaField,
  schemaFields,
  withField,
} from '../client/schema-fields.ts';
import { isRow, json } from '../client/shaped-data.ts';
import { useLabels } from './labels-provider.tsx';
import { useKeyedRows } from './row-keys.ts';
import { AddRow, Group, Labelled, RemoveRow, type Edit as StateEdit } from './StateFields.tsx';

type Edit<T = unknown> = StateEdit<T>;

const NO_SUGGESTIONS = { search: () => [], bootstrap: () => [] };
const CODE_FONT = { '--font-family-body': 'var(--font-family-code)' } as CSSProperties;

/** A field whose input carries no label of its own, labelled as one. */
function Described({ field, children }: { field: SchemaField; children: React.ReactNode }) {
  return (
    <Labelled label={field.label} isRequired={field.isRequired} description={field.description}>
      {children}
    </Labelled>
  );
}

/** A field the schema doesn't shape (no type, a union, a free object), as its JSON. */
function JsonField({ field, value, onChange }: Edit & { field: SchemaField }) {
  const t = useLabels();
  const [text, setText] = useState(() => (value === undefined ? '' : json(value)));
  const [isValid, setValid] = useState(true);
  return (
    <TextArea
      label={field.label}
      description={field.description}
      isRequired={field.isRequired}
      size="sm"
      rows={3}
      value={text}
      hasSpellCheck={false}
      status={isValid ? undefined : { type: 'error', message: t('@theorem.decision.invalid_json') }}
      style={CODE_FONT}
      onChange={(next) => {
        setText(next);
        if (next.trim() === '') {
          setValid(true);
          onChange(undefined);
          return;
        }
        try {
          onChange(JSON.parse(next) as unknown);
          setValid(true);
        } catch {
          setValid(false);
        }
      }}
    />
  );
}

/** A list of objects: each row its own fields, removable, and one more at the end. */
function RowsField({
  field,
  item,
  value,
  onChange,
}: Edit & { field: SchemaField; item: JsonSchema }) {
  const rows = Array.isArray(value) ? value : [];
  const keyed = useKeyedRows(rows);
  return (
    <Group label={field.label} isRequired={field.isRequired} description={field.description}>
      <VStack gap={3}>
        {keyed.rows.map(({ item: row, index, key }) => (
          <HStack key={key} gap={2} vAlign="start">
            <StackItem size="fill">
              <ObjectFields
                schema={item}
                value={isRow(row) ? row : {}}
                onChange={(next) => onChange(rows.map((old, at) => (at === index ? next : old)))}
              />
            </StackItem>
            <RemoveRow
              index={index}
              onRemove={() => {
                keyed.drop(index);
                onChange(rows.filter((_, at) => at !== index));
              }}
            />
          </HStack>
        ))}
        <AddRow field={field.label} onAdd={() => onChange([...rows, blankRow(item)])} />
      </VStack>
    </Group>
  );
}

function common(field: SchemaField) {
  return {
    label: field.label,
    description: field.description,
    isRequired: field.isRequired,
    size: 'sm',
  } as const;
}

/** One of a few options as segments; more as a menu. */
function ChoiceField({
  field,
  options,
  isMenu,
  value,
  onChange,
}: Edit & { field: SchemaField; options: string[]; isMenu: boolean }) {
  if (isMenu) {
    return (
      <Selector
        {...common(field)}
        options={options}
        value={typeof value === 'string' ? value : undefined}
        hasSearch={options.length > 10}
        onChange={onChange}
      />
    );
  }
  return (
    <Described field={field}>
      <HStack>
        <SegmentedControl
          label={field.label}
          size="sm"
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
        >
          {options.map((option) => (
            <SegmentedControlItem key={option} value={option} label={option} />
          ))}
        </SegmentedControl>
      </HStack>
    </Described>
  );
}

function TextField({
  field,
  isLong,
  type,
  value,
  onChange,
}: Edit & { field: SchemaField; isLong: boolean; type: 'text' | 'email' }) {
  const text = typeof value === 'string' ? value : '';
  return isLong ? (
    <TextArea {...common(field)} rows={3} value={text} onChange={onChange} />
  ) : (
    <TextInput {...common(field)} type={type} value={text} onChange={onChange} />
  );
}

/** A list of words or numbers as tokens. */
function WordsField({ field, value, onChange }: Edit & { field: SchemaField }) {
  const t = useLabels();
  const words = Array.isArray(value) ? value : [];
  return (
    <Tokenizer
      {...common(field)}
      value={words.map((word, index) => ({
        id: `${String(index)}:${String(word)}`,
        label: String(word),
      }))}
      searchSource={NO_SUGGESTIONS}
      hasCreate
      debounceMs={0}
      placeholder={t('@theorem.decision.add_value')}
      onChange={(items) =>
        onChange(
          items.map((item) =>
            typeof words[0] === 'number' && Number.isFinite(Number(item.label))
              ? Number(item.label)
              : item.label,
          ),
        )
      }
    />
  );
}

type ControlKind = SchemaControl['kind'];
type ControlProps<K extends ControlKind> = Edit & {
  field: SchemaField;
  control: Extract<SchemaControl, { kind: K }>;
};

/** Each control's input, as the schema asks for it. */
const CONTROLS: { [K in ControlKind]: (props: ControlProps<K>) => ReactNode } = {
  choice: ({ field, control, value, onChange }) => (
    <ChoiceField
      field={field}
      options={control.options}
      isMenu={control.isMenu}
      value={value}
      onChange={onChange}
    />
  ),
  range: ({ field, control, value, onChange }) => (
    <Slider
      label={field.label}
      description={field.description}
      isRequired={field.isRequired}
      min={control.min}
      max={control.max}
      step={1}
      value={typeof value === 'number' ? value : control.min}
      valueDisplay="text"
      onChange={onChange}
    />
  ),
  number: ({ field, control, value, onChange }) => (
    <NumberInput
      {...common(field)}
      value={typeof value === 'number' ? value : undefined}
      min={control.min}
      max={control.max}
      isIntegerOnly={control.isInteger}
      isWheelEnabled={false}
      onChange={(next) => onChange(next ?? undefined)}
    />
  ),
  switch: ({ field, value, onChange }) => (
    <Switch
      label={field.label}
      description={field.description}
      value={value === true}
      onChange={onChange}
    />
  ),
  date: ({ field, value, onChange }) => (
    <DateInput
      {...common(field)}
      value={typeof value === 'string' ? (value as ISODateString) : undefined}
      onChange={onChange}
    />
  ),
  text: ({ field, control, value, onChange }) => (
    <TextField
      field={field}
      isLong={control.isLong}
      type={control.type}
      value={value}
      onChange={onChange}
    />
  ),
  choices: ({ field, control, value, onChange }) => (
    <CheckboxList
      label={field.label}
      description={field.description}
      value={
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === 'string')
          : []
      }
      onChange={onChange}
    >
      {control.options.map((option) => (
        <CheckboxListItem key={option} label={option} value={option} />
      ))}
    </CheckboxList>
  ),
  words: ({ field, value, onChange }) => (
    <WordsField field={field} value={value} onChange={onChange} />
  ),
  rows: ({ field, control, value, onChange }) => (
    <RowsField field={field} item={control.item} value={value} onChange={onChange} />
  ),
  group: ({ field, control, value, onChange }) => (
    <Group label={field.label} isRequired={field.isRequired} description={field.description}>
      <ObjectFields schema={control.schema} value={isRow(value) ? value : {}} onChange={onChange} />
    </Group>
  ),
  json: ({ field, value, onChange }) => (
    <JsonField field={field} value={value} onChange={onChange} />
  ),
};

function Field({ field, value, onChange }: Edit & { field: SchemaField }) {
  const control = CONTROLS[field.control.kind] as (props: ControlProps<ControlKind>) => ReactNode;
  return control({ field, control: field.control, value, onChange });
}

/** Room a short field takes: numbers, dates, menus and one-line text sit side by side. */
const SHORT_FIELD_PX = 200;
/** Segments whose labels run this long in all still fit a short field's width. */
const SHORT_SEGMENT_CHARS = 18;

/** A field that reads in a column's width; the rest take the whole row. */
function isShort({ control }: SchemaField): boolean {
  switch (control.kind) {
    case 'number':
    case 'switch':
    case 'date':
      return true;
    case 'choice':
      return control.isMenu || control.options.join('').length <= SHORT_SEGMENT_CHARS;
    case 'text':
      return !control.isLong;
    default:
      return false;
  }
}

function ObjectFields({
  schema,
  value,
  onChange,
}: Edit<Record<string, unknown>> & { schema: JsonSchema }) {
  return (
    <Grid columns={{ minWidth: SHORT_FIELD_PX, repeat: 'fill' }} gap={3}>
      {schemaFields(schema).map((field) => (
        // why: Short fields meet at their inputs, whether or not each has a description.
        <div
          key={field.key}
          style={
            isShort(field)
              ? { minWidth: 0, alignSelf: 'end' }
              : { gridColumn: '1 / -1', minWidth: 0 }
          }
        >
          <Field
            field={field}
            value={value[field.key]}
            onChange={(next) => onChange(withField(value, field.key, next))}
          />
        </div>
      ))}
    </Grid>
  );
}

/**
 * A tool's request as a form drawn from its input schema: each field the
 * input its type asks for, labelled by its title or key and described by its
 * description. Optional fields left empty aren't sent.
 */
export function SchemaFields({
  schema,
  value,
  onChange,
}: StateEdit<Record<string, unknown>> & { schema: JsonSchema }) {
  return <ObjectFields schema={schema} value={value} onChange={onChange} />;
}
