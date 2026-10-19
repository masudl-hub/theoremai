# The wire

Use this contract when you implement a transport or a live relay.
The browser and host validate messages at their shared boundary. Provider adapters and credentials remain on the host.

## Describe the interface

The host returns a profile interface validated by `profileInterfaceSchema`.
The interface contains tool IDs, model choices, input declarations, and client wording.
It excludes tool definitions and host functions.
The browser rejects an invalid description with `bad_response`.

## Send a turn, a tool decision, or a conversation read

`createTheoremHandler` validates each request before it calls the kernel.

| Route | Schema | Purpose |
| --- | --- | --- |
| `/turn` | `theoremTurnRequestSchema` | Start or continue a turn |
| `/invoke` | `theoremInvokeRequestSchema` | Answer a paused tool call |
| `/page-result` | `pageToolResultSchema` | Return an active dispatch result |
| `/steer` | `theoremSteerRequestSchema` | Send a steer to a running turn |
| `/conversation` | `theoremConversationRequestSchema` | Read the conversation that a ref names |
| `/rewind` | `theoremRewindRequestSchema` | Cut the conversation after one transcript block |

A missing or malformed field produces a `request` error with HTTP status 400.
For custom routes, use `checkRequest(schema, body, what)`.

The host keeps the conversation. A request carries the message and the `conversation` ref that the store issued, never the history or native provider state.
A `/turn` request without a ref starts a conversation. An `/invoke` request needs the ref of the conversation whose reply waits.
A ref that the store cannot open fails with `session.conversation_unknown`.
The `/turn` and `/invoke` streams carry `{ "type": "conversation", "ref": "…" }` lines. A line with `"posted": true` means the message reached the conversation.
Each later line carries the ref of a later save. The client sends the last ref that it received.
`/conversation` returns the transcript and a reply that waits for a gate. `/rewind` returns the new ref and the same view.
A profile whose `providerContinuation.history` is `'stateless'` keeps no conversation. Its streams carry no ref lines, and its host refuses a ref, `/conversation` and `/rewind`.

An `/invoke` request carries `gateId` and `operationId`.
The gate ID is the provider call ID. The operation ID identifies the action that the kernel issued.
The host checks both values against its saved gate. A missing operation ID fails request validation.
Its decision is `approve` or `deny`. An approval can contain edited `input` or a sign-in `secret`.
The host settles the call. Custom routes use `answerGatedCall` from `@theoremjs/agents/kernel` for the same rule.

The handler saves the accepted answer in a ready operation record. A retry must repeat that answer.
The kernel claims execution immediately before the tool body. Its claim token identifies the worker that can settle it.
The handler saves the outcome before the client receives completion. A repeat answer receives the saved terminal event.
A walk-away request also receives that retained event. Settled outcomes remain for 24 hours from settlement.
A settled replay may omit input. Supplied input must match the saved accepted invocation.
Legacy settlements without invocation evidence refuse supplied input.
A request failure after dispatch does not restore an approval. Its operation remains running or uncertain.
The host must check the destination before it creates a replacement action.

Session authority uses `TheoremSessionStore.load` and `compareAndSwap`.
The handler claims a pending gate with an atomic revision check before it executes the tool.
On conflict, it reads the current state and evaluates the answer again.
Two handlers that share the same atomic store cannot both claim that pending gate.
A process failure after the claim leaves a protected running record. No timer permits another worker to execute it.
The current session schema is version 3. Previous versions require an explicit host migration.

A new message can abandon calls that its reply waits for.
The `/turn` request lists `{ callId, operationId }` references in `abandon`.
The host's paused reply must wait on exactly those calls.
The host cancels them before it starts the new reply.

## Read events

The transport validates each turn line or live envelope against the schema for its kind.
It reports an unknown kind as `unsupported`.
It reports invalid JSON, a missing kind, or an invalid known kind as `malformed`.
The resulting `bad_response` diagnostic names the failure, not the malformed value.
The reply or live call continues without that part.

The chat identifies skipped parts in the composer. The live interface identifies them in its failure banner.
Both use the labels key `session.part_skipped`.
`streamInterfaceTurn` reports skipped parts through `view.skipped`.

## Open and resume a live session

The relay validates live client messages with `parseLiveClientMessage`.
An `executeTool` message requires both IDs. Its result echoes both IDs.
The client resolves a pending result only when both values match.
Check the call with the relay before invoking page code. Answer permission and sign-in gates first.
Invoke the callback only after a `dispatched` result. It contains the grant ID and final arguments.
Return the result with both IDs and `grantId`. A restored page gate does not authorize a callback.
Confirmation gates can carry `preparedArguments` for approval after an input change.
Studio replay carries `gateKind`, so permission approval does not skip preparation.
A settled relay result does not permit a page callback. Server tool results arrive through tool events.
Chat and host transports expose `pageResult` for the same authenticated result endpoint.
`withPageToolDispatch` accepts either transport. It runs callbacks only from the active stream.
A kernel-owned `dispatch` phase follows the acquired body claim and persisted grant.
A cached terminal replay emits no new grant. Results require the issuing session and exact grant reference.
It reads the opening message before it calls `runSession`.
`createTheoremSessionBoundary` validates conversation ownership before `prepareLiveOpen` returns normalized fields.
The relay supplies its vault through separate host options.

A live `provider_checkpoint` event contains `providerState` and the covered portable `history`.
The client stores both separately from displayed transcript content. Its next opening message sends both values.
The relay validates them through `prepareLiveOpen`. It saves new checkpoint ownership before browser delivery.

The kernel validates native state against provider identity, model identity, state version, deployment, and covered history.
On a mismatch, the default policy rebuilds from portable history and emits `provider_warning`.
The client then discards the incompatible native state and retains portable history.
The profile can instead select `providerContinuation.onMismatch: 'error'`.
