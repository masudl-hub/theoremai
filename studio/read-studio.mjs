/**
 * What `theorem-studio status` and `theorem-studio errors` read from a studio that is open: the
 * text its server gives, and its events, as lines for a terminal. Each only reads; neither changes
 * the studio.
 */
import { serverAddress } from './ports.mjs';

/** Where a studio's server says what it loaded, and keeps what happened. */
export const STATUS_PATH = '/api/studio/status';
export const EVENTS_PATH = '/api/studio/events';

/**
 * @typedef {import('./ports.mjs').Held} Held
 * @typedef {{ at: string, kind: string, text: string, repeated?: number }} StudioEvent
 */

/**
 * The studios open on these setups, in the order of their ports.
 * @param {readonly Held[]} held every pair
 * @param {ReadonlySet<string>} setups the setups' files, in full
 * @returns {Held[]}
 */
export const studiosOn = (held, setups) =>
  held.filter((one) => one.setup !== undefined && setups.has(one.setup));

/**
 * An event as a line: its time on this machine, its text with each further line indented under
 * the first, and how often it came when it repeated.
 * @param {StudioEvent} event
 * @returns {string}
 */
export function eventLine(event) {
  const time = new Date(event.at).toTimeString().slice(0, 8);
  const text = event.text.replaceAll('\n', '\n         ');
  return `${time} ${text}${event.repeated ? ` (×${String(event.repeated)})` : ''}`;
}

/**
 * The events in a server-sent stream, as each arrives.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<StudioEvent>}
 */
export async function* streamedEvents(body) {
  const decoder = new TextDecoder();
  let held = '';
  for await (const chunk of body) {
    held += decoder.decode(chunk, { stream: true });
    let end = held.indexOf('\n\n');
    while (end !== -1) {
      const data = held
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      held = held.slice(end + 2);
      if (data) yield JSON.parse(data);
      end = held.indexOf('\n\n');
    }
  }
}

/**
 * Prints what a studio says: `status` its text, `errors` its events, and `errors --follow` each
 * event as it comes, until the studio stops.
 * @param {Held} studio
 * @param {'status' | 'errors'} command
 * @param {{ follow?: boolean, write?: (line: string) => void }} [options]
 */
export async function readStudio(studio, command, { follow = false, write = console.log } = {}) {
  const at = serverAddress(studio.pair);
  if (command === 'status') {
    write((await answer(`${at}${STATUS_PATH}`)).trimEnd());
    return;
  }
  if (!follow) {
    /** @type {StudioEvent[]} */
    const events = JSON.parse(await answer(`${at}${EVENTS_PATH}`));
    if (events.length === 0) write('nothing has happened yet');
    for (const event of events) write(eventLine(event));
    return;
  }
  const response = await fetch(`${at}${EVENTS_PATH}?follow`);
  if (!response.ok || !response.body)
    throw new Error(`the studio answered ${String(response.status)}`);
  try {
    for await (const event of streamedEvents(response.body)) write(eventLine(event));
  } catch {
    // why: the studio closes the stream as it stops, which ends it as plainly as a last event.
  }
  write('the studio stopped');
}

/** @param {string} address */
async function answer(address) {
  const response = await fetch(address);
  if (!response.ok) throw new Error(`the studio answered ${String(response.status)}`);
  return await response.text();
}
