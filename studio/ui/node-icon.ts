import type { IconType } from '@astryxdesign/core/Icon';
import { IconTool } from '@tabler/icons-react';
import type { StudioDraft, StudioNodeRef } from '../mod.ts';
import { modelFamilyMark } from './brand-icons.tsx';
import { FACET_ICON } from './lib/facet-icons.ts';
import { PROFILE_TYPE_ICON, toolTypeIcon } from './lib/type-icons.ts';

/** A node's icon; Identity shows the profile type's once one is picked. */
export function nodeIcon(draft: StudioDraft, ref: StudioNodeRef): IconType {
  const type = draft.identity.profileType;
  if (ref.facet === 'identity' && type) return PROFILE_TYPE_ICON[type];
  if (ref.facet === 'modelBinding') {
    const binding = draft.modelBindings.find((each) => each.key === ref.key);
    if (!binding) return FACET_ICON.modelBinding;
    return modelFamilyMark(binding.apiId) ?? FACET_ICON.modelBinding;
  }
  if (ref.facet !== 'toolSpec') return FACET_ICON[ref.facet];
  const tool = draft.toolSpecs.find((spec) => spec.key === ref.key);
  return tool ? toolTypeIcon(tool.toolType) : IconTool;
}
