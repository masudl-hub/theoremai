# The wire

How the browser and the host talk, and what each side checks.

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
