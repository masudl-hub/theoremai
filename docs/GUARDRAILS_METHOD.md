# Guardrails evaluation method

This page defines how we measure the guardrails, and it logs every experiment we run on them. Read it before you trust, repeat, or extend a figure on [`GUARDRAILS_COVERAGE.md`](GUARDRAILS_COVERAGE.md). When this page and the code disagree, the code is right.

## The method: role-split evaluation, version 1

**Role-split evaluation (RSE-1)** is the name of this method. Each dataset has one **role**, and the role decides what we may do with it.[^roles]

| Role | What we may do with it |
| --- | --- |
| `train` | Read its rows, design features on them, and fit on them. |
| `validate` | Set thresholds and pick between versions. Never fit on it. Never read its rows to design a feature. |
| `test` | Score only. A figure from it is the figure we report. |
| `holdout` | Score only, and never publish its figures. The bench reads it only with `--holdout`.[^holdout] |

Five rules apply to every experiment:

1. A threshold comes from `validate` rows only. It is never set on `test` or `holdout` rows.
2. A set the model under test never trained on is an **unseen set**. We score it and do not tune on it, whatever its role.
3. We never generate data. A gap with no labelled external set stays a gap.
4. We change one thing per experiment, and we log it below, including the experiments that fail.
5. A figure is reported with its count, for example "22,255 of 26,127". Small sets also get a 95% interval.

## Terms

- **Attack:** a row whose label says it holds the detector's target.[^holds]
- **Recall:** attacks caught, divided by attacks scored.
- **False alarm rate:** benign rows flagged, divided by benign rows scored.
- **Scored:** a detector is scored on a row if it read the row and the row's label means what the detector means.[^scored] A row can be left out for one detector with `unscored`.
- **p50, p95, p99:** the time to read one text, at that rank of the sorted times.[^percentiles]
- **Hijack:** text that tries to take control of the agent, for example "ignore your rules". A bare harmful request is not a hijack. Neither is persona or suffix framing alone.
- **Design rows:** the rows we may read to design a feature. See [Splits and seeds](#splits-and-seeds).
- **95% interval:** the Wilson score interval for a proportion. It shows how much a figure can move by chance alone.

## Systems under test

### The kernel detectors

These are the regular-expression detectors in `src/guardrails/`, as run by the guardrails bench (`deno task bench:guardrails`). The bench reads each dataset at the boundary its texts fit and writes one line per text to `results.jsonl`.[^bench-row] For `injection`, a row counts as caught if `injection` or `tool_instructions` fired.

### The linear model, `theoremai-subversion-linear` 0.5.1

This model is frozen. It lives outside the repo, in `~/Development/theoremai-guardrail-model/`.

| Item | Value |
| --- | --- |
| Heads | hijack, scored on tool output. gen_inj, scored on user text. |
| Features | Counts of regex matches. hijack has 16, gen_inj has 23. |
| Pre-pass | Zero-width strip, NFKC and confusables fold, base64 and hex payloads appended. |
| Fit | Logistic regression, L2, C = 1, balanced class weights, features standardised. |
| hijack training origins | slabs, repo, deepset, wildjailbreak, spml, injecagent |
| gen_inj training origins | slabs, repo, deepset, wildjailbreak, spml, aegis, wildguard, plus mosscap unpaired |
| Threshold | 2% false alarms on validation benign. For hijack the pool is glaive-tool, the three agentdojo sets, injecagent-benign, asb-benign and pii-structured. |
| Corpus | md5 prefix dedcd8c29783. That file is lost. |

A **paired origin** is a source that gives both attacks and benign rows. The model trains on paired origins only, so the source of a text cannot stand in for its label.

## Splits and seeds

| Data | Split | Seed |
| --- | --- | --- |
| Bench datasets | By the dataset's role. Splits such as `gravitee-train` and `llmail-test` are the authors' own, or are made in the dataset reader. | None |
| 0.5.1's training corpus | Per source: 60% train, 20% validate, 20% test. Hard benign sources go 50% to validate and 50% to test, and none to train. | 13, numpy RandomState |
| The rebuilt corpus, v06/corpus.jsonl in the model folder (md5 prefix 2edf9217a6ea) | The same rule as above. | 13, mulberry32. This does not give the same rows as numpy. |

The hard benign sources are wildjailbreak-benign, repo-hard-benign, and the three agentdojo sets.

The design rows for a hijack feature are these:

- The rebuilt corpus's train split, from the six hijack origins.
- The bench's `train` role sets at a tool boundary: `gravitee-train`, `hermes-kimi-tool-errors`, `agentleak-agent-results`, and `agentleak-agent-calls`.

`llmail-train` has the `train` role, but 0.5.1 never trained on llmail. So we keep it out of the design rows, as an unseen set.

## Assumptions and known threats

Each item is a reason a figure can mislead. A figure that one of these touches says so.

- **The rebuilt corpus is not the original.** Its hash differs, and its seed draws different rows. A refit on it is not 0.5.1 refitted. For example, refit A scores 23.8% recall on asb-instr where 0.5.1 scores 80.6%.
- **Threshold pool contamination.** glaive-tool and agentdojo set 0.5.1's hijack threshold. Their false alarm rates are not unseen figures.
- **Seen origins.** The bench's injecagent, s-labs, spml, deepset, repo-texts, wildjailbreak-benign and aegis sets share a source with 0.5.1's training data. They show fit, not generalisation.
- **No tool-shaped attacks to design on.** The design rows hold 632 tool-shaped attacks, all from injecagent, against 20,833 tool-shaped benign rows.
- **AgentLeak has no held-out split.** Both of its sets are `train`. Once we fit on them, their false alarm rates are in-sample.
- **Shift inside llmail.** 43% of `llmail-test` attacks contain `---`. In `llmail-train` it is 6%, and in `llmail-validate` 7%. A feature that reads markdown changes `llmail-test` recall far more than the other two splits.
- **Duplicates.** `hermes-kimi-tool-errors` has 11,749 rows and 9,363 distinct texts. `agentleak-agent-calls` has 9,958 rows and 9,163 distinct texts. A repeated text counts once per row.
- **One label per row.** We take each dataset's label as true. Where a label means something else, the row is `unscored`, not relabelled.
- **Selection on test.** Up to A11, we compared versions on test sets. That leaks the test into the choice. From A12 on, we pick versions on `validate` rows only, and score the chosen one on test once.
- **Tied scores.** Every version-1 feature is present or absent, so many texts get the same score. A threshold cannot land between tied texts, so a 2% budget can give more or less than 2%.
- **Latency is one machine.** All times come from one Apple laptop, one process, warm. Times are comparable within this log, not across machines.

## Experiments

Each line is an experiment ID, a date, a config, and a result. Recall and false alarm rates are on `test` roles and unseen sets unless the line says otherwise.

### Accuracy

| ID | Date | Config | Result |
| --- | --- | --- | --- |
| A1 | 21/10 | 0.5.1 as frozen. Heads chosen by boundary. Compared with bench run `2026-10-21T17-48-16Z`. | hijack recall: llmail-test 22,255 of 26,127 (85.2%, regex 20.3%); nvidia 1,255 of 1,272 (98.7%, regex 3.2%). hijack false alarms: gravitee-test 7.6%, hermes-glm 15.7%, agentleak-agent-results 51.7% (regex 0.02%). gen_inj recall on lakera-b3 is 13.3%, and on gandalf-ignore 19.6% (regex 53.6%). |
| A2 | 21/10 | Refit A: the 0.5.1 recipe on the rebuilt corpus. | The weights are close to 0.5.1, and the threshold is 7.62 against 4.77. llmail-test recall is 84.5%, nvidia 98.7%, gravitee-test false alarms 7.4%. This checks the pipeline. |
| A3 | 21/10 | Refit B: A2 plus 36,686 `train` role tool benign rows, with no tool attacks added. | Rejected. False alarms fall: gravitee-test to 1.3%, hermes-glm to 0.3%. Recall collapses: llmail-test to 8.5%, nvidia to 77.9%, injecagent to 21.9%. The model learns that tool-shaped text is benign. The boundary_spoof weight goes to −6.31. |
| A4 | 21/10 | A2 with boundary_spoof as present or absent, real boundary tokens only (no `##`, `---` or `===`). | False alarms: hermes-glm 15.7% to 4.5%, gravitee-test 7.4% to 5.0%, agentleak-agent-results (in-sample) 51.7% to 29.4%. Recall: llmail-test 84.5% to 48.1%. nvidia and injecagent do not change. |
| A5 | 21/10 | A4, and a markdown heading or rule also counts when a boundary word follows it. | The same as A4 to 0.3 points. |
| A6 | 21/10 | A2 with boundary_spoof as present or absent, markdown included. | Rejected for false alarms: hermes-glm 10.6%, gravitee-test 6.1%, agentleak-agent-results 44.8%. llmail-test recall 84.2%. |
| A7 | 21/10 | Probe of the design rows. Each signal's presence, by group. | In tool benign, tool_verbs is present in 37.3%, authority in 23.6%, boundary_spoof in 18.4%, and exfil_target in 13.9%. Of 6,408 flagged tool benign rows, 1,461 are authority + exfil_target + tool_verbs. Each of these is a common word or address read with no context. |
| A8 | 21/10 | Version 1 of the context features: every signal present or absent, plus a verb said to the reader, a verb that sends to an address, second person, "you must", and markdown that fences an instruction. Fit as A2. | Against A2: gravitee-test false alarms 7.4% to 4.2%, hermes-glm 15.7% to 2.4%. Recall: llmail-test 84.5% to 82.9%, injecagent 61.7% to 69.3%, nvidia 98.7%. agentdojo-records false alarms 8.8% to 19.0% (26 of 137). With the bench benign added (as A3), recall still collapses: nvidia 20.9%. |
| A9 | 21/10 | Diagnosis of A8's false alarms on the design rows. | 4,481 of 36,686 flagged. 1,456 are authority + tool_verbs + exfil_target, and 1,434 of those are AgentLeak rows. AgentLeak has 1,430 rows that hold one payment page's script addresses. Benign tool output names addresses as data, in fields and markup. An attack names an address as where to send. |
| M2 | 21/10 | Method change. A refit's threshold comes from all validation benign: the rebuilt corpus's tool validation rows plus `gravitee-validate` and `hermes-glm-tool-errors`, 24,062 rows. Before, it came from 509 rows, so 2% rested on about 10 texts. | Applies to A10 on. |
| A10 | 21/10 | A2, A4 and A8 at budgets of 0.5%, 1%, 2% and 5% validation false alarms (M2). | At 2%: llmail-test recall 7.2%, 22.7% and 43.0%; injecagent 0.0%, 25.9% and 58.4%; gravitee-test false alarms 0.8%, 1.8% and 1.8%. A8 needs the 5% budget to reach 82.9% llmail-test recall, at 4.2% gravitee-test false alarms. |
| A11 | 21/10 | A8 without tool_verbs, without exfil_target, without authority, and without all three (M2). | Without all three, at 2%: llmail-test 55.2%, injecagent 66.9%, gravitee-test false alarms 1.1%, agentdojo-records 0.0%. But llmail-validate recall falls from 92.2% (A8) to 64.3%. Validation and test disagree on which version is better. |

### Speed

These measure the read of the whole regex bundle, over 7,355 bench texts.

| ID | Date | Config | Result |
| --- | --- | --- | --- |
| S1 | 21/10 | The kernel detectors after the ASCII fast path and one-pass credential keywords. | p50 per text: 0.058 ms under 256 characters, 0.73 ms at 1K–4K, 24.5 ms over 16K. 330–593 ns per character. Shares: injection 69%, tool_instructions 11%, credentials 10%. Hits equal the baseline. |
| S2 | 21/10 | One eager DFA per pattern set, from the loosened patterns. | Rejected. Injection, sensitive and URL sets each go past 60,000 states. |
| S3 | 21/10 | Lazy DFAs. 337 patterns packed into groups by a state budget. | 4 groups, of 177, 131, 21 and 8 patterns. Each sensitive pattern alone needs 202 states or fewer. The working sets are 15,630, 12,729, 12,261 and 384 states, about 21 MB. |
| S4 | 21/10 | S3, first reads of unseen texts, prefilter plus a whole-text confirm. | Under 1 ms: 100% under 256 characters, 98% at 1K–4K, 82% at 4K–16K, 1% over 16K. The confirm costs about 21 ns per character. |
| S5 | 21/10 | S3, warm, all 4 groups in one loop. | 4.7 ns per character for all 337 patterns, about 75 µs for 16K characters. Each group alone runs at 2.5–3.3 ns. |

## Where the code is

The bench and its scoring are in the repo. The experiment scripts for A1–A8 and S2–S5 are not yet in the repo. Until they are, these lines cannot be repeated from a checkout.

[^roles]: `ROLES` in [`studio/guardrail-bench.ts`](../studio/guardrail-bench.ts). Each dataset sets its role in [`scripts/guardrails-bench/datasets.ts`](../scripts/guardrails-bench/datasets.ts).
[^holdout]: [`scripts/guardrails-bench.ts`](../scripts/guardrails-bench.ts) leaves out `holdout` unless `--holdout` is passed, and `score.ts` marks a hold-out score "never tune or publish".
[^holds]: `holdsTarget` in [`studio/guardrail-bench.ts`](../studio/guardrail-bench.ts). A dataset that labels each detector apart sets `holds`. Otherwise the row's `attack` flag decides.
[^scored]: `isScoredFor` and `outcomeFor` in [`studio/guardrail-bench.ts`](../studio/guardrail-bench.ts). Recall counts only for the detectors in a dataset's `labels`. False alarms count for every detector.
[^percentiles]: `percentiles` in [`scripts/guardrails-bench/score.ts`](../scripts/guardrails-bench/score.ts) takes the value at rank floor(q × n) of the sorted times.
[^bench-row]: `BenchRow` in [`studio/guardrail-bench.ts`](../studio/guardrail-bench.ts).
