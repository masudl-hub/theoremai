/**
 * Optional host-application helpers.
 *
 * Not part of the turn kernel. Shared glue for Deno HTTP hosts (reply status,
 * cutout-trace flush) and live structured-output preview while tokens stream.
 *
 * @module
 */

export type { ClientTurnOptions } from './client-turn.ts';
export { forClient, forClientEvents } from './client-turn.ts';
export type { CutoutTape } from './mint-trace.ts';
export { flushMintTrace } from './mint-trace.ts';
export { readStreamingJsonStringField } from './readStreamingJsonStringField.ts';
export {
  caughtStatus,
  HTTP_BUSY,
  HTTP_METHOD,
  HTTP_NOT_FOUND,
  HTTP_OK,
  json,
} from './reply.ts';
