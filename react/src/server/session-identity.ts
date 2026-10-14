import { toBase64Url } from '@theoremjs/agents/kernel';
export type Session = { id: string; setCookie?: string };
const SESSION_COOKIE = 'theorem_session';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function newSessionId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The session id the handler issued in its cookie, for a host route outside the
 * handler (an OAuth callback) that saves credentials under it. Hosts that pass
 * a `session` resolver use their own id instead.
 */
export function theoremSessionId(request: Request): string | undefined {
  const existing = readCookie(request, SESSION_COOKIE);
  return existing && SESSION_ID_PATTERN.test(existing) ? existing : undefined;
}

/**
 * The handler's cookie session for `request`: its id, and the `Set-Cookie` header to send when
 * the request had none. A page that starts a conversation before the chat's first request uses
 * it, so the chat and the conversation share one session.
 */
export function theoremSession(request: Request): Session {
  const existing = theoremSessionId(request);
  if (existing) return { id: existing };
  const id = newSessionId();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return {
    id,
    setCookie: `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure}`,
  };
}
