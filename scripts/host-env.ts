/**
 * Env for the live verify scripts. The dev chooses which keys fill which
 * `KeyVault` slot; the scripts read only the slot-named variables below and
 * `OPENROUTER_API_KEY`, and `THEOREM_ENV_FILE`, when set, names a `KEY=value`
 * file to load first. Keys never go on the command line, where `deno task`
 * echoes them.
 * Variables already set in the shell win over the file.
 *
 * @module
 */

import type { KeySlot, KeyVault } from '../src/kernel/types.ts';

/** The env variable that fills each vault slot. */
export const VAULT_ENV: Record<KeySlot, string> = {
  slotA: 'THEOREM_VAULT_SLOT_A',
  slotB: 'THEOREM_VAULT_SLOT_B',
  slotC: 'THEOREM_VAULT_SLOT_C',
  paid: 'THEOREM_VAULT_PAID',
};

/** The env variable that holds the OpenRouter key. */
export const OPENROUTER_ENV = 'OPENROUTER_API_KEY';

/** Set each `KEY=value` line not already set. */
function loadEnvFile(path: string): void {
  const text = Deno.readTextFileSync(path);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (Deno.env.get(key) !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    Deno.env.set(key, val);
  }
}

/**
 * Load `THEOREM_ENV_FILE` when set (a named file that cannot be read throws),
 * then log which vault slots are set, never their values.
 */
export function loadHostEnv(): void {
  const path = Deno.env.get('THEOREM_ENV_FILE');
  if (path) {
    loadEnvFile(path);
    console.log(`Loaded env from ${path}`);
  }
  const state = Object.entries(hostVault()).map(([n, key]) => `${n} ${key ? 'set' : 'unset'}`);
  console.log(`Vault: ${state.join(', ')}; openrouter ${hostOpenRouterKey() ? 'set' : 'unset'}`);
}

/** The vault from the slot-named variables; an unset slot stays undefined and fails upstream. */
export function hostVault(): KeyVault {
  const slot = (name: KeySlot) => Deno.env.get(VAULT_ENV[name])?.trim() || undefined;
  return { slotA: slot('slotA'), slotB: slot('slotB'), slotC: slot('slotC'), paid: slot('paid') };
}

/** The OpenRouter key from `OPENROUTER_API_KEY`; undefined when unset. */
export function hostOpenRouterKey(): string | undefined {
  return Deno.env.get(OPENROUTER_ENV)?.trim() || undefined;
}
