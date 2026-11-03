import { fetchGuarded, type ResolveHost, z } from '@theoremjs/agents';
import { caughtStatus, clientError } from '@theoremjs/agents/host';
import { STUDIO_READER } from '../reader.ts';
import { readBody } from '@theoremjs/web/server';
import { FORWARD_HEADERS, FORWARD_STATUS, type ForwardedRequest } from '../forwarded-fetch.ts';

const forwardedSchema: z.ZodType<ForwardedRequest> = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string().optional(),
});

/**
 * Headers the reply does not carry back: the page reads the body already decoded, and a host's
 * cookies are not the page's.
 */
const DROPPED = new Set(['content-encoding', 'content-length', 'set-cookie', 'transfer-encoding']);

/**
 * `POST <base>/forward`: one request a page's tool makes, sent on to its host, whose reply comes
 * back with its status and headers in `FORWARD_STATUS` and `FORWARD_HEADERS`. A redirect comes back
 * as it is, for the page's kernel to check and follow. It reaches public hosts only, unless
 * `draftNetwork` is set: that server is the builder's alone, and the page has already held the
 * request to the draft's network rules. A name is checked against private addresses only through
 * `resolveHost`.
 * invariant: a request's headers and body, the tool's credentials among them, pass through in
 * memory only: this route never logs or stores them.
 * The host's headers come back in one header, so a host whose headers outgrow the platform's
 * header size limit (about 16KB on Cloudflare Workers) fails the request.
 */
export async function forwardRequest(
  request: Request,
  options: { resolveHost?: ResolveHost; draftNetwork?: boolean } = {},
): Promise<Response> {
  try {
    const asked = await readBody(request, forwardedSchema);
    const answered = await fetchGuarded(
      asked.url,
      {
        method: asked.method,
        headers: asked.headers,
        ...(asked.body === undefined ? {} : { body: asked.body }),
        signal: request.signal,
      },
      {
        followRedirects: false,
        ...(options.draftNetwork ? { policy: { allowPrivateNetworks: true } } : {}),
        ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
      },
    );
    const headers = [...answered.headers].filter(([name]) => !DROPPED.has(name.toLowerCase()));
    return new Response(answered.body, {
      headers: {
        [FORWARD_STATUS]: String(answered.status),
        [FORWARD_HEADERS]: JSON.stringify(headers),
      },
    });
  } catch (err) {
    // why: the request is the page's own tool call, so its reader is the builder of that draft,
    // who needs the raw reason (connection refused, a blocked address) to fix the tool.
    return Response.json(clientError(err, undefined, STUDIO_READER), {
      status: caughtStatus(err),
    });
  }
}
