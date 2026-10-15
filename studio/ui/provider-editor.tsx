import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
	connectionFields,
	kernelAdapters,
	providerUse,
	type StudioIssue,
	type StudioProvider,
	type StudioWorkspace,
} from '../mod.ts';
import { NodeIssues } from './inspector-context.ts';
import {
	ChoiceRow,
	InspectorRow,
	InspectorSection,
	SetInCode,
	TextRow,
} from './inspector.tsx';
import { IssueBanners, SlotRow } from './profile-editor.tsx';
import { SupportSection } from './support-rows.tsx';

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
	const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
	return `${plural(models, 'model')} in ${plural(agents, 'agent')} ${models === 1 ? 'runs' : 'run'} on it.`;
}

/** `provider` with the text setting `name` of `field` set, or left out once it is blank. */
function withText<K extends 'keySlot' | 'fallbackKeySlot'>(provider: StudioProvider, field: K, value: string) {
	const { [field]: _was, ...rest } = provider;
	return value ? { ...rest, [field]: value } : rest;
}

function withConnection(provider: StudioProvider, name: string, value: string): StudioProvider {
	const { [name]: _was, ...rest } = provider.connection ?? {};
	return { ...provider, connection: value ? { ...rest, [name]: value } : rest };
}

/**
 * `provider` on the kernel adapter `adapter`, keeping what it connects with that the adapter also
 * takes. What the old adapter was told its models take goes with it.
 */
function withAdapter(provider: StudioProvider, adapter: string): StudioProvider {
	const takes = new Set(connectionFields(adapter)?.map((field) => field.name));
	const kept = Object.entries(provider.connection ?? {}).filter(([name]) => takes.has(name));
	const { support: _told, ...rest } = provider;
	return { ...rest, adapter, connection: Object.fromEntries(kept) };
}

/**
 * The editor for one provider: its adapter, what it connects with, as its adapter takes it, the
 * key slots its models read, and what its models take. Its id is what code and models name it by, so it takes no edit,
 * and an adapter the project made itself stays its code's. `onChange` is left out where the
 * providers are the studio's own: every row then shows its value and takes no edit.
 */
export function ProviderEditor({
	workspace,
	provider,
	issues,
	onChange,
}: {
	workspace: StudioWorkspace;
	provider: StudioProvider;
	issues: readonly StudioIssue[];
	onChange?: (next: StudioProvider) => void;
}) {
	const held = connectionFields(provider.adapter);
	const set = onChange ?? (() => undefined);
	// A setting its adapter does not take still gets a row, so its issue shows and it can be cleared.
	const extra = Object.keys(provider.connection ?? {})
		.filter((name) => !held?.some((field) => field.name === name))
		.map((name) => ({ name, required: false, url: false }));
	// The studio's own show only what they are set with: a blank row would say more than the studio knows.
	const fields = held && [...held, ...extra].filter((field) => onChange || provider.connection?.[field.name]);
	const slots = (['keySlot', 'fallbackKeySlot'] as const).filter((slot) => onChange || provider[slot]);
	const rows = (
		<>
			{fields === undefined ? (
				<InspectorSection
					title="Connection"
					note="Its adapter is the project's own, so what it connects with is the adapter's to say."
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
			{/* The studio's own say only what they are told: rows of defaults would say more than the studio knows. */}
			{(onChange || provider.support) && <SupportSection provider={provider} onChange={set} />}
		</>
	);
	return (
		<NodeIssues value={issues}>
			<VStack>
				<IssueBanners issues={issues} />
				<InspectorSection title="Provider" note={usedBy(workspace, provider.id)}>
					<InspectorRow label="Id" path="id">
						<Text>{provider.id}</Text>
					</InspectorRow>
					{onChange && held ? (
						<ChoiceRow
							label="Adapter"
							path="adapter"
							field="adapter"
							isRequired
							value={provider.adapter}
							options={kernelAdapters()}
							onChange={(next) => {
								if (next && next !== provider.adapter) onChange(withAdapter(provider, next));
							}}
						/>
					) : (
						<InspectorRow label="Adapter" path="adapter">
							<Text>{provider.adapter}</Text>
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
