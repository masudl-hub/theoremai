/**
 * The shape the decision and embedding handlers share: `GET <base>` answers the profile's
 * interface, `POST <base>/<action>` answers `{ result }`, and a failure is worded with the
 * profile's labels.
 *
 * @module
 */

import { labelText, type ProfileDefinition } from '@theoremjs/agents';
import {
  type ClientTurnOptions,
  caughtStatus,
  clientError,
  HTTP_METHOD,
} from '@theoremjs/agents/host';
import { jsonResponse } from './json-response.ts';

export type SingleActionOptions = {
  /** The last path segment the POST is sent to, such as `decide`. */
  action: string;
  /** What `GET <base>` answers, as `{ interface }`. */
  iface: unknown;
  labels: ProfileDefinition['labels'];
  clientEvents?: ClientTurnOptions;
  onError?: (err: unknown, ctx: { request: Request }) => void;
};

export function singleActionHandler(
  { action, iface, labels, clientEvents, onError }: SingleActionOptions,
  run: (request: Request) => Promise<unknown>,
): (request: Request) => Promise<Response> {
  const isAction = (request: Request) =>
    new URL(request.url).pathname.split('/').filter(Boolean).at(-1) === action;
  return async (request) => {
    try {
      if (request.method === 'GET' && !isAction(request))
        return jsonResponse(200, { interface: iface });
      if (request.method !== 'POST' || !isAction(request)) {
        return jsonResponse(HTTP_METHOD, {
          error: labelText('error.request', {}, labels),
          errorKind: 'request',
        });
      }
      return jsonResponse(200, { result: await run(request) });
    } catch (err) {
      onError?.(err, { request });
      return jsonResponse(caughtStatus(err), clientError(err, labels, clientEvents));
    }
  };
}
