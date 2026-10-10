/**
 * Studio tree icons for PROFILE_GRAPH facets. Docs chapters reuse this
 * map so a section does not grow a second glyph.
 */

import {
	IconActivity,
	IconFileExport,
	IconFileImport,
	IconGitBranch,
	IconHeadset,
	IconId,
	IconInputAi,
	IconPhoto,
	IconQuote,
	IconRepeat,
	IconShieldCheck,
	IconStack2,
	IconTool,
	IconVolume,
} from '@tabler/icons-react';
import type { StudioNodeRef } from '../../mod.ts';

export const FACET_ICON = {
	identity: IconId,
	models: IconStack2,
	modelBinding: IconInputAi,
	tools: IconTool,
	inputs: IconFileImport,
	outputs: IconFileExport,
	turnBehaviour: IconRepeat,
	guardrails: IconShieldCheck,
	observability: IconActivity,
	wording: IconQuote,
	image: IconPhoto,
	speech: IconVolume,
	live: IconHeadset,
	decision: IconGitBranch,
} satisfies Record<Exclude<StudioNodeRef['facet'], 'toolSpec'>, unknown>;
