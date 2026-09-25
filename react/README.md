# `@theoremai/react`

React projection of the repo-private headless interface (`src/interface/`) — runners, transcript, composer, live stage.

Lives next to the kernel at `theoremai/react/` so React apps depend on:

- `@theoremai/agents` (kernel)
- `@theoremai/react` (this package)

No Svelte. The playground site (`theoremai-frontend`) hosts a thin Vite SPA at `apps/run` that imports this package; the info-site graph stays Svelte and only writes a `PlaygroundRunPayload` handoff.

## Imports

```ts
import { useTheoremChat, useTheoremInterface } from '@theoremai/react'; // headless hooks + transport
import { TheoremChat } from '@theoremai/react/ui'; // Astryx chat UI
import { LiveRunner } from '@theoremai/react/live'; // Astryx voice / video UI
import { createTheoremHandler } from '@theoremai/react/server'; // host side
```

The playground's run-tab handoff (`savePlaygroundRunPayload`,
`readPlaygroundRunIdFromUrl`, …) lives in `@theoremai/playground`; see
[`playground/README.md`](../playground/README.md).

## Local layout

```text
Development/
  theoremai/           # kernel + this package
    react/
  theoremai-frontend/  # site; apps/run consumes file:../../../theoremai/react
```

## Tool credentials

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
- **Refresh** — a refreshed OAuth token is saved to the store as the turn
  reports it, before the event reaches the browser.

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
	// That page runs `notifyOAuthComplete('tracker')` from `@theoremai/react`.
	return Response.redirect(new URL('/oauth/done?slot=tracker', request.url), 303);
}
```

A host with its own `session` resolver passes its own session id instead of
`theoremSessionId`. For voice, the relay you host receives a typed key as `secret`
on the `executeTool` message: save it with `credentialFromTypedSecret` (from
`@theoremai/agents/kernel`) under the gate's slot, and read the session's
credentials from your store for every `executeTool`.

## Composer pending intents

`src/interface/` owns stash / queue / steer list ops and the action matrix.
This package wires AbortSignal, the pending bar, and playground turn/steer HTTP.

| Phase | Empty composer | Filled composer |
| --- | --- | --- |
| idle | disabled | Send (+ Stash menu) |
| streaming | Stop | Queue (+ Steer / Send now / Stash) |
| gated | disabled | Queue (+ Send now / Stash; no Steer) |

Enter matches the primary action. No keyboard shortcuts for stash/steer.

Send now while gated abandons the tool wait (`abandonGatedInterfaceTool`) without
continuing the model, then starts a new user turn. Steer POSTs use the Cache API
on Cloudflare (process Map locally) so mid-turn injects work across isolates.
Live sessions key the same inbox by `sessionId` from relay `ready`.

Pending rows show attachment / voice previews, text, **Queue** (stash → queue),
and **Send now**. Clicking the text restores the full draft (text + files + voice)
into the composer; if the composer already had a payload, that payload is re-stashed.

## Wording

The headless layer (hooks, client, components, server handler) writes no
English. It hands the builder kinds, codes, and states:

- Failures are `ClientFailure` (`{ error, errorKind, errorInternal? }`). `error`
  is the profile's wording (`iface.lexicon`, resolved on the host); show it to
  the user. `errorKind` and `errorInternal` are for the builder.
- Attachment problems are `AttachmentValidationIssue`s; word one with
  `attachmentIssueText(issue, iface.lexicon)` from `@theoremai/agents`.
- A Live call the provider ended after warning it would is not a failure:
  `LiveSessionClient`'s `onSessionEnded(session)` gives `session.message`, the
  profile's `live.session_ended` wording, and `session.ended` (close code,
  timing, the code's kind) for the builder.
- Chrome is semantic: `liveState`, `workStatus`, drawer `parts`, hint `id`.

`@theoremai/react/ui` is the default UI. Every line it shows is an Astryx i18n
message: Theorem's under `@theorem.*` keys (`THEOREM_UI_CATALOG`, each with a
description and the ICU values it takes), Astryx's own under `@astryx.*`. The
builder owns all of them; `labels` replaces any line, per locale:

```tsx
<TheoremChat
  labels={{
    en: {
      '@theorem.chat.greeting': 'What shall we plan?',
      '@theorem.composer.placeholder': 'Write to @{handle}',
      '@astryx.chatSendButton.send': 'Go',
    },
    de: { '@theorem.chat.greeting': 'Woran arbeiten wir?' },
  }}
/>
```

`LiveRunner` takes the same prop. The locale is the host's Astryx
`InternationalizationProvider` locale (`en` without one); a host's own Astryx
`messages` and `overrides` also apply, and win over the defaults. Labels are
checked on mount: an unknown `@theorem.*` key, a message that is not valid ICU,
a value the line is not given, or a key outside `@theorem.*` / `@astryx.*`
throws, naming the locale and key. Label values render as text, never HTML.

A builder with their own UI replaces all of it.
`scripts/docs-truth/copy-lint.mjs` keeps prose out of the headless directories.
