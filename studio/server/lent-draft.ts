/**
 * What a decision and an embedding on lent keys share: the model the keys judge, and the vault
 * the run takes from the host.
 *
 * @module
 */
import { type Profile, type ProviderHostOptions, TheoremError } from '@theoremjs/agents';
import type { LentBinding, ModelProfileType } from '../lent-keys.ts';
import { modelRoute, STUDIO_PROVIDERS } from '../providers.ts';
import type { LentRuntime } from './draft-handler.ts';

/** The route of `profile`'s first model, as the keys judge it. */
export function lentRoute(
  type: ModelProfileType,
  profile: { models: Record<string, { protocol: string; provider: string; apiId: string }> },
): LentBinding {
  return {
    ...modelRoute(STUDIO_PROVIDERS, type, Object.values(profile.models)[0]),
    builtInTools: [],
  };
}

/** The vault the host lends `profile`, refused as `auth` when it holds no key. */
export function lentVault(
  runtime: LentRuntime,
  profile: Profile,
  route: string,
): NonNullable<ProviderHostOptions['vault']> {
  const vault = runtime.hostOptions?.(profile).vault ?? {};
  if (!Object.values(vault).some(Boolean)) {
    throw new TheoremError('auth', `studio ${route}: provider key is missing`); // labels-exempt: internal diagnostic
  }
  return vault;
}
