# Evals over traces — proposed specification

**Status:** decisions D1–D12 locked 25/09/2026 (see "Decisions locked in review"); amended 26/09/2026 (see "Amendment"): calibration, comparison, consensus, blame and human results are cut in favour of the trace viewer, and the judge is a text profile, Jev, or both, as the host chooses. Implemented on `feat/otel-turn-traces`.
**Depends on:** [otel-turn-traces.md](./otel-turn-traces.md) steps 1–5 (done). This is the "next spec" that proposal named.
**Version:** ships within `@theoremai/agents` 2.x as a new entry `@theoremai/agents/evals`. No existing export changes shape.

## Goal

A host should be able to say, for any Theorem profile: *here are the cases, here is what "good" means, run it k times and tell me — from the trace alone — whether it passed.* Whether the judge agrees with a human is read in the trace viewer the host already uses (Amendment, 26/09).

Theorem stays unopinionated:
- The eval layer reads the v3 `TraceRecord` and nothing else. If a grader needs a fact the trace does not hold, the trace is wrong, not the grader.
- Hosts own the cases, the judge (a text model, Jev, or both) and the pass rule. Theorem owns the runner, the code graders, the judge grader and the result record. Labelling, agreement and run comparison belong to the viewer.
- Results are trace records too, written through the same `TraceSink`, so every question about an eval is answerable the same way as every question about a turn.

## Vocabulary

Anthropic's terms, used verbatim so hosts can read their guide and ours interchangeably (see [S1]):

| Term | Meaning here |
|---|---|
| **suite** | A named set of cases against one profile, with graders and a pass rule. |
| **case** | One input with success criteria (Anthropic also says *task*). |
| **trial** | One run of one case. Models vary, so a suite declares how many. |
| **transcript** | The v3 trace tree of that trial: root `invoke_agent` plus its `chat`, `execute_tool`, `generate_content` and child-agent records. We never build a second transcript. |
| **outcome** | The end state the case cares about (a booking exists, a JSON field is right), as opposed to what the agent *said*. |
| **grader** | Code or model logic that reads a transcript and returns a **result**. |
| **result** | `{name, score.value?, score.label?, explanation?}` — the semconv `gen_ai.evaluation.result` event ([S2]). |
| **verdict** | The suite's pass/fail for one case after k trials, by its declared pass rule. |

Footnotes for terms used below: **pass@k**¹, **pass^k**², **phi / MCC**³, **Cohen's kappa**⁴, **Kendall's τ_b**⁵, **cluster bootstrap**⁶, **noise floor**⁷, **LALM**⁸.

## What the research found (25/09/2026)

| # | Finding | Consequence for this spec |
|---|---|---|
| R1 | OTel GenAI semconv defines one eval primitive, `gen_ai.evaluation.result`, with `gen_ai.evaluation.{name, score.value, score.label, explanation}`, `gen_ai.response.id` and `error.type`. It "SHOULD be parented to the GenAI operation span being evaluated". It is present at our pinned commit `8ffdf56` and unchanged on `main`; the whole GenAI namespace is still *Development*. ([S2]) | We emit exactly that event, parented to the judged span (below), and add `theorem.evaluation.*` only for what semconv lacks (source, grader version, suite/case/trial ids). |
| R2 | The field converged on "grade the transcript, not a re-execution": vitest-evals' harness contract returns `{output, session.events, traces?, usage}` and judges read those; agentevals scores OTLP traces directly and needs no re-run; Anthropic: "the complete record of a trial" is the transcript. ([S1], [S3], [S4]) | Our transcript is the `TraceRecord`. Graders take a `Trial` built from records, never from the live event stream, so live and recorded runs grade identically. |
| R3 | Anthropic: grade outcome and product, not path — "we've found [step-checking] too rigid". Tool-trajectory graders exist (agentevals `EXACT / IN_ORDER / ANY_ORDER`, phoenix `createToolSelectionEvaluator`) but are one grader among several. ([S1], [S4], [S5]) | Trajectory is a code grader with those three modes plus `subset`; the default suite template puts an outcome grader first. |
| R4 | Consistency is reported as pass^k, not pass@1. τ-bench, Anthropic model cards and EVA all report pass^k with k=3 as the floor. A per-trial 75% becomes 42% at k=3. ([S1], [S6]) | Suites declare `trials.repeat` and a pass rule; the default rule is **all** (pass^k). Every trial is reported; nothing is summarized away. |
| R5 | Noise floor: same config re-run at temperature 0 flips 0.7–2.7% of BFCL items; semantics-preserving prompt perturbations flip 11–58× more. ([S7]) A suite with `repeat: 1` gets a printed warning that it cannot distinguish noise from change. Paired comparison of runs is the viewer's (Amendment; `agents eval compare` was built and cut). |
| R6 | Judge agreement: on binary data Pearson, Spearman, τ_b, phi and MCC are the same number; kappa is always ≤ phi unless base rates match ("kappa paradox"). The protocol for abstentions moves reported accuracy by up to 34.8 points on identical verdicts. Report N, the 2×2 table, both MET rates, cluster-bootstrap CIs, and declare abstention handling *before* looking. ([S8]) Judges always have an `unknown` label (Anthropic: "give the LLM a way out"). The checklist itself is read in the viewer against the annotations (Amendment; `agents eval calibrate` was built and cut). Thresholds are the suite's; Theorem ships none. |
| R7 | Voice: task-only metrics miss the experience axis. EVA scores accuracy (task completion, faithfulness, speech fidelity by a LALM on the audio) and experience (conciseness, progression, turn-taking) and finds a consistent trade-off between them; τ-Voice shows voice agents at 31–51% clean vs 26–38% with noise; Hamming: 42% of voice defects are invisible transcript-only. Every one of these frameworks is a bot-to-bot simulator built on Pipecat (Python). ([S9], [S10], [S11]) | First slice: **scripted** Live sessions (fixed audio turns) graded on transcription, tool use, turn latency and interruption from the trace. Simulated caller and LALM speech-fidelity are V2, listed, not implied. |
| R8 | Every current CLI names it `eval`: `inspect eval`, `promptfoo eval`, `claude plugin eval` (which also runs a no-plugin baseline and exposes `--threshold`, `--max-cost-usd`). ([S12], [S13]) | New command `agents eval`. `agents test` stays what it is: a smoke test that the profile runs. |
| R9 | `@arizeai/phoenix-evals` (TS) needs an AI SDK v7 `LanguageModel` and Node ≥ 22.12; its value is fifteen rubric templates plus a classifier parser. Phoenix ingests protobuf only (P5) and is adding "online" trace evaluators that fire after a trace goes quiet. ([S5], [S14]) | **Changes the 22/09 "borrow judges" decision** (below): the judge runs as a Theorem profile; phoenix-evals' rubrics are ported (Apache-2.0, attributed), not imported. |
| R10 | Inspect's `.eval` log keeps per-sample messages, events, store and scores in one file and reads samples lazily; every_eval_ever wants explicit zero counts and score reasons preserved. ([S15]) | Our run record keeps every trial's result with its explanation; counts are never dropped when zero. |

## Shape

### Suite (host-owned TypeScript module)

```ts
import type { EvalSuite } from '@theoremai/agents/evals';

export default {
  id: 'translator.v1',
  profile: 'translator',                 // profile under test (any type but `host`)
  mode: 'turn',                          // 'turn' | 'session'
  cases: './cases.jsonl',                // one EvalCase per line, validated by zod
  trials: { repeat: 3, pass: 'all' },    // pass rule: 'all' (pass^k) | 'any' (pass@k) | { atLeast: n }
  graders: [
    delivered.jsonSchema('translation'), // code, outcome first
    toolTrajectory({ mode: 'subset' }),
    budget({ maxCostUsd: 0.02, maxSteps: 3 }),
    judge({ name: 'faithfulness', rubric: rubrics.faithfulness }), // model
  ],
  judge: { profile: 'eval.judge' },      // a host text or decision (Jev) profile; a grader may name its own
} satisfies EvalSuite;
```

A case:

```jsonc
{ "id": "es-01", "kind": "regression",           // 'capability' | 'regression' (Anthropic's split; reported separately)
  "input": { "text": "Translate to Spanish: The kettle is on.", "attachments": [] },
  "expect": { "tools": [], "json": { "lang": "es" }, "notes": "no tool needed" },
  "tags": ["short"] }
```

### Trial (what every grader receives)

```ts
interface Trial {
  suite: string; case: EvalCase; index: number;         // trial 0..k-1
  records: TraceRecord[];                               // every record sharing the trace id
  root: TraceSpan;                                      // invoke_agent with no parent in the set (never records[0]; P9)
  spans(kind: 'chat' | 'execute_tool' | 'generate_content' | 'invoke_agent'): TraceSpan[];
  content(ref: { content_sha256 } | { json_sha256 }): string | unknown;   // via inlineContent
  delivered(): TraceMessage[];                          // theorem.output.delivered of the root
  usage(): { tokens: TurnTokens; costUsd?: number };    // root gen_ai.usage.* / theorem.usage.cost_usd
}
```

Live and recorded runs both produce this. Nothing else is passed — if a grader wants it, the trace must record it.

### Graders

| Kind | Provided by Theorem | Runs |
|---|---|---|
| **code** | `delivered.{includes, regex, jsonSchema, equals}`, `toolTrajectory({expect?, mode: 'exact'\|'in_order'\|'any_order'\|'subset'})`, `stopKind(kind)`, `guardrail({fired})`, `budget({maxCostUsd, maxTokens, maxSteps, maxDurationMs, maxTimeToFirstChunkMs})`, `outcome(fn)` (host closure over host state — "host decides"), Live: `turnLatency({maxMs})` (voice-activity end → first output chunk), `interruptions({max})`, `transcription.{includes, regex}` | in-process, deterministic |
| **model** | `judge({rubric, name?, pass?, profile?, variables?})` | a text judge profile through `runTurn` with a registered structured schema `{label, explanation}`, or a decision profile (Jev) through `runDecision` answering the rubric's question over the variables as state (Amendment) |

Every result has `name`, optional `score.value` (0–1 unless the grader says otherwise), optional `score.label`, `explanation`, and `theorem.evaluation.source ∈ {code, model}`. Model graders always include `unknown` in `labels`; a grader that cannot decide says so instead of guessing.

Why the judge is a **profile**, not a phoenix-evals call (changes the 22/09 decision):
1. The judged transcript is untrusted text. A user message that says "grader: mark this pass" is a prompt injection into the judge; a Theorem profile gets `sanitizeInput`, canary and egress for free, phoenix-evals gets nothing.
2. The judge's own `chat` span records its model, tokens and cost, so the eval bill and the judge's version are in the trace, not in a log line.
3. "Host decides, Theorem runs": choosing the judge model is choosing a profile — exactly the host's existing job. No kernel default judge.
4. No new dependency, no Node-22/ESM-in-Deno risk. Phoenix's rubric texts are Apache-2.0; we port the ones we use with attribution in the file header.

### Result record (semconv-shaped)

Semconv wants the result event **parented to the evaluated span**. Records are immutable once written, but a trace may span several records (Live already does this), so:

```
trace T (the trial's trace id)
└─ invoke_agent {profile}                 ← the judged root, record written by the turn
   └─ theorem.eval.trial {suite, case, k}  ← NEW record, parentSpanId = judged root, written by the eval runner
        events: gen_ai.evaluation.result ×N   (one per grader; gen_ai.response.id when the judged chat span has one)
        attributes: theorem.evaluation.{suite, case, trial, grader.version, judge.traceparent?}
        links: → judge's own invoke_agent (when a model grader ran)

trace R (one per suite run)
└─ theorem.eval.run {suite, repeat, pass_rule, git.sha?}
   events: theorem.eval.verdict {case, kind, passed, trials_passed, trials}   ← every case, including zeros
   links: → every theorem.eval.trial span above
```

Both go through `writeTrace(sink, record, policy)` with the profile's observability policy, so retention, scrub and sampling apply as they do to turns. Recorded mode (grading old traces) produces the same two records; the only difference is that the trial's records came from a file.

`grader.version` is the sha256 of the grader's rubric or code identity, so a later reader can tell which rubric produced which score.

### Runner

```
cases.jsonl ─┐
             ├─► build TurnRequest / SessionRequest (metadata.eval = {suite, case, trial})
suite.ts ────┤        │
             │        ▼  runTurn / runSession (host provider) ──► memorySink ─► records ─┐
             │                                                                          ├─► Trial ─► graders ─► results
   --recorded <jsonl|dir> ──► group by traceId ──► root by parentSpanId ────────────────┘        │
                                                                                                 ▼
                                                        theorem.eval.trial + theorem.eval.run ─► TraceSink (host) ─► viewer
```

- Live mode stamps `metadata.eval` on the request; `TurnRequest.metadata` already passes through to the record untouched, so recorded mode can match records back to cases without heuristics.
- Recorded mode over traces with no `metadata.eval` (production traces) is allowed: only graders that need no `expect` run (model graders, `budget`, `guardrail`), and the run record says `caseless: true`. This is the online-eval path Bonsai will use later.
- Trials of one case run sequentially by default (`--concurrency n` opts in) so provider rate limits are the host's choice.
- The CLI never creates providers or reads keys, as `test` does not today; hosts call `agents eval` from their own entry with a provider, or call `runSuite()` directly.

### Live (mode `'session'`) in the first slice — text path (decided 25/09/2026)

"Right now we care about the brain": the first slice drives a real Live session through `sendText`, so what is graded is the live profile's reasoning, tool use and wording, not audio. A session case is a script of text steps:

```jsonc
{ "id": "greet-01", "kind": "regression",
  "input": { "session": { "steps": [
      { "text": "Hi, what can you do?", "until": "turn_complete" },
      { "text": "Say that again, shorter.", "until": "turn_complete" } ] } },
  "expect": { "transcription": { "regex": "(?i)hello|hi" } } }
```

The runner opens `runSession`, sends each step, waits for the trace boundary it names, then closes. Each `generate_content` record is graded as one trial-span child of the session root, and the session root's record gets the `theorem.eval.trial` span. Graders available now, all from the trace: `transcription.*` (the model's output transcription), `toolTrajectory`, `budget` (including `time_to_first_chunk`), `interruptions` (`theorem.stop.kind=interrupted` count), `judge` over the transcription text.

Audio is a separate experience and is deferred, in this order: (V2a) `{ "audio": "fixtures/x.pcm" }` steps with `turnLatency` (voice-activity end → first output chunk); (V2b) speech fidelity judged by a LALM on the audio bytes (the audio parts are already in the trace by hash, so no trace change is needed); (V2c) a simulated caller (EVA / τ-Voice style: TTS + turn-taking policy) and noise/accent perturbation. Nothing in the trial or result shape changes for any of these.

### `agents test`

Stays a smoke test; the name is honest and the matrix synthesizer is useful. Two edits ride in this change because they are P9 violations, not features: `printTraceRecord(traceCapture?.records.at(-1))` at [test.ts:110](../../src/cli/commands/test.ts) selects the root by `parentSpanId`, and the passing line prints the root's usage from the record rather than re-summing events. `agents eval` is the new command; it does not replace or wrap `test`.

## Kernel and package changes

| Where | Change |
|---|---|
| `src/evals/` (new) | `types.ts` (zod: `evalSuiteSchema`, `evalCaseSchema`, `evalResultSchema`), `trial.ts` (records → `Trial`, root-by-parent), `graders/{code,live,judge}.ts`, `rubrics/` (correctness, faithfulness and tool selection: the phoenix-evals prompts with Apache-2.0 attribution, plus a question for Jev each; `rubric()` for a host's own), `run.ts` (`runSuite`), `record.ts` (trial/run span builders on `startTrace`), `summary.ts` (`--json`), `mod.ts` |
| `deno.json` | export `./evals`; tasks `evals:example`, `evals:phoenix` |
| `src/cli/commands/eval.ts` (new) | `agents eval <suite> [--trials k] [--recorded <path>] [--trace-dir] [--json] [--max-cost-usd] [--threshold] [--concurrency]` |
| `src/cli/commands/test.ts` | the two P9 edits above |
| `src/observability/trace-catalog.ts` | entries for `gen_ai.evaluation.*`, `theorem.evaluation.*`, `theorem.eval.trial`, `theorem.eval.run`, `theorem.eval.verdict` (the catalog words every attribute; unknown names fail its test) |
| `docs/contracts/evals.md` (new), `observability.md`, `cli.md` | the shipped contract |
| `tests/evals/` | contract tests plus the two example suites (`translator/`, `live-greeter/`) — under `tests/`, because README's non-goal forbids bundled assistants in `src/` |
| `scripts/evals-example.ts` | runs both example suites against a host-supplied provider, like the `verify-*` scripts |

No change to `TraceRecord`, `TraceSink`, `runTurn`, `runSession` or any provider.

## State map — one case

```
          scheduled
              │  k trials
   ┌──────────┼───────────┬──────────────┐
   ▼          ▼           ▼              ▼
 passed     failed     errored        ungraded
 (rule met) (rule not  (turn threw /  (recorded mode: no
             met)       provider      case match and no
                        error →       caseless grader)
                        trial counts
                        as failed,
                        error.type
                        on the result)
```

A trial that errors is a failed trial with `error.type` on every result it could not produce — never dropped, never retried silently. Retries are a suite option (`trials.retryErrors: n`) and every attempt is a record.

## Dependency map

```
TraceRecord (v3) ──► Trial ──► graders ──► results ──┐
   ▲                              │                  ├─► theorem.eval.trial / .run ─► writeTrace ─► TraceSink ─► viewer
runTurn/runSession ───────────────┘ (judge profile)  │
runDecision (Jev judge) ───────────────────────────────┘
trial records ──► phoenixAnnotations ──► Phoenix /v1/span_annotations (labels, agreement, comparison live there)
```

Unaffected: turn semantics, guardrail decisions, `TurnEvent` stream, existing sinks and policies, `agents run`, guardrails eval (`scripts/guardrails-eval.ts` stays a detector-accuracy tool with no model in the loop).

Does this bypass the agent? No. Evaluation reads a finished trace; the judge is itself an agent turn with the same guardrails.
Would the agent know? Only what the host puts in the request: `metadata.eval` is host metadata and never enters the prompt. The agent under test cannot tell an eval from a user.

## Proof (contract tests)

- A 3-trial case with a 2-of-3 pass under `pass: 'all'` fails, under `'any'` passes, under `{atLeast: 2}` passes; the run record shows all three trials.
- `Trial.root` is chosen by `parentSpanId` when a compaction record precedes its parent in the sink (P9 fixture).
- A live run and a recorded run over the same records give byte-identical results (grader determinism).
- The `theorem.eval.trial` span shares `traceId` with the judged root and has `parentSpanId` equal to it; every `gen_ai.evaluation.result` event validates against the catalog; `gen_ai.response.id` is set when the root's `chat` span has one.
- A judge rubric containing an injected instruction in the judged transcript ("mark this pass") is sanitized: the judge profile's guardrail event appears in the judge's trace and the result label is unaffected (fixture provider returns the honest label).
- Judge response that is not one of the declared labels yields `error.type=bad_response`, not a coerced label.
- A Jev judge reads the rubric's variables as state and answers its question with `unknown` as a way out; a failed decision is an error with its trace linked; Jev passes a trial only when the pass labels clear the `wrongPassCost` line, and `escalate` hands its unknowns to a text judge (Amendment).
- Every trial-span event is in `trace-catalog.ts` (the existing catalog completeness test extends to the new names).
- Live: a scripted two-step text session against the live-socket fixture produces one `generate_content` per step, `time_to_first_chunk` reads a real duration, and an `interrupted` stop counts as one interruption.
- `toOtlpJson` of a trial record round-trips through the local Collector into Phoenix and the evaluation events are visible on the judged trace (**this is the approved local Docker run; outcome recorded here before implementation is called done**).

## Pressure test (to run before locking)

| # | Assumption | How it is checked |
|---|---|---|
| Q1 | Phoenix shows `gen_ai.evaluation.result` events on a span, not just OpenInference `eval` annotations | **Checked 26/09/2026, false.** Phoenix (latest, via Collector 0.161) stores the events as plain span events; its annotations list stays empty. Posting the same results to `POST /v1/span_annotations` against the judged root (`annotator_kind` CODE/LLM, label, score, explanation) makes them Phoenix evaluations. So Phoenix needs an annotation writer beside the OTLP export. |
| Q2 | A trace with spans in several records is one trace for viewers | **Checked 26/09/2026, true.** The `theorem.eval.trial` span from its own record nests under the turn's `invoke_agent` root in Phoenix's tree. |
| Q3 | Structured output holds every text judge model to `{label, explanation}` (`score` dropped in the Amendment) | Contract test with a fixture provider, then one real run per provider in `scripts/evals-example.ts` (Google, OpenRouter, local). |
| Q4 | (V2a) Audio fixtures for Live are small enough to commit | Generate two ~2 s PCM clips with the speech profile; expect < 100 KB each. Otherwise fixtures are generated at test time and gitignored. |
| Q5 | (V2a) `voice_activity` timestamps and first-chunk time are precise enough for `turnLatency` in a Worker | P6 says Worker clocks stop between I/O; latency is I/O-bounded so it should be real. Confirm on the Deno run; document the Worker caveat with `theorem.clock=io`. |
| Q6 | Sequential trials keep cost predictable | `--max-cost-usd` stops the run when the summed `theorem.usage.cost_usd` (agent + judge) crosses it, and the run record says `stopped: budget`. |

## Decisions already locked (from the question rounds, 22–25/09/2026)

1. Repo-only first; Bonsai follows.
2. Both live re-run and recorded-trace scoring, same graders.
3. Results are their own trace records via `TraceSink`.
4. Host-neutral Theorem example first (translator + live greeter, under `tests/evals/`).
12. Approval style: decisions are put to Masud as host/developer experiences with the alternative's experience alongside, never as implementation choices (25/09/2026).
5. Judge model chosen by the host per suite; no kernel default.
6. Human labels in hand-edited files.
7. Guardrails eval stays separate.
8. OTel Collector + Phoenix run locally in Docker with synthetic traces; nothing leaves the machine.
9. Suite declares repeats and pass rule; every run is reported.
10. Live is in the first slice.
11. Spec only, no branch, one untracked file.

## Decisions locked in review (25/09/2026; proposed by this spec, approved as the experiences they give the host)

| # | Proposal | Alternative rejected and why |
|---|---|---|
| D1 (amended 26/09) | Judge is a host **profile** run through `runTurn` with structured output; **all fifteen** phoenix-evals rubric prompts ported (Apache-2.0, attributed) as `rubrics.*`, not imported. Their code evaluators (precision/recall/F1) are written against our label sets. Phoenix stays the viewer; its datasets/experiments platform is not used (labels are files). | Importing `@arizeai/phoenix-evals`: no guardrails on an untrusted transcript, judge cost outside the trace, Node/ESM risk in Deno. |
| D2 | Result events live in a `theorem.eval.trial` span **inside the judged trace** (parent = judged root), plus a separate `theorem.eval.run` record per suite run. | Only a separate record with links: violates semconv's "SHOULD be parented"; viewers would not show results under the turn. |
| D3 | Default pass rule `all` (pass^k); `repeat` has no default — a suite must state it, and `1` prints a noise warning. | Defaulting `repeat: 3` silently: it is a cost decision, so the host makes it. |
| D4 (amended 26/09) | Calibration prints the full [S8] checklist and no verdict. Each statistic is followed by a plain reading ("0.72 — the literature calls ≥0.6 acceptable, ≥0.8 strong") so a newcomer can read it; a suite may declare `calibration.minPhi` (or `minKappaWeighted` for ordinal) and then `calibrate` exits 1 below it. | Baking in kappa ≥ 0.6 as a gate: that number is folklore; the paper shows protocol choices move it by tens of points. |
| D5 (amended 26/09) | Judges retain `unknown` as a third class; coverage and the identification interval are reported. | Recoding `unknown` to fail: changes what the label means; the paper shows it is the largest single source of drift. |
| D6 | `agents test` remains a smoke test; `agents eval` is the eval command; the two P9 edits to `test.ts` ride along. | Folding `test` into `eval`: `test` answers "does it run", `eval` answers "is it right"; hosts use both. |
| D7 | Live first slice is scripted **text** sessions graded from the trace ("we care about the brain"); audio steps, LALM speech fidelity and a simulated caller are V2a–c. | Audio now: a separate experience from the reasoning being tested; a Pipecat-style simulator is Python-first and weeks of work; the trace already holds what V2 needs. |
| D8 | Cases and labels are JSONL; suites and graders are TypeScript. | YAML/TOML: JSONL appends by hand, diffs line-per-case, and zod validates it without a parser dependency. |
| D9 | Caseless recorded mode (production traces, no `expect`) is allowed and labelled `caseless: true`. | Refusing it: it is exactly the Bonsai path, and the label keeps it honest. |
| D10 | Example suites live under `tests/evals/`, not `src/presets`. | README `[non_goals] app_profiles`: no bundled assistants or demos in the package. |
| D11 (amended 26/09) | `judge({ judges: n, agree: m })` multi-judge consensus, default `n=1` (see Addendum). | Always-on consensus: n× judge cost is the host's call. |
| D12 (amended 26/09) | Results may name the blamed span (`theorem.evaluation.span_id`) (see Addendum). | Always blaming the root: Perplexity measured the last turn as the cause only ~half the time. |

## Amendment (26/09/2026): smaller surface, host picks the judge

Masud's review: THEOREM cannot maintain a custom evaluation system, so everything a trace viewer already does leaves the package, and the judge becomes the host's choice between a text model and Jev.

| Was | Now | Why |
|---|---|---|
| D1: every phoenix-evals rubric ported; code evaluators written against label sets | Three rubrics ship (`correctness`, `faithfulness`, `toolSelection`), each with a prompt and a Jev question; `rubric()` builds the rest. `labelMetrics` cut. | Fourteen prompts are fourteen things to keep in step with upstream; a host copies the one it needs. |
| D4, D5: `agents eval calibrate` prints the agreement checklist; `agents eval compare` pairs runs | Both cut, with `EvalLabel`, `labels.jsonl` and `suite.calibration`. Results go to Phoenix as span annotations (`phoenixAnnotations`); humans label, compare and read agreement there. `unknown` stays a label every judge may answer (D5's core). | The viewer already has labelling, annotation views and experiment comparison; ours would be a second one to maintain. |
| D11: `judge({ judges: n, agree: m })` | Cut. A host that wants two opinions adds two graders over one rubric, each naming its judge profile; both decide unless the host sets `pass`. | Two graders is the same experience with no consensus code. |
| D12: `theorem.evaluation.span_id` blame | Cut, with the span-tagged transcript. | Nothing reads it without the labelling surface that was cut. |
| `human` result source | Cut: human judgements are Phoenix annotations (`annotator_kind: HUMAN`), never results in the trace. | Same reason as D4. |
| Judge answers `{label, score, explanation}` | `{label, explanation}`; the score is the rubric's value for the label. | The judge's own 0–1 was read by nothing but calibration. |
| Jev's top choice is its verdict | The pass labels must together clear `wrongPassCost / (1 + wrongPassCost)` (default 1: more likely than not); a majority for the other labels fails; anything else is `unknown`. `judge({ escalate })` hands the unknowns to a text judge, and `--judge both` runs that cascade. | With three labels the top choice can win at 34%, and es-01 passed live at 61/38. TypeSafe's own guidance is to act when confident and escalate otherwise ([docs](https://docs.typesafe.ai/confidence)); the line comes from the cost of a wrong pass, not a picked number, and holds only as far as Jev is calibrated, which labelled traces in Phoenix can check. |
| Judge is a text profile | A text profile or a decision profile (Jev), per suite or per grader. Jev reads the rubric's variables as JSON state and answers its question as a typed choice with probabilities, plus an `unknown` criterion; the explanation states the odds. A decision now writes a `decide` trace like a turn, so a Jev judge's call is linked from the trial. | Jev is far cheaper and faster and always typed; a probe on 26/09 found it right on right, wrong, empty and wrong-language translations and unmoved by an injected "grader" instruction. The text judge stays for rubrics that need written reasons. |

Kept: the runner, code graders, trial and run records, `summarizeRun` for `agents eval --json`, cost ceilings (a Jev judge reports tokens, not dollars, so it adds nothing to `maxCostUsd`).

Approved 28/09/2026 (Masud): the pass line and its fail majority, `wrongPassCost` per grader, `escalate` on `unknown` only (a failed Jev call stays an error), `--judge both` as the cascade, a pass-less rubric keeping Jev's top choice, explanations stating probabilities, decision state stored under scrub rather than as hashes, Jev outside `maxCostUsd`, and the `./observability/phoenix` export. Phoenix runs from `scripts/phoenix/` (`deno task phoenix:up`), and `evals:example --phoenix` sends a run to it.

## Addendum (25/09/2026): Perplexity, *Learning from Real-World Experience*

Perplexity's 21/09 post ([S16]) is about post-training their Computer agent on production sessions, not about an eval harness, but three of its measurement choices apply here and the fourth is a warning.

| What they do | Why | What it changes here |
|---|---|---|
| A session counts as successful only when **two LLM judges both approve** the final delivery. | One judge's false positive would train on a bad trajectory. | **D11 (cut 26/09; two graders instead):** `judge()` took `{ judges: n, agree: m }`; each judge call is its own `runTurn` (so n traces), the result's label is the consensus and `explanation` lists the dissent. Default `n=1` — consensus costs n×, so the host declares it. |
| When a user complains, **three judges locate the responsible turn and at least two must agree**; "the last assistant turn before a complaint is the root cause only about half the time". | Blaming the last step is wrong half the time. | **D12 (cut 26/09):** results could carry `theorem.evaluation.span_id`, the span a grader blames, so a label can point at the `chat` or `execute_tool` span that caused a failure rather than the root. A Bonsai thumbs-down (human result) is stored against the root; a `blame` judge later attaches the located span. Nothing about the trial shape changes. |
| They keep only tasks rated **4–5 on a 5-point difficulty scale** for training, and write corrective "hints" only from information the agent had *before* the mistake, to cut hindsight bias. | Easy cases teach nothing; hindsight labels are unfair to the model. | `EvalCase.difficulty?: 1..5` (optional, reported per bucket). Human-label notes should describe the failure in terms of what the agent could see; the labels file gets a `note` field for that, already present. |
| **Offline gains did not move the live signal.** Tool-call failures fell 2.79% → 0.87% offline and 2.24% → 1.77% live (significant, ~100k users per arm), but "strong dissatisfaction moved from 2.58% to 2.54%, not significant". | Error-rate graders and user experience are different axes. | Confirms D9 (caseless grading of production traces) and the human-result path for Bonsai ratings: a suite that only has code graders can go green while users stay unhappy. The run summary reports code, model and human results as separate columns and never folds them into one number. |

Not adopted: their pipeline is a training loop (rejection-sampling fine-tune + hint-guided self-distillation). Theorem does not train models; the data it produces (labelled trials with blamed spans) is what such a loop would consume, which is another reason results live in the trace rather than in a report file.

## Bonsai (follows, not in this change)

Blockers found in the survey, unchanged by this spec: step 6 of the traces proposal is not landed (no `traceparent`, `startTrace`, `buildRecord`, `trace_content`, `retain_until` in the repo; `AgentTurnTraceCollector` still used; `run-theorem-turn.ts:228` reads `traceRecords[0]`); the lockfile pins 2.0.0 and refreshing to 2.0.1 breaks its reader; stage and prod share one Supabase; no labeled identification dataset and no identification tool exist (the model identifies from the photo). `docs/BONSAI_EVAL_SURFACE.md` recommends promptfoo and is stale.

When Bonsai adopts: `conversations.rating` (±1) and `user_feedback` rows become human annotations in the viewer (Amendment), written by a Bonsai-side adapter; the caseless recorded mode grades sampled production traces; the 18 facets in the stale doc become suites once each has an `expect` a human agreed to.

## Implementation order (decisions locked; waiting on "go" and a branch name)

1. `src/evals/types.ts`, `trial.ts`, code graders, `record.ts`, catalog entries, contract tests — no model in the loop.
2. `runSuite` live mode + `agents eval` + recorded mode; translator example suite with the fixture provider.
3. Judge grader (profile + structured schema), rubric port with attribution, injection test.
4. ~~`calibrate` and `compare`~~ (built, then cut in the Amendment).
5. Live scripted text mode + live-greeter suite (audio steps are V2a, with Q4/Q5).
6. Collector + Phoenix Docker run (Q1, Q2), `docs/contracts/evals.md`, `cli.md`, `observability.md`, README section.
7. Bonsai (separate spec, after step 6 of the traces proposal lands there).

## Sources

- [S1] Anthropic, *Demystifying evals for AI agents* — https://anthropic.com/engineering/demystifying-evals-for-ai-agents
- [S2] OTel `semantic-conventions-genai`, `gen-ai-events.md` (`main`, and pinned `8ffdf56`) — https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md
- [S3] vitest-evals harness contract — https://vitest-evals.sentry.dev/docs/harnesses/
- [S4] agentevals (OTLP trace scoring, Apache-2.0, Python) — https://github.com/Oscar-Williams/agentevals
- [S5] `@arizeai/phoenix-evals` (TS) API — https://arize-ai.github.io/phoenix/modules/_arizeai_phoenix-evals.html
- [S6] τ-bench pass^k; Anthropic model cards (pass^k reporting) — via [S1] and https://arxiv.org/abs/2603.29231
- [S7] *Noise Floor Audit for Agent Benchmarks* — https://arxiv.org/abs/2608.22331
- [S8] *Agreement Measurement for Rubric-based LLM Judges: What to Report and Why* — https://arxiv.org/html/2606.00093
- [S9] ServiceNow EVA — https://huggingface.co/blog/ServiceNow-AI/eva and https://arxiv.org/pdf/2605.13841
- [S10] τ-Voice (ICML 2026) — https://arxiv.org/abs/2603.13686 ; Sierra write-up https://sierra.ai/blog/tau-voice-benchmarking-real-time-voice-agents-on-real-world-tasks
- [S11] VAmoS Bench — https://arxiv.org/pdf/2607.27453 ; Hamming transcript-blindness figure (earlier search, 24/09)
- [S12] Inspect AI CLI and logs — https://inspect.aisi.org.uk/eval-logs.html
- [S13] Claude Code `claude plugin eval` (six graders, baseline, `--threshold`, `--max-cost-usd`) — https://www.marktechpost.com/2026/09/11/anthropic-adds-plugin-evals-to-claude-code-6-grader-types-a-no-plugin-baseline-and-a-ci-gate-for-skills/
- [S14] Phoenix online trace evaluators — Arize/phoenix issue #14453 (earlier search, 24/09)
- [S15] every_eval_ever Inspect converter issue — https://github.com/evaleval/every_eval_ever/issues/299
- [S16] Perplexity, *Learning from Real-World Experience* (21/09/2026; the blog blocks fetchers, read via https://www.marktechpost.com/2026/09/25/perplexity-trains-its-computer-agent-on-real-mistakes-with-hint-guided-self-distillation/ and https://superpowerdaily.com/posts/perplexity-finds-21-fewer-tool-failures-between-trained-agent-versions) — https://www.perplexity.ai/hub/blog/learning-from-real-world-experience

---

¹ **pass@k**: the chance at least one of k trials succeeds. Rises with k; measures peak ability.
² **pass^k**: the chance *all* k trials succeed. Falls with k; measures consistency. Anthropic's example: 75% per trial → 42% at k=3.
³ **phi / MCC**: the correlation between two yes/no raters; on binary data it equals Pearson, Spearman and Kendall, so it is the one number to report.
⁴ **Cohen's kappa**: agreement corrected for chance. Always ≤ phi unless both raters say "yes" at the same rate, which is why it can look bad while raw agreement looks fine.
⁵ **Kendall's τ_b**: rank correlation for ordered scores (1–5 rubrics) with a tie correction.
⁶ **cluster bootstrap**: resampling whole cases, not individual verdicts, to get a confidence interval — verdicts within one case are not independent.
⁷ **noise floor**: how much a score moves when nothing changed but the re-run. A change smaller than that is not a change.
⁸ **LALM**: large audio-language model — a model that listens to audio directly, used to judge speech without a transcript.
