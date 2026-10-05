# Guardrail detectors: one standard for everything the kernel finds in text

**Status:** proposal. Rewritten 5 Oct 2026 with Masud. It replaces the first
version of this file, whose steps 1 to 4 are built (section 11). Section 12
lists what is decided and section 13 what is still open. Nothing new is built
until Masud agrees the whole doc.

## 1. The standard

**The kernel finds X in text at place Y and does Z.**

- X is a **detector**.
- Y is a **boundary**.
- Z is an **action**: `ignore`, `flag`, `redact` or `block`.

Every guardrail that reads text is a detector in `guardrails.detect`. There is
no second place to configure one and no second vocabulary.

Today six places configure the same kind of decision:

| Finds | Configured in | Becomes |
|---|---|---|
| IDs, financial, network, credentials, injection | `detect` | stays |
| The planted canary token | `canary` | detector `canary_leak` |
| The private system prompt, repeated | `promptEcho` | detector `prompt_leak` |
| The kernel's fence markers | `egress.checks.boundary` | detector `marker_leak` |
| Images and links the model was not given | `egress.checks.images`, `.links` | detectors `ungiven_images`, `ungiven_links` |
| A tool result that tells the agent what to do | no setting, always on | detector `tool_instructions` |
| Whatever a host's own check finds | `egress.enforce`, `egressPolicy({ rules })` | host patterns and host detectors (section 5) |

`guardrails.canary`, `guardrails.promptEcho` and `guardrails.egress` cease to
exist.

Guardrails that do not read text are **limits**. They stay as they are
(section 7): `quota`, `network`, `taint`.

## 2. Detectors

A detector declares three things. Nothing else describes it, and the editor,
validation, catalog and docs are generated from the declaration.

1. What it finds.
2. The boundaries it applies at.
3. Its default action at each boundary, which is also the recommended one.

Every action is valid for every detector at every boundary it applies at. The
kernel has no table of "this detector cannot do that". The editor marks the
recommended action; the builder may pick any.

`redact` means one thing everywhere: every span that matched is replaced with
a placeholder. For `tool_instructions` that is the order, the authority claim,
the tool name and the destination, wherever each matched. The kernel does not
promise to remove a sentence.

### Theorem's detectors

| Detector | Finds | Applies at | Host patterns |
|---|---|---|---|
| `ids` | US SSN, ITIN, EIN | every boundary | yes |
| `financial` | IBANs, card numbers | every boundary | yes |
| `network` | IPv4, IPv6 addresses | every boundary | yes |
| `credentials` | API keys, tokens, key assignments, PEM keys | every boundary | yes |
| `injection` | prompt-injection phrasing, as written or disguised | every boundary | yes |
| `tool_instructions` | a tool result that instructs the agent: names a callable tool, gives an order or claims authority alongside a destination, or tells it to drop its instructions | tool output, tool failure | yes |
| `canary_leak` | the token the kernel plants in the system instruction | reply, structured reply, Live reply, thought, tool arguments | no |
| `prompt_leak` | a run of words from the private system instruction, also reversed, in rot13 or leetspeak | reply, structured reply, Live reply, thought, tool arguments | no |
| `marker_leak` | the kernel's fence markers | reply, structured reply, Live reply | no |
| `ungiven_images` | an image URL the model was not given, on a host not allowed | reply | no; takes `allow` |
| `ungiven_links` | a link the model was not given, on a host not allowed | reply | no; takes `allow` |
| `tool_leak` | the profile's own tool and parameter names, and tool-call JSON | reply, structured reply, Live reply, thought | yes; takes `allow` |

A detector is not offered at a boundary it does not apply at. Naming one there
is a registration error. An action a detector does not support is a
registration error.

`canary_leak` and `prompt_leak` do not apply to incoming text: a token the user,
history or a tool result supplied this turn is allowed, as today.

**Planting follows the setting.** The canary token is added to the system
instruction only when `canary_leak` is above `ignore` at some boundary.

### Defaults

Principle (decided): what is **ours** blocks when it leaves. What is the
**user's** stays as today.

| Detector | Incoming text | Tool output, failure | Tool arguments | Reply, structured, Live | Thought |
|---|---|---|---|---|---|
| `ids`, `financial`, `network`, `credentials` | redact | redact | flag | ignore | ignore |
| `injection` | redact | redact | ignore | ignore | ignore |
| `tool_instructions` | | flag | | | |
| `canary_leak` | | | **block** (new) | block | redact |
| `prompt_leak` | | | flag (new) | block | redact |
| `marker_leak` | | | | block | |
| `ungiven_images` | | | | block | |
| `ungiven_links` | | | | ignore | |
| `tool_leak` | | | | flag | flag |

An empty cell is a boundary the detector does not apply at.

What changes for a profile that sets nothing:

- **Canary in tool arguments refuses the call, not the turn.** Before, the
  stream ended the whole turn when a model tool call carried the token
  (nothing under `src/kernel/tools/` read it). Now the tool-arguments
  boundary reads it: default `block` refuses that call and the turn goes on,
  as any other blocked argument does. The token has no honest use in a tool
  call.
- **The system prompt in tool arguments is flagged.** Not blocked: an agent
  tool may be handed instructions on purpose.
- **Fence markers and ungiven images block in the reply.** Today they run only
  when a profile sets `egress`.
- `tool_instructions` at `flag` is today's behaviour: reported, and it raises the turn's
  taint (section 7).

## 3. Boundaries

Unchanged: the 25 boundaries in `boundaries.ts` (13 named, 12 built from the
tool types). `host` profiles have the tool boundaries only.

One case does not fit, and the doc says so rather than hiding it. A provider's
own tool (`builtin`) can carry the canary or the system prompt out before the
kernel sees it. Nothing can be stopped there. It stays an always-reported
incident, under `detect.canary_leak` or `detect.prompt_leak`, and the reply is
withheld as today.

## 4. Actions

| Action | Meaning |
|---|---|
| `ignore` | Does not check the text. |
| `flag` | Records the match in the trace. Changes nothing. |
| `redact` | Replaces the match with a placeholder. Keeps the rest. |
| `block` | Stops the whole message, reply or tool call. None of it gets through. |

When several detectors match one crossing, the strongest action wins (`block`
over `redact` over `flag`). Every match is reported under its own detector.

### After a blocked reply

One setting for the profile (decided), whichever detector stopped the reply:

```ts
guardrails.blockedReply?: {
  /** 'retry': the model is asked to try again. 'refuse': the person reads the refusal. Default 'retry'. */
  then?: 'retry' | 'refuse';
  /** How many retries before the reply is withheld. */
  maxRetries?: number;
}
```

It replaces `egress.onBlock` and `egress.maxRetries`. `egress.holdback` goes:
it existed only for a host's own function.

What follows a block elsewhere is fixed, as today: a refused request ends the
turn; a stopped tool call or withheld result is reported to the model as a
failed call; a hidden thought changes nothing else.

## 5. Whose patterns: Theorem's, the host's, both or none

Decided: per detector, a host chooses Theorem's patterns and its own, only
Theorem's, only its own, or none. A host can also add a detector of its own.
Patterns are data, checked for safety.

### The setting

```ts
/** One action wherever the detector applies, or the full form. */
type DetectorRule = DetectAction | DetectorConfig;

interface DetectorConfig {
  /** The action wherever the detector applies. Left out: its defaults. */
  action?: DetectAction;
  /** An action for the boundaries named, over `action` or the default. */
  at?: Partial<Record<Boundary, DetectAction>>;
  /** Theorem's patterns. Default true. */
  theorem?: boolean;
  /** The host's patterns. */
  patterns?: HostPattern[];
  /** `ungiven_images` and `ungiven_links` only: hosts allowed, and whether a tool result's URLs count as given. */
  allow?: { hosts?: string[]; fromTools?: boolean };
}

type HostPattern =
  | { name: string; pattern: string; flags?: string }
  | { name: string; words: string[] };
```

Two fields give the four choices, and no combination contradicts itself:

| `theorem` | `patterns` | The detector uses |
|---|---|---|
| true (default) | given | both |
| true (default) | none | Theorem's only |
| false | given | the host's only |
| false | none | none: it finds nothing |

```ts
detect: {
  credentials: { patterns: [{ name: 'bonsai-key', pattern: 'bns_[a-z0-9]{32}' }] },  // both
  ids: { theorem: false, patterns: BONSAI_IDS, action: 'redact', at: { reply: 'block' } },
  injection: 'block',
  'bonsai.record': { label: 'Record numbers', patterns: RECORDS, action: 'redact' },
}
```

Changes to the shape already built (breaking, made outright):

- The per-boundary map moves under `at`. A bare `{ reply: 'block' }` is gone.

`detect: 'ignore'` for every detector at once stays: that action wherever each
detector applies.

`theorem` and `patterns` are refused on a detector that does not take patterns.

### Host detectors

A key with a dot (`bonsai.record`) is the host's own detector. Theorem's names
never contain one, so the two cannot collide. It needs a `label`, an `action`
or `at`, and one of:

- `patterns`: data, as above. Many patterns under one detector share its name
  in the trace, so a detector is the host's category.
- `find`: a function, for what patterns cannot say (parse the text as JSON,
  require two things at once, count matches against a threshold).

```ts
find?: (text: string, at: { boundary: Boundary }) => readonly { start: number; end: number }[];
```

Either kind applies at every boundary, takes all four actions, reports as
`detect.bonsai.record`, and appears in the same grid in the editor and the
trace. What a function costs, stated plainly:

- It is code, so a saved profile and the playground cannot hold it. The
  playground shows the row and its actions, not the function.
- The kernel cannot bound its time. It must be synchronous.
- A throw counts as a match with the action `block`.
- At the reply the kernel cannot know what a function might still match, so
  the stream holds a fixed tail back for it (256 characters, 96 on Live:
  today's `holdback` defaults).

Patterns live in the profile. A host with many profiles shares one constant.

### The hint a retry carries

Every detector has a `hint`: one line telling the model what to leave out.
Theorem's are in the lexicon; a host detector sets its own, and may set one on
a Theorem detector it adds patterns to. When a blocked reply is retried, the
kernel sends the hints of the detectors that fired and the text each matched.
No host code builds the message. The retry is itself read at the `repair`
boundary, so a matched secret is redacted there by default.

### `tool_leak`: the profile's own tools

A Theorem detector (decided), so no host derives it: the names of the
profile's tools and their parameters, and tool-call JSON, in what the model
says. Applies at reply, structured reply, Live reply and thought. Default
`flag`: an agent often names a tool honestly. It takes `allow` (names that are
innocent) and host patterns.

### Safety of host patterns

A host pattern runs on text an attacker may control. At registration the kernel:

- refuses a pattern that does not compile, is sticky, or uses a backreference
  to text that varies;
- refuses a pattern that can backtrack super-linearly;
- caps the number of patterns per detector and the length of each.

At the reply the stream holds exactly the text a match could still be under
way in. That needs each pattern as an automaton. The compiler exists
(`egress-compiler.ts`, behind `agents egress-compile`) and is too slow for a
Worker cold start. So: a profile with host patterns loads a table written at
build time, or compiles at registration. `agents egress-compile` becomes
`agents detect-compile`. The registration cost is measured in step 4.

### What this removes

`egress.enforce` (a host function) and `egressPolicy({ rules })` (host reply
rules). Both become host detectors, which now also work at every other
boundary. `egress.enforce`'s own verdict (allow, flag, redact, block) goes: a
function says what it found, and the profile's action says what happens.

## 6. What a stored trace keeps

`observability.scrub` decides what a stored trace keeps. It reads the same
registry, including host patterns and host detectors, so a host's own category
is scrubbed too. Its three switches stay (decided) and ride the same engine:
`sensitive` covers the data detectors and host detectors, `injection` covers
`injection` and `tool_instructions`, `canary` covers `canary_leak` and
`prompt_leak`. Scrubbing is `detectAt` with `redact`, not a second scanner.

The trace has its own choice of whose patterns (decided). The patterns are
still written once, on the detector; the switch picks which of them clean the
trace:

```ts
type ScrubSwitch = boolean | { theorem?: boolean; host?: boolean };
```

| Value | The stored trace is cleaned with |
|---|---|
| `true` (default) | what each detector uses in the turn |
| `{ host: true, theorem: false }` | the host's patterns only |
| `{ host: true, theorem: true }` | both, whatever the turn uses |
| `false` | nothing |

So a detector may use both sets in the turn and only the host's in the trace.

## 7. Limits

Not text, not detectors, unchanged:

- `quota`: how many turns.
- `network`: which hosts a tool may reach.
- `taint`: what tools may still do after the turn reads a remote result.

`taint` reads `tool_instructions`: a `tool_instructions` match raises the turn's advisory level,
as the directive rules do today. With `tool_instructions` at `ignore`, the
`afterRemoteRead` limit still holds; it never depended on reading the content.

## 8. One engine

Every crossing calls `detectAt`. It reads the resolved matrix, runs each
detector that is above `ignore` at that boundary, and returns one result.

- **A detector at `ignore` costs nothing.** It is not run.
- **One normalisation per crossing,** shared by every detector.
- **One report per crossing,** each hit carrying its detector, boundary, the
  action taken and, for a host pattern, the pattern's name.
- **One rule id form:** `detect.<detector>`. `EGRESS_RULES` and
  `DIRECTIVE_RULES` go. A `tool_instructions` hit keeps its kind (tool name, order,
  authority claim, override) as a field on the hit.
- The reply stream and the thought guard read the same registry, as they do
  now for the five built detectors.

### Rules that hold, because this part is high stakes

1. **Fail closed.** A scanner that throws, or structured output that cannot be
   scanned, is a `block` wherever any detector there is above `flag`.
2. **Nothing reaches the person before it is settled.** The stream holds text
   a match could still be under way in.
3. **A misspelling is an error, never a silent default:** an unknown detector,
   boundary or action.
4. **Theorem's patterns go off only when the profile says `theorem: false`,**
   and the editor and the interface view show it.
5. **Every stop is reported** with detector, boundary and action.
6. **The defaults are one table,** snapshot-tested. Changing a default is a
   breaking change with a release note.

## 9. Speed and precision

Budgets for speed and floors for hit and miss rates are a separate stream of
work (decided). This work must not make either worse: a detector at `ignore`
is not run, and each crossing is normalised once.

## 10. The editor

One section, **Detect**. `Egress` and `Canary` go.

- Rows in four groups: **Data** (ids, financial, network, credentials),
  **Attacks** (Injection, Tool instructions), **Ours** (Canary leak, Prompt
  leak, Marker leak, Ungiven images, Ungiven links), **Yours** (host detectors, with Add).
- Every row offers all four actions, with the recommended one marked. Its
  chevron shows only the boundaries it applies at.
- A detector that takes patterns has a switch for Theorem's patterns and a
  list of the host's. `ungiven_images` and `ungiven_links` have their allowed hosts.
- One row below the groups: **Blocked reply** (retry or refuse, retries).
- Labels, tooltips and descriptions come from the detector declarations. The
  frontend holds only the icons.

## 11. Build order

Built already (first version of this doc): the five detectors, 25 boundaries,
`detectAt` at every boundary, both reply scanners on the registry, the old
fields deleted.

Each step ends green on every gate and carries its contract-doc edits.

1. Detector declarations (applies at, defaults, takes patterns). The
   `action` / `at` shape. Validation, catalog, interface view, editor.
2. `canary_leak` and `prompt_leak` as detectors, including tool arguments.
   `guardrails.canary` and `guardrails.promptEcho` deleted. Until step 3 a
   blocked leak in the reply ends the turn through the attempt gate
   (`stop.native: 'egress'`), with no retry of its own.
3. `marker_leak`, `ungiven_images`, `ungiven_links` as detectors. `blockedReply`.
   `guardrails.egress.checks`, `onBlock`, `maxRetries` deleted.
4. Host patterns and host detectors: compile, safety check, `detect-compile`.
   `egress.enforce`, `holdback` and `egressPolicy` deleted.
5. `tool_instructions`, agreed with the session that owns the tool-result
   scanner. `tool_leak`. Hints on every detector, carried by a retry.
6. Trace scrub on the registry. Docs chapters. Cassettes.

## 12. Decided

1. **One standard.** Everything the kernel finds in text is a detector in
   `guardrails.detect`.
2. **Canary is a detector.** Flag, redact or block; block by default.
3. **Defaults:** ours blocks when it leaves; the user's stays as today;
   ungiven links default to `ignore`. This replaces "no default is `block`".
4. **What a blocked reply does is set once per profile.**
5. **Whose patterns is chosen per detector:** both, Theorem's, the host's, none.
6. **A host can add patterns to a Theorem detector and add its own detector.**
7. **Host patterns are data,** checked for safety. A host detector may
   instead be a function that returns what it found.
8. **`tool_instructions` is a detector,** default as today.
10. **`egress.enforce` is removed.** A host function is a host detector's
    `find`, in the grid.
15. **Every detector has a hint.** A retry carries the hints of the detectors
    that fired and what each matched.
16. **`tool_leak` is a Theorem detector,** default `flag`.
17. **`detect: <action>` for all detectors stays.**
11. **Every action is valid wherever a detector applies.** No per-detector
    exceptions in the kernel. Each cell has a recommended action, which is
    its default.
12. **`redact` replaces every span that matched,** for every detector.
13. **Trace scrub keeps its three switches** and runs on the same engine. Each
    switch can pick whose patterns clean the trace, apart from the turn.
14. **Names:** Canary leak, Prompt leak, Marker leak, Ungiven images, Ungiven
    links, Tool instructions.
9. Kept from the first version: every crossing follows the settings; `block`
   means the same everywhere; `redact` at tool arguments calls the tool with
   the placeholder; `host` profiles have the tool boundaries only; no shims.

## 13. Open

Nothing.

## Not in this work

- Speed budgets and precision floors as build gates.
- Raising a flag in the chat UI and wiring it to manual approval.
- Rules per destination (an action that depends on which host the text is
  going to).
- Merging `TOOL_TYPES` and `TOOL_ORIGINS`.
- Cleaning up `GUARDRAIL_STAGES`.
