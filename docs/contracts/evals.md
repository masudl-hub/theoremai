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
through `withOpenInference` and `phoenixAnnotations`). Design and locked
decisions: `docs/proposals/evals.md`.

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
| `src/evals/graders/live.ts` | Live graders: `transcription`, `interruptions` |
| `src/evals/graders/latency.ts` | `turnLatency`: the person's wait before each reply began, for turns and Live |
| `src/evals/graders/transcript.ts` | `trialVariables`: the record as the text a rubric is filled from |
| `src/evals/graders/judge.ts` | `judge`: the model grader over a text or decision judge profile; `EVAL_JUDGMENT` structured output |
| `src/evals/rubrics/` | `rubric()` and three shipped rubrics (`rubrics.*`), each with a prompt and a question |
| `src/evals/verdict.ts` | `trialOutcome`, `caseVerdict`, `passRuleName` |
| `src/evals/record.ts` | `startTrialRecord` (`theorem.eval.trial`), `buildRunRecord` (`theorem.eval.run`) |
| `src/evals/suite.ts` | `loadSuite` (module + cases + host exports), `readJsonl`, `readTraceRecords` |
| `src/evals/run.ts` | `runSuite`: live or recorded, every case `repeat` times, records written, verdicts returned |
| `src/evals/summary.ts` | `summarizeRun`: a run as the JSON document `eval --json` prints |

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
`expect` holds what graders may read when built without an argument:
`tools` (names in order), `json` (fields the delivered structured output must
match), `transcription` (`includes` / `regex`), and free-text `notes`.

Trials: `{ repeat, pass? }`. `pass` is an `EvalPassRule`:

| Rule | A case passes when |
| --- | --- |
| `'all'` (default) | every one of its `repeat` trials passed (pass^k) |
| `'any'` | at least one trial passed (pass@k) |
| `{ atLeast: n }` | at least `n` trials passed |

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
grader also has `judgeProfile(suiteJudge)`, which names the profile it judges
with and checks that the profile can run its rubric. `context` is an
`EvalGradeContext`: the suite's judge profile, the text judge's provider
(`judgeProvider`), the decision judge's key (`judgeDecision`), `traced(records)`
for a grader that ran a judge call to hand its records back, and the run's
`signal`. Code graders ignore it; a host's own grader may.

Code graders return `passed` and a `pass` / `fail` score and are deterministic:
grading the same records twice is byte-identical.

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
| `judge({ rubric, name?, pass?, profile?, variables? })` | the record, through a host judge profile (text or decision) | the judge's label is in `pass` (see Judges) |

Graders whose explanations name a budget list every ceiling crossed, not the
first.

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
(`{ apiKey }` or `{ keyVault }`; option, then the suite's
`export const judgeDecision`). `runSuite` refuses, before any trial, a model
grader with no judge profile, a profile that cannot run its rubric (a text
profile of another output, a text profile over a rubric without a prompt, a
decision profile over a rubric without a question), a text judge with no
provider, or a decision judge with no key.

Every judge call is stamped `metadata.eval = { suite, case, trial, judge:
{ grader } }`, runs under the trial span (`EvalGradeContext.traceparent`), so
it lands in the judged trace beneath the trial it graded (an `invoke_agent`
turn or a `decide` decision), and goes to the run's sink under the judge
profile's observability policy. The result names each judge call's root in
`judgeTraceparents`.

| Variable | Read from the trial |
| --- | --- |
| `input` | the last user message of the root's `gen_ai.input.messages` |
| `output` | the delivered text, else the delivered structured JSON |
| `context` | every `execute_tool` result, in order |
| `toolSelection` | every tool called: `name(arguments) → outcome` |
| `availableTools` | `gen_ai.tool.definitions` of the last model call, else `none` |
| `conversation` | the whole record as a transcript, step by step |

`variables(trial)` adds or overrides readings for a rubric that needs more; a
variable nothing fills is a config error when the grader is built.

An `EvalRubric` is `{ name, description, variables, labels, pass?, template?,
question? }`: `labels` maps each label to its score and `pass` is the labels
that pass (absent: the result informs and never decides). `template` is the
prompt a text judge fills; `question` (`{ instructions, criteria }`, one
criterion per label) is what a decision judge answers. A rubric carries either
or both, and only a judge whose kind it carries can run it. `rubric({ name,
labels, pass?, variables?, template?, question? })` builds a host's own: a
prompt's `{{variables}}` are read from it, a question-only rubric names its
`variables`, and the question's criteria must be exactly the labels.
`fillRubric` renders a prompt.

`rubrics.*` ships three, each with both: `correctness`, `faithfulness` and
`toolSelection`. Their prompts are the `@arizeai/phoenix-evals` 2.5.0
classifiers (Arize AI, Apache-2.0; prompt text unchanged, attribution in each
file); their questions are THEOREM's, written to the same labels.

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
pass rule to the trial outcomes and keeps every count. A case with no deciding
trial never passes.

| Verdict field | Meaning |
| --- | --- |
| `passed` | the pass rule held over the deciding trials |
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
Status is `ERROR` / `grader_error` when any result
errored. The record inherits the judged record's metadata, so the same sink
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
up `export const provider`, `judgeProvider` and `judgeDecision` when the module
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
| `judgeDecision` | The key decision judges (Jev) run with: `{ apiKey }` or `{ keyVault }`, plus `fetch` / `endpoint` for tests; absent, the suite's `judgeDecision` export |
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
const loaded = await loadSuite('./evals/translator/suite.ts');
const run = await runSuite(loaded, { provider, sink: jsonlSink(`${Deno.env.get('HOME')}/.theorem/traces/evals`) });
run.passed; // every case met its pass rule and nothing stopped the run
run.verdicts; // one CaseVerdict per case, in suite order
run.trials[0]?.results; // the graders' words for the first trial
```

The example suite is `tests/evals/translator/` (profile, cases, suite) and
`scripts/evals-example.ts` runs it against a real provider
(`deno task evals:example`). `tests/evals/judge/` adds a Gemini text judge
profile, a Jev decision judge profile, and three judged copies of the suite:
`suite.ts` (text), `jev.ts` (Jev) and `both.ts` (Jev escalating to text);
`deno task evals:example --judge text|jev|both` runs one, with a second Gemini
provider for the text judge and `TYPESAFE_API_KEY` for Jev. The example
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
records.

`run.costUsd` sums only the costs providers reported; `run.unpriced` counts
the agent turns and judge calls whose cost went unreported, in whole or part.
THEOREM keeps no price table for models whose providers report none, so a
Gemini run's cost is unknown, not zero: the table output says `cost not
reported (N calls)`, or `cost $X, plus N calls whose cost went unreported`,
and never prints a zero standing in for them.

## Exported API

| Export | Kind |
| --- | --- |
| `EvalSuite`, `EvalTrials`, `EvalPassRule` | type |
| `EvalCase`, `EvalCaseKind`, `EvalDifficulty`, `EvalExpect` | type |
| `EvalCaseInput`, `EvalTurnInput`, `EvalAttachment`, `EvalSessionInput`, `EvalSessionStep` | type |
| `EvalResult`, `EvalResultSource`, `EvalGrader` | type |
| `Trial`, `TrialMessage`, `TrialUsage`, `TraceOperation` | type |
| `evalSuiteSchema`, `evalCaseSchema`, `evalResultSchema` | const |
| `buildTrial`, `groupByTrace` | function |
| `delivered`, `toolTrajectory`, `stopKind`, `guardrail`, `budget`, `outcome` | function |
| `DeliveredGraders`, `TrajectoryMode`, `BudgetOptions` | type |
| `transcription`, `interruptions`, `turnLatency` | function |
| `TranscriptionGraders` | type |
| `judge`, `trialVariables`, `rubric`, `fillRubric` | function |
| `EVAL_JUDGMENT`, `TRIAL_VARIABLES`, `rubrics` | const |
| `JudgeOptions`, `Judgment`, `EvalGradeContext`, `EvalRubric`, `EvalRubricQuestion` | type |
| `trialOutcome`, `caseVerdict`, `passRuleName` | function |
| `TrialOutcome`, `CaseVerdict` | type |
| `startTrialRecord`, `buildRunRecord` | function |
| `GradedResult`, `OpenTrialRecord`, `TrialRecordInput`, `RunRecordInput` | type |
| `loadSuite`, `readJsonl`, `readTraceRecords`, `runSuite` | function |
| `LoadedSuite`, `RunSuiteOptions`, `SuiteRun`, `TrialReport` | type |
| `summarizeRun` | function |
| `RunSummary`, `TrialSummary` | type |

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
        { "kind": "contract_test", "path": "tests/evals/verdict.test.ts" }
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
        { "kind": "contract_test", "path": "tests/evals/graders.test.ts" }
      ]
    },
    "Judges": {
      "supports": [
        { "kind": "source", "path": "src/evals/graders/judge.ts" },
        { "kind": "source", "path": "src/evals/graders/transcript.ts" },
        { "kind": "source", "path": "src/evals/rubrics/mod.ts" },
        { "kind": "source", "path": "src/evals/rubrics/types.ts" },
        { "kind": "contract_test", "path": "tests/evals/judge.test.ts" }
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
        { "kind": "contract_test", "path": "tests/evals/run.test.ts" },
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
