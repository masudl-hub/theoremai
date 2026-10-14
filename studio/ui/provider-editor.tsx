import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
	connectionFields,
	type StudioIssue,
	type StudioProvider,
	type StudioWorkspace,
} from '../mod.ts';
import { NodeIssues } from './inspector-context.ts';
import { InspectorRow, InspectorSection, SetInCode, TextRow } from './inspector.tsx';
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
	const counts = workspace.agents.map(
		(agent) => agent.modelBindings.filter((binding) => binding.provider === id).length,
	);
	const models = counts.reduce((sum, count) => sum + count, 0);
	const agents = counts.filter((count) => count > 0).length;
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
 * The editor for one provider: what it connects with, as its adapter takes it, and the key slots
 * its models read. Its id and adapter are what code names it by, so they show and take no edit.
 * `onChange` is left out where the providers are the studio's own: every row then shows its value
 * and takes no edit.
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
	const fields = connectionFields(provider.adapter);
	const set = onChange ?? (() => undefined);
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
			<InspectorSection
				title="Keys"
				note="The slots its models read their key from, unless a model names its own."
			>
				<SlotRow
					label="Key slot"
					path="keySlot"
					field="keySlot"
					value={provider.keySlot ?? ''}
					onChange={(slot) => {
						set(withText(provider, 'keySlot', slot));
					}}
				/>
				<SlotRow
					label="Fallback slot"
					path="fallbackKeySlot"
					field="fallbackKeySlot"
					value={provider.fallbackKeySlot ?? ''}
					onChange={(slot) => {
						set(withText(provider, 'fallbackKeySlot', slot));
					}}
				/>
			</InspectorSection>
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
					<InspectorRow label="Adapter" path="adapter">
						<Text>{provider.adapter}</Text>
					</InspectorRow>
				</InspectorSection>
				{onChange ? (
					rows
				) : (
					<>
						<Section variant="transparent" padding={3}>
							<Text type="supporting" color="secondary">
								The studio's own provider. A project's providers are changed here.
							</Text>
						</Section>
						<SetInCode>{rows}</SetInCode>
					</>
				)}
			</VStack>
		</NodeIssues>
	);
}
