/**
 * With `THEOREM_IMPORT_PROBE=1`, lets subprocess tests assert adapters stay unloaded
 * until `complete` runs. Only `create-provider.ts` may call it.
 */
export function markModuleLoad(label: string): void {
  try {
    const d = (globalThis as Record<string, unknown>).Deno as
      | {
          env?: { get(key: string): string | undefined };
          stdout?: { writeSync(data: Uint8Array): void };
        }
      | undefined;
    if (d?.env?.get('THEOREM_IMPORT_PROBE') === '1' && d.stdout?.writeSync) {
      d.stdout.writeSync(new TextEncoder().encode(`LOADED:${label}\n`));
    }
  } catch {
    // why: Non-Deno runtime or missing --allow-env.
  }
}
