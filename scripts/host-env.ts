/**
 * `THEOREM_ENV_FILE`, when set, names a `KEY=value` file to load first; variables already set in
 * the shell win. Keys never go on the command line, where `deno task` echoes them.
 */

import type { KeySlot, KeyVault } from '../src/kernel/types.ts';

const VAULT_PREFIX = 'THEOREM_VAULT_';

/** The variable a slot reads: `slot_a` → `THEOREM_VAULT_SLOT_A`. Name slots with `_`, not `-`, to set them here. */
export function vaultEnv(slot: KeySlot): string {
  return `${VAULT_PREFIX}${slot.toUpperCase()}`;
}

export const OPENROUTER_ENV = 'OPENROUTER_API_KEY';

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

/** A named file that cannot be read throws; logs which vault slots are set, never their keys. */
export function loadHostEnv(): void {
  const path = Deno.env.get('THEOREM_ENV_FILE');
  if (path) {
    loadEnvFile(path);
    console.log(`Loaded env from ${path}`);
  }
  const slots = Object.keys(hostVault());
  console.log(
    `Vault: ${slots.length ? slots.join(', ') : 'no slots'}; openrouter ${hostOpenRouterKey() ? 'set' : 'unset'}`,
  );
}

/** Every set `THEOREM_VAULT_<NAME>` variable, as slot `<name>` lowercased; an empty one is left out. */
export function hostVault(): KeyVault {
  const vault: Record<KeySlot, string> = {};
  for (const [name, value] of Object.entries(Deno.env.toObject())) {
    const key = value.trim();
    if (!name.startsWith(VAULT_PREFIX) || !key) continue;
    vault[name.slice(VAULT_PREFIX.length).toLowerCase()] = key;
  }
  return vault;
}

export function hostOpenRouterKey(): string | undefined {
  return Deno.env.get(OPENROUTER_ENV)?.trim() || undefined;
}
