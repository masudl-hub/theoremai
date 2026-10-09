# Theorem Studio: the playground, opened on your own project

**Status:** sketch, started 7 Oct 2026 with Masud. Nothing is built and
nothing will be until Masud agrees the whole doc. We write this as we talk:
section 3 lists what is decided, section 5 what is open. A decision moves
from 5 to 3 only when Masud makes it.

## 1. The reader and the job

**Who:** a builder who has an application on Theorem. The example in this doc
is Bonsai: 41 profiles, 101 tools, 54 function handlers.

**The job:** open the application's real profiles, edit one, test the edit,
save it to code, and trust what was saved.

**Today:** the builder cannot do this. The playground is a website. It starts
from an example or an empty draft. It cannot open a profile that an
application registers.

### 1.1 What Masud wants it for

Asked on 8 Oct as questions about his own experience. These are his answers
and they are firm.

**The moments he wants it.** All of these:

- **To test tools.** "Just being able to load all the tools into the host
  profile and using the playground's UI to test them and see what comes back
  would be blissful. That's why we built the host page." He added this one
  himself.
- A conversation went wrong, and he wants to see why and fix it.
- He wants to change how the agent talks, and hear the difference.
- He cannot see what a profile does without reading many files.
- He changed code and wants to check it before it ships.

**What he sees first.** The map of everything, then a chat. The map is the
tree the playground already has. The tree needs a search.

**What makes him hesitate before Save.** Three things: he does not know what
else the edit changes, he has tried it only once or twice, and he cannot undo
it easily. He did not choose "I cannot see the exact change to my code".

**How he uses it.** Mostly to look. Then open all day beside the editor.
Then in and out for one job.

**Where the line is between the studio and the IDE.** To build a tool is to
write its input and its output, and that is JSON. He goes back to the IDE for
that. In the studio: "I'd mostly be tweaking reasonable things from the UI."

So the studio changes words and settings. The IDE changes structure and
logic. For a tool, Claude reads that as:

| In the studio | In the IDE |
|---|---|
| The description the model reads | The shape of the input and the output |
| The description of each field | The handler |
| Read-only, read-write or destructive | A new tool |
| When the tool loads, and who may call it | |

Masud checked the table on 8 Oct: "the table looks right". The one change
is the last row of the right column, below.

**Adding a tool.** Masud (8 Oct): "I'd wanna be able to add a tool to the
studio, don't get me wrong. But the function wiring and JSON and stuff will
probably be agent work (for me) in an IDE." So the table's last row is wrong
for him: a new tool can start in the studio.

Claude's reading of what that means:

- An `http` or `mcp` tool needs no function. The playground makes these
  today. The studio makes them in full.
- For a function tool, the builder gives the name, what the tool is for, and
  whether it reads or writes. The studio writes the start of the tool in the
  project. The tool shows as "not built yet".
- A coding agent, or an engineer, writes the input, the output and the
  handler in the IDE. The studio sees the change and the builder tests the
  tool in the host console.

**Two kinds of builder.** Masud: "I can't speak for actual engineers." He
directs a coding agent and does not write the JSON himself. An engineer may
want to write it in the studio. The doc is written from Masud's experience.
An engineer has not been asked.

**What follows (Claude's reading, not Masud's words):**

- The first thing to build is not the edit loop. It is: open the project,
  see the tree, pick a tool, fill the form the host console makes from the
  tool's schema, run it, read the result. This needs no Save, no change to
  the instruction, and no rewrite of source code.
- "See what is set" comes with it: every profile opens read-only.
- For Save, the diff is not what earns his trust. What earns it is the list
  of what else changes, more than one or two runs, and a way back.

## 2. The loop

1. **Open.** The builder runs one command in the project. A local page opens
   with the project's profiles and tools in the playground editor.
2. **Read.** Every setting has a row. A setting that is a function says "set
   in code", names the function and its file, and opens that line in the
   builder's editor.
3. **Run.** The builder picks the context of the run (for example the test
   user and the plan). Tools run against the development environment.
4. **Edit and test.** An edit goes to a scratch copy. The builder tests the
   scratch copy.
5. **Save.** The builder reads a diff. The studio writes the value into the
   source file.
6. **Commit.** The builder commits. The studio does not run git.

### 2.1 Shared settings

A **shared setting** is a value that more than one profile uses: for example
one set of guardrails that 12 profiles import.

The builder does not open one of the 12 profiles to change it. The studio
has two ways in:

- **The list of profiles.** In a profile, a shared setting shows as a link:
  its name, the number of other profiles that use it, and "open".
- **The list of shared settings.** Each entry shows its name, its file and
  the profiles that use it. The builder opens it and edits it once, with the
  same rows the profile editor has.

Masud (9 Oct): "something to consider is a visual map to show how
constants, profiles, tools, etc are connected". Not designed. The studio
already reads what the map needs: for each constant, the profiles, tools and
other constants that read it.

A tool is already like this. A profile names its tools. Each tool is defined
once, and the studio shows it once, with the profiles that allow it.

Open about shared settings:

- A test of a shared edit runs on each profile that uses the setting, not
  only on one. What it costs depends on what the edit changes (Masud's
  question, 8 Oct):

  | The shared edit | The test | Cost |
  |---|---|---|
  | A guardrail rule | Run the new rule on the text of recorded turns, for every profile | No model call |
  | A guardrail rule that now acts where it did not | Run those turns again, to see what the turn does next | A few runs |
  | The instruction, the models, the tools | Real runs | Full |

  Decided as D21 to D30. Still open:

  - Each of Theorem's own detectors needs a way to make a fake that it
    still matches. That does not exist.

## 3. Decided

| # | Decision | Said |
|---|---|---|
| D1 | The studio opens from a command in the project. It serves a local page. | 7 Oct |
| D2 | Only this machine can reach it. | 7 Oct |
| D3 | The studio is the playground, opened on the project's code. It is not a second design. | 7 Oct |
| D4 | The builder edits in the studio, tests, and saves to code. A studio that cannot save is incomplete. | 7 Oct |
| D5 | Save rewrites the value in the builder's file, after a diff. | 7 Oct |
| D6 | Save always needs two checks: the profile registers, and the project type-checks. The builder turns on any other check. | 7 Oct |
| D7 | The studio stops at the file. It never runs git. | 7 Oct |
| D8 | Tools run for real. Each tool that writes asks the builder first. | 7 Oct |
| D9 | Keys and the user come from the application's development setup. The studio does not hold, show or ask for a key. | 7 Oct |
| D10 | The builder chooses where run data lives: memory, a git-ignored folder in the project, or the application's trace store. | 7 Oct |
| D11 | The screen shows prompts, replies and tool results. It never shows a key. It masks text that a guardrail matched as a credential or an ID, and names the rule. | 7 Oct |
| D12 | A setting that is a function is shown, named, and opened in the builder's editor. The studio does not edit functions. | 7 Oct |
| D13 | The application gives the studio a setup file. The file says how to build the context of a run. | 7 Oct |
| D14 | The builder can test four ways: chat by hand, before and after side by side, pinned turns, and the project's evals. | 7 Oct |
| D15 | The studio changes existing profiles and adds a profile. The builder can also add a tool in the studio (section 1.1). The wiring of a function tool, and its input and output, are done in the IDE. | 7 Oct; changed 8 Oct in Masud's words |
| D16 | No Rust at the start. The core loads TypeScript profiles and runs JavaScript handlers, and the wait is the model. | 7 Oct, Claude's advice; Masud did not object |
| D17 | We do not rush to build. Changed the same day: "let's get started". The first slice is being built, and the open pieces are resolved as it runs. | 8 Oct, twice |
| D18 | A setting that several profiles share is a thing of its own in the studio (section 2.1). The editor and the preview stay the playground's (D3). | 8 Oct |
| D19 | A shared setting shows the name of its constant, made readable (`STANDARD_GUARDRAILS` as "Standard guardrails"), with the real name and the file beside it. | 8 Oct |
| D20 | A constant that one profile uses is a part of that profile. It becomes a shared setting when a second profile uses it. | 8 Oct |
| D21 | A check that needs no model call runs by itself as the builder edits, for every profile that uses the setting. A run that needs the model waits: the studio lists the runs and the builder picks the profiles. | 8 Oct |
| D22 | A pinned turn keeps its text: the input, the reply and the tool results. It is saved in the project's test files. The checks that need no model call read pinned turns. | 8 Oct |
| D23 | Before a turn is pinned, the studio shows what it will save: the input, the reply and each tool result, with the replacements of D24, D25 and D29 already made and marked. The builder can change any text. Nothing is written until the builder confirms. | 8 Oct, Claude's choice; Masud said "go with what makes sense" |
| D24 | Personal text that a Theorem detector matches is replaced by a fake of the same kind: an email by another email, a card number by a published test number. One real value becomes the same fake everywhere in the turn. The builder's rules then act on the pinned turn as on the real one. | 8 Oct |
| D25 | A real credential is never written, and the builder cannot override this. The studio writes a made-up key of the same format, and says so. | 8 Oct |
| D26 | A pinned turn keeps each tool result in full, after the replacements. It does not copy a photo or a voice note. It records that one was there (its type and size), and the builder can attach a stand-in file. | 8 Oct |
| D27 | A builder's own rule can carry an example value that it matches. The studio uses the example as the fake for that rule. After the replacements, the studio runs every rule on the cleaned turn and on the original, and shows each rule that acted on one and not on the other. A rule with no example leaves a labelled gap, and the pin says that it cannot test that rule. | 8 Oct |
| D28 | A pinned turn records what was changed in it ("4 values replaced, 1 photo left out"). The record shows beside each result of that turn. A turn with a photo left out and no stand-in is used for the checks that need no model call only. The studio does not run it with the model, and says why. | 8 Oct |
| D29 | The setup file can give the studio the known values of the user of the run: for example the name, the phone number and the address. The studio replaces each one where it appears in a turn to be pinned. | 8 Oct, Claude's lean; Masud agreed |
| D30 | The builder is responsible for what a pin holds, and must be diligent. The studio removes what it can find. It does not find a personal detail in free text that the application never stored ("my mother's house on Elm Street"). The review of D23 says this, and the builder reads the turn before the builder confirms. | 8 Oct |

**How firm each decision is.** Masud said on 8 Oct that many of the
questions behind this table were not ones he could judge. So the table has
two kinds of row:

- **In Masud's own words:** D4, D6, D10, D17, D18, D30. These are firm.
- **Claude's recommendation, which Masud accepted:** all the others. These
  are defaults. Claude owns them, must be able to explain each one by what
  the builder sees, and brings one back to Masud only when it changes what
  the builder experiences.

Build order, as Masud gave it: "open and run, but also all of it". Open and
run comes first. The rest follows. Section 5 asks what "the rest" needs
before it starts.

## 4. What we know about Bonsai

Read from Bonsai's code on 7 Oct. This is the evidence the design must fit.

- **Plain settings Bonsai sets:** identity, models, inputs,
  `validation: { maxRetries: 1 }`, and compaction as plain values
  (`maxTokens`, `compactAt`, `previousExchanges`, `profile`, `timing`).
- **Functions Bonsai sets:** `tools.t1Policy` (`bonsaiT1Policy`), and the
  `find` of each `bonsai.*` detector. The detector's `label`, `at` and `hint`
  are plain values.
- **`bonsaiT1Policy` reads application context:** the tool-loading strategy
  and whether the turn is proactive. A plain setting cannot replace it.
- **Bonsai does not call Theorem bare.** Its own code builds the prompt, the
  tool catalog and the history before a turn (`run-host-turn.ts`).
- **One function makes several profiles:** the brain variants and the
  free-Gemini set.
- **Shared constants:** `ORCHESTRATOR_COMPACTION` is one object used by more
  than one profile.

### 4.1 Why Bonsai builds the turn itself

Read on 8 Oct from `assemble-host-turn-*.ts`, `run-theorem-turn.ts` and
`orchestrator/profile.ts`. Bonsai does not repeat work Theorem does: the
canary, tool visibility, tool confirmation and the compaction signal are all
left to Theorem. It builds the turn for two other reasons.

**Work that belongs to the application:**

- The history comes from Bonsai's own tables: one-to-one and group
  conversations, media from storage, messages that arrived during the turn.
- The user's data (plants, plans, journeys) goes into the request.
- A proactive turn has no user message. Bonsai writes its input from a queue.
- Bonsai picks the profile for the turn: proactive, free, developer or
  standard.

**Things Theorem does not offer yet:**

| What Bonsai does | The gap in Theorem |
|---|---|
| The brain profile has an empty `identity.system`. Bonsai builds the whole instruction each turn and sends it on the request | A profile cannot hold an instruction that depends on the turn (the plan, group or one-to-one, developer mode). The request line was made for one extra line, not for the whole instruction |
| Bonsai writes "tools you can load with load_tools: …" into the instruction by hand | Theorem promotes a loaded tool, but no text was found where it tells the model which tools it can load. To confirm |
| Each brain is registered twice, once for each key (`<id>` and `<id>.gemini`) | A turn cannot choose the key. The provider work in progress on 8 Oct may close this |

**What this means for the studio:** the Instruction row of Bonsai's main
profile is empty. The most important setting of the profile is not in the
profile.

### 4.2 The instruction: what Bonsai does and what others do

Masud's rule (8 Oct): Theorem must not become Bonsai-shaped. A Bonsai pattern
moves into Theorem only if it is good and other applications need it.

**What Bonsai does.** The instruction is a list of named text blocks
("frames") in `context/frames/`: the persona, the path (iMessage, web, voice),
the group frame, the date, the developer frame, the loadable-tools note. Code
picks the blocks from five facts about the turn: the plan, the path, group or
one-to-one, developer mode, proactive or not. The user's data does not go in
the instruction. It goes in the user message, inside a `<user-data>` fence.
The frames have tests.

**What others do.**

| Who | The opinion |
|---|---|
| Langfuse | A prompt is data, not code: a named template with versions and labels. It has `{{variables}}`, references to shared prompts, and a placeholder for the history. Code fetches it by label and fills it |
| OpenAI Agents SDK, Pydantic AI, Mastra | The instruction is a string, or a function of the context of the run |

**Where Bonsai sits.** Bonsai's frames are Langfuse's shared prompts. Its
choice of frames is the frameworks' function of context. Its history is
Langfuse's placeholder, which Theorem already has as `input.history`. Bonsai
is not unusual. What is unusual is that none of it is in the profile.

**A candidate that is not Bonsai-shaped.** `identity.system` is already a
list of parts. A part could also be computed for the turn by a named function
of the application's context. Fixed parts stay text the studio can edit.
Computed parts are "set in code" (D12), and the trace shows what each one
produced. Not agreed. Not checked against a second application.

**Not candidates.** Building the history, loading the user's data, and
writing a proactive input stay the application's work.

### 4.3 A candidate schema for the instruction

Not agreed. Today a part of `identity.system` is a string or
`{ private: string }`. The candidate adds one form: a function of the turn.

```ts
type SystemPart =
  | string
  | { private: string }
  | ((ctx: SystemContext) => string | { private: string } | undefined);

interface SystemContext {
  profile: Profile;
  input?: TurnInput;
  path?: string;
  /** Opaque application context from `TurnRequest.host`; the kernel never reads it. */
  host?: unknown;
}
```

`SystemContext` has the fields that `ToolLoadContext` already gives
`tools.t1Policy`. A function that returns `undefined` adds nothing.

Bonsai's main profile would then read:

```ts
identity: {
  handle: 'Bonsai',
  system: [persona, pathFrame, groupFrame, freshness, developerFrame],
},
```

Open about this candidate:

- Four of Bonsai's five parts are "fixed text, chosen by a fact". Only the
  date is computed. A second form, `{ text, when }`, would keep that text
  editable in the studio. One form or two?
- `systemByRole` chooses an instruction by role. A function part can do the
  same. Does `systemByRole` stay?
- The loadable-tools note needs no schema. Theorem writes it.
- The trace shows what each part produced. A private part stays out of the
  trace, as today.
- Parts that change each turn (the date) should come last, so the provider
  can cache the parts before them.

### 4.4 What the first slice needs from Bonsai

Read on 8 Oct. Masud agreed the first slice on 8 Oct: open the project, the
tree with a search, test a tool in the host console, read each profile.

- **One function registers everything.** `ensureBonsaiTheoremProfiles()` in
  `backend/infrastructure/theorem/register.ts` registers every tool and
  every profile. The studio can call it. It does not need to start Bonsai's
  server.
- **Bonsai's backend runs on Deno.** The command must run in the project's
  own runtime.
- **A handler needs Bonsai's context.** Each handler reads a `BonsaiToolHost`
  (a database client, the user of the turn). Bonsai builds it with
  `buildBonsaiToolHost`. The setup file (D13) is where Bonsai gives the
  studio a context for a test user.
- **Bonsai uses the published package** (`@theoremjs/agents@^0.3.0`), not
  the local checkout. The studio ships in a later version.

**Does loading Bonsai do any work?** Checked on 8 Oct, by reading only.

- `register.ts` pulls in 567 of Bonsai's files and 202 of the kernel's.
- A scan of the 567 files found no work at load time: no network call, no
  database client, no read of the environment, no timer, no server. A file
  only defines things.
- Limit of the scan: it reads each statement at the top of a file for a
  known risky call. It does not follow a call into a helper.
- The stronger test is to load Bonsai with no permissions and see what it
  asks for. Deno can do this. It could not run on 8 Oct: Bonsai links the
  local kernel, and the provider work in progress there removed an export
  Bonsai imports (`createProvider`). To repeat when that work is finished.
- Against the published 0.3.0, Bonsai's current code does not register
  either: it uses a lexicon placeholder that 0.3.0 does not know.

**Who the builder is in a test.** Masud (8 Oct): "generally a tester
account we've signed into". He asked how the studio handles Bonsai's
sign-in.

- The studio does not sign in. Read on 8 Oct: a Bonsai tool does not read a
  login. It reads a context that `buildBonsaiToolHost` makes from a database
  client and the id of a user. It also needs a channel, a session id and a
  billing record. The rest is optional.
- So Bonsai's setup file (D13) names the test users and builds that context
  for the one the builder picks. Bonsai's development server does not need
  to run.
- Claude's default: the studio always shows who the test runs as, and which
  database. The builder picks from the test users the setup file names.
- Not read: how Bonsai makes its walkthrough test accounts
  (`tests/support/`), and whether the setup file can reuse them.

## 5. Open

Each item is a question for Masud, or a thing to find out before he can
answer. Most serious first.

### 5.1 Accuracy

The studio makes four promises. None has a design.

| Promise | The risk |
|---|---|
| A row shows the setting that runs | The source text and the resolved profile differ: defaults, variants, values a request overrides |
| A studio run equals an application run | Bonsai builds the prompt, the catalog and the history itself. A bare profile run tests something no user gets |
| What was tested is what was saved | The rewrite of the source produces a profile that differs from the scratch copy |
| A comparison means something | A model varies from run to run. One "before" and one "after" is noise |

A candidate answer for the third promise: after the write, reload the file,
and compare the profile with the scratch copy. If they differ, undo the write
and tell the builder. Not agreed.

Masud (8 Oct) on the second promise: the profile on its own is enough to
start with. Bonsai still needs a test account behind it, so the tools have a
user. A run that equals the application's run comes later.

Open questions:

- Does the setup file give the studio the application's own "run a turn"
  function, or only a context?
- How many runs make a comparison? Do the tool results stay fixed between
  the two sides?

### 5.2 Save

**Built on 8 Oct, the first slice.** The studio shows a line when its edits
are not in the files, and a button, Review and save.

- The review shows each changed line of each file, before and after.
- Save writes a value where the file sets it as a plain value in the
  `defineProfile` or `registerTool` call. It keeps the file's indentation and
  quotes. A setting put back to its default is taken out.
- Save follows a constant (9 Oct). When one profile or tool is all that reads
  the constant, Save changes the value where the constant is set, in its own
  file, through any number of names and imports (D20).
- A constant that several profiles or tools read is written once (9 Oct),
  when every one of them holds the same change. The studio makes that so: an
  edit to a shared setting in one profile shows in the others at once. If
  they differ, the review names the constant, its `file:line`, and the ones
  that do not hold the change.
- A constant that other code reads too is not written. The review names it
  and its `file:line`.
- Save writes every change or none. If one change is set by a shared
  constant, by code, or by a tool's schema, Save is off. This keeps the third
  promise of 5.1: the files hold what was tested. Claude asked Masud on 9 Oct
  whether Save should write what it can instead. His answer: the question
  should not come up for constants, because the studio walks the project,
  offers its constants, and builds a library of them. So all-or-none stays as
  Claude's default for what is left: code and a tool's schema.
- After the write the studio type-checks the setup file (Deno only), loads
  the project again, and compares it with what the builder tested. If any of
  the three fails, it puts the files back and says which.
- If a file changed after the review, Save refuses and asks for a new review.
- Undo puts the files back. It refuses if they changed since the save. The
  edits stay in the studio, unsaved.
- The studio writes only files inside the project folder that the setup file
  imports. It does not run git.

**The list of shared settings, built on 9 Oct (D18).** A project whose
profiles or tools share a constant has a third list beside Agents and Tools:
Shared.

- Each entry shows a readable name (`STANDARD_GUARDRAILS` reads "Standard guardrails"), the
  constant's real name and `file:line`, and the profiles and tools that use
  it.
- A constant that is a whole section of every profile that uses it (its
  tools, its guardrails, its models) is edited in the studio. Opening it
  shows that section, with a line above it: the name, how many other
  profiles use it, and where it is declared. The same line shows when the
  builder reaches the section from the list of profiles, with "Open".
- Any other shared constant is listed and marked "edited in your code": one
  smaller than a section, one a tool reads, or one other code reads.

Built (D12): a setting the files set in code is shown, greyed, and takes no
edit. This is a call, a template, a spread, a constant other code reads, or
a tool's schemas and handler. Under it is one line that says what sets it
and where (`Set in code · stepsFor(PLAN) · setup.ts:34`), with "Open".

- Open starts the builder's editor on that line: the one `--editor` names,
  else `$VISUAL` or `$EDITOR` when it opens a window, else `code`. When no
  editor starts, the studio says so and offers the path to copy. It opens
  only files the project's setup reads.
- When one place sets a whole section (`inputs: deskInputs()`), the line is
  said once, over the section, and every row in it is locked. A spread
  (`...BASE_GUARDRAILS`) is said once too, and locks only the rows the files
  do not write after it.
- A row is locked exactly where Save would refuse the change, so the studio
  never lets the builder make an edit it cannot write.
- A profile or tool the files define twice, or that no file defines, is
  locked whole and says why.
- The places are read again after a Save or an undo, and when the builder
  comes back to the page from their editor.

Built (D8): in the studio, every tool that writes asks the builder before
each run, whatever its own Permission says. A tool that only reads runs
unasked.

- In the chat and the console, the run stops on the same card the
  application shows for a tool that asks: the input, with Reject and Approve.
- The editor's Test of a web tool that writes, and the assistant's test of
  one, stop on a dialog first: the request it sends, the input, Cancel and
  Run.
- A tool that a called agent runs cannot ask: a question inside a called
  agent has no one to answer it. The call to that agent asks instead, and
  the tool's Policy section says so. A profile that runs such a tool itself
  runs it unasked.
- The files are not changed, and the editor still shows the Permission they
  set. The tool's Policy section says the studio asks, and that the
  application runs it as Permission says.

Not built: editing those in the studio. Adding or removing a profile or a tool.
The project's formatter after the write. Markdown instruction files. A
type-check for a project that is not Deno.

- How often can a setting in Bonsai be traced to one exact place in the
  source? See the count below.
- What does the row do when it cannot be traced? Candidate: the row is
  read-only and opens the file.
- A value from a shared constant, or from a function that makes several
  profiles, changes several profiles. Save must name them.
- The file changes on disk while the studio holds a scratch copy. The
  builder, or another agent, edited it.
- Undo. The studio does not run git, so it needs its own.
- After the write: the project's own formatter.

**Reading where a value comes from.** Masud (8 Oct): a real profile rarely
holds its values inline. It imports constants, so that builders do not edit
the profile file each time. The studio must follow the import.

- The running project gives the value. It does not say where the value was
  written. Reading the source (the syntax tree, with the TypeScript compiler
  to follow names and imports) gives the place. The studio needs both, and
  they must agree.
- Each row then has one of three origins:

  | Origin | Example in Bonsai | The row |
  |---|---|---|
  | Written in the profile | `maxSteps: 8` | Editable |
  | A constant, here or imported | `compaction: ORCHESTRATOR_COMPACTION` | Editable. Names the constant, its file, and the profiles that use it |
  | Computed | `inputs: bonsaiConversationalInputs()`, the detectors built with `Object.fromEntries` | Read-only. Shows the value and opens the code |

- This makes "the edit changes several profiles" the normal case of Save,
  not a special case.
- The choice "only this profile" would rewrite the profile to stop using the
  constant. That is the edit builders avoid. Does the choice stay?
- Measured on 8 Oct, by reading the syntax of the 23 `defineProfile` calls
  in Bonsai's backend (16 files). It counts each value written in a call:

  | Origin | Values | Share |
  |---|---|---|
  | Written in the profile | 246 | 69% |
  | A constant | 82 | 23% |
  | Computed, or a spread | 26 | 7% |

  Limits of the count: a constant counts once, however many settings it
  holds (`models: PAID_KEY_MODELS`). 44 of the 82 constants are the `id` and
  `observability` of each profile. A call inside a function that makes
  several profiles counts once. The count did not follow a constant to its
  definition, so it does not show whether that definition is plain values.
- Masud (8 Oct): Bonsai is not typical. He made Bonsai write its values in
  the profile. A typical project imports them. So the count above does not
  set the design. The design assumes that a value is usually a constant from
  another file, and that a value written in the profile is the less common
  case.
- This leaves a need: a sample project written the typical way, to test the
  reading and the writing against. Bonsai alone would make the studio look
  better than it is.
- A second project, read on 8 Oct at Masud's suggestion: `ml_deno` in
  `model-sculpt-studio`. It has 7 profiles in 6 files, no tools, and an old
  package (`@theorum/core@0.1.15`). It is not the typical layout either:

  | Origin | Values | Share |
  |---|---|---|
  | Written in the profile | 209 | 80% |
  | A constant | 28 | 11% |
  | Computed, a spread, or a function | 24 | 9% |

  It adds two things Bonsai did not show:

  - **The instruction is a Markdown file.** Each profile reads `system.md`
    from disk when its file loads. This is a fourth origin: text in a file
    that is not code. The row is editable, and Save writes the Markdown
    file. One profile joins two texts into one instruction.
  - **A profile file reads from disk when it loads.** So "loading does no
    work" is too strict a rule. A project may read its own files.
- A sample project in the typical layout is still needed. Masud agreed
  (8 Oct) that Claude may make one in another repository.
- Masud (8 Oct) on the typical layout: one file for each concern makes
  sense, and guardrails are the clearest case of a thing that profiles
  share. Tools are most probably in their own files. But builders lay a
  project out in many ways.
- So the studio cannot assume a layout. It finds the origin of each value,
  one value at a time. When it cannot, that one row is read-only and opens
  the code. The rest of the profile still works.

### 5.3 More than one turn

History, compaction, memory, a proactive turn with no user message, and live
voice. The loop in section 2 covers "type one message".

### 5.4 Safety

- "A tool that writes asks first" trusts the tool's `access` label. A tool
  marked read-only that sends a message is not stopped.
- Paid calls and model spend. No limit is designed.
- The local page can write files and run project code. A token is not
  enough: it must refuse requests from other sites, and write only files
  that define profiles.
- A tool result on screen can hold a remote image or link. Loading it can
  leak data.
- "Refuses production" is a guess unless the setup file states the
  environment.
- A promise that the studio sends nothing to Theorem or anyone else.

### 5.5 Cost and speed

- Side by side doubles each run. Pinned turns multiply it. Recorded tool
  results and prompt caching reduce spend more than a faster studio does.
- A full type-check of Bonsai on each Save may take a minute.
- Start time and reload time for 41 profiles and 101 tools.

### 5.6 Where the editor lives

The editor is in the website's repository. The package ships the headless
parts (`playground/`) and the React components. A command in the package
cannot open an editor it does not ship.

Checked on 8 Oct:

| Part of the first slice | Where it is today | Size |
|---|---|---|
| The tool console (`TheoremHost`) | The package, `@theoremjs/react` | 595 lines |
| The chat and the trace | The package | Shipped |
| The model of the tree | The package, `@theoremjs/playground` | Shipped |
| The tree on screen, and the rows that show a profile's settings | The website, `profile-editor.tsx` | 6,464 lines |
| The playground page around them | The website | About 4,600 lines |

- The design library is not an obstacle. Astryx is MIT, and the React
  package already needs it.
- The website's editor imports about 35 of the website's own files. Some
  belong to the website only: its limits on free use, the demo mode, the
  docs.
- The package ships source code, not a page. A command that opens a page
  needs two new things: the studio built as a page inside the package, and
  a small local server.

**Built on 8 Oct:**

A first page of its own was built and thrown away the same day. Masud:
"studio uses the exact same playground implementation." What stands:

- The studio is the website's playground at `/studio`, on the site's dev
  server only. Same page, tree, editor and preview. Nothing is copied.
- `studio/serve.ts` starts the local server for one project. It takes the
  project's setup module: the default export registers the tools, profiles
  and providers; an optional `host` export gives the tools their context.
- `studio/handler.ts` hands the page the project as the playground's own
  workspace: one agent per registered profile, and every registered tool in
  the library. No new mapping was written. The playground already prints a
  profile as source and reads that source back as a draft; the server uses
  both. A profile that cannot be read is listed as a problem, not dropped
  silently.
- A run is the project's own code. The page names the profile by id and the
  server runs the registered one. Host profiles run in the tool console;
  text, image and speech profiles run in the chat. Decision and live
  profiles show but do not run yet.
- The server answers this machine only, and refuses a request from any site
  but the dev site.
- `studio/example.ts` is a small project to open while Bonsai is untried.
- Seen in a browser against the example: the tree, the editor and a
  read-only tool run with the project's real output.

Not done:

- Edits on the page are not written to the project. A note above the editor
  says so.
- The chat path is wired but untried: the example has no model profile.
- Bonsai has not been opened.
- A profile the page's own compile refuses shows no preview.
- Two processes: the site's dev server and the studio server.
- The thrown-away page's files (`react/src/studio/`, `studio/vite.config.ts`,
  `studio/package.json`) are still in the tree, unused.

**Renamed on 8 Oct:**

Masud chose one name: studio everywhere. The paths above are the old ones.

- `playground/` is now `studio/`, and the package is `@theoremjs/studio`.
  Every `Playground…` name in the code is `Studio…`.
- The local server is `studio/server/` (`serve.ts`, `handler.ts`,
  `example.ts`). The thrown-away page's Vite files are `studio/app/`.
- The website's page moves from `/playground` to `/studio`. The old address
  stops working; there is no redirect.
- A new tab opened from a project runs the project's code, not the draft's
  stand-in tools.
- The screen is in `studio/ui/`: the editor, inspector, runner and the page
  itself (`studio-screen.tsx`). The website's `/studio` route is a thin
  page that renders `StudioScreen` and passes a `StudioHost`
  (`studio-host.ts`): the kernel version, and th30's surface and report.
  `openStudio` works out what a tab opens on.
- The code view (Monaco, its worker and type checker) is in
  `studio/ui/code/`, and the zip is `studio/ui/lib/zip.ts`. A Vite build
  that shows the screen adds `studioVite` from `@theoremjs/studio/vite`.
- The screen's CSS is `studio/ui/studio.css` and the mark's is
  `studio/ui/theorem-mark.css`; each is imported by the file that uses it.
  Both read Astryx's theme tokens, which the host loads.
- The run page is `StudioRunScreen` in `studio/ui/studio-run.tsx`, with
  its CSS beside it. `openStudioRun` works out what a run tab opens on.
  The website's `/studio/run` route sends a tab with no agent back to the
  studio and renders the screen.
- The studio runs from the package with one command:
  `node studio/start.mjs <setup-module>`. It starts the project's server
  and the page at `http://127.0.0.1:4984/studio/`, and stops both together.
  This closes "Two processes" above.
- The studio is opt-in. Nothing of it installs with the kernel or the React
  package. `npm install --prefix studio` is the one install; the start and
  test commands check for it and print that line when it is missing. The
  old page-only install in `studio/app/` is gone.
- The shell is in the package too, so the studio looks the same on its own
  as on the website: the theme (`studio/ui/studio-theme.ts`, built to
  `studio/ui/built/`; the website's theme extends it), the rail and the
  popup bounds (`studio/ui/studio-shell.tsx`), the rail's links
  (`studio/ui/studio-nav.ts`), Figtree (`studio/ui/figtree.css`) and the
  popover motion (`studio/ui/motion.css`).
- On its own the rail has no th30, and every page but the studio opens on
  the website (`THEOREM_SITE`): the mark, and Docs in a new tab.
- The studio's tests are `studio/tests/`, run by `npm --prefix studio test`
  with the theme check. They are opt-in like the install, so the default
  coverage run does not see the screen and `studio/ui/**` keeps its own
  CRAP ceiling in `.fallowrc.jsonc`.

### 5.7 Fit and finish

- Finding a profile among 41: search, and which profile calls which.
- Pinned turns as the project's existing test and eval files, so they also
  run in CI.
- A place for what the CLI already does: probe a text, fuzz, bench.
- Other setups: Deno, Node, a monorepo, and how the command finds the
  project's profiles.

## 6. Not this doc

"Settings forms for code-only fields" is a separate idea. Checked against
Bonsai on 7 Oct, it closes no gap Bonsai has: Bonsai sets no
`outputs.validation.fields`, its `t1Policy` needs application context, and
`guardrails.disclosure` is for decision profiles. It stays parked.
