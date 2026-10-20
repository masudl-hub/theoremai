import { Section } from '@astryxdesign/core/Section';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useState } from 'react';
import {
  connectionFields,
  kernelDefinitions,
  providerUse,
  type StudioIssue,
  type StudioProvider,
  type StudioWorkspace,
  takesKey,
} from '../mod.ts';
import { ChoiceRow, InspectorRow, InspectorSection, SetInCode, TextRow } from './inspector.tsx';
import { NodeIssues } from './inspector-context.ts';
import { IssueBanners, SlotRow } from './profile-editor.tsx';

/** A connection setting's name as a row labels it: `baseURL` is Base URL. */
function settingLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\bUrl\b/g, 'URL');
  const [first = '', ...rest] = words.split(' ');
  const lower = rest.map((word) => (word === 'URL' ? word : word.toLowerCase()));
  return [first.charAt(0).toUpperCase() + first.slice(1), ...lower].join(' ');
}

/** How many models run on the provider, and across how many agents. */
function usedBy(workspace: StudioWorkspace, id: string): string {
  const { models, agents } = providerUse(workspace, id);
  if (models === 0) return 'No model runs on it.';
  const plural = (count: number, word: string) =>
    `${String(count)} ${word}${count === 1 ? '' : 's'}`;
  return `${plural(models, 'model')} in ${plural(agents, 'agent')} ${models === 1 ? 'runs' : 'run'} on it.`;
}

/** `provider` with the text setting `name` of `field` set, or left out once it is blank. */
function withText<K extends 'keySlot' | 'fallbackKeySlot'>(
  provider: StudioProvider,
  field: K,
  value: string,
) {
  const { [field]: _was, ...rest } = provider;
  return value ? { ...rest, [field]: value } : rest;
}

function withConnection(provider: StudioProvider, name: string, value: string): StudioProvider {
  const { [name]: _was, ...rest } = provider.connection ?? {};
  return { ...provider, connection: value ? { ...rest, [name]: value } : rest };
}

/**
 * `provider` registered from the kernel definition `definition`, keeping what it connects with
 * that the definition also takes.
 */
function withDefinition(provider: StudioProvider, definition: string): StudioProvider {
  const takes = new Set(connectionFields(definition)?.map((field) => field.name));
  const kept = Object.entries(provider.connection ?? {}).filter(([name]) => takes.has(name));
  return { ...provider, definition, connection: Object.fromEntries(kept) };
}

/**
 * A new provider's id, renamed as it is left or on Enter, so its page stays open while it is typed.
 * A blank or taken id says why and goes back to the one it has.
 */
function ProviderIdRow({
  id,
  taken,
  onRename,
}: {
  id: string;
  taken: readonly string[];
  onRename: (next: string) => void;
}) {
  const [typed, setTyped] = useState(id);
  const name = typed.trim();
  const problem = !name
    ? 'A provider needs an id.'
    : name !== id && taken.includes(name)
      ? `A provider named '${name}' is already here.`
      : undefined;
  const commit = () => {
    if (problem) setTyped(id);
    else if (name !== id) onRename(name);
  };
  return (
    <InspectorRow
      label="Id"
      path="id"
      isRequired
      hasIssue={problem !== undefined}
      hasNote={problem !== undefined}
    >
      <StackItem size="fill">
        <TextInput
          label="Id"
          isLabelHidden
          size="sm"
          value={typed}
          status={problem ? { type: 'error', message: problem } : undefined}
          onChange={setTyped}
          onEnter={commit}
          onBlur={commit}
        />
      </StackItem>
    </InspectorRow>
  );
}

/**
 * The editor for one provider: its adapter, what it connects with, as its adapter takes it, the
 * key slots its models read, and what its models take. Its id is what code and models name it by,
 * so only a provider the files do not hold yet takes a new one, through `onRename`, and an adapter
 * the project made itself stays its code's. `onChange` is left out where the
 * providers are the studio's own: every row then shows its value and takes no edit.
 */
export function ProviderEditor({
  workspace,
  provider,
  issues,
  onChange,
  onRename,
}: {
  workspace: StudioWorkspace;
  provider: StudioProvider;
  issues: readonly StudioIssue[];
  onChange?: (next: StudioProvider) => void;
  onRename?: (id: string) => void;
}) {
  const held = connectionFields(provider.definition);
  const set = onChange ?? (() => undefined);
  // A setting its definition does not take still gets a row, so its issue shows and it can be cleared.
  const extra = Object.keys(provider.connection ?? {})
    .filter((name) => !held?.some((field) => field.name === name))
    .map((name) => ({ name, required: false, url: false }));
  // The studio's own show only what they are set with: a blank row would say more than the studio knows.
  const fields =
    held && [...held, ...extra].filter((field) => onChange || provider.connection?.[field.name]);
  // A definition that signs in with no key reads no slot; one set anyway still shows, so its issue can be cleared.
  const slots = (['keySlot', 'fallbackKeySlot'] as const).filter(
    (slot) => provider[slot] || (onChange && takesKey(provider.definition)),
  );
  const rows = (
    <>
      {fields === undefined ? (
        <InspectorSection
          title="Connection"
          note="Its definition is the project's own, so what it connects with is the definition's to say."
        >
          {null}
        </InspectorSection>
      ) : (
        fields.length > 0 && (
          <InspectorSection title="Connection">
            {fields.map((field) => (
              <TextRow
                key={field.name}
                label={settingLabel(field.name)}
                path={`connection.${field.name}`}
                field={`connection.${field.name}`}
                isRequired={field.required}
                value={provider.connection?.[field.name] ?? ''}
                placeholder={field.url ? 'https://' : undefined}
                onChange={(value) => {
                  set(withConnection(provider, field.name, value.trim()));
                }}
              />
            ))}
          </InspectorSection>
        )
      )}
      {slots.length > 0 && (
        <InspectorSection
          title="Keys"
          note="The slots its models read their key from, unless a model names its own."
        >
          {slots.map((slot) => (
            <SlotRow
              key={slot}
              label={slot === 'keySlot' ? 'Key slot' : 'Fallback slot'}
              path={slot}
              field={slot}
              value={provider[slot] ?? ''}
              onChange={(next) => {
                set(withText(provider, slot, next));
              }}
            />
          ))}
        </InspectorSection>
      )}
    </>
  );
  return (
    <NodeIssues value={issues}>
      <VStack>
        <IssueBanners issues={issues} />
        <InspectorSection title="Provider" note={usedBy(workspace, provider.id)}>
          {onRename ? (
            <ProviderIdRow
              id={provider.id}
              taken={workspace.providers.map((each) => each.id)}
              onRename={onRename}
            />
          ) : (
            <InspectorRow label="Id" path="id">
              <Text>{provider.id}</Text>
            </InspectorRow>
          )}
          {onChange && held ? (
            <ChoiceRow
              label="Definition"
              path="definition"
              field="definition"
              isRequired
              value={provider.definition}
              options={kernelDefinitions()}
              onChange={(next) => {
                if (next && next !== provider.definition) onChange(withDefinition(provider, next));
              }}
            />
          ) : (
            <InspectorRow label="Definition" path="definition">
              <Text>{provider.definition}</Text>
            </InspectorRow>
          )}
        </InspectorSection>
        {onChange ? (
          rows
        ) : (
          <>
            <Section variant="transparent" padding={3}>
              <Text type="supporting" color="secondary">
                The studio's own provider: the studio decides what it connects with. A project's
                providers are changed here.
              </Text>
            </Section>
            <SetInCode>{rows}</SetInCode>
          </>
        )}
      </VStack>
    </NodeIssues>
  );
}
