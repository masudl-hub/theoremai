# Guardrail detectors: one action per detector, per boundary

**Status:** proposal, not built. Written 5 Oct 2026 with Masud. Section 13 lists what
was decided. Nothing is built until Masud agrees the whole doc.

## 1. The problem

A builder makes one kind of decision about guarded text: *when the kernel finds
this kind of thing, what should it do?* Today that decision is spread over four
settings with three names, and each one is hard-wired to one action in one
direction:

| Setting today | Finds | Where | Does |
|---|---|---|---|
| `guardrails.sanitizeInput` | injection phrasing | incoming text | masks |
| `guardrails.redactSensitive` | ids, financial, network, credentials | incoming text | masks |
| `guardrails.egress.checks.sensitive` | the same four groups | the reply | stops the reply |
| `guardrails.egress.checks.injection` | injection phrasing | the reply | stops the reply |

"Sanitize" and "redact" are the same operation on different patterns. "Redact"
and "block" are not a choice: each direction can do only one of them. Tool
arguments are only ever reported, thoughts are never read for these patterns,
and three paths ignore the settings completely (section 4).

The same lists are also written out many times. The four group names appear in
about ten places in `src/`, the idea of "where text is read" exists as four
overlapping vocabularies, and the playground and the frontend each restate
labels and behaviour in prose. Section 9 lists every copy.

## 2. The model

Three small vocabularies, each owned by one file, and one setting built from them.

### Detectors: what the kernel finds

```ts
const DETECTORS = ['ids', 'financial', 'network', 'credentials', 'injection'] as const;
```

The four sensitive-data groups, unchanged, plus injection phrasing. "Detector"
replaces "sensitive group" and "sanitize": injection is not data, and a detector
is the thing that finds a match.

### Boundaries: where text crosses

A boundary is one place the kernel reads text. Every place it reads today is
named here. None is folded into another, and none ignores the profile.

One flat list. Each tool boundary exists once per kind of tool, shown here as
`<tool>`: `function`, `http`, `mcp`, `agent`. Those are the words a
builder already writes as a tool's `type`, so `tool_output_function` is what a
`type: 'function'` tool returns.

| Boundary | What is read there | Today |
|---|---|---|
| `user` | the message the person typed | follows the settings |
| `attachment` | the text of a file the person attached | always fully masked, no event |
| `voice` | the transcript of what the person said | always fully masked, no event |
| `slots` | values the host fills into the prompt | follows the settings |
| `history` | earlier messages the host replays | follows the settings |
| `injected` | messages a host stage adds during the turn | follows the settings, reported as history |
| `system` | text the host adds to the system prompt for one turn | follows the settings |
| `repair` | a stopped reply and the reason, handed back to the model to try again | follows the settings |
| `live_user` | text the person sends in a Live session | follows the settings |
| `tool_arguments_<tool>` | what the model sends to a tool | reported only |
| `tool_output_<tool>` | what a tool returns | follows the settings |
| `tool_failure_<tool>` | the error text of a tool that failed | always fully masked |
| `reply` | the text the model says to the person | checked only when `egress` is set |
| `reply_structured` | the structured output the model returns | checked only when `egress` is set |
| `live_reply` | what the model says in a Live session | checked only when `egress` is set |
| `thought` | the model's reasoning, where the host shows it | not read for these detectors |

That is 25 boundaries: 13 named above and 12 for tools (three per kind of tool).

In the code the list is one array in `boundaries.ts`, with a label and a
description for each name. The tool entries are produced
from the tool types, so adding a type adds its three boundaries and nothing is
typed twice. Today's "local or remote" split is a second, coarser list over the
same tools and goes away.

The kernel has two lists for where a tool runs: `TOOL_TYPES` (`function`,
`agent`, which builders write) and `TOOL_ORIGINS` (`local`, `delegated`, which
traces record). The boundaries use the builder's words, and one function maps
an origin to its type. Merging the two lists renames what traces record, so it
is a follow-up.

The profile's own `identity.system` is not a boundary. It is the builder's text
and is never read.

`builtin` tools have no boundary. The provider runs them and the kernel never
reads their arguments or output (checked 5 Oct 2026: `execute.ts` refuses to
run one, and the only text at that point is the kernel's own message).

An agent tool is `agent` whatever the called agent can do. Today's trace origin
for it is `local` or `delegated` depending on whether the called agent has
tools; that difference still drives fencing and taint, not detection.

### Actions: what the kernel does

```ts
const DETECT_ACTIONS = ['ignore', 'flag', 'redact', 'block'] as const;
```

Each action has one meaning, stated in terms of the thing that is crossing, so
it means the same at every boundary:

| Action | Meaning |
|---|---|
| `ignore` | Not read. |
| `flag` | Read and reported in the trace. It crosses unchanged. |
| `redact` | The match is replaced with a placeholder. The rest crosses. |
| `block` | The thing crossing does not cross. |

`block` never means "stop the turn". Whether the turn can go on is a consequence
of what failed to cross (section 3).

### The setting

```ts
type DetectorRule = DetectAction | Partial<Record<Boundary, DetectAction>>;

interface ProfileGuardrailsSpec {
  /** One action for every detector, or a rule per detector. Anything left out keeps its default. */
  detect?: DetectAction | Partial<Record<Detector, DetectorRule>>;
  // quota, canary, promptEcho, egress, network, taint: see section 6
}
```

```ts
detect: {
  credentials: 'block',                                   // at every boundary
  ids: { reply: 'block', tool_arguments_mcp: 'block' },   // the others keep their defaults
  network: 'ignore',
}
```

Every action is valid for every detector at every boundary. There is no table
of exceptions to maintain.

Resolved, it is always the full matrix:

```ts
type ResolvedDetect = Readonly<Record<Detector, Readonly<Record<Boundary, DetectAction>>>>;
```

## 3. What each action does at each boundary

`flag` and `redact` are the same at every boundary. `block` stops the thing
that is crossing, so the table says what that thing is.

| Boundary | The thing crossing | `block`: it does not cross |
|---|---|---|
| `user`, `attachment`, `voice`, `slots`, `history`, `injected`, `system` | the request the host sends for a turn | the request does not reach the model: the turn is refused with the lexicon's message |
| `repair` | the retry request | the retry is not sent: the turn ends refused |
| `live_user` | one Live message | the message does not reach the model |
| `tool_arguments_<tool>` | one tool call | the tool is not called |
| `tool_output_<tool>` | one tool's output | the model does not read the output |
| `tool_failure_<tool>` | one tool's error text | the model does not read the error text |
| `reply`, `reply_structured` | the reply | the reply does not reach the person |
| `live_reply` | what the model is saying | it does not reach the person |
| `thought` | one thought | the thought is not shown |

`block` never puts a stand-in for the content in its place. That would be
`redact`. Seven boundaries read parts of the same request, so a `block` at any
of them stops the same thing.

What happens after a block is not part of the action. It follows from what was
stopped, and the kernel already does each of these today:

- A refused request ends the turn.
- A stopped tool call or a withheld result is reported to the model as a failed
  call, in the lexicon's words, and the turn goes on.
- A stopped reply goes to `egress.onBlock`: the model is asked to try again, or
  the person reads the refusal.
- A hidden thought changes nothing else.

`flag` is the same everywhere: an event with the hits, and nothing else changes.

When more than one detector matches the same thing, the strongest action wins
for the crossing (`block` over `redact` over `flag`), and every hit is reported
with its own detector.

Structured output that cannot be scanned still fails closed, as invariant 3 of
`guardrail-invariants.md` requires: it is blocked when any detector at
`reply_structured` is set above `ignore`.

## 4. Defaults, and what changes

The defaults are today's behaviour. They are one matrix, `DETECT_DEFAULTS` in
`detectors.ts`, built from the boundary lists:

| Boundary | `ids`, `financial`, `credentials`, `network` | `injection` |
|---|---|---|
| `user`, `attachment`, `voice`, `slots`, `history`, `injected`, `system`, `repair`, `live_user` | `redact` | `redact` |
| `tool_output_<tool>`, `tool_failure_<tool>` | `redact` | `redact` |
| `tool_arguments_<tool>` | `flag` | `ignore` |
| `reply`, `reply_structured`, `live_reply`, `thought` | `ignore` | `ignore` |

No default is `block`. A profile that sets nothing has no reply check today
either: the bundled reply checks run only when a profile sets
`guardrails.egress`.

A profile that turns those checks on gets, today, `block` at the reply for
`ids`, `financial`, `credentials` and `injection`. That was the builder's
choice, so the migration in section 7 writes it out as `block` at `reply`,
`reply_structured` and `live_reply`.

Four boundaries ignore the profile today. That is a bug. Each now follows its
own setting:

| Boundary | Today | With this proposal |
|---|---|---|
| `attachment`, `voice` | always masked for everything, whatever the profile says, and no event is reported | follow their own setting, and report |
| `tool_failure_<tool>` (and the `formatToolResult` and `formatToolFailureForModel` fallbacks) | always masked for everything | follows its own setting |
| `injected` | follows the settings but is reported in the trace as history | reported as itself |

At the defaults those behave as they do now. They differ only when a builder
turns a detector down.

## 5. One engine

Every crossing calls one function. Nothing else decides what a match does.

```ts
/** Reads `text` as it crosses `boundary` under the profile's resolved matrix. */
function detectAt(text: string, boundary: Boundary, detect: ResolvedDetect): {
  action: 'allow' | 'flag' | 'redact' | 'block';
  /** The text to let through: unchanged, or with placeholders. Absent on `block`. */
  text?: string;
  hits: GuardrailHit[];
};
```

- Each detector owns its patterns in one registry (`src/guardrails/detectors.ts`).
  The whole-text scan and the streaming scan both read that registry, which
  removes the two hand-kept mappings (`collectEgressHits`' `if` chain and
  `egress-stream.ts`' `runs` and `KIND_RULES`).
- A hit carries its detector. Its rule id is `detect.<detector>` at every
  boundary, and the event carries the boundary. That replaces six rule ids that
  name the same match differently per place (`sanitize.injection`,
  `sanitize.sensitive`, `egress.sensitive-echo`, `egress.injection-echo`,
  `tool_result.redacted`, `tool_failure.redacted`, `tool_call.sensitive-argument`).
- The streaming reply gate already holds back text that could still become a
  match. On a settled match it now asks the matrix: `flag` releases the text,
  `redact` releases the placeholder, `block` does what it does today.
- The thought guard reads the same registry for `thought`.

### What is removed from the kernel

- `sanitizeInput`, `redactSensitive`, `egress.checks.sensitive`,
  `egress.checks.injection`, and their types: `SensitiveSelection`,
  `SensitiveSwitches`, `SensitiveGroups`, `DetectionOptions`,
  `detectionForTrust`, `detectionForProfile`, `redactSensitiveOnly`,
  `EGRESS_SENSITIVE_DEFAULT`, `NO_GROUPS`.
- The two validators for the same group shape (`assertRedactSensitive`, and the
  sensitive branch of `egressChecksProblem`). One validator for `detect` replaces both.
- The ad-hoc option literals at `sanitize.ts:42`, `tool-result.ts:218`,
  `execute.ts:1298`, and the raw `applySpans` calls in `attachments.ts:118`.

### What stays

- `guardrails.egress`: `enforce`, `onBlock`, `maxRetries`, `holdback`, and
  `checks` with `boundary`, `images` and `links`. Those three are about the
  reply by nature (the fence marker, and URLs the model was not given).
- `canary`, `promptEcho`, `network`, `taint`, `quota`.
- `observability.scrub` (`sensitive`, `injection`, `canary`). It decides what a
  stored trace keeps, which is not a crossing to the model or the person. It
  keeps its own switches and reads the same detector registry.
- Trust levels. `trusted` text is still never read.

## 6. How `detect` and `egress` relate

- `detect` at `reply` runs whether or not `egress` is set. A `block` there uses
  `egress.onBlock` and `egress.maxRetries`, at their defaults when `egress` is
  left out.
- `egress.checks` (`boundary`, `images`, `links`) and `egress.enforce` stay
  "one or the other", as today.
- When a host supplies `egress.enforce`, `detect` still runs at `reply`, and the
  host check runs after it. Today a host check replaces the bundled sensitive
  and injection checks, which silently drops the builder's detector settings.

## 7. Migration

This is a breaking change to the profile schema. A profile that still sets a
removed field fails registration with a message that names the replacement.

| Was | Becomes |
|---|---|
| `sanitizeInput: false` | `detect: { injection: 'ignore' }` at every boundary that defaults to `redact` |
| `redactSensitive: false` | the four data detectors set to `ignore` at every boundary that defaults to `redact` or `flag` |
| `redactSensitive: { network: false }` | `detect: { network: … }` set to `ignore` at every boundary that defaults to `redact` or `flag` |
| `egress: { checks: true }` | `detect` with `block` at `reply`, `reply_structured` and `live_reply` for `ids`, `financial`, `credentials`, `injection`; `egress: { checks: true }` stays for boundary, images, links |
| `egress.checks.sensitive: { network: true }` | `detect: { network: { reply: 'block' } }` |
| `egress.checks.injection: false` | `detect: { injection: { reply: 'ignore' } }` |

Known consequences:

- Stored playground drafts are discarded once, by the existing "draft shape
  grew" check. `tests/playground-store.test.ts` uses `egressChecks` as its
  example key and needs another.
- Trace rule ids change. Stored traces keep their old ids; the trace catalog
  keeps labels for the old ids so old traces still read.
- The frontend's `probe_misses` rows hold old field names. They are history and
  are left as they are.

## 8. Who owns each list

One owner per list. Everything else reads it; nothing restates it.

| List | Owner | Read by |
|---|---|---|
| Detectors: name, label, description, patterns | `src/guardrails/detectors.ts` | validation, catalog, both scanners, thought guard, trace scrub, playground, frontend |
| Boundaries: name, label, what crosses, when, what `block` means there | `src/guardrails/boundaries.ts` | validation, catalog, events, playground probe, frontend tester and editor |
| Actions: name, label, description | `src/guardrails/detectors.ts` | validation, catalog, frontend |
| Defaults matrix | `src/guardrails/detectors.ts` (`DETECT_DEFAULTS`) | `resolveGuardrailPolicy`, playground draft defaults, docs tables |
| Field descriptions | `PROFILE_FIELDS` in `src/kernel/schema.ts`, generated from the three lists | the frontend editor's row descriptions |
| Per-profile-type scope | `src/kernel/profile-scope.ts` | validation, `draftAllows` |

`PROFILE_FIELDS` gets `guardrails.detect`, `guardrails.detect.<detector>` and
`guardrails.detect.<detector>.<boundary>`, built in a loop from the lists. No
description string is typed twice.

`PROBE_BOUNDARIES` and `PROBE_BOUNDARY_NOTES` in `playground/guardrail-probe.ts`
become re-exports of the kernel's boundary list. The "what the kernel does
there" sentence is no longer prose: the tester shows the draft's actual actions
for that boundary.

`GUARDRAIL_STAGES` (13 members, two never emitted) stays as the trace's
vocabulary in this change, with one table mapping each boundary to its stage.
Retiring the dead members and the two extra mapping tables is a follow-up, not
part of this work.

## 9. Everything that changes

### Kernel `src/`

- `guardrails/`: `types.ts`, `policy.ts`, `sensitive.ts`, `injection.ts`,
  `sanitize.ts`, `tool-result.ts`, `egress.ts`, `egress-stream.ts`,
  `egress-patterns.ts`, `egress-policy.ts`, `thought-guard.ts`,
  `progressive-yield.ts`, `live-outbound-gate.ts`, `rules.ts`, `lexicon.ts`,
  `mod.ts`, `corpus/fuzz-inbound.ts`, `eval/mod.ts`; new `detectors.ts`,
  `boundaries.ts`.
- `kernel/`: `schema.ts` (catalog), `profile-scope.ts`, `profile-presence.ts`,
  `types.ts`, `registry/profiles.ts` (validation), `registry/attachments.ts`,
  `registry/system-prompt.ts`, `stages.ts`, `tools/execute.ts`,
  `tools/model-text.ts`, `engine/live-inbound.ts`, `engine/runner/stream.ts`,
  `engine/runner/gates.ts`, `engine/tool-trace.ts`, `engine/turn-trace.ts`.
- `interface/`: `types.ts`, `from-profile.ts`, `profile-interface.ts`,
  `draft.ts` (the client view carries the resolved matrix).
- `observability/`: `trace-catalog.ts` (rule and action labels), `trace-record.ts`.
- `cli/commands/bench.ts`, root `mod.ts` exports.

### Kernel outside `src/`

- `playground/`: `draft.ts` (`GuardrailsDraft.detect`, and `EgressChecksDraft`
  loses two members), `compile.ts`, `guardrail-probe.ts`, `probe-battery.ts`,
  `mod.ts`.
- `react/src/`: nothing names the settings. `client/trace-story.ts` and
  `ui/TraceGuardrails.tsx` read labels from the trace catalog and follow it.
- `tests/`: 26 files set the old fields (the largest: `guardrails/policy.test.ts`,
  `guardrails/sanitize.test.ts`, `playground/compile.test.ts`,
  `interface/headless.test.ts`, `kernel/profiles.test.ts`), plus the files that
  assert rule ids. `tests/cassettes/cases.ts` sets them, so cassettes are
  checked for re-recording.
- `scripts/`: `verify-guardrails-api.ts`, `verify-runner-api.ts`.
- Docs: `docs/contracts/guardrails.md` (the Sanitization, Sensitive data,
  Egress, Trust levels and Exported API sections), `docs/contracts/kernel.md`,
  `host.md`, `observability.md`, `README.md`, and `docs/_map.mjs` (section
  triggers and required headings).

### Frontend

- `app/components/profile-editor.tsx`: the guardrails editor (section 10).
- `app/components/guardrail-tester.tsx`: reads the kernel's boundary list and
  action labels; drops its own "Blocked / Redacted / Flagged / Passed" wording.
- `app/lib/.server/th30.ts`: a real profile that sets the old fields.
- Docs articles: `guardrails.ts`, `identity.ts`, `modalities.ts`, `start.ts`,
  `traces.ts`, `tools.ts`. These follow `docs/DOCS_CONTRACT.md`.
- Tests: `playground-coverage.test.ts` (every catalog path needs an editor row),
  `playground-store.test.ts`, `guardrail-probe.test.ts`.

## 10. The editor

One section, "Detect".

- One row per detector: its label, and a four-way segmented icon button
  (ignore, flag, redact, block) with a tooltip on each. Setting it sets every
  boundary.
- A disclosure on the row opens the full boundary list, in the kernel's order,
  each with the same button. The tool boundaries are a small grid: one line per
  kind of tool, with a button each for what the model sends, what the tool
  returns, and its error text.
- A row whose boundaries differ shows "Mixed" on its collapsed button.
- Labels, tooltips and descriptions come from the kernel lists. The frontend
  holds only the icons.
- The old "Input", "Redact" and "Block → Sensitive" sections go. "Egress" keeps
  on-block, retries, and the three reply checks.

## 11. Built for the gates

The kernel fails a change on fallow, Biome and ast-grep findings. The design
is shaped so it passes them by construction, and uses them to hold the
single-owner rule in place afterwards.

### Fallow

| Gate | What the design does |
|---|---|
| `unused-exports`, `unused-types`, `unused-files` (error) | No step adds an export before its reader. Each step in section 12 lands the list, its reader and its tests together, and deletes the old export in the same step as its last caller. |
| `duplicates` (strict, 40 tokens, 5 lines, tests included) | Catalog rows, validation and the defaults are built by looping the lists, never written per detector or per boundary. Every boundary calls one `detectAt`, and the twelve tool boundaries are built from the tool types, not typed out; no boundary has its own copy of "scan, pick action, emit". Tests are one table over detector × boundary × action, not a block per case. |
| `maxCyclomatic` 24, `maxCognitive` 34, `maxUnitSize` 140 | `detectAt` is a lookup in the matrix and a rank table for "strongest action wins"; it has no `switch` over boundaries or detectors. What `block` means stays in each caller, which already owns that outcome. The detector registry is data. |
| `maxCrap` 57 against coverage | Every new function ships with its tests in the same step. |
| `circular-dependency`, `re-export-cycle` (error) | `detectors.ts` and `boundaries.ts` are leaves: they import pattern modules only, never `types.ts` or `src/kernel/`. `types.ts` imports their types. The tool-origin-to-boundary mapping lives with `REMOTE_ORIGINS`, not in `boundaries.ts`. |
| `private-type-leaks` (error) | `Detector`, `Boundary`, `DetectAction`, `DetectorRule` and `ResolvedDetect` are exported with the functions that take them. |
| `audit` gate `new-only` | The removals shrink the findings baseline; nothing new is suppressed. |

### Biome

- `noExplicitAny` and the recommended preset: the matrix is a total
  `Record<Detector, Record<Boundary, DetectAction>>`, so every lookup is typed
  without a cast. One typed helper builds a record from a list of keys, so
  `Object.fromEntries` and its loose type appear once.
- `noUnusedVariables`: removed settings leave no dead parameters behind; the
  functions that took `DetectionOptions` are deleted, not emptied.
- Formatting: `biome check --write` on kernel `src/`, `tests/`, `scripts/` and
  frontend files. Kernel `playground/` and `react/` are wrapped by hand to 100
  columns, as always. No other formatter.

### ast-grep

Existing rules the design obeys: no `as any`, no `!` (total records make both
unnecessary), no `console`, `src/guardrails/types.ts` imports nothing from
`src/kernel/`, and `src/kernel/` does not re-export guardrails.

New rules, added in the step that makes each one true, so the design cannot
quietly come apart later:

| Rule | Fails on |
|---|---|
| `no-kernel-import-in-guardrail-types` (extended) | `detectors.ts` or `boundaries.ts` importing from `src/kernel/` |
| `detect-single-engine` | a call to `sensitiveSpans`, `injectionSpans` or `applySpans` outside `detectors.ts` and `observability/spans.ts`. Eleven files call them today. |
| `no-removed-guardrail-fields` | the identifiers `sanitizeInput` or `redactSensitive` anywhere in `src/`, `playground/` or `react/src/`, except the one registration error that names them |
| `no-detect-rule-id-literal` | a `'detect.…'` rule id written as a string outside `detectors.ts` |

### Docs gates

- `export-drift`: every export must appear in its owning contract doc. So the
  contract doc changes in the same step as the export, not in a docs step at
  the end.
- `copy-lint`: labels and descriptions for detectors, boundaries and actions
  are authoring copy, like `PROFILE_FIELDS`, and their two files carry the same
  `lexicon-exempt-file` note. Text a person or the model reads (the refusal,
  the "withheld" notes) goes in the lexicon.
- `_map.mjs`: section triggers and required headings change with the contract
  doc.
- Frontend `playground-coverage`: every new catalog path has an editor row in
  the same change that bumps the kernel. `docs-check-facts`: articles stop
  naming the removed paths in that change too.

## 12. Build order

Each step ends green on every gate above (typecheck, Biome, ast-grep, tests,
docs lint), and carries its own contract-doc edits.

1. Vocabularies and resolution, wired in: `detectors.ts`, `boundaries.ts`,
   `resolveGuardrailPolicy` returns the matrix, validation, catalog rows,
   scope, interface view. The old fields still work and are translated into the
   matrix here, so behaviour is unchanged and nothing new is unused.
2. `detectAt` at every boundary that carries text to the model or to a tool. `detect-single-engine`
   rule added.
3. The reply and thought boundaries: both scanners on the registry; `flag` and
   `redact` in the stream gate.
4. Old fields removed, with the registration error. `no-removed-guardrail-fields`
   rule added. Trace catalog, CLI, exports, scripts.
5. Playground package: draft, compile, probe, battery.
6. Frontend: editor, tester, `th30.ts`, tests, docs articles.
7. Cassettes checked, full kernel and frontend gates including fallow, browser
   check of the editor.

## 13. Decided

1. **No default is `block`.** The defaults are `redact`, `flag` and `ignore`
   only (section 4). `block` is always a builder's choice.
2. **Every crossing follows the settings.** Attachments, voice transcripts,
   slots and tool failure messages ignoring them today is a bug.
3. **`block` means the same everywhere:** the thing crossing does not cross.
   History and per-turn system text are part of the request, so `block` there
   refuses the turn, the same as at `user`.
4. **The field is `guardrails.detect`.**
5. **A host's own reply check does not switch the detectors off.** `detect`
   runs at `reply` first; the host's `egress.enforce` runs after it.
6. **`redact` at `tool_arguments` means what `redact` means:** the tool is
   called with the placeholder in place of the match.
7. **A profile with no model** (`host`) has only the tool boundaries. A rule for
   every boundary (`ids: 'block'`) is fine there; naming a boundary it does not
   have is a registration error. Decision profiles still refuse `detect`.
8. **One rule id per detector,** with the boundary on the event.

## Not in this work

- Raising a flag in the chat UI and wiring it to manual approval (saved as its
  own task).
- Rules per destination: letting a detector's action depend on which host or
  server the text is going to or came from. The per-boundary rule can later
  grow an object form for this without changing what is built here.
- Merging `TOOL_TYPES` and `TOOL_ORIGINS` into one list.
- Host-defined detectors. `egressPolicy({ rules })` keeps its own path.
- Cleaning up `GUARDRAIL_STAGES` and the check-to-stage tables.
