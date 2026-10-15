/**
 * What a provider's models take, and what one model takes apart from them: rows for an adapter
 * that is told, where the adapter is made. The provider holds both, so a model's own rows change
 * it for every agent whose model calls the same id there.
 *
 * @module
 */

import type { DeclarableFeature } from '@theoremjs/agents';
import { IconArrowBackUp, IconCheck, IconQuestionMark, IconX } from '@tabler/icons-react';
import { useContext } from 'react';
import {
	connectionFields,
	declarableFeatures,
	declaresSupport,
	type ModelBindingDraft,
	modelSupport,
	providerSupport,
	type StudioProvider,
	withSupport,
} from '../mod.ts';
import { WorkspaceContext } from './inspector-context.ts';
import { InspectorSection, type Segment, SegmentedRow } from './inspector.tsx';

export type Support = 'supported' | 'unknown' | 'unsupported';

/** What a model can be said to take, as a row names it. */
export const FEATURE_LABEL: Record<DeclarableFeature, string> = {
	clientTools: 'Tools',
	parallelTools: 'Parallel tools',
	structuredOutput: 'Structured output',
	thinking: 'Thinking',
	summaries: 'Summaries',
};

export const SUPPORT: readonly Segment<Support>[] = [
	{ value: 'supported', label: 'Supported', icon: IconCheck },
	{ value: 'unknown', label: 'Unknown', icon: IconQuestionMark },
	{ value: 'unsupported', label: 'Unsupported', icon: IconX },
];

/**
 * What the provider's models take. An adapter that is told shows a row for each, set where the
 * adapter is made; one that knows each model's own support, or the project's own, says so.
 */
export function SupportSection({
	provider,
	onChange,
}: {
	provider: StudioProvider;
	onChange: (next: StudioProvider) => void;
}) {
	const support = providerSupport(provider);
	const apart = Object.keys(provider.support?.models ?? {});
	if (!connectionFields(provider.adapter)) {
		return (
			<InspectorSection
				title="Supports"
				note="Its adapter is the project's own, so what its models take is the adapter's to say."
			>
				{null}
			</InspectorSection>
		);
	}
	if (!declaresSupport(provider.adapter) || !support) {
		return (
			<InspectorSection title="Supports" note="Its adapter knows what each model takes.">
				{null}
			</InspectorSection>
		);
	}
	return (
		<InspectorSection
			title="Supports"
			note={`What its models take. A model runs a turn only when what the turn uses is marked Supported.${
				apart.length ? ` Told apart: ${apart.join(', ')}.` : ''
			}`}
		>
			{declarableFeatures(provider.adapter).map((feature) => (
				<SegmentedRow
					key={feature}
					label={FEATURE_LABEL[feature]}
					path={`support.capabilities.features.${feature}`}
					value={support.features[feature]}
					segments={SUPPORT}
					onChange={(next) => {
						onChange(withSupport(provider, { [feature]: next }));
					}}
				/>
			))}
		</InspectorSection>
	);
}

/** A model's own support, or the provider's. */
type ModelSegment = Support | 'provider';

/**
 * What one model takes on its provider, apart from the provider's other models. Shown on a model
 * whose provider's adapter is told; editable where the project's providers are the builder's.
 */
export function ModelSupportSection({
	providers,
	binding,
}: {
	providers: readonly StudioProvider[];
	binding: ModelBindingDraft;
}) {
	const workspace = useContext(WorkspaceContext);
	const provider = providers.find((each) => each.id === binding.provider);
	const update = workspace?.updateProvider;
	const apiId = binding.apiId.trim();
	const rows = provider && modelSupport(provider, apiId, update !== undefined);
	if (!provider || !rows) return null;
	const { base, told } = rows;
	const sharers = workspace?.sharing(binding.key, provider.id, apiId) ?? { models: [], agents: [] };
	const others = [...sharers.models.map((model) => `its ${model} model`), ...sharers.agents];
	const shared = others.length ? ` A change here changes ${others.join(', ')} too.` : '';
	return (
		<InspectorSection
			title="Supports"
			note={`What ${apiId} takes on ${provider.id}, apart from its other models.${shared}`}
		>
			{declarableFeatures(provider.adapter).map((feature) => {
				const inherited = SUPPORT.find((segment) => segment.value === base.features[feature]);
				const segments: readonly Segment<ModelSegment>[] = [
					{
						value: 'provider',
						label: 'As provider',
						icon: IconArrowBackUp,
						description: `${provider.id} says ${inherited?.label.toLowerCase() ?? base.features[feature]}.`,
					},
					...SUPPORT,
				];
				return (
					<SegmentedRow<ModelSegment>
						key={feature}
						label={FEATURE_LABEL[feature]}
						path={`support.models.*.${feature}`}
						value={told[feature] ?? 'provider'}
						segments={segments}
						isDisabled={!update}
						onChange={(next) => {
							update?.(withSupport(provider, { [feature]: next === 'provider' ? undefined : next }, apiId));
						}}
					/>
				);
			})}
		</InspectorSection>
	);
}
