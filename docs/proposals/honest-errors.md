# Honest errors: what a failure must say, and to whom

**Status:** proposal, 24 Oct 2026, written with Masud. Masud agreed the rules
(sections 3 to 6) on 24 Oct 2026. The open questions (section 9) are not
decided. A fix that depends on one waits for that decision. Every fix is
measured against the failure matrix (section 8).

**Reader:** a maintainer who changes how the kernel reports a failure. **Job:**
know the rules a failure report must keep. **After:** they can tell whether a
change keeps Theorem honest, and the matrix test tells them when it does not.

## 1. The rule

**Theorem says what happened.** The builder reads the exact reason. The user
reads a label that is true and shows no internals. A turn that fails keeps what
it did, and its end says why it ended.

Today the kernel breaks this rule in at least 16 places (section 7). The
contract already states part of the rule. [Public errors](../contracts/guardrails.md#public-errors)
says "Nothing is guessed from message text" and that the raw detail is always
set. The code does not keep it, and no test checks it across the kernel.

## 2. Terms

| Term | Meaning |
| --- | --- |
| **failure** | Anything that stops an operation from giving its result. It is a thrown error, an `error` event, a tool failure, or a stop that is not `completed`. |
| **kind** | The failure's category, one of `ERROR_KINDS` in `src/guardrails/theorem-error.ts`. Hosts choose the HTTP status and the label from it. |
| **reason** | The exact text that says why it failed: the original message, word for word. |
| **cause** | The failure a wrapping failure came from (`Error.cause`). The causes form a chain. |
| **origin** | Where the failure happened: the provider, a tool, host code (a stage, a detector's `find`, a page), a guardrail, or the kernel. |
| **stop** | Why a model call or a turn ended: `done.stop`, one of `TURN_STOP_KINDS` in `src/kernel/schema.ts`. |
| **label** | The user's words for a failure: the kind's label or a more specific `errorCopy`. The text is in `src/guardrails/labels.ts`. |
| **view** | One reader's copy of a failure (section 4). |

## 3. Invariant 1: the builder sees the exact reason

- **R1.1** Every failure keeps its reason and the reason of each cause. The
  builder reads them in `errorInternal` and in the trace. Code that wraps an
  error keeps the original as `cause`. Code that rebuilds an error keeps its
  cause too.
- **R1.2** Only the code where the failure happens sets the kind. Code that
  catches a failure and passes it on keeps its kind.
- **R1.3** A failure that reaches a boundary with no kind is `internal`. No code
  guesses a more specific kind. A catch-all never maps to `network`,
  `unavailable`, `bad_response`, `unsupported`, or `failed`.
- **R1.4** Every failure names its origin (open question O3: as a field, or as
  a rule on the kind).
- **R1.5** The reason is raw. It is never the label. A failure whose message is
  its own label (`operationUnavailable` in `src/kernel/tools/operation.ts`)
  tells the builder nothing.

## 4. Invariant 2: the label is true and shows no internals

Each failure has these views. The kernel keeps all of them consistent from one
failure.

| View | Reads | Where |
| --- | --- | --- |
| Builder | `errorKind`, `errorInternal`, `errorCopy`, `done.stop` | the turn's events; `forClient` with `reader: 'builder'` (`src/host/client-turn.ts`) |
| Trace | the span's `error.type` and `exception.message` | `src/kernel/engine/turn-trace.ts` |
| Visitor | `errorKind` and the label, with no `errorInternal` | `forClient` (`src/host/client-turn.ts`) |
| Model | a failed tool's read-back text | `frameToolFailure` (`src/kernel/tools/model-text.ts`) |

- **R2.1** A label describes the failure's kind and origin, and nothing else. A
  tool's failure never says "the model". A setup mistake never says "try again
  shortly".
- **R2.2** A label never holds the reason, a cause, a detector's name, matched
  text, a server's words, or a code path.
- **R2.3** Each kind has a label, and each specific failure that the user can
  act on has its own `errorCopy`. A vague label is allowed. A wrong one is not.
- **R2.4** The visitor view never holds `errorInternal`. This holds today
  (`stripErrorInternal`), and the matrix keeps it.

## 5. Invariant 3: a failed turn keeps what it did, and ends truthfully

- **R3.1** `done.stop` is what ended the call. A provider's own stop
  (`length`, `filtered`, `tool`) is never replaced. A failure in the same call
  is reported beside the stop, not instead of it. This changes the contract:
  [Stop and resume](../contracts/kernel.md#stop-and-resume) says an `error`
  "outranks the call's own `done`".
- **R3.2** A turn or an `invokeTool` never ends as `completed` after a failure.
  A cancel ends as `cancelled`.
- **R3.3** If the profile's resumption or validation covers the failure, the
  turn takes that path, and the trace records it.
- **R3.4** If no path covers it, the turn ends. Everything it streamed stays
  with the host, and the host can continue it with `continueFrom`. The builder
  can read what the model wrote before the cut, such as a cut answer's drafts
  (open question O5: the provider checkpoint on a failed stop).
- **R3.5** A retry never sends again a call whose stop is truthful and would
  repeat. A reply cut at `length` is cut again at the same place.

## 6. Invariant 4: honesty is never a leak

Honest detail and the guardrails meet in four places.

- **S1. Detail can hold secrets.** A reason can hold a key, the canary (a
  secret marker in the system prompt), or user data. Every origin removes its
  credentials before the reason leaves it. The provider path does this
  (`clean` in `src/kernel/provider-runtime.ts`). HTTP and MCP tools do it
  (`omitSecretText` in `src/kernel/tools/remote.ts`). The matrix checks every
  other origin. Traces leave the process, so the trace view obeys S1 too.
- **S2. A server's words are untrusted.** Provider and tool servers write their
  own error text. The builder may read it raw. The model reads a tool's failure
  after detectors read it at its boundary (`guardToolFailureText` in
  `src/guardrails/tool-result.ts`). The read-back then frames it as
  `Tool error (code): message`, which reads as the kernel's own report. A
  server's words must reach the model marked as the server's.
- **S3. The security kinds never lie.** `blocked` and `safety` mean that a
  guardrail, a host policy, or the provider held something back. No other
  failure reads as either. A guardrail's action never reads as another kind. A
  detector that fails stays closed and tells the builder why.
- **S4. A retry never gets past a guardrail or repeats an action.** A blocked
  step is never sent again to try for a different answer. A tool call that may
  have changed something is never run twice. The "unresolved execution" failure
  (`uncertainError` in `src/kernel/tools/coordinate.ts`) keeps this, and it
  keeps its cause for the builder.

## 7. Where the code breaks the rules today

The first four rows were reproduced with a scratch test. The rest were read in
code. The audit covered runtime code: `src/kernel`, `src/providers`,
`src/guardrails` (not its `eval` and `corpus` folders), `src/host`,
`src/surface`, `src/interface`, and `src/observability`. It did not cover
studio, evals, or the CLI.

| # | Where | What breaks | Rules |
| --- | --- | --- | --- |
| 1 | `src/providers/shared/protocol-events.ts:19` | A tool call whose arguments do not parse becomes `{ type: 'error', errorKind: 'bad_response' }`. The parse message and the raw arguments are lost, and the call fails. `ToolCallRequest.arguments` in `src/kernel/turn-events.ts` says the error carries the raw text. | R1.1, R3.1 |
| 2 | `src/kernel/engine/runner/stream.ts:528` | An `error` event replaces the provider's stop with `provider_error`, and the native reason is lost. | R3.1 |
| 3 | `src/kernel/tools/execute.ts:761`, `src/kernel/tools/operation.ts:84` | A page tool runs with no execution coordinator. This is a host setup mistake. It reads as `unavailable` with the label "Sorry, the model isn't available at the moment." `errorInternal` holds the same label. | R1.3, R1.5, R2.1 |
| 4 | `src/kernel/tools/invoke.ts:339`, `:383` | `invokeTool` ends as `completed` after a thrown failure, and after a cancel. | R3.2 |
| 5 | `src/kernel/tools/remote.ts:613` | An HTTP or MCP tool reads every thrown failure as `network`, except `blocked`. This includes a cancel, a host `resolveHost` that throws, and a kernel bug. | R1.2, R1.3 |
| 6 | `src/guardrails/error.ts:69`, `src/kernel/provider-runtime.ts:172` | `describeError` reads the message only, not the cause. `diagnosticError` rebuilds a provider error without its cause. | R1.1 |
| 7 | `src/kernel/engine/decision.ts:454` | A decision reads any `TypeError` as `network`. It reads `internal`, `config`, `safety`, `blocked`, and `input` as `malformed_response`. | R1.2, R1.3, S3 |
| 8 | `src/kernel/engine/runner/mod.ts:205` | A compactor that throws keeps its kind and loses its reason. | R1.1 |
| 9 | `src/kernel/registry/profiles.ts:591` | A profile build reads any failure as `config` and drops its cause. | R1.1, R1.3 |
| 10 | `src/kernel/stop.ts:200`, `:222` | An OpenAI finish reason the kernel does not know reads as `provider_error`. A Gemini status it does not know reads as `stream_incomplete`. | R3.1 |
| 11 | `src/kernel/engine/runner/gates.ts:611` | A model that ends without the answer tool gives stop `provider_error`, though the provider completed. | R3.1 |
| 12 | `src/guardrails/detect-at.ts:259` | A host detector's `find` that throws stays closed, which is correct. The builder reads `find_threw` and not the thrown reason. | R1.1, S3 |
| 13 | `src/guardrails/error.ts:41` | HTTP 400, 404, 409, 413, and 422 all read as `unsupported`. A 400 for a request that is too long reads as "the model cannot serve this". | R1.3, R2.1 |
| 14 | `src/observability/trace.ts:9` | A trace that fails to write is silent when the sink has no `onError`. The contract says so. | R1.1 |
| 15 | `src/guardrails/sanitize.ts` (`requestRefused`) | A host detector's `find` that throws on a request reads as `input`, which says the request was wrong. The detector failed instead. The label (`detect.blocked`) is vague but true. Found by the matrix. | R1.2, S3 |
| 16 | `src/providers/shared/upstream-tap.ts` (`networkFetch`) | A connection that drops while the reply streams reads as `internal`. Only the send was named as `network`, not the body read. Found by the matrix. | R1.2, R1.3 |

The contract also writes three of these down as rules:

- "an `error` the provider sent during the call (it outranks the call's own
  `done`)" in [Stop and resume](../contracts/kernel.md#stop-and-resume) (row 2).
- "Other HTTP ≥ 400 | `unsupported`" in [Provider failures](../contracts/guardrails.md#provider-failures) (row 13).
- "Mid-stream provider error without a status | `unavailable`" in the same
  table. It guesses a kind (R1.3).

## 8. The failure matrix

One test injects each failure at each origin and checks every view against
sections 3 to 6. A cell that does not apply is listed as not applicable, with
the reason.

| Axis | Values |
| --- | --- |
| Origin | provider HTTP; provider stream; a model's tool call; function tool; page tool; HTTP tool; MCP tool; agent tool; host stage; host detector `find`; compactor; decision; `invokeTool`; profile build; trace sink |
| Failure | `Error`; `TypeError`; `TheoremError` of each kind; HTTP status; a stream that ends early; a stop at `length`; JSON that does not parse; a cancel; a timeout |
| View | builder event; `done.stop`; trace span; visitor (`forClient`); model read-back; retry taken or not |

Each cell asserts:

1. The builder view holds the injected reason and each cause (R1.1).
2. The kind is the injected kind, or `internal` when none was given (R1.2, R1.3).
3. The label is the kind's label or its `errorCopy`, and holds none of the reason (R2.1, R2.2).
4. The visitor view holds no `errorInternal` (R2.4).
5. `done.stop` is the true stop (R3.1, R3.2).
6. No credential or canary reaches the label, the visitor view, or the model (S1).

## 9. Open questions

Each needs Masud's decision before the fix that depends on it.

- **O1. A tool call whose arguments do not parse.** (a) End the model call, as
  today (`tests/kernel/tools.adversarial.test.ts` keeps this). (b) Give the model
  a tool failure to read back, as the comment on `malformedToolCall` in
  `src/providers/shared/tool-args.ts` says.
- **O2. HTTP 4xx kinds.** Which kind a 400, 404, 409, 413, and 422 read as.
  `request` means "the host called THEOREM wrongly", so it does not fit a
  provider's refusal either. A new kind is one answer.
- **O3. Origin.** A new `origin` field on error events and tool failures, or a
  rule that each kind has one origin.
- **O4. No answer.** The stop for a model that completes without the answer
  tool: `completed` with an `error` beside it, or a new stop kind.
- **O5. Checkpoint on failure.** Whether `done` keeps `providerState` after a
  failed stop, so a host can continue without sending the whole history again.
- **O6. A cancel during a page tool's dispatch.** `cancelled`, or "unresolved
  execution" when the page may have acted.
- **O7. A finish reason the kernel does not know.** `provider_error`, or a stop
  that carries the native reason and says the kernel does not know it.
- **O8. A host detector that fails on a request.** Keep `input`, or give it
  a kind that says the check failed.
- **O9. The trace when a host detector fails.** The trace cleans each text it
  stores with the host's own detectors. A `find` that fails covers the whole
  text, the failure's reason too, so the trace holds `[omitted]` where the
  reason was. The builder reads the reason on the host stream only. (a) Keep
  this: the reason can repeat the text the detector could not check. (b) Store
  the reason without the host's clean-up, as the trace stores a provider error.
  **Decided (24/10):** neither. The trace stores a summary in the kernel's
  words (`error_summary`: detector, how it failed, error type, error id), and
  the host stream's reason ends with the same id. A hash of the reason was
  rejected: a short reason can be guessed back from its hash. A host that
  wants the reason itself already has `observability.scrub.sensitive.host:
  false`.
