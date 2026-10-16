/**
 * The tools Gemini runs itself, and how each is sent on Interactions and on Live, with what it
 * takes from a request's `builtInArgs`.
 *
 * @module
 */

import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import type { ProviderBuiltin } from '../../kernel/types.ts';

const googleMapsArgs: z.ZodType<{ location: { latitude: number; longitude: number } }> =
  z.strictObject({
    /** Where Maps grounding searches around. */
    location: z.strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
  });

type GoogleBuiltinId = 'googleSearch' | 'googleMaps' | 'urlContext' | 'codeExecution';

const GOOGLE_BUILTIN_IDS: readonly GoogleBuiltinId[] = [
  'googleSearch',
  'googleMaps',
  'urlContext',
  'codeExecution',
];

const INTERACTIONS_TYPE: Record<GoogleBuiltinId, string> = {
  googleSearch: 'google_search',
  googleMaps: 'google_maps',
  urlContext: 'url_context',
  codeExecution: 'code_execution',
};

/** The request's builtins that are Google's own tools; the wire takes no others. */
function googleBuiltins<B extends ProviderBuiltin>(builtins: readonly B[]): B[] {
  return builtins.filter((builtin) =>
    (GOOGLE_BUILTIN_IDS as readonly string[]).includes(builtin.id),
  );
}

function googleBuiltinId(builtin: ProviderBuiltin): GoogleBuiltinId {
  const id = GOOGLE_BUILTIN_IDS.find((known) => known === builtin.id);
  if (!id) {
    throw new TheoremError('config', `Builtin '${builtin.id}' is not a Google tool`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return id;
}

/** One builtin as an Interactions `tools` entry. */
function interactionsBuiltinTool(builtin: ProviderBuiltin): Record<string, unknown> {
  const id = googleBuiltinId(builtin);
  const type = INTERACTIONS_TYPE[id];
  if (id === 'googleMaps' && builtin.args) {
    const { location } = googleMapsArgs.parse(builtin.args);
    return { type, latitude: location.latitude, longitude: location.longitude };
  }
  return { type };
}

/** One builtin as a Live setup `tools` entry. Live takes no args for any of them. */
function liveBuiltinTool(builtin: ProviderBuiltin): Record<string, unknown> {
  const id = googleBuiltinId(builtin);
  if (builtin.args) {
    throw new TheoremError('unsupported', `Builtin '${id}' takes no args on Google Live`); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return { [id]: {} };
}

export { googleBuiltins, interactionsBuiltinTool, liveBuiltinTool };
