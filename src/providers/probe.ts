/**
 * Import-isolation probe for `createProvider`'s lazy adapter loader.
 *
 * Only `create-provider.ts` calls this. Adapters must not import it.
 * When `THEORUM_IMPORT_PROBE=1`, writes `LOADED:<label>` to stdout once per
 * lazy load so subprocess tests can assert adapters stay unloaded until
 * `complete` runs. No-op in normal hosts.
 *
 * @module
 */

export function markModuleLoad(label: string): void {
  try {
    const d = (globalThis as Record<string, unknown>).Deno as
      | {
          env?: { get(key: string): string | undefined };
          stdout?: { writeSync(data: Uint8Array): void };
        }
      | undefined;
    if (d?.env?.get('THEORUM_IMPORT_PROBE') === '1' && d.stdout?.writeSync) {
      d.stdout.writeSync(new TextEncoder().encode(`LOADED:${label}\n`));
    }
  } catch {
    // Non-Deno runtime or missing --allow-env.
  }
}
