# `@theoremjs/react`

React projection of the headless interface (`@theoremjs/agents/interface`) — runners, transcript, composer, live stage.

## Install

```bash
npm install @theoremjs/react @theoremjs/agents zod react react-dom
# for the chat and live UI (`/ui`, `/live`):
npm install @astryxdesign/core@0.6.3 @stylexjs/stylex@0.19.0
# only to build your own theme from the Theorem one (`/ui/theme`):
npm install @astryxdesign/theme-neutral@0.6.3
```

Published to npm only: the package ships built JavaScript, declarations and
stylesheets. `@theoremjs/agents` is a peer, so the host and the UI share one
kernel. The Astryx peers are optional: the hooks, client and server entry
points run without them. The declarations need TypeScript 5.7 or later.

`@theoremjs/react/ui` and `@theoremjs/react/live` import their stylesheets
themselves, so a bundler that handles CSS imports (Vite does) needs no extra
step. The theme's type is Figtree with a system-font fallback;
the package does not ship the font, so load it yourself if you want it.

The live UI loads its microphone worklet as an asset
(`new URL('./worklets/mic-capture.js', import.meta.url)`); Vite ships it
without configuration, and any bundler that resolves that pattern does too.

No Svelte. The playground site (`theoremai-frontend`) hosts a thin Vite SPA at `apps/run` that imports this package; the info-site graph stays Svelte and only writes a `PlaygroundRunPayload` handoff.

## Imports

```ts
import { useTheoremChat, useTheoremInterface } from '@theoremjs/react'; // headless hooks + transport
import { TheoremChat } from '@theoremjs/react/ui'; // Astryx chat UI
import { LiveRunner } from '@theoremjs/react/live'; // Astryx voice / video UI
import { createTheoremHandler } from '@theoremjs/react/server'; // host side
```

A `host` profile runs no model: the page calls its tools directly. Serve it
with `createTheoremHostHandler({ profile })` and render `<TheoremHost
endpoint="/api/host" />` (`createHostTransport` and `useTheoremHost` for a UI
of your own). `GET` describes each allowed tool with its input and output JSON
Schema, never its endpoint or credentials; `POST /call` `{ name, input }`
streams the call's events, and `POST /invoke` answers a gate it paused on, as
in chat. The console draws the form from the input schema and lays the result
out from its value: figures, charts, tables, images, audio and Markdown, with
the raw JSON beside them.

The playground's run-tab handoff (`savePlaygroundRunPayload`,
`readPlaygroundRunIdFromUrl`, …) lives in `@theoremjs/playground`; see
[`playground/README.md`](../playground/README.md).

## The wire

Turn lines, live envelopes, request bodies, live messages and the profile
interface `describe` returns are each checked against their schema, both ways:

- **Browser → host.** `createTheoremHandler` reads `/turn`, `/invoke` and
  `/steer` bodies with `theoremTurnRequestSchema`, `theoremInvokeRequestSchema`
  and `theoremSteerRequestSchema`; a missing or malformed field is a `request`
  error (400). `/invoke` answers a paused call by its `gateId` with a
  `decision`: `approve` (with `input` when the user edited it, `secret` at a
  sign-in gate) or `deny`; the host settles each one. An answer whose request
  ends before its call settles (the network drops, the host fails) puts the
  call back to wait, to be answered again; once it settled, the session keeps
  the settle (`TheoremSessionState.settled`, pruned with the gates): a second
  answer is refused with `session.gate_expired`, and a walk-away naming the
  call reads its result. A message sent while
  its reply waits walks away in its own `/turn`: `abandon` names the waiting
  calls, its history leaves exactly those open, and the host settles each
  cancelled ahead of the message's reply (`checkWalkAway` and `walkAway` for a
  host with routes of its own). A relay reads the live client's messages with
  `parseLiveClientMessage`. A host with routes of its own reads a body with
  `checkRequest(schema, body, what)`, and answers a paused call with
  `answerGatedCall` (`@theoremjs/agents/kernel`), the rule the handler uses.
- **Host → browser.** `describe` returns the profile interface as
  `profileInterfaceSchema` names it: tool ids, never a tool's definition, and
  no host functions. The transport and the live client read each line or
  envelope against its kind's schema, and `describe` against
  `profileInterfaceSchema`. A kind the client does not know reaches
  the event handler as `unsupported`, and one that fails its check (not JSON,
  no kind, or a known kind that fails its schema) as `malformed`: a
  `bad_response` naming what broke, never the value. Either way the reply or
  call goes on without it. The chat names a skipped part in the composer and
  the live call in its failure banner, both with the lexicon's
  `session.part_skipped`; a run built on `streamInterfaceTurn` hears of it
  through its `view.skipped`. A `describe` reply that fails its schema is
  `bad_response`.

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

## Composer pending intents

`src/interface/` owns stash / queue / steer list ops and the action matrix.
This package wires AbortSignal, the pending bar, and playground turn/steer HTTP.

| Phase | Empty composer | Filled composer |
| --- | --- | --- |
| idle | disabled | Send (+ Stash menu) |
| streaming | Stop | Queue (+ Steer / Send now / Stash) |
| gated | disabled | Queue (+ Send now / Stash; no Steer) |

Enter matches the primary action. No keyboard shortcuts for stash/steer.

Send now while gated walks away from every waiting gate in the message's own request
(`walkAway` on `streamInterfaceDraftTurn`): the host settles each call cancelled, the
paused reply commits, and the message's reply follows in the same stream. The message
leaves the composer only once it posts; if the request fails first, the reply still waits.
An answer at a gate that fails before its call settles leaves the gate to answer again,
the failure in the composer; one that fails after keeps the call's result. The gate cards
show the answer on its way from their owner (`useTheoremChat().answering`, passed as
`ChatTranscript`'s `answering`, `ApprovalCard`'s `decided`, `AuthChallengeCard`'s
`submitted`), so a failed answer brings the gate's actions back. Steer POSTs use the Cache API
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
  `attachmentIssueText(issue, iface.lexicon)` from `@theoremjs/agents`.
- A Live call the provider ended after warning it would is not a failure:
  `LiveSessionClient`'s `onSessionEnded(session)` gives `session.message`, the
  profile's `live.session_ended` wording, and `session.ended` (close code,
  timing, the code's kind) for the builder.
- Chrome is semantic: `liveState`, `workStatus`, drawer `parts`, hint `id`.

`@theoremjs/react/ui` is the default UI. Every line it shows is an Astryx i18n
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
