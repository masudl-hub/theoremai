import { COOKBOOKS, type CookbookId } from '../../cookbooks/catalog.ts';

/** The ready agents and systems "Add agent" offers, projected from `COOKBOOKS`. */
export const STUDIO_EXAMPLES: Readonly<
  Record<CookbookId, { readonly label: string; readonly description: string }>
> = {
  research: {
    label: COOKBOOKS.research.label,
    description: COOKBOOKS.research.description,
  },
  concierge: {
    label: COOKBOOKS.concierge.label,
    description: COOKBOOKS.concierge.description,
  },
  architect: {
    label: COOKBOOKS.architect.label,
    description: COOKBOOKS.architect.description,
  },
  'live-concierge': {
    label: COOKBOOKS['live-concierge'].label,
    description: COOKBOOKS['live-concierge'].description,
  },
  decision: {
    label: COOKBOOKS.decision.label,
    description: COOKBOOKS.decision.description,
  },
  'gemini-embedding-2': {
    label: COOKBOOKS['gemini-embedding-2'].label,
    description: COOKBOOKS['gemini-embedding-2'].description,
  },
  narrator: {
    label: COOKBOOKS.narrator.label,
    description: COOKBOOKS.narrator.description,
  },
  console: {
    label: COOKBOOKS.console.label,
    description: COOKBOOKS.console.description,
  },
} as const;
