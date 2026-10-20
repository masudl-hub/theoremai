/**
 * Where a studio listens. A studio takes a pair of ports on this machine: the project's server,
 * and the page one above it. The first pair is the one a project opens on; a second project opened
 * beside it takes the next pair that is free.
 */
import { createServer } from 'node:net';

const FIRST_SERVER_PORT = 4983;
/** How many studios can be open at once. */
const PAIRS = 10;
/** Where a studio's server says which setup it is open on. */
export const RUNNING_PATH = '/api/studio/running';
/** How long a server has to say so. One on this machine answers at once. */
const ANSWER_MS = 1000;

/**
 * @typedef {{ server: number, page: number }} Pair
 * @typedef {{ pair: Pair, setup?: string, free: boolean }} Held what a pair holds: the setup a
 *   studio there is open on, and whether both ports are free
 */

/** @param {number} at @returns {Pair} */
export const pairAt = (at) => ({
  server: FIRST_SERVER_PORT + 2 * at,
  page: FIRST_SERVER_PORT + 2 * at + 1,
});

/** @returns {Pair[]} */
export const pairs = () => Array.from({ length: PAIRS }, (_, at) => pairAt(at));

/** @param {Pair} pair */
export const pageAddress = (pair) => `http://127.0.0.1:${String(pair.page)}`;
/** @param {Pair} pair */
export const serverAddress = (pair) => `http://127.0.0.1:${String(pair.server)}`;

/**
 * Where a setup opens: on the pair a studio already has it open on, else the first free pair.
 * Nothing when every pair is taken.
 * @param {string} setup the setup's file, in full
 * @param {readonly Held[]} held every pair, in order
 * @returns {{ pair: Pair, running: boolean } | undefined}
 */
export function placeFor(setup, held) {
  const running = held.find((one) => one.setup === setup);
  if (running) return { pair: running.pair, running: true };
  const free = held.find((one) => one.free);
  return free && { pair: free.pair, running: false };
}

/** @param {number} port @returns {Promise<boolean>} */
function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** The setup the studio on a pair is open on, or nothing when no studio answers there. */
async function runningOn(pair) {
  try {
    const response = await fetch(serverAddress(pair) + RUNNING_PATH, {
      signal: AbortSignal.timeout(ANSWER_MS),
    });
    const said = response.ok ? await response.json() : undefined;
    return typeof said?.setup === 'string' ? said.setup : undefined;
  } catch {
    // Nothing listens there, or what does is not a studio.
    return undefined;
  }
}

/** @returns {Promise<Held[]>} */
export function heldPairs() {
  return Promise.all(
    pairs().map(async (pair) => {
      const [setup, server, page] = await Promise.all([
        runningOn(pair),
        isFree(pair.server),
        isFree(pair.page),
      ]);
      return { pair, ...(setup === undefined ? {} : { setup }), free: server && page };
    }),
  );
}
