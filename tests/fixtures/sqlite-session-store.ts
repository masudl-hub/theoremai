import { z } from '../../mod.ts';
import {
  DEFAULT_SESSION_CAPACITY,
  type TheoremSessionStore,
  theoremSessionStateSchema,
} from '../../web/src/server/mod.ts';

const snapshotSchema = z.strictObject({
  revision: z.string().min(1),
  state: theoremSessionStateSchema,
});
const resultSchema = z.discriminatedUnion('written', [
  z.strictObject({ written: z.literal(false) }),
  z.strictObject({ written: z.literal(true), revision: z.string().min(1) }),
]);

/** Each transaction runs in a separate process against the same database. */
export function sqliteSessionStore(path: string): TheoremSessionStore {
  const worker = new URL('./sqlite-session-worker.mjs', import.meta.url);
  const run = async (
    operation: string,
    sessionId: string,
    revision: string | null = null,
    state?: unknown,
  ) => {
    const process = new Deno.Command('node', {
      args: [worker.pathname, path, operation, sessionId, JSON.stringify(revision)],
      stdin: state === undefined ? 'null' : 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    if (state !== undefined) {
      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify(state)));
      await writer.close();
    }
    const output = await process.output();
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    return JSON.parse(new TextDecoder().decode(output.stdout)) as unknown;
  };
  return {
    capacity: DEFAULT_SESSION_CAPACITY,
    async load(sessionId) {
      const result = await run('load', sessionId);
      return result === null ? undefined : snapshotSchema.parse(result);
    },
    async compareAndSwap(sessionId, revision, state) {
      return resultSchema.parse(await run('cas', sessionId, revision, state));
    },
  };
}
