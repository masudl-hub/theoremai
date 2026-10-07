import { TheoremError } from '../../guardrails/error.ts';
import type { Profile } from '../types.ts';
import { profileInputs } from './catalog.ts';

const SLOT_REF = /\{([A-Za-z_][\w-]*)\}/g;

/**
 * Replaces each `{name}` that names one of the profile's slots with the value the request chose.
 * A `{name}` that is no slot stays as written. A prompt that uses a slot the request left
 * unfilled is a request error. Every value is one the profile lists, so no free text is written.
 */
export function fillSlots(
  profile: Profile,
  text: string,
  slots: Record<string, string> | undefined,
  where: string,
): string {
  const declared = profileInputs(profile)?.slots;
  if (!declared) return text;
  return text.replace(SLOT_REF, (whole, name: string) => {
    if (!Object.hasOwn(declared, name)) return whole;
    const value = slots && Object.hasOwn(slots, name) ? slots[name] : undefined;
    if (value === undefined) {
      throw new TheoremError(
        'request',
        `Profile ${profile.id}: ${where} uses slot '${name}', and the request chose no value for it`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return value;
  });
}
