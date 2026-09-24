import { type ComposerProfileInterface, defaultInterfaceEffort } from '../../../src/interface/mod.ts';

/** A model and effort for the next turn. */
export type GenerationSelection = { model?: string; effort?: string };

/** The profile's default model (its first, when it names none). */
export function defaultModel(iface: ComposerProfileInterface): string | undefined {
	return iface.defaultModel ?? Object.keys(iface.models)[0];
}

/**
 * The selection for `iface`, given what was `selected` under the `previous` interface (none on
 * first load). A pick that was on the previous default follows the new one, and a pick `iface` no
 * longer has falls back to its default; any other pick is kept. Model and effort are each judged
 * this way, the effort against its model's default, and a new model takes its own default effort.
 */
export function followGenerationDefaults(
	iface: ComposerProfileInterface,
	selected: GenerationSelection,
	previous: ComposerProfileInterface | undefined,
): GenerationSelection {
	const keepModel =
		selected.model !== undefined &&
		Object.hasOwn(iface.models, selected.model) &&
		(previous === undefined || selected.model !== defaultModel(previous));
	const model = keepModel ? selected.model : defaultModel(iface);
	const efforts = model === undefined ? undefined : iface.models[model]?.efforts;
	const keepEffort =
		model === selected.model &&
		selected.effort !== undefined &&
		efforts !== undefined &&
		Object.hasOwn(efforts, selected.effort) &&
		(previous === undefined || selected.effort !== defaultInterfaceEffort(previous, model));
	return { model, effort: keepEffort ? selected.effort : defaultInterfaceEffort(iface, model) };
}
