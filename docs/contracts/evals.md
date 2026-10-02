# Evals (`@theoremai/agents/evals`)

Evaluations over traces. A host says, for any profile: here are the cases, here
is what "good" means, run each case k times and tell me, from the trace alone,
whether it passed. Graders read the v3 `TraceRecord` and nothing else; results
are trace records too, written through the same `TraceSink` as the turns they
judge. The only model in the loop is the one a host names as a judge, and it
reads the trace too: a judge grader hands a rubric, filled from the record, to
a host profile and takes its answer as the result. The judge is a text model,
Jev (a decision profile), or Jev escalating to a text model, as the host
chooses.

Hosts own the cases, the judge profiles and the pass rule. THEOREM owns the
trial view of a trace, the code graders, the judge grader and its rubrics, the
result records and the verdict math. Viewing, labelling and comparing runs
belong to the trace viewer the host already uses (Phoenix reads the records
through `withOpenInference` and `phoenixAnnotations`).

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremai/agents/evals` / `jsr:@theoremai/agents/evals` |
| Module | `src/evals/mod.ts` |

## Ownership

| Path | Role |
| --- | --- |
| `src/evals/types.ts` | Suite, case, result and grader shapes (zod schemas + `Trial` view) |
| `src/evals/trial.ts` | `buildTrial` (records → one `Trial`), `groupByTrace` |
| `src/evals/graders/shared.ts` | `codeGrader`, `passFail`, delivered text/JSON readers |
| `src/evals/graders/code.ts` | Code graders for any turn: `delivered`, `toolTrajectory`, `stopKind`, `guardrail`, `budget`, `outcome` |
| `src/evals/graders/answer.ts` | `answer`: a dataset case's answer against its accepted, partial and rejected names, by code |
| `src/evals/graders/live.ts` | Live graders: `transcription`, `interruptions` |
| `src/evals/graders/latency.ts` | `turnLatency`: the person's wait before each reply began, for turns and Live |
| `src/evals/graders/media.ts` | The media a judged turn carried, and its bytes from the case or the host's `media` store |
| `src/evals/graders/transcript.ts` | `trialVariables`: the record under Phoenix's variable names, as a rubric reads it |
| `src/evals/graders/judge.ts` | `judge`: the model grader over a text or decision judge profile; `EVAL_JUDGMENT` structured output |
| `src/evals/rubrics/` | `rubric()`, Phoenix's fourteen rubrics (`rubrics.*`, copied into `catalog.ts` by `deno task rubrics:sync`), and the Mustache they are written in |
| `src/evals/verdict.ts` | `trialOutcome`, `caseVerdict`, `passRuleName` |
| `src/evals/record.ts` | `startTrialRecord` (`theorem.eval.trial`), `buildRunRecord` (`theorem.eval.run`) |
| `src/evals/suite.ts` | `loadSuite` (module + cases + host exports), `readJsonl`, `readTraceRecords` |
| `src/evals/attachments.ts` | File attachments pinned by hash at load, read when their trial runs |
| `src/evals/run.ts` | `runSuite`: live or recorded, every case `repeat` times, records written, verdicts returned |
| `src/evals/summary.ts` | `summarizeRun`: a run as the JSON document `eval --json` prints |
| `src/evals/breakdown.ts` | `groupSummaries`: the run overall and by tag, as the table and the summary report it |

Validated by `tests/evals/`. Every attribute and event name the records carry is
in the trace catalog (`src/observability/trace-catalog.ts`), gated by
`tests/observability/trace-catalog.test.ts`.

## Suites and cases

An `EvalSuite` names a profile, a mode (`live` runs the profile now, `recorded`
grades traces a host already has), its cases, the trial policy, the graders
and, when a grader judges, the default judge profile (`judge: { profile }`). `evalSuiteSchema` validates a suite a host loads from
disk; graders are checked structurally (`isGrader`), not serialised.

An `EvalCase` has an `id`, a `kind` (`regression` guards what works;
`capability` probes what should work next), an optional `difficulty` (1–5), an
`input` and an optional `expect`. Input is one turn (`{ text?, attachments? }`)
or a Live session (`{ session: { steps } }`, each step `until: 'turn_complete'`).
An attachment is inline (`{ mimeType, data, name? }`, base64) or a file beside
the cases (`{ mimeType, path, sha256, name? }`): `path` is relative to the cases
file, `sha256` the lowercase hex hash of its bytes. `loadSuite` makes the path
absolute and refuses a file that is missing or hashes otherwise, naming the
case, before anything runs; the runner reads the file when its trial starts and
refuses it again if it changed since, so a trial errors `config`. Thousands of
photos are never held at once.
`expect` holds what graders may read when built without an argument:
`tools` (names in order), `json` (fields the delivered structured output must
match), `transcription` (`includes` / `regex`), `answer` (a dataset question's
right answer: `accepted` names, optional `partial` names, optional `rejected`
names (wrong answers the dataset records for the case: confusers, superseded
identifications), and `reference` notes for the person reading a miss), and
free-text `notes`.

Trials: `{ repeat, pass? }`. `pass` is an `EvalPassRule`:

| Rule | A case passes when |
| --- | --- |
| `'all'` (default) | every one of its `repeat` trials passed (pass^k) |
| `'any'` | at least one trial passed (pass@k) |
| `{ atLeast: n }` | at least `n` trials passed |

An errored trial (a provider error, a judge that failed: anything that left
it ungraded by fault rather than by the agent) is read as a trial that never
ran, so a rate limit never lowers pass^k: two passes and one provider error
pass under `'all'`. A case errors left with too few trials for its rule (none
under `'all'` and `'any'`, fewer than `n` under `{ atLeast: n }`), and that
the trials left do not already pass, is undecided: it neither passes nor
fails, and no pass rate counts it. A case that ran no trials at all, with no
error, fails.

## Trials

`buildTrial({ suite, case?, index, records })` folds one or more records of the
same trace into a `Trial`. The root is the `invoke_agent` span whose parent is
absent or not in the trace, chosen by start time when several qualify, so a
compaction turn recorded before its parent does not become the root. No root, or
no records, is a `TheoremError('config')`.

A `Trial` exposes: `root`, `spans(operation)` in start order across records,
`children(span)` (the spans one span parents, such as a model call's HTTP tries),
`content(value)` / `text(value)` resolving stored content markers against the
merged content of every record, `delivered()` (root `gen_ai.output.messages`,
or a Live turn's `theorem.output.delivered` from its response spans, parts left
as stored markers) and `usage()` (tokens, thinking share and cost from the root).

`groupByTrace(records)` keeps records of one trace together, first seen first.

```ts
const trial = buildTrial({ suite: 'translator.v1', case: cases[0], index: 0, records });
const [message] = trial.delivered();
trial.text(message?.parts?.[0]); // 'La tetera está encendida.'
trial.usage(); // { tokens: { input, output, total, thinking, cost? }, costUsd? }
```

## Graders

Every grader is `{ name, identity, source, needsExpect, grade(trial, context) }`.
`name` is the `gen_ai.evaluation.name` on the result event; `identity` is what
the grader checks, hashed into `theorem.evaluation.grader.version` so a changed
threshold is a new version. `needsExpect` is true when the grader reads the
case's `expect` rather than an argument; a caseless run skips it. A model
grader also has `judgeProfiles(suiteJudge)`, which names every profile it may
judge with (its judge, then any `escalate` profile) and checks that each can
run its rubric. `context` is an
`EvalGradeContext`: the suite's judge profile, the text judge's provider
(`judgeProvider`), the decision judge's key (`judgeDecision`), the host's
media store (`media`), `traced(records)`
for a grader that ran a judge call to hand its records back, and the run's
`signal`. Code graders ignore it; a host's own grader may.

Code graders return `passed` and a `pass` / `fail` score and are deterministic:
grading the same records twice is byte-identical.

A trial's graders run at once, so its judges answer in parallel; the judge
records they hand back are written in grader order once every grader is done,
whichever answered first.

| Grader | Reads | Passes when |
| --- | --- | --- |
| `delivered.includes(text)` / `.regex(pattern)` / `.equals(text)` | delivered text parts | the text matches |
| `delivered.jsonSchema(schema)` | delivered structured part, else parsed text | it validates against the JSON Schema |
| `delivered.json()` | same, against case `expect.json` | every expected field is equal |
| `toolTrajectory({ mode, expect? })` | `execute_tool` spans | `exact`, `in_order`, `any_order`, or `subset` (nothing unexpected was called) |
| `stopKind(kind \| kinds)` | root `theorem.stop.kind` | it is one of the kinds |
| `guardrail({ fired, action? })` | root `theorem.guardrail` events | fired (any action but `allow`) matches, and the action when given |
| `budget({ maxCostUsd, maxTokens, maxSteps, maxDurationMs, maxTimeToFirstChunkMs })` | root usage, span times, chat `time_to_first_chunk` | no ceiling is crossed; a ceiling the trace cannot show fails as "not recorded" |
| `outcome(name, check)` | whatever the host checks | the host's boolean, or the host's full result |
| `turnLatency({ maxMs })` | turn start, HTTP tries, `time_to_first_chunk`, Live `voice_activity` events | every reply began within `maxMs` of the person finishing their input |
| `transcription.includes(text?)` / `.regex(pattern?, flags?)` | output transcription text parts, final only | the transcript matches (argument or case `expect.transcription`) |
| `interruptions({ max })` | Live `generate_content` spans stopped `interrupted` | the count is within `max` |
| `answer({ from? })` | case `expect.answer`, and the answer where `from` says | the answer is an `accepted` name (see Dataset answers) |
| `judge({ rubric, name?, pass?, profile?, variables? })` | the record, through a host judge profile (text or decision) | the judge's label is in `pass` (see Judges) |

Graders whose explanations name a budget list every ceiling crossed, not the
first.

### Dataset answers

`answer` grades a dataset question by code alone: no judge, since the case's
list settles it, and a miss is for a person to read. It labels each trial
`accepted` (passes, score 1), `partial` or `wrong` (fail, score 0). Names are
compared ignoring case, accents, punctuation and spacing, so `DEVIL’S IVY`
is `devil's ivy`, but `devils ivy` is not. `from` says where the answer is:

| `from` | Reads | Matches when |
| --- | --- | --- |
| `{ json: 'a.b' }` | that key of the delivered JSON (dots walk into objects) | the string equals a name, whole |
| `{ tool, arg: 'a.b' }` | that argument of the last call to `tool` | the string equals a name, whole |
| absent | the delivered reply text | a name appears as whole words |

`accepted` is checked before `partial`. A `rejected` name is `wrong`, and the
explanation says the case rejects it; in the reply, a rejected name beside an
accepted one is a hedge, labelled `partial`, and a rejected name outranks a
`partial` one. A name said only inside a longer listed name is not said:
`black-eyed Susan` in `sweet black-eyed Susan` is the longer name. An answer
that is absent (no key, the tool never called, no name in the reply) is `wrong`
and says so; so is a case with no `expect.answer`. A name the case does not list
is `wrong` until it is added to the case. The exception is a turn that stopped
`provider_error` with no answer: the agent never had its say, so the result has
no label and `errorType: 'provider_error'`, the trial errors, and it counts
toward neither accuracy nor pass^k. An answer given before the provider failed
is graded as usual. Other stops (`length`, `stream_incomplete`, …) stay `wrong`.

Latency is two readings, not one. `budget.maxTimeToFirstChunkMs` is the
provider's share: from the successful HTTP try (or the Live response's first
frame) to its first chunk. `turnLatency` is the person's whole wait. For a
turn it runs from the turn's start, through guardrails, history and any
retried try, to the first chunk of the first model call. For a Live session it
runs, per response, from the provider's last `ACTIVITY_END` before the reply
when the session heard speech, else from the response's first input frame. A
reply whose first chunk the trace did not record fails as "not recorded". A
buffered call's body is its one chunk, so buffered and streamed calls read
alike.

## Judges

A judge is a host profile of one of two kinds, and the host picks per grader:

| Judge | Profile | Reads | Answers |
| --- | --- | --- | --- |
| Text | `type: 'text'` with `outputs.structured: EVAL_JUDGMENT` (`evalJudgment`, registered when `graders/judge.ts` is imported) | the rubric's `template`, filled, as its one user message through `runTurn` | `{ label, explanation }` through structured output |
| Decision (Jev) | `type: 'decision'` | the rubric's variables as JSON state, and its `question` as one choice question through `runDecision` | a typed choice with a probability per label, read against the pass line below; the explanation is `Jev: <label> N%, …; passing needs <pass labels> above N%.` |

The suite's `judge: { profile }` is the default; `judge({ profile })` names a
grader's own.

A turn that stopped with `provider_error`, `cancelled`, `stream_incomplete` or
`interrupted`, or delivered nothing, is not judged: no judge is called, and
the result decides nothing (`the turn stopped with provider_error; not
judged`). The code graders say the turn failed; a judge would only grade an
empty reply.

A judge sees the media it judges. The transcript names each distinct piece
of media in the turn's input and the model's output by a label
(`[image 1: image/jpeg]`), and when what a rubric reads contains a label, the
judge's turn attaches that media beside the prompt. A trace keeps a blob's
sha256 and size, never its bytes, so the bytes come from the case's own
attachments (matched by the sha256 of their decoded bytes) or else from the
host's `media` resolver (`({ sha256, mimeType }) => base64 | undefined`;
bytes that do not hash to the trace's sha256 are not used). A `uri` part is
passed on as the reference it was. Media no source has leaves the trial
unjudged (`the judge could not be shown [image 1: image/jpeg]; not
judged`), never judged blind. A text judge whose profile does not accept the
media's type is a `TheoremError('config')`. A decision judge reads JSON
state only, so a trial whose rubric reads media goes straight to its
`escalate` text judge, with the media; without one it is not judged. A
rubric whose readings never name media is judged without it, by either
judge.

A decision judge's verdict comes from its probabilities, not its top choice
(with three labels the top choice can sit at 34%). `wrongPassCost` (default
1) says how many times worse a wrong pass is than a wrong fail, and sets the
line `wrongPassCost / (1 + wrongPassCost)`:

| Jev's probabilities | Label | Passes |
| --- | --- | --- |
| the pass labels together above the line (50% at 1, 75% at 3) | the likeliest pass label | yes |
| otherwise, the other declared labels together above 50% | the likeliest of those | no |
| otherwise | `unknown` (explanation `Jev was unsure: …`) | no |

A rubric without `pass` keeps Jev's top choice and decides nothing.
`judge({ escalate: <text profile> })` hands every `unknown` to that text
judge: its label and explanation become the result (after Jev's odds), and
the result links both judge traces; a sure Jev settles the trial alone
(`tests/evals/judge/both.ts`). `wrongPassCost` and `escalate` are refused on a
text judge, `wrongPassCost` on a rubric without `pass`, and `escalate` naming
anything but a text profile. Both are part of the grader's version. A host
that wants two independent votes instead adds two `judge` graders over one
rubric, each naming its profile. A text judge runs with
`judgeProvider` (option, then the suite's `export const judgeProvider`), else
the agent's own provider; a decision judge runs with `judgeDecision`
(`{ vault }`, read through the slot the judge profile names; option, then the suite's
`export const judgeDecision`). `runSuite` refuses, before any trial, a model
grader with no judge profile, a profile that cannot run its rubric (a text
profile of another output, a text profile over a rubric without a prompt, a
decision profile over a rubric without a question), a text judge (its own
or one it escalates to) with no provider, or a decision judge with no key.

Every judge call is stamped `metadata.eval = { suite, case, trial, judge:
{ grader } }`, runs under the trial span (`EvalGradeContext.traceparent`), so
it lands in the judged trace beneath the trial it graded (an `invoke_agent`
turn or a `decide` decision), and goes to the run's sink under the judge
profile's observability policy. The result names each judge call's root in
`judgeTraceparents`.

The variables are Phoenix's names, so its prompts read the trace unchanged:

| Variable | Read from the trial |
| --- | --- |
| `input`, `user_message` | the last user message of the root's `gen_ai.input.messages` |
| `output`, `text` | the delivered text, else the delivered structured JSON |
| `output.messages` | every model message (`role`, `content`, `tool_calls` as JSON) and tool result (`role: 'tool'`), in the order they happened; for a prompt that reads it |
| `output.available_tools` | each tool in `gen_ai.tool.definitions` of the last model call, as JSON; empty when none was offered |
| `context` | the media the turn's input carried (`[attached]` and its label), then every `execute_tool` call with its arguments and result, in order, as `conversation` writes them |
| `tool_call` | every tool called: `name(arguments) → outcome`, one a line |
| `tool_result` | every tool result: `name: result`, in order |
| `conversation` | the whole record as a transcript, step by step; for a prompt that also reads `user_message`, only what came before that message |

A prompt that reads `output.messages` or `output.available_tools` gets
`output` as those lists; one that reads `{{output}}` gets the text. A decision
judge reads the same view as its JSON state. `document_text` is not in the
trace (nothing marks which retrieval was the document), so
`rubrics.documentRelevance` needs the host's reading. `variables(trial)` adds
or overrides readings for a rubric that needs more, and a host reading wins
over the trace's; a variable nothing fills is a config error when the grader
is built.

An `EvalRubric` is `{ name, description, variables, labels, pass?, template?,
question? }`: `labels` maps each label to its score and `pass` is the labels
that pass (absent: the result informs and never decides). `template` is the
Mustache prompt a text judge fills; `question` (`{ instructions, criteria }`, one
criterion per label) is what a decision judge answers. A rubric carries either
or both, and only a judge whose kind it carries can run it. `rubric({ name,
labels, pass?, variables?, template?, question? })` builds a host's own: a
prompt's variables are the names it reads outside any section (`output` for
`{{#output.messages}}`), a question-only rubric names its `variables`, and the
question's criteria must be exactly the labels. `fillRubric` renders a prompt
over a view.

The Mustache (`rubrics/mustache.ts`) is variables, dotted names, `{{.}}`,
triple braces, sections over lists and values, inverted sections and comments;
a tag alone on its line takes the line with it. Nothing is HTML-escaped: the
output is a prompt. Partials, delimiter changes and unbalanced sections are
config errors.

`rubrics.*` is every classification evaluator Phoenix serves, fourteen from
Phoenix 20.16.0: `completeness`, `conciseness`, `correctness`,
`documentRelevance`, `faithfulness`, `hallucination`, `piiDetection`,
`refusal`, `retrievalRelevance`, `toolInvocation`, `toolResponseHandling`,
`toolSelection`, `toxicity`, `userFriction`. Each keeps Phoenix's name (the
result's, e.g. `tool_selection`), labels, scores and prompt, copied verbatim
into `rubrics/catalog.ts` (Arize AI, Apache-2.0). `deno task rubrics:sync`
copies them again from the running Phoenix (`deno task phoenix:up`), and
refuses a prompt the judge cannot use: more than one message, a part that is
not text, Mustache it does not render, no single `<data>` block. Run it when
the Phoenix image in `scripts/phoenix/compose.yaml` changes.

What passes follows Phoenix's direction: the top-scoring labels when higher is
better, the bottom-scoring when lower is (`toxicity` passes `non-toxic`,
`hallucination` `grounded`), none when Phoenix names no direction (`refusal`
informs). The question for a decision judge is the same prompt, its `<data>`
block replaced by a line naming the state's keys as data, not instructions,
with one criterion per label pointing back to it.

Reading the result:

- `score` is the rubric's value for the label (`{ value: 1, label: 'correct' }`).
  `passed` is `label ∈ pass`; a rubric without `pass` leaves it undefined.
- Every judge may answer `unknown`: a text judge through its schema, Jev
  through an added criterion (`The record does not show enough to decide.`).
  `unknown` has no score and passes only if `pass` names it.
- A label the rubric does not declare is `bad_response`, as is a text reply
  that is not a judgment or a decision answer that is not a choice. A text
  judge reads labels case-insensitively. A judge call that fails gives its
  error kind (`rate_limit`, `unavailable`, …) and still links its trace.
- Injection in the judged record is handled twice for a text judge: the
  stored record is scrubbed by default (`scrub.injection`), and the judge
  turn's input guardrail redacts anything left (`theorem.guardrail` on the
  judge root, `action: redact`). A decision judge reads the state as data to
  classify, not instructions, and its answer can only be one of the labels.
- Judge calls cost: `TrialReport.judgeCostUsd` carries a trial's judge
  spend, and `run.costUsd` and `maxCostUsd` count agent and judge together.
  Jev reports tokens, not dollars; `runDecision` prices them at Jev's fixed
  price ($0.042 per million input tokens, output free), so a Jev judge counts
  like any other.

## Result records

`trialOutcome(results)` is `passed` when every deciding result (`passed` set)
passed, `failed` when one failed, `errored` when one carries `errorType`, and
`ungraded` when nothing decided. `caseVerdict(case, trials, rule)` applies the
pass rule to the trial outcomes, errored trials left out, and keeps every
count. A case with no deciding trial never passes.

| Verdict field | Meaning |
| --- | --- |
| `passed` | the pass rule held over the trials that did not error |
| `decided` | false when errors left too few trials to apply the rule, and those left do not pass; such a case counts toward no pass rate |
| `trials` | trials run for the case |
| `trialsPassed` | trials whose every deciding result passed |
| `trialsErrored` | trials where a grader failed to grade |
| `trialsUngraded` | trials with no deciding result |

`startTrialRecord({ trial, policy, clock? })` opens one span,
`theorem.eval.trial`, in the judged trace as a child of its root, with
`theorem.evaluation.{suite, case, trial}`, and returns its `traceparent` for
the judge calls to run under. `finish(results)` closes it, so it lasts as long
as the grading, with one `gen_ai.evaluation.result` event per result
(`gen_ai.evaluation.{name, score.value, score.label, explanation}`,
`gen_ai.response.id` of the judged model call, `error.type`,
`theorem.evaluation.{source, grader.version, passed}`), and builds the record.
Status is `ERROR` when any result errored, its message the first errored
result's `errorType` (`grader_error`, `provider_error`, …). The record inherits the judged record's metadata, so the same sink
routes it the same way. Phoenix shows the events but does not read them as
evaluations; `phoenixAnnotations` (`@theoremai/agents/observability/phoenix`)
turns them into span annotations on the judged root (see the observability
contract).

`buildRunRecord({ suite, verdicts, trialSpans, policy, clock?, caseless?,
stopped?, revision? })` writes one root span, `theorem.eval.run`, with
`theorem.evaluation.suite`, `theorem.eval.{repeat, pass_rule, pass_at_least,
caseless, stopped}` and `vcs.ref.head.revision`, one `theorem.eval.verdict`
event per case, and a link per trial span (`theorem.link.kind: trial`). A run
stopped on budget is `UNSET`, never `OK`. Failed verdicts never make the run
`ERROR`; a failing suite is a finding, not a fault.

## Running a suite

`loadSuite(path)` imports the suite module, validates its `default` export
with `evalSuiteSchema`, reads `cases` relative to the module (a bad line is
named `file:line`; a repeated case id is a `TheoremError('config')`) and picks
up `export const provider`, `judgeProvider`, `judgeDecision` and `media` when the module
has them.
`readTraceRecords(path)` reads one JSONL file or every `.jsonl` file of a
directory, in name order, through `traceRecordSchema`.

`runSuite(loaded, options)` runs every case `repeat` times and grades each
trial from its trace. Live mode (`provider`) runs `runTurn` with the case's
input, stamped `metadata.eval = { suite, case, trial }` so the record finds its
case again later; recorded mode (`recorded`) groups records by trace and
matches each to a case by that stamp. Both build the same `Trial`, so the same
records grade to byte-identical results either way.

| Option | Effect |
| --- | --- |
| `provider` | Live mode: the host's provider for the profile under test |
| `judgeProvider` | The provider text judges run with; absent, the suite's `judgeProvider` export, else `provider` |
| `judgeDecision` | The key decision judges (Jev) run with: `{ vault }`, read through the slot the judge profile names, plus `fetch` / `endpoint` for tests; absent, the suite's `judgeDecision` export |
| `media` | Where judges find media a trace names only by hash (see Judges); absent, the suite's `media` export, else only the case's attachments |
| `recorded` | Recorded mode: the records to grade; a trace with no stamp for this suite is graded caseless (no verdict); judge calls (inside the judged trace, or in traces of their own) and eval run records among them are skipped with a warning, so a whole trace directory can be graded again |
| `sink` | Where the judged turns' own records (live mode), the judge turns' records, `theorem.eval.trial` and `theorem.eval.run` go; absent, they are returned only |
| `repeat` | Overrides `suite.trials.repeat`; `1` adds a warning, since one trial cannot tell noise from change |
| `maxCostUsd` | Live mode starts no further trial once the summed `theorem.usage.cost_usd` of agent turns and judge calls passes it; the run is `stopped: 'budget'` and never passes. A call whose provider reports no cost (Google) adds nothing, so the run warns when any ran |
| `revision` | `vcs.ref.head.revision` on the run record |
| `concurrency` | Live mode: trials in flight at once (default 1). Trials still start in suite order and are reported in it; the cost check runs before each start, so a stop lets in-flight trials finish and count |
| `onTrial` | Called after each live trial, for progress |
| `signal` | Aborts the turn in flight |

A turn that fails still leaves a trace, and the trace is graded (its
`stop_kind` and the rest fail in the grader's words). An error before any
trace exists (a session case in a turn suite, a profile that cannot run) gives
every applicable result `errorType` = its error kind and the trial `errored`.
A grader that throws is one `grader_error` result, not a failed run. Session
suites (`mode: 'session'`) are refused with a config error until Live scripted
runs land.

```ts
import { jsonlSink } from '@theoremjs/agents/observability/jsonl';

const loaded = await loadSuite('./evals/translator/suite.ts');
const run = await runSuite(loaded, { provider, sink: jsonlSink(`${Deno.env.get('HOME')}/.theorem/traces/evals`) });
run.passed; // some case was decided, every decided case passed, and nothing stopped the run
run.verdicts; // one CaseVerdict per case, in suite order
run.trials[0]?.results; // the graders' words for the first trial
```

The example suite is `tests/evals/translator/` (profile, cases, suite) and
`scripts/evals-example.ts` runs it against a real provider
(`deno task evals:example`). `tests/evals/judge/` adds a Gemini text judge
profile, a Jev decision judge profile, and three judged copies of the suite:
`suite.ts` (text), `jev.ts` (Jev) and `both.ts` (Jev escalating to text);
`deno task evals:example --judge text|jev|both` runs one, with a second Gemini
provider for the text judge and `TYPESAFE_API_KEY` for Jev, which the script
puts in vault slot `jev`, the slot the Jev judge profile names. The example
writes records under `~/.theorem/traces/evals` unless `--trace-dir` names
another directory (a trace directory sits outside the checkout).

To read a run in Phoenix, `deno task phoenix:up` starts Phoenix
(`http://localhost:6006`) and the Collector in front of it
(`scripts/phoenix/`, images pinned), and gives Phoenix Jev's price: Phoenix
prices spans from its own model table, not from the `llm.cost.total` a span
carries, and its table has no Jev. `--phoenix` on the example sends the
records that run wrote: through the Collector as OTLP with OpenInference
attributes, then every result as a span annotation, posted again while Phoenix
has yet to store the spans (it answers 404 until then). A failed send names
both endpoints and exits 1; so does a trace directory it cannot read. `deno task phoenix:down` stops both; Phoenix keeps
nothing between runs.

`summarizeRun(run)` is the run as one JSON document, what `agents eval --json`
prints for CI: verdicts and results keep their shapes, trials drop their
records and keep their `turn`.

Each trial that produced a trace reports its `turn`: `durationMs` (the root
span, from the input handed over to the last word), `modelCalls`,
`toolCalls` and `stop` (the root's `theorem.stop.kind`). `groupSummaries(run)` reports every cased trial (`all`), then each
tag's trials in name order; the summary carries them as `groups` and the table
prints them under the cases. A group gives its cases and how many met the
suite's pass rule (`run.passRule`; under the default `all` this is pass^k)
out of the decided ones (`casesUndecided` apart), its trials and how many
passed out of those that did not error (`trialsErrored` apart), the `answer` labels over its trials when the
suite grades answers (`none` counts trials with no label: the turn errored,
or stopped `provider_error` before it answered), how its traced trials stopped (`stops`, counted by stop kind, so a
run of provider errors is not read as a run of wrong answers), and the median
and 90th percentile of turn time, model calls and tool calls. Percentiles are nearest-rank, so each is a value some trial had.
Caseless trials belong to no group.

`run.costUsd` sums only the costs providers reported; `run.unpriced` counts
the agent turns and judge calls whose cost went unreported, in whole or part,
and `run.priced` those that reported one, `$0` included (the summary carries
both).
THEOREM keeps no price table for models whose providers report none, so a
Gemini run's cost is unknown, not zero: the table output says `cost not
reported (N calls)` when no call reported a cost, or `cost $X, plus N calls
whose cost went unreported` when some did (a free model's reported `$0` is
`$0.0000`), and never prints a zero standing in for them.

## Exported API

| Export | Kind |
| --- | --- |
| `EvalSuite`, `EvalTrials`, `EvalPassRule` | type |
| `EvalCase`, `EvalCaseKind`, `EvalDifficulty`, `EvalExpect` | type |
| `EvalCaseInput`, `EvalTurnInput`, `EvalAttachment`, `EvalInlineAttachment`, `EvalFileAttachment`, `EvalAnswer`, `EvalSessionInput`, `EvalSessionStep` | type |
| `EvalResult`, `EvalResultSource`, `EvalGrader` | type |
| `Trial`, `TrialMessage`, `TrialUsage`, `TraceOperation` | type |
| `evalSuiteSchema`, `evalCaseSchema`, `evalResultSchema` | const |
| `buildTrial`, `groupByTrace` | function |
| `delivered`, `toolTrajectory`, `stopKind`, `guardrail`, `budget`, `outcome` | function |
| `DeliveredGraders`, `TrajectoryMode`, `BudgetOptions` | type |
| `answer` | function |
| `AnswerSource`, `AnswerLabel` | type |
| `transcription`, `interruptions`, `turnLatency` | function |
| `TranscriptionGraders` | type |
| `judge`, `trialVariables`, `rubric`, `fillRubric` | function |
| `EVAL_JUDGMENT`, `TRIAL_VARIABLES`, `rubrics` | const |
| `JudgeOptions`, `Judgment`, `EvalGradeContext`, `EvalMediaRef`, `EvalMediaResolver`, `EvalRubric`, `EvalRubricQuestion` | type |
| `trialOutcome`, `caseVerdict`, `passRuleName` | function |
| `TrialOutcome`, `CaseVerdict` | type |
| `startTrialRecord`, `buildRunRecord` | function |
| `GradedResult`, `OpenTrialRecord`, `TrialRecordInput`, `RunRecordInput` | type |
| `loadSuite`, `readJsonl`, `readTraceRecords`, `runSuite` | function |
| `LoadedSuite`, `RunSuiteOptions`, `SuiteRun`, `TrialReport`, `TurnShape` | type |
| `summarizeRun`, `groupSummaries` | function |
| `RunSummary`, `TrialSummary`, `GroupSummary`, `Spread` | type |

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/evals/mod.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/evals/mod.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Suites and cases": {
      "supports": [
        { "kind": "source", "path": "src/evals/types.ts" },
        { "kind": "source", "path": "src/evals/attachments.ts" },
        { "kind": "contract_test", "path": "tests/evals/verdict.test.ts" },
        { "kind": "contract_test", "path": "tests/evals/dataset.test.ts" }
      ]
    },
    "Trials": {
      "supports": [
        { "kind": "source", "path": "src/evals/trial.ts" },
        { "kind": "contract_test", "path": "tests/evals/trial.test.ts" }
      ]
    },
    "Graders": {
      "supports": [
        { "kind": "source", "path": "src/evals/graders/code.ts" },
        { "kind": "source", "path": "src/evals/graders/live.ts" },
        { "kind": "source", "path": "src/evals/graders/latency.ts" },
        { "kind": "source", "path": "src/evals/graders/answer.ts" },
        { "kind": "contract_test", "path": "tests/evals/graders.test.ts" },
        { "kind": "contract_test", "path": "tests/evals/dataset.test.ts" }
      ]
    },
    "Judges": {
      "supports": [
        { "kind": "source", "path": "src/evals/graders/judge.ts" },
        { "kind": "source", "path": "src/evals/graders/media.ts" },
        { "kind": "source", "path": "src/evals/graders/transcript.ts" },
        { "kind": "source", "path": "src/evals/rubrics/mod.ts" },
        { "kind": "source", "path": "src/evals/rubrics/types.ts" },
        { "kind": "source", "path": "src/evals/rubrics/mustache.ts" },
        { "kind": "source", "path": "src/evals/rubrics/catalog.ts" },
        { "kind": "contract_test", "path": "tests/evals/judge.test.ts" },
        { "kind": "contract_test", "path": "tests/evals/mustache.test.ts" }
      ]
    },
    "Result records": {
      "supports": [
        { "kind": "source", "path": "src/evals/record.ts" },
        { "kind": "source", "path": "src/evals/verdict.ts" },
        { "kind": "contract_test", "path": "tests/evals/record.test.ts" }
      ]
    },
    "Running a suite": {
      "supports": [
        { "kind": "source", "path": "src/evals/run.ts" },
        { "kind": "source", "path": "src/evals/suite.ts" },
        { "kind": "source", "path": "src/evals/summary.ts" },
        { "kind": "source", "path": "src/evals/breakdown.ts" },
        { "kind": "contract_test", "path": "tests/evals/run.test.ts" },
        { "kind": "contract_test", "path": "tests/evals/dataset.test.ts" },
        { "kind": "contract_test", "path": "tests/cli/eval.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/evals/mod.ts" },
        { "kind": "contract_test", "path": "tests/evals/record.test.ts" },
        { "kind": "contract_test", "path": "tests/evals/run.test.ts" }
      ]
    }
  }
}
```
