# Composer, queue, and steer

`@theoremjs/agents/interface` owns stash / queue / steer list ops and the action matrix.
This package wires AbortSignal, the pending bar, and the turn and steer requests.

| Phase | Empty composer | Filled composer |
| --- | --- | --- |
| idle | disabled | Send (+ Stash menu) |
| streaming | Stop | Queue (+ Steer / Send now / Stash) |
| gated | disabled | Queue (+ Send now / Stash; no Steer) |

Enter matches the primary action. No keyboard shortcuts for stash/steer.

Send now while gated walks away from every waiting gate in the message's own request
(`walkAway` on `streamInterfaceDraftTurn`): the host settles each call cancelled, the
paused reply commits, and the message's reply follows in the same stream. A message the
host never saved leaves the transcript and goes back in the composer with the failure, and
the chat draws the conversation as the host keeps it.
An answer at a gate that fails before its call settles leaves the gate to answer again,
the failure in the composer; one that fails after keeps the call's result. The gate cards
show the answer on its way from their owner (`useTheoremChat().answering`, passed as
`ChatTranscript`'s `answering`, `ApprovalCard`'s `decided`, `AuthChallengeCard`'s
`submitted`), so a failed answer brings the gate's actions back. Steer POSTs use the Cache API
on Cloudflare (process Map locally) so mid-turn injects work across isolates.
Live sessions key the same inbox by `sessionId` from relay `ready`.

A chat can be resumed: `onConversationChange` (the same option on `useTheoremChat`) reports
each ref the host issues for the conversation (once the message posts, and again as the reply
is saved; `undefined` when the host can no longer open the resumed ref, and the chat starts
a new conversation without an error), and `conversation` resumes from one, read once when the chat mounts: the chat draws
the conversation as the host keeps it. A stateless profile keeps no conversation, so it has no
ref, and its transcript is kept only in the page. `chatRef` (`sendText`
on the hook) sends a message as the composer would and resolves with the blocks the turn added
once its reply is done, or `null` while a reply streams or waits on a gate.

Pending rows show attachment / voice previews, text, **Queue** (stash → queue),
and **Send now**. Clicking the text restores the full draft (text + files + voice)
into the composer; if the composer already had a payload, that payload is re-stashed.
