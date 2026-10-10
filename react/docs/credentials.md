# Tool credentials

Tool credentials live on the server, never in the browser. `createTheoremHandler`
keeps them in a `credentialStore` keyed by session id (default: process memory;
use a vault or an encrypted row in production) and loads them into every turn
and every resumed call.

- **Typed keys** — at a bearer or API-key gate, the user types the key into the
  gate card. It goes up once as `secret` on the resume request, and the server
  saves it under the gate's slot; the card keeps no copy and no event carries it.
  The server decides the credential's kind and header from the tool, not the
  request.
- **OAuth** — pass `authorizationUrl`: begin the flow with `createOAuthPkceFlow`,
  binding it to the `sessionId` you're given, and return its URL; the gate card
  opens it in a popup. Your callback route exchanges the code, saves the
  credential under that session, then its page calls `notifyOAuthComplete(slot)`.
  The card takes that message only from its own popup and origin, and resumes the
  gate with its id alone.
- **Refresh** — a refreshed OAuth token is saved to the store before the call
  goes on, so a rotated refresh token is never lost.

```ts
const credentialStore = createMemoryCredentialStore();
const secret = secrets.oauthStateSecret;
const redirectUri = 'https://app.example/oauth/callback';

export const theorem = createTheoremHandler({
  profile,
  provider,
  credentialStore,
  authorizationUrl: async (challenge, { sessionId }) =>
    (
      await createOAuthPkceFlow({
        resourceServerUrl: challenge.resource ?? 'https://api.tracker.example',
        clientId: 'https://app.example/oauth/client.json',
        redirectUri,
        scopes: challenge.requiredScopes,
        signingSecret: secret,
        sessionBinding: sessionId,
      })
    ).authorizationUrl,
});

// The callback route: the handler's session cookie comes with the redirect.
export async function oauthCallback(request: Request): Promise<Response> {
  const sessionId = theoremSessionId(request);
  if (!sessionId) return new Response(null, { status: 401 });
  const params = new URL(request.url).searchParams;
  const { credential } = await exchangeOAuthPkce({
    code: params.get('code') ?? '',
    state: params.get('state') ?? '',
    iss: params.get('iss') ?? undefined,
    redirectUri,
    signingSecret: secret,
    sessionBinding: sessionId,
  });
  const saved = (await credentialStore.load(sessionId)) ?? {};
  await credentialStore.save(sessionId, { ...saved, tracker: credential });
  // That page runs `notifyOAuthComplete('tracker')` from `@theoremjs/react`.
  return Response.redirect(new URL('/oauth/done?slot=tracker', request.url), 303);
}
```

A host with its own `session` resolver passes its own session id instead of
`theoremSessionId`. For voice, the relay you host receives a typed key as `secret`
on the `executeTool` message: save it with `credentialFromTypedSecret` (from
`@theoremjs/agents/kernel`) under the gate's slot, and pass a
`ToolCredentialSource` over your store as `credentials` on every `executeTool`.
