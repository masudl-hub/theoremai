/**
 * The icon for each type of agent and of tool, wherever the studio shows one: the editor's Type
 * controls, the tree, the map, and the loader's map of a project being read.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import {
	IconGitBranch,
	IconHeadset,
	IconLetterT,
	IconMathFunction,
	IconMessageForward,
	IconPhoto,
	IconServer,
	IconTool,
	IconTopologyStar,
	IconVolume,
	IconWorld,
} from '@tabler/icons-react';
import type { CustomToolType } from '@theoremjs/agents';
import type { StudioProfileType } from '../../mod.ts';
import { IconMcp } from '../mcp-icon.tsx';

/** Each profile type's icon: the Type control's segments and the tree's Identity row. */
export const PROFILE_TYPE_ICON = {
	text: IconLetterT,
	image: IconPhoto,
	speech: IconVolume,
	live: IconHeadset,
	decision: IconGitBranch,
	embedding: IconTopologyStar,
	host: IconServer,
} satisfies Record<StudioProfileType, IconType>;

/** The icon for a profile type, or none when the type is not one of those. */
export function profileTypeIcon(type: string | undefined): IconType | undefined {
	if (type !== undefined && Object.hasOwn(PROFILE_TYPE_ICON, type)) return PROFILE_TYPE_ICON[type as StudioProfileType];
	return undefined;
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
