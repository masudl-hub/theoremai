# Turn stages (target contract)

**Status: target — slices 1–3 on branch.** Locked design replacing steer
barriers and overlapping tool pre-gates. **Foundation + text `runTurn` + tool
execute + live cycle/`executeTool` + playground `onStage` inbox + react
`gated*` (pause aliases removed) landed on branch.** **No dual API** on a
released line: stages are not “shipped” until `kernel.md` matches this file on
the release cut.

## Export (target)

| Foundation | Landed |
| --- | --- |
| `TURN_STAGES` / inject stages / gate kinds / awaiting unions | landed |
| `STAGE_AFFORDANCE_MATRIX` / `applyStageResult` / parsers | landed |
| `TurnRequest` / `SessionRequest` / `InvokeToolRequest.onStage` types | landed |
| Text `runTurn` `pre_turn` / `post_tool` / `before_end` / `post_turn` | landed |
| Text barriers / `onSteer` / `barrier` events deleted from API | landed |
| `pre_tool` deny/confirm/mutate execute cutover | landed |
| Tool `preTool`; removed `canExecute` / `preflight` / `interactive` | landed |
| `ask_user` awaiting completion; gate vs deny wire | landed |
| Interface gated/awaiting split (text) | landed |
| Live profile `allowSteering`; cycle `idle`\|`open`; `LiveSession.executeTool` | landed |
| Playground steer inbox via `onStage` (inject-capable stages only) | landed |
| React / interface `gated*` only (`paused*` removed; no aliases) | landed |
| Cancelled `done` + `post_turn` for AbortSignal (not only stage abort) | landed |

Slice 1 removed: `TURN_STEER_BARRIERS`, `TurnSteer*`, `onSteer`, `barrier` events.
Slice 2 removed: `canExecute`, `preflight`, `interactive` tool config; pause fiction for
confirm/permission/auth (`phase: 'gate'` + `stop.kind: 'gate'`). `ask_user` completes with
`awaiting_user_input`. Slice 3: live stages + `executeTool` + playground `onStage`
+ full `paused*` → `gated*` cut (no aliases).

## Ownership

| Concern | Owner |
| --- | --- |
| Stage timeline + affordance application | Kernel (`runTurn`, `runSession`, tool execute) |
| UI for awaiting / confirm / auth | Host |
| Tool-result projection | Kernel — not a stage ([`TOOL_RESULT_FIDELITY.md`](../TOOL_RESULT_FIDELITY.md)) |
| `GUARDRAIL_STAGES` | Guardrails — different enum; never alias to turn stages |

## Abstraction

A **stage** is a named timeline moment where:

1. the runner emits `{ type: 'stage', stage, … }`,
2. the registered `onStage` handler runs (open host code),
3. the kernel applies returned **affordances** only.

Stages name **when**. Affordances are what theorem applies to the turn — not a
ceiling on host side effects.

---

## Stages

| Stage | Fires | Inject? | Other affordances |
| --- | --- | --- | --- |
| `pre_turn` | Once per user turn / live utterance cycle, before model work for that cycle | if inject allowed | `abort` |
| `pre_tool` | Per `callId`, after chosen, before body | no | `deny`, `confirm` (gate), `mutate`, `abort` |
| `post_tool` | Per `callId`, after the body (success / fail / awaiting), before the terminal `tool` event | if inject allowed | `deny`, `mutate`, `abort` |
| `before_end` | About to end the turn / utterance cycle; host may extend | if inject allowed | `abort` |
| `post_turn` | After cycle-ending `done` | **never** (ignored) | observe only |

### Frozen types

These shapes are **frozen** for slice 1. Do not “add fields as we go.”

```ts
type TurnStage =
  | 'pre_turn'
  | 'pre_tool'
  | 'post_tool'
  | 'before_end'
  | 'post_turn';

/** Confirm-to-run / permission gate — NOT ToolPause, NOT awaiting. */
interface ToolGate {
  kind: 'confirmation' | 'permission' | 'auth';
  tool: string;
  permission?: ToolPermission;
  summary?: string;
  /** Auth challenge when kind === 'auth' (same fields as today’s authChallenge). */
  authChallenge?: ToolPause['authChallenge'];
}

interface StageContext {
  stage: TurnStage;
  /** 1-based provider/model step index within the current attempt (text). Live: utterance cycle index starting at 1. */
  step: number;
  history: readonly TurnHistoryMessage[];
  /** Opaque host slot from TurnRequest / SessionRequest / InvokeToolRequest — never traced. */
  host?: unknown;
  callId?: string;
  tool?: string;
  input?: unknown;
  /** True when pre_tool settled without running the body (deny or gate). */
  callNotStarted?: boolean;
  outputRaw?: unknown;
  outputModel?: ModelToolResult;
  failure?: ToolFailure;
  /** True when outputRaw/status is awaiting_user_input completion. */
  awaiting?: boolean;
  stop?: TurnStop;
  gate?: ToolGate;
}

interface StageResult {
  inject?: TurnHistoryMessage[];
  abort?: boolean | { reason?: string };
  /** pre_tool: refuse the call. post_tool: replace the result with this failure. */
  deny?: { code?: string; message?: string };
  /** pre_tool only — request confirm/permission gate (not ask_user). */
  confirm?: true | { summary?: string };
  /** pre_tool: replace the input. post_tool: replace the raw output. Both re-validate. */
  mutate?: { input: unknown } | { output: unknown };
}

type StageHandler = (
  ctx: StageContext,
) => StageResult | undefined | Promise<StageResult | undefined>;
```

**Affordance matrix (invalid combinations are no-ops with a host-visible
`stageWarnings` follow-up on a `stage` event — not silent drop):**

| Affordance | `pre_turn` | `pre_tool` | `post_tool` | `before_end` | `post_turn` |
| --- | --- | --- | --- | --- | --- |
| `inject` | yes* | no | yes* | yes* | no |
| `abort` | yes | yes | yes | yes | no |
| `deny` | no | yes | yes | no | no |
| `confirm` | no | yes | no | no | no |
| `mutate` | no | yes | yes | no | no |

\*Only when `profileAllowsInject` / session inject gate is true; otherwise no-op.

### Attach points (locked)

| Surface | Handler | Stages |
| --- | --- | --- |
| `TurnRequest.onStage` | Required for inject; optional otherwise | All five on text; image/speech emit stages but inject never allowed |
| `SessionRequest.onStage` | Set once at `runSession`; immutable for session life | All five on live cycles + tool executes |
| `InvokeToolRequest.onStage` | Optional | `pre_tool` / `post_tool` only |
| `LiveSession` | **No** `setOnStage` — avoids mid-session races | — |

If both `InvokeToolRequest.onStage` and an ambient turn/session handler exist,
**both** run at tool stages: tool-local ambient first is N/A; order is
**tool `preTool` → request `onStage` → turn/session `onStage`**.

Every stage run records one `theorem.stage` span event —
`{ stage, affordance, hook_ms?, warnings? }` — on the span it belongs to:
turn stages on the `invoke_agent` root, Live cycle stages on the session root,
`pre_tool` / `post_tool` on that call's `execute_tool` span. `affordance` lists
what the handlers applied (`inject`, `abort`, `deny`, `confirm`, `mutate`;
`[]` when nothing, or no handler ran); `hook_ms` is present only when handlers
ran; `warnings` lists warning codes. See
[observability.md](./observability.md#trace-records).

### Inject application (every inject site)

1. Reject inject when inject gate is false (no-op).
2. Drop any inject message with `role: 'tool'` (same as today).
3. Run the same sanitize path as today’s steer injects (`sanitizeHistory` +
   untrusted-input policy from the profile).
4. Text / Interactions: append to turn history, after the opening input; when
   `interactionsContinuation` is active, also append `user_input` steps.
5. Live: apply as live ingress only — **text** via `sendText` (or equivalent
   realtime text). **No** `TurnMediaRef` / history `parts` inject on live
   (live already refuses media refs). Other modalities out of scope for inject.
6. `before_end` inject on text: re-enter the step loop subject to **maxSteps**
   (see Budgets). On live: schedule ingress; does not invent a fake model pull.

### `abort`

- Sets/triggers the turn `AbortSignal` path where one exists.
- Prefer emitting terminal `done` with `stop.kind: 'cancelled'` when the runner
  can do so without throwing away the event stream; if today’s `AbortError`
  throw remains, document that `post_turn` may not run — **target follow-up:**
  always emit cancelled `done` + `post_turn` (slice 1 must not leave abort
  half-specified: implement cancelled `done` + `post_turn` as part of stages).

---

## Inject gate (`allowSteering` → `profileAllowsInject`)

| Profile type | Stage events | Inject allowed when |
| --- | --- | --- |
| `text` | always | `turnBehaviour.allowSteering !== false` (default true) |
| `live` | always | `turnBehaviour.allowSteering !== false` on **live** profiles (field added; default true) |
| `image` / `speech` | always | **never** (`allowSteering` remains omit-only / rejected) |
| `host` | `pre_tool` / `post_tool` only | **never** |

Rename in code is allowed (`profileAllowsInject`) if docs and exports update in
the same change. Semantics: **inject only** — never hides stage emission or
tool stages.

`SessionRequest` does not grow a second flag; live uses the profile field.

---

## Tool execute pipeline (frozen order)

Applies to function, HTTP, and MCP tools on every execute path
(`runTurn` tools, `invokeTool`, `LiveSession.executeTool`):

1. Allow / path / visibility / load-tier checks (unchanged).
2. `inspectToolArguments` / taint gate (unchanged; **before** host stages).
3. Schema parse of input.
4. Declarative catalog `permission` (may → gate).
5. Auth readiness for HTTP/MCP (may → gate `kind: 'auth'`).
6. Tool `preTool?(input, ctx)` if registered (returns `StageResult`-compatible
   deny / confirm / mutate / void).
7. Host `onStage({ stage: 'pre_tool', … })` (request then turn/session).
8. Apply `mutate` → **re-parse** schema; fail → error settle.
9. Body (function handler / HTTP / MCP).
10. T2 loader promotion when applicable (**before** projection).
11. `projectForModel` → guard (fence, redaction, provenance) → model result.
12. `onStage({ stage: 'post_tool', outputRaw, outputModel, failure?, awaiting? })`
    — `outputModel` is the guarded result. Apply `deny` → the model gets that
    failure instead; apply `mutate { output }` → **re-validate** output schema,
    re-project, **re-guard**; fail → error settle. `mutate` needs a completed
    body the host may own: on a failed or unstarted call, or on the T2 loader
    (whose output drives the snapshot), it is a `mutate_invalid` warning.
13. **One** terminal host event per `callId`, after the host had its say:
    `tool.phase: 'complete'` with the final raw output, or `tool.phase: 'error'`
    with the final failure. Hosts that rebuild history from events therefore
    never see a result the model did not get.
14. Record provider-facing tool result when this path is responsible for it.

**Builtins:** no local body. No `pre_tool`/`post_tool` on the host execute path;
provider-native builtin traffic is not kernel-executed.

### Three different human waits (do not collapse)

| Kind | Wire | Provider tool result | Turn / cycle |
| --- | --- | --- | --- |
| **Gate** (permission / confirm-to-run / auth) | `tool.phase: 'gate'` + `gate: ToolGate`; stage `pre_tool` with `callNotStarted: true`; then **`done.stop.kind: 'gate'`** + `done.tools` snapshot | **None yet** | Honest **suspension** — generator ends; host must resume |
| **Deny** | `post_tool` (with `failure` + `callNotStarted: true` for a `pre_tool` deny, or with the completed `outputRaw` for a `post_tool` deny) then `tool.phase: 'error'` + failure | **One** synthetic failure result for that `call_id` (required so Interactions/Live rounds do not deadlock) | Continues |
| **Awaiting user input** | Body **completes**; `tool.phase: 'complete'`; `awaiting: true` on stage; `post_tool` | **One** final result = awaiting payload | Turn may **truly** `done` (`completed` etc.); host UI orthogonal |

**Resume gate:** `invokeTool` / `executeTool` with `resume: { granted: true }`
(and credentials for auth), same `callId` / snapshot rules as today’s permission
resume — but stop kind was `'gate'`, not `'tool'`. After settle, host continues
the model turn the same way they do after today’s tool resume
(`continueAfterTool` / new `runTurn` / live already open).

**Deny resume:** `resume: { granted: false }` settles as deny **without** running
the body: failure event, `post_tool` with `callNotStarted: true`, and (on live)
one upstream tool response — same honesty as `pre.kind === 'deny'`. Do not skip
settle via bare `sendToolResponses`.

**Do not** reuse `ToolPause` or `tool.phase: 'pause'` or `stop.kind: 'tool'` for
these. Those names are removed with the fiction.

### `awaiting_user_input` payload (frozen)

Harness and any tool that needs human-as-product return this **as output**
(Zod on `ask_user`):

```ts
{
  status: 'awaiting_user_input';
  kind: 'confirm' | 'choice' | 'text';
  prompt: string; // non-empty
  options?: string[]; // choice
}
```

- `projectForModel`: normal projection (`finding` derived from prompt/status
  text — must be model-safe summary, not empty).
- `exposeToModel: false` still stubs to `Completed.` (host keeps raw).
- Answers: **new user turn only** (queue if busy). Never a second provider
  result on the same `call_id`.

### Provider hard rule

First completed tool message for a given provider `call_id` / `tool_call_id`
is final. No second bind. Validated for Google Interactions, OpenAI-compat /
OpenRouter, AI SDK, Gemini Live tool responses.

---

## Completion

| Outcome | `before_end` | Cycle-ending `done` | `post_turn` |
| --- | --- | --- | --- |
| Normal complete / length / etc. | yes | yes | yes |
| Tools done incl. awaiting; host UI may still be open | yes | yes (`completed` / …) | yes |
| `stop.kind: 'gate'` | no | yes (`gate`) | yes — observe suspension |
| Live interrupt ending cycle | yes | yes (`interrupted`) | yes |
| Deny mid-batch | no (not ending) | no | no — batch continues |
| Cancelled (abort affordance) | if ending | yes (`cancelled`) | yes |

### Same-round batch rules

1. Run pending calls **in order**.
2. On **gate**: emit gate wire for that call; **do not** start its body; **do
   not** start later siblings in this batch; end with `done.stop.kind: 'gate'`
   + snapshot (includes already-completed siblings’ results in history).
3. On **deny**: write synthetic failure result; `post_tool`; **continue**
   siblings.
4. On **awaiting / success / error**: `post_tool`; **continue** siblings.
5. After batch without gate → model follow-up or `before_end` as today.

### Repair

`pre_turn` once per user turn. `before_end` before every true end attempt
(including after egress/validation repair). Inject re-entry and repair each
consume the normal step / attempt accounting. A repair is the next user message
in turn history, so a `before_end` inject on the retry lands after it.

### Budgets

- **`maxSteps`:** `before_end` still fires when the step loop exits because the
  ceiling is hit. If the host `inject`s and another provider step would exceed
  `maxSteps`, **reject the inject** (no-op + warning); proceed to finalize.
- **Live:** no `maxSteps`; inject ingress is best-effort subject to session
  liveness.
- **Compaction `before`:** runs before `pre_turn`.
- **Compaction `after`:** attaches to terminal `done`, then `post_turn` sees
  that `done`. Compaction **child** turns do not fire the parent’s stages.
- **Live:** kernel compaction stages do not apply; provider context compression
  is out of band.

---

## Text `runTurn` map

| Stage | Trigger |
| --- | --- |
| `pre_turn` | After resolve / sanitize / compaction-before / canary bind; before first provider step of the turn |
| `pre_tool` / `post_tool` | Shared execute path |
| `before_end` | No further autonomous work (no pending tools, or batch finished without gate); **before** egress/validation finalize. Inject → re-enter step loop if under `maxSteps` |
| `post_turn` | Immediately after terminal `done` |

On a text turn the opening user input is already the last message of
`history` when `pre_turn` runs, with or without a handler
([kernel.md](./kernel.md)); image and speech turns keep it as the call input.

---

## Live `runSession` map

Same names. Cycle state `idle` | `open` on the session.

| Stage | Trigger | Site |
| --- | --- | --- |
| `pre_turn` | First ingress opening a cycle: first `sendText` / `sendVideo` / `sendAudio` / initial `input` after `idle`. Continuous audio: first chunk after idle only | Before socket write |
| `pre_tool` / `post_tool` | Inside `executeTool` | Session execute API |
| `before_end` | Cycle boundary (`interactionStatus: IDLE`, else `turnComplete`) or interrupt that will emit cycle-ending `done`; after batch known; before finalize / before yield `done` | `events()` outbound path |
| `post_turn` | After that `done`; cycle → `idle` | Same |

**Barge-in / empty audio:** interrupt ends the cycle with `before_end` /
`interrupted` / `post_turn`. Empty or zero-length audio chunks do **not** open
a cycle. After `post_turn`, the next non-empty ingress opens a new cycle.

**StageContext.history (live):** seeded from `SessionRequest.history`, then
appended for user `sendText` / inject texts, tool settles from `executeTool`,
and outbound assistant `text` events. Raw PCM / video frames are **not** stubbed
into history — text + tools + seed are the observe surface until a multimodal
history model exists.

### `LiveSession.executeTool` (required)

```ts
executeTool(args: {
  name: string;
  callId: string;
  input?: unknown;
  resume?: InvokeToolResume;
  credentials?: Record<string, ToolCredential>;
  host?: unknown; // overrides/fills session host for this call if provided
}): Promise<{
  outputRaw?: unknown;
  outputModel?: ModelToolResult;
  failure?: ToolFailure;
  awaiting?: boolean;
  gated?: ToolGate; // if settled as gate without body
}>
```

**Rules:**

- Runs the frozen tool pipeline (stages included).
- **Pumps** `stage` + `tool` events into the same `events()` queue (single
  stream for hosts). Does **not** return a second AsyncIterable of turn events.
- On successful/awaiting/deny settle: sends upstream `sendToolResponse` with the
  **one** final model-facing result (deny → failure text/data).
- On **gate**: does **not** send upstream tool response; returns `gated`; host
  shows UI; host calls `executeTool` again with `resume: { granted: true }`
  (allow) or `resume: { granted: false }` (deny settle); then upstream send on
  allow/deny settle.
- `SessionRequest` gains optional `credentials` and `host` for the session
  default; per-call args override.

`sendToolResponse` / `sendToolResponses` remain for hosts that must speak the
wire for **non-registry** pre-failed call ids, but **using them alone to complete
model tool calls skips stages and is non-compliant** with this contract.
Playground HTTP `/api/playground/live/tool` is **removed** — live tools run only
via relay `executeTool`.

**Process split:** registry-owning process runs `executeTool` (or shared
`invokeTool` + explicit stage dispatch); session process may only forward the
already-settled upstream payload. Stages fire where the body runs.

### Not stages

`generation_complete`, `waiting_for_input`, `turn_complete` / `working` while
the server is still `IN_PROGRESS`, setupComplete, socket close, bare
tool-request events, raw `sendToolResponse`.

---

## Host profiles / `invokeTool`

- Stages: `pre_tool` / `post_tool` only.
- `InvokeToolRequest.onStage` optional.
- `HostGuardrailsSpec` unchanged.
- Gate → return events to caller; **no** model `done` (no model). Caller sees
  tool events with `phase: 'gate'` and must resume — same API.

---

## Interface / composer / playground

| Concern | Target |
| --- | --- |
| Steer | Offered when inject allowed **and** runner is at an inject-capable stage (`pre_turn` / `post_tool` / `before_end`). Not tied to “not gated.” |
| Confirm / auth gate | Composer phase `gated` only; primary actions: resolve gate / abandon — **not** “queue as if turn ended” |
| Awaiting completion | Turn may be `idle` / completed; host UI from tool output; **not** composer `gated` |
| Gate helpers | `gatedToolFromEvents` (stop `gate`) + `awaitingFromEvents` (complete+awaiting) |
| Abandon | `abandonGatedToolSession` |
| Playground steer inbox | FIFO **one consume per inject-capable stage fire**; keyed by turn id (text) or session id (live). Do not consume on `pre_tool` / `post_turn` |
| Snapshot | Still on `done` when `stop.kind === 'gate'` (and available on normal `done` when tools ran — not only gates) |

---

## Credentials, host slot, taint, client boundary

- `StageContext.host` is the opaque slot; never on traces / client events.
- `forClient` / `forClientEvents`: pass `stage` events through; strip nothing
  stage-specific beyond existing rules; **never** put `outputRaw` secrets on a
  separate client field — clients already should not see raw tool secrets if the
  host filters tool events (unchanged host duty).
- Taint / arg inspect stay **before** `pre_tool` stages (frozen pipeline).

---

## T2 / snapshots

- Promote loader output **before** `post_tool`.
- Killing pause-`done` does not kill snapshots: emit `done.tools` on
  `stop.kind: 'gate'` and on normal completion when useful for hosts; turn
  state retains the snapshot for `invokeTool` / `executeTool` resume without
  requiring a fake pause.

---

## Migration slices (release rule)

| Slice | Must fully cut over |
| --- | --- |
| **1 — Spine** | `TURN_STAGES`, `stage` events, `onStage` attach points, inject gate semantics, text maps, delete `onSteer`/barriers, cancelled `done`+`post_turn`, maxSteps inject reject, frozen types |
| **2 — Tools** | Pipeline order, `preTool`, remove three old hooks, gate vs deny vs awaiting wire, `ask_user` awaiting payload, synthetic deny results, T2-before-post_tool, interface gated/awaiting split (text) |
| **3 — Live + playground** | Live profile `allowSteering`, cycle machine, `executeTool`, live inject, playground/session inbox, react rename |

**Release rule:** do not publish a theorem version that exports stages while any
slice above is missing. Branch work may land incrementally; **mainline release
requires all three.** That is how “no dual API” is enforced without pretending
slice 1 alone is the product.

---

## Forbidden

| Pattern | Why |
| --- | --- |
| `done.stop.kind: 'tool'` meaning pause | Fake |
| `tool.phase: 'pause'` / `ToolPause` for ask or confirm | Wrong layer / removed |
| Second provider result on same `call_id` | Invalid |
| Silent ignore of invalid affordances | Use matrix + warning |
| `executeTool` as a second event AsyncIterable | Mux spaghetti |
| “Fields TBD at implement time” | Shim license |
| Gaps / “does not fire” for a named live stage | Incomplete |
| Folding projection into stages | Skippable fencing |
| Shipping stages without live + awaiting + gate honesty | Incomplete product |

## Relation to `kernel.md`

Text mid-turn inject is stages (`onStage`); steer barriers are deleted.
Tool execute uses `preTool` + gate/deny/awaiting ([`stages.md`](stages.md) slice 2).
Live `executeTool` / playground inbox / cycle stages / react+interface `gated*`
(no `paused*` aliases) are on branch (slice 3).
