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

From A12 on, we pick between versions on the **selection rows** only:

- Recall on `llmail-validate`, and on the rebuilt corpus's validation rows of llmail (2,384) and injecagent (211). A corpus source that the head never trained on also counts its unused train split as validation.
- False alarms on `gravitee-validate`, `hermes-glm-tool-errors`, the corpus's validation rows of the threshold pool, and the corpus's validation rows of wildjailbreak-benign.

`llmail-validate` breaks rule 2: it is an unseen set, and we pick on it. We chose this on 21/10 because no other validation set holds enough tool-shaped attacks. The figures we report stay `llmail-test`, `nvidia-agentic-ipi` and the new half of `injecagent` (see [Assumptions and known threats](#assumptions-and-known-threats)). We score them once, on the chosen version.

## Assumptions and known threats

Each item is a reason a figure can mislead. A figure that one of these touches says so.

- **The rebuilt corpus is not the original.** Its hash differs, and its seed draws different rows. A refit on it is not 0.5.1 refitted. For example, refit A scores 23.8% recall on asb-instr where 0.5.1 scores 80.6%.
- **Threshold pool contamination.** glaive-tool and agentdojo set 0.5.1's hijack threshold. Their false alarm rates are not unseen figures.
- **Seen origins.** The bench's injecagent, s-labs, spml, deepset, repo-texts, wildjailbreak-benign and aegis sets share a source with 0.5.1's training data. They show fit, not generalisation.
- **Corpus texts inside bench test sets.** All 1,054 distinct injecagent texts in the rebuilt corpus are also in the bench's `injecagent` set, which has 2,108. 0.5.1 and the refits train on 60% of the corpus's injecagent rows. All 676 corpus nvidia-ipi texts are the bench's `nvidia-agentic-ipi` texts. No corpus llmail text is in a bench llmail set. From A12 on, we report `injecagent` recall on the 1,054 rows that are not in the corpus, and we do not pick on corpus nvidia-ipi rows.
- **Selection on llmail-validate runs high.** Its attacks look like `llmail-train`, not like `llmail-test` (see the shift item below). A version can rank higher on it than it does on `llmail-test`.
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
| A12 | 21/10 | A2, A8 and A11 without all three, on the selection rows at a 2% budget. | llmail-validate recall 24.8%, 92.2% and 64.3%. Corpus validation llmail 23.6%, 76.7% and 56.8%. Corpus validation injecagent 0.0%, 40.8% and 31.3% (of 211). wildjailbreak-benign false alarms 0.0%, 5.1% and 44.4% (of 39,352). A8 is chosen. A11's gain on test came with a 44% false alarm rate on hard benign that no test set held. |
| A13 | 21/10 | Version 2: A8 plus address_sent (a sending verb, then to, at or with, then an address), authority_to_reader (an authority word in the same sentence as you), and false_authority. Each alone was also left out. | On design rows, address_sent fires on 44.6% of injecagent attacks and 0.0% to 0.1% of tool benign. But the fit gives it a weight of 0.06, because verb_to_target already separates the corpus rows. At 2%: corpus validation injecagent 40.8% to 45.0% (of 211), wildjailbreak-benign false alarms 5.1% to 5.6%, other selection figures within 1 point. Not chosen: the change is inside chance for 211 rows. Refit A trains on no tool benign, so a feature that marks tool benign as benign cannot get a weight. |
| A14 | 21/10 | Training mix, linear, v1 features. The corpus plus the `train` role tool benign (TB), with corpus injecagent weighted ×10 or ×50, or with 2K to all 98,453 `llmail-train` rows; source-balanced weights; C = 0.01. | Every mix with TB and the corpus loses: llmail-validate 23% to 80% against 92.2% for A8, and wildjailbreak-benign false alarms 43% to 53%. The model learns that tool-shaped text is benign and chat-shaped text is an attack. C does not change the result. |
| A15 | 21/10 | Tool-shaped training only: corpus injecagent, TB and all of `llmail-train`, no chat-shaped corpus sources. Also with injecagent ×20, source-balanced weights, and llmail capped at 10K. | At 2%: llmail-validate 92.5%, corpus validation llmail 80.2% and injecagent 56.9%, gravitee-validate false alarms 2.6%, hermes-glm 0.9%. Against A8 this is higher recall at about the same false alarms. wildjailbreak attack recall falls from 9.8% to 0.4%. |
| A16 | 21/10 | Transfer between sources, A15 config. Train without injecagent, then without llmail. Then remove TB, keep gravitee only, or remove AgentLeak. | Trained without injecagent, it catches 54.0% of corpus injecagent. Trained without llmail, it catches 30.3% of llmail-validate. With no TB, it catches 13.7% of injecagent. llmail transfers to injecagent; injecagent does not transfer to llmail. |
| A17 | 21/10 | Model form on A15: C from 0.01 to 10, all pairwise ANDs of the features, boosted trees of depth 2, 3 and 4. Also boosted trees on the corpus. | Every selection figure moves by 3 points or less. On the corpus, boosted trees lose: llmail-validate 84.1% against 92.2%. The features are the limit, not the model form. |
| A18 | 21/10 | Feature ablations on A15, one feature out at a time. | Only exfil_target matters: without it, llmail-validate falls to 85.6%. Without second_person, injecagent rises to 63.0% and gravitee-validate falls to 2.1%, but llmail-validate falls to 90.7%. Without the three bare signals, llmail-validate falls to 65.2%. The version-2 features add nothing here either. |
| A19 | 21/10 | Score a text by its highest-scoring window of 400 or 1,000 characters, not by the whole text. A8 and A15. | Rejected. llmail-validate falls from 92% to 80%–83%, and gravitee-validate false alarms rise to 3.0%. An llmail attack spreads its signals over more than one window. |
| F1 | 21/10 | Test score, once: A8 against A15, both at 2%. | llmail-test recall goes from 43.0% to 73.7%. nvidia-agentic-ipi recall goes from 98.6% to 15.2%. injecagent (rows not in the corpus) stays at 72.7%. False alarms: gravitee-test 1.8% to 2.4%, agentdojo-records 5.8% to 16.1%. A15 is rejected. It learned llmail, the source it trained on, and lost the only tool-shaped source that no version trained on. Validation warned of this: wildjailbreak attack recall fell to 0.4%. From now on, nvidia figures have been seen. |
| R1 | 21/10 | Ruling on the budget. | A budget of 5% validation false alarms is not acceptable. Versions are compared at 1% and 2%. No version is locked, A8 included. |
| A20 | 21/10 | Two heads at one budget: A8 OR A15, and the mean of their standardised scores. Each head with the 0.5.1 count features added. | At 2%: A8 OR A15 gets llmail-validate 93.6%, injecagent 56.9%, wildjailbreak attacks 7.6%, gravitee-validate false alarms 2.9%. The mean gets 93.3%, 55.9%, 1.4% and 2.8%. Neither beats A15 alone on llmail or injecagent, and both cost false alarms. Raw counts on the corpus collapse recall: llmail-validate 26.4%. |
| A21 | 21/10 | The counts as log(1 + n) or as present or absent, and a new diagnostic column: recall on `llmail-train`, which A8 never trained on. | log counts: llmail-validate 51.1%. Present or absent: 92.0%, no gain. A8 catches 78.8% of `llmail-train`, so `llmail-train`, `llmail-validate` (92.2%) and corpus llmail (76.7%) all run far above `llmail-test` (43.0%). All three are phase 1. `llmail-test` is phase 2, from teams new to it. No selection row is phase 2. |
| R2 | 22/10 | Ruling on scope. Detection covers takeover and exfiltration only. A harmful request in jailbreak framing is out of scope. | Removed from training and from every recall row: the 82,728 wildjailbreak attacks (74% of the corpus training attacks), all of spml, and llmail emails that name no target (no `contact` and no `@`): 3,632 in `llmail-train`, 2,558 in `llmail-validate`, 2,064 in `llmail-test`, 84 in corpus llmail. All of spml goes, because in a hand sample of 40 rows only 12 were in scope, and to pick those out we would need a regex close to our own features, so the labels would follow the model. Hex-encoded llmail attacks name no plain target and go too. wildjailbreak-benign stays as a false alarm row. It was never in training: its split puts no rows in `train`. In-scope corpus training is 9,433 rows, down from 68,675. llmail recall is also reported as the mean over teams and over subject templates, because in `llmail-test` 3 teams send 64.4% of the emails and one template is 37.5%. |
| A22 | 22/10 | Every version refit on in-scope data (S2, S8, S11, S13, S15, S8 OR S15, S8 at C = 0.1), and the old fits (A2 to A15) scored on the in-scope rows. Selection rows only, 2%. | S8 against A8: llmail-validate 95.0% and 95.3%, `llmail-train` 80.5% and 81.1%, corpus injecagent 28.9% and 40.8%, gravitee-validate false alarms 2.4% and 2.0%, wildjailbreak-benign false alarms 2.8% and 5.1%. Per team, llmail-validate is 66.0% and 70.0%. Per template, 84.6% and 85.8%. S13 is within 2.3 points of A13 on every recall row, with wildjailbreak-benign false alarms 2.8% against 5.6%. S15 is within 0.2 points of A15. S8 OR S15 is the highest on llmail (96.5%, per team 71.9%) at 2.9% gravitee-validate false alarms. Removing the jailbreaks halves the wildjailbreak-benign false alarms and costs S8 its injecagent recall. It does not move llmail. |
| A23 | 22/10 | 0.5.1 as shipped, at its own threshold, on the in-scope rows. | Pooled validation false alarms 12.0%, gravitee-validate 7.5%, hermes-glm 15.7%, wildjailbreak-benign 16.6%. llmail-validate recall 96.8%, per team 76.1%, per template 90.8%. Its recall comes from a threshold far past the 2% budget. |
| A24 | 22/10 | A new validation row, `llmail-p2`: the 11,857 distinct phase 2 emails from the 16 teams that also played phase 1 (847 name no target and are out of scope). Recall is also averaged per team on `llmail-test`, for versions already scored on test. | `llmail-p2` does not predict `llmail-test` per email: A8 catches 82.6% of it and 45.7% of `llmail-test`. Per team, validation does predict test. A8: 70.0% on `llmail-validate`, 71.0% on `llmail-p2`, 64.7% on `llmail-test`. A15: 70.6%, 74.0%, 66.2%. 0.5.1: 76.1%, 78.7%, 75.0%. The per-email gap comes from a few large teams in `llmail-test`. From now on, versions are picked on recall per team. |
| A25 | 22/10 | Version 3, written from the `llmail-validate` emails S13 missed. decode3 adds HTML entities and spelled-out addresses (`[at]`, `[dot]`) to the decode. Three new signals: an address that only decode3 shows, a send to an address in any voice ("be sent to", "push an email to"), and an instruction that names what the sent message holds ("with the body"). Each alone, all three, with and without decode3, corpus and tool-shaped training. | At 2%, against S13: llmail-validate per team 70.1% to 84.0% (T5: decode3 and all three), `llmail-p2` per team 71.4% to 74.1%, corpus injecagent 42.7% to 46.0%, gravitee-validate false alarms 1.9% (no change), wildjailbreak-benign 2.8% to 3.1%. The message-content signal gives most of the gain. The obfuscated-address signal adds nothing once decode3 is used. Tool-shaped training (T8) is higher again: 86.4% per team. Validation per team now overstates the gain, because these features were written from validation misses. |
| F2 | 22/10 | Test score, once: T5 and T8 at 2%. | T5 against A8: `llmail-test` per team 64.7% to 69.4%, per template 68.2% to 74.0%, per email 45.7% to 47.5%. nvidia 98.6% (no change), injecagent (new rows) 72.7% (no change). False alarms: gravitee-test 1.8% (no change), agentdojo-records 5.8% (no change). T8 loses nvidia again (16.4%), as A15 did, and is rejected. T5 is the best version at 2%, but it is still below 0.5.1 per team on `llmail-test` (75.0%, at 7.6% gravitee-test false alarms). |
| A26 | 22/10 | Version 4, from T5's remaining `llmail-validate` misses. decode4 also reads "name AT host. Com". Three new signals: a tool call written out with a recipient argument, a send verb with the address as its object ("send x@y.com", "cc"), and a message-content instruction that quotes the content. Each alone, and all with decode4 (U5). | Each adds 0.6 points or less. U5 against T5: llmail-validate per team 84.0% to 84.7%, `llmail-p2` per team 74.1% to 74.8%, corpus injecagent 46.0% to 46.9%, gravitee-validate false alarms 1.9% to 2.0%. The rest of the misses are other languages, ciphers and tool calls the corpus does not teach. |
| A27 | 22/10 | Training mix on U5's features: the corpus plus `llmail-train` (all, or 10K, or with source weights, or with injecagent ×5), plus `llmail-train` and `gravitee-train`, or injecagent ×5 alone. | Adding `llmail-train` (V1): `llmail-p2` per team 74.8% to 76.3%, wildjailbreak-benign false alarms 3.1% to 0.4%, gravitee-validate 2.0% to 2.4%. Adding `gravitee-train` too: `llmail-p2` per team 80.6%, but wildjailbreak-benign false alarms 8.6%, so it is rejected on validation. Injecagent ×5: corpus injecagent 55.0%, other figures within 1 point. |
| F3 | 22/10 | Test score, once: U5 and V1 at 2%. | U5 against T5: `llmail-test` per team 69.4% to 71.5%, per email 47.5% to 51.6%. nvidia 98.6%, gravitee-test false alarms 2.0%, agentdojo-records 5.8%. V1 gets 73.7% per team, but nvidia falls to 78.4%, so it is rejected. U5 is the best version at 2%. Against A8 it is +6.8 points per team on `llmail-test` with no loss elsewhere. It is 3.5 points below 0.5.1 per team, at about a quarter of 0.5.1's false alarms. |
| R3 | 22/10 | Ruling on language. Theorem is English today, and non-English attacks are a stated caveat. | An llmail email with more than 20% of its letters outside Latin script gets its own row: 3,412 in `llmail-validate`, 573 in `llmail-test`, 3,631 in `llmail-train`, 50 in `llmail-p2` (no-target emails included in these counts). These rows are left out of the headline recall and are not used to fit. Non-English text in Latin script (German, Spanish) cannot be split this way and stays in the English rows. |
| A28 | 22/10 | English and non-English attacks scored apart, every version refit (35 versions). | At 2%, `llmail-test` per team, English against non-English (22 teams): A8 66.7% and 24.2%, U5 73.8% and 25.3%, 0.5.1 77.7% and 35.2%. Per email: A8 46.1% and 21.4%, U5 52.1% and 24.0%, 0.5.1 89.8% and 40.1%. On `llmail-validate`, non-English recall is about 90% for every version, because those emails still hold the plain target address. |
| A29 | 22/10 | An English-only ingress flag on A8, U5 and 0.5.1: a text is flagged when more than 5%, 20% or 50% of its letters are outside Latin script. Each head keeps its own threshold. | U5 with the flag at 50%: non-English `llmail-test` per team 25.3% to 67.2%, English unchanged, gravitee-test false alarms 2.0% (no change). At 20%, non-English recall is 100% by construction, because 20% is the rule that defines the row; gravitee-test false alarms 2.0% to 2.1%. At 5%: English per team 73.8% to 75.3%, gravitee-test false alarms 2.0% to 3.1%. Every benign set we hold is English, so these false alarm figures say nothing about a host whose users or data are not English. For such a host, the flag would flag all of their traffic. |

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
