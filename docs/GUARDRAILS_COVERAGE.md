# Guardrails coverage

This page tracks what the kernel checks and where. Each name links to its one definition in the code. When this page and the code disagree, the code is right.

## Invariant

> **No data enters or leaves a Theorem agent without the ability to be checked and actioned.**

This is the invariant we build and audit against. Each gap below is a place where it does not hold yet.

The contract's current wording, in [`docs/contracts/guardrails.md#invariant`](contracts/guardrails.md#invariant), is narrower: it covers only what leaves. It will change once the gaps are closed or accepted.

### Gaps

- **Provider built-in tools.** They run inside the provider, before the kernel sees the call. The kernel reads the provider's report afterwards and ends the turn on a hit. That is detection, not a hold.
- **`voice` reads nothing.** A voice clip is audio, and nothing turns it into text the boundary can read. See the proof table.
- **`history` replays tool calls and reasoning unread.** Only the text of each message is read.

## Where text is read

A **boundary** is a place where the kernel reads text as it crosses. The order below is the order a turn meets them.[^boundaries] Each boundary's label and description is in `BOUNDARY_META`.[^boundary-meta]

| Group | Boundaries | Defined |
| --- | --- | --- |
| Inbound: to the model from the person or the host | `user`, `attachment`, `voice`, `slots`, `context`, `history`, `injected`, `system`, `repair`, `live_user` | `INBOUND_BOUNDARIES`[^inbound] |
| Tool: each crossing, for each kind of tool | crossings `tool_arguments`, `tool_output`, `tool_failure`, `tool_shown`, each paired with a kind `function`, `http`, `mcp`, `agent` (for example `tool_output_mcp`) | `TOOL_CROSSINGS`[^crossings] × `TOOL_KINDS`[^kinds] |
| Outbound: the model's own text to the person | `reply`, `reply_structured`, `live_reply`, `thought` | `OUTBOUND_BOUNDARIES`[^outbound] |

## What is looked for

A **detector** finds one kind of text.[^detectors] Each detector belongs to a group[^groups] and takes an action at each boundary it reads.[^actions] The actions are:

- `ignore`: the text is not read.
- `flag`: the hit is reported.
- `redact`: the hit is replaced.
- `block`: the text does not cross.

A builder sets these under `guardrails.detect`, per detector or per boundary.[^detect-field]

## Defaults

The default action is also the recommended one. The table below is copied from `DETECTOR_META`.[^meta] Each row links to its own entry. A blank cell means the detector does not apply at that boundary, so a builder cannot set it there.

Key: R is redact, F is flag, B is block, and – is ignore.

| Detector | Group | Inbound | Tool arguments | Tool output and errors: `function` / others | Tool shown | `reply` / `reply_structured` / `live_reply` / `thought` |
| --- | --- | --- | --- | --- | --- | --- |
| `ids`[^ids] | data | R | F | R / R | – | – / – / – / – |
| `financial`[^financial] | data | R | F | R / R | – | – / – / – / – |
| `network`[^network] | data | R | F | R / R | – | – / – / – / – |
| `credentials`[^credentials] | data | R | F | R / R | R | R / R / – / – |
| `injection`[^injection] | manipulation | R | – | R / R | – | – / – / – / – |
| `tool_instructions`[^tool-instructions] | manipulation | | | – / F | | |
| `canary_leak`[^canary-leak] | setup | | B | | | B / B / B / R |
| `prompt_leak`[^prompt-leak] | setup | | F | | | B / B / B / R |
| `marker_leak`[^marker-leak] | setup | | | | | B / B / B / R |
| `tool_leak`[^tool-leak] | setup | | | | | F / F / F / F |
| `ungiven_images`[^ungiven-images] | addresses | | | | | B / B / B / R |
| `ungiven_links`[^ungiven-links] | addresses | | | | | – / – / – / – |

The patterns behind the detectors can be configured in two ways:

- A detector that reads with patterns (`patterns: true`) also takes `theorem` and `patterns`. This lets a builder use Theorem's patterns, their own, both, or neither.
- `ungiven_images` and `ungiven_links` take an `allow` list of addresses. `tool_leak` takes an `allow` list of names.

A host can add its own detectors under `guardrails.detect`, alongside these.[^host-detectors]

## Proof

This table records, for each boundary, where the kernel runs the check and which test proves the check runs there. A test counts as proof only if it sends text through the kernel's own path and asserts the action. A test that calls the check with the boundary's name passed in by hand is marked **unit only**: it shows the check works, not that the kernel calls it at that boundary.

Status as of 20/10/2026. Every cited test passes. Each also fails when the kernel stops reading at its boundary: the check was removed at its source, one boundary at a time, and the test went red.

| Boundary | Checked at | Test | Status |
| --- | --- | --- | --- |
| `user` | [sanitize.ts:148](../src/guardrails/sanitize.ts#L148) | [sanitize-events.test.ts:123](../tests/guardrails/sanitize-events.test.ts#L123) | Proven |
| `slots` | [sanitize.ts:148](../src/guardrails/sanitize.ts#L148) | [sanitize-events.test.ts:123](../tests/guardrails/sanitize-events.test.ts#L123) | Proven |
| `repair` | [sanitize.ts:148](../src/guardrails/sanitize.ts#L148) | [sanitize-events.test.ts:123](../tests/guardrails/sanitize-events.test.ts#L123) | Proven |
| `history` | [sanitize.ts:148](../src/guardrails/sanitize.ts#L148) | [sanitize-events.test.ts:123](../tests/guardrails/sanitize-events.test.ts#L123) | Proven for text. Replayed tool calls, reasoning and media pass unread |
| `system` | [sanitize.ts:148](../src/guardrails/sanitize.ts#L148) | [sanitize-events.test.ts:123](../tests/guardrails/sanitize-events.test.ts#L123) | Proven |
| `context` | [sanitize.ts:157](../src/guardrails/sanitize.ts#L157); Live: [live-inbound.ts:52](../src/kernel/engine/live-inbound.ts#L52) | [turn-context.test.ts:87](../tests/kernel/turn-context.test.ts#L87); Live: [run-session.test.ts:383](../tests/kernel/run-session.test.ts#L383), [run-session.test.ts:416](../tests/kernel/run-session.test.ts#L416) | Proven |
| `attachment` | [attachments.ts:270](../src/kernel/registry/attachments.ts#L270) | [sanitize-events.test.ts:239](../tests/guardrails/sanitize-events.test.ts#L239) | Proven for text files. Only CSV, plain text and Markdown are read; other files pass unread (see Tasks) |
| `voice` | [attachments.ts:270](../src/kernel/registry/attachments.ts#L270) | None | **Reads nothing in practice.** Only text files are read, and a voice clip is audio. No path makes a transcript for this boundary. In Live, the provider's transcript of the user's speech is recorded but not read |
| `injected` | [stages.ts:743](../src/kernel/stages.ts#L743) | [stages.test.ts:558](../tests/kernel/stages.test.ts#L558) | Proven |
| `live_user` | [live-inbound.ts:22](../src/kernel/engine/live-inbound.ts#L22) | [live-inbound.test.ts:36](../tests/kernel/live-inbound.test.ts#L36) | Proven |
| `tool_arguments` · `function` | [execute.ts:1380](../src/kernel/tools/execute.ts#L1380) | [tool-boundary.test.ts:374](../tests/guardrails/tool-boundary.test.ts#L374) | Proven |
| `tool_arguments` · `http` | same | [tool-boundary.test.ts:529](../tests/guardrails/tool-boundary.test.ts#L529) | Proven |
| `tool_arguments` · `mcp` | same | [tool-boundary.test.ts:550](../tests/guardrails/tool-boundary.test.ts#L550) | Proven |
| `tool_arguments` · `agent` | same | [agent-tool.test.ts:1023](../tests/kernel/agent-tool.test.ts#L1023) | Proven |
| `tool_output` · `function` | [execute.ts:1705](../src/kernel/tools/execute.ts#L1705) | [tool-boundary.test.ts:340](../tests/guardrails/tool-boundary.test.ts#L340) | Proven |
| `tool_output` · `http` | same | [tool-boundary.test.ts:202](../tests/guardrails/tool-boundary.test.ts#L202) | Proven |
| `tool_output` · `mcp` | same | [tool-boundary.test.ts:565](../tests/guardrails/tool-boundary.test.ts#L565) | Proven |
| `tool_output` · `agent` | same | [agent-tool.test.ts:1037](../tests/kernel/agent-tool.test.ts#L1037) | Proven |
| `tool_failure` · `function` | [execute.ts:1678](../src/kernel/tools/execute.ts#L1678) | [tools-execute-c.test.ts:1371](../tests/kernel/tools-execute-c.test.ts#L1371) | Proven |
| `tool_failure` · `http` | same | [tool-boundary.test.ts:323](../tests/guardrails/tool-boundary.test.ts#L323) | Proven |
| `tool_failure` · `mcp` | same | [tool-boundary.test.ts:582](../tests/guardrails/tool-boundary.test.ts#L582) | Proven |
| `tool_failure` · `agent` | same | [agent-tool.test.ts:1049](../tests/kernel/agent-tool.test.ts#L1049) | Proven |
| `tool_shown` · `function` | [execute.ts:1718](../src/kernel/tools/execute.ts#L1718) | [tool-shown.test.ts:66](../tests/kernel/tool-shown.test.ts#L66) | Proven |
| `tool_shown` · `http` | same | [tool-boundary.test.ts:598](../tests/guardrails/tool-boundary.test.ts#L598) | Proven |
| `tool_shown` · `mcp` | same | [tool-boundary.test.ts:615](../tests/guardrails/tool-boundary.test.ts#L615) | Proven |
| `tool_shown` · `agent` | same | [agent-tool.test.ts:1059](../tests/kernel/agent-tool.test.ts#L1059) | Proven |
| `reply` | [stream.ts:331](../src/kernel/engine/runner/stream.ts#L331); final: [detect-reply.ts:79](../src/guardrails/detect-reply.ts#L79) | [detect-reply-turn.test.ts:69](../tests/kernel/detect-reply-turn.test.ts#L69) | Proven |
| `reply_structured` | [stream.ts:169](../src/kernel/engine/runner/stream.ts#L169); final: [detect-reply.ts:83](../src/guardrails/detect-reply.ts#L83) | [detect-reply-turn.test.ts:116](../tests/kernel/detect-reply-turn.test.ts#L116); drafts: [structured-draft-stream.test.ts:99](../tests/kernel/structured-draft-stream.test.ts#L99) | Proven |
| `live_reply` | [live-outbound-gate.ts:79](../src/guardrails/live-outbound-gate.ts#L79) | [live-outbound-gate.test.ts:166](../tests/guardrails/live-outbound-gate.test.ts#L166) | Proven |
| `thought` | [stream.ts:337](../src/kernel/engine/runner/stream.ts#L337); Live: [live-outbound-gate.ts:75](../src/guardrails/live-outbound-gate.ts#L75) | [canary-leak-report.test.ts:53](../tests/kernel/canary-leak-report.test.ts#L53) | Proven |

Every tool kind goes through the same lines of code. The kernel picks the boundary from the tool's `type`.[^tool-kind] Each tool test sets an action at one kind's boundary only, or asserts the boundary the event names. So a passing test proves that the tool's type reaches that line.

## Datasets

This section maps each detector to the labelled data we can benchmark it on, and to the boundaries that data fits. A dataset can test a boundary only if its text has the shape of what crosses there: a person's message, a tool's output, or the model's own writing. Data can be replayed through a boundary of the same shape, such as a user-shaped attack sent as `slots`, but that tests the wiring, not text native to that boundary.

The external sets are in `~/Development/.guardrail-corpus/`, outside the repo. The in-repo sets in `src/guardrails/corpus/` were written by us while building the detectors, so they are not unseen data. A benchmark on them shows a regression, not accuracy.

Two kinds of evidence are kept apart:

- **Accuracy on unseen data** comes only from sets someone else labelled, such as SPL and the Tensor Trust detection set.
- **End-to-end runs** send attacks from others' data through the real kernel to a real model, and label the replies. They show that the detector catches what a model actually writes, and how often it raises a false alarm on real replies. They do not measure accuracy: they cover one model, and a simple label rule, such as "the reply holds the canary", is close to the detector's own rule.

End-to-end runs follow three rules. The attacks come unchanged from others' data; we never write, pick or tune them. A person reads every reply where the detector and the code label disagree, plus a random sample of the rest, and that reading is the label. We never generate data to fill a gap: a detector with no labelled external set stays a gap.

Status as of 20/10/2026.

| Detector | Boundaries it fits | Attacks | Benign | Coverage |
| --- | --- | --- | --- | --- |
| `injection` | inbound (user-shaped); tool output and errors | User-shaped: Lakera b3[^lakera], TensorTrust hijack[^tt-hijack], WildJailbreak[^wildjailbreak], deepset[^deepset], SPML[^spml]. Tool-shaped: LLMail[^llmail], NVIDIA agentic IPI[^nvidia-ipi], InjecAgent[^injecagent], ASB[^asb], AgentDojo[^agentdojo] | User-shaped: NotInject[^notinject], Aegis safe[^aegis], WildGuard benign[^wildguard], ASB normal. Tool-shaped: Glaive tool results[^glaive], AgentDojo benign, InjecAgent clean results, Bonsai pages and tools[^bonsai-pages] | Good at `user` and tool output. Other inbound boundaries only by replay |
| `tool_instructions` | tool output and errors | The tool-shaped injection sets above | The tool-shaped benign sets above | Good |
| `ids`, `financial`, `network` | inbound; tool output; tool arguments | gravitee PII spans[^gravitee], labelled US SSN, US ITIN, credit card, IBAN and IP address | Rows of the same set without those spans | Inbound and tool output only. None in model-written text. The eval loader already reads this set, so it may not be unseen |
| `credentials` | inbound; tool output; tool shown; tool arguments; `reply` | In-repo `secrets.ts`[^secrets]. gitleaks' own rule examples[^gitleaks]: 855 of 855 match. The SecretBench[^secretbench] candidate regexes, as a check of which vendors have a rule | gitleaks' own should-not-match examples: 0 of 291 match | **Gap:** no labelled set of real secrets. SecretBench's labels need its authors' agreement |
| `prompt_leak` | outbound | System Prompt Leakage (SPL)[^spl] test split, synthetic: 30,938 paraphrases of the system prompt | SPL: 40,413 replies to the same prompts | Precision 0.99, recall 0.18. Recall is 100% when the reply keeps 60% or more of the prompt's four-word runs, and 0% under 10% |
| `canary_leak` | tool arguments; outbound | Tensor Trust extraction detection[^tt-extract]: 115 replies that reveal a player's access code, by hand label | Tensor Trust: 115 replies paired with another player's code | Recall 0.55, false alarms 8.7%. The access codes are words, not the kernel's token, so this tests the matcher, not the real canary. End-to-end: the 570 Tensor Trust extraction attacks[^tt-robust], in progress |
| `marker_leak` | outbound | In-repo `canary-egress-attacks.ts`[^canary-attacks] and `live-attacks.ts`[^live-attacks] only | AgentDojo assistant replies[^agentdojo-runs], as clean model output | **Gap:** no labelled external set. End-to-end: the Tensor Trust run above |
| `tool_leak` | outbound | None | AgentDojo assistant replies | **Gap:** no labelled external set |
| `ungiven_images`, `ungiven_links` | outbound | None | AgentDojo assistant replies | **Gap:** no labelled external set |

### Boundaries with no native data

- **`thought`:** no labelled set of model reasoning.
- **`tool_shown`:** no set of what a tool shows the person. Tool output can be replayed there.
- **`tool_arguments`:** AgentDojo runs record the tool calls a model made, and mark whether an injected task succeeded. That labels harmful calls for `guardrails.taint`, not for a detector. There is no set of tool arguments labelled for data or leaks.
- **`reply_structured`, `live_reply`:** none apart from replaying `reply` data.
- **`voice`:** nothing is read there, so there is nothing to benchmark yet.
- **`context`, `slots`, `history`, `repair`, `injected`, `system`, `attachment`:** replay only.

## Other guardrail settings

These settings act on tools and turns, not on text at a boundary.

| Setting | What it does | Defined |
| --- | --- | --- |
| `guardrails.taint.afterRemoteRead` | Which tool calls are refused, by each tool's access, once the turn has read a remote tool's result | [^taint] |
| `guardrails.taint.remoteDestination` | What happens to a tool call that sends to an address only a remote tool's result named: off, confirm or block | [^taint] |
| `guardrails.network` | The addresses that HTTP and MCP tools may reach | [^network-field] |
| `guardrails.blockedReply` | Whether a blocked reply is rewritten by the model or replaced by a refusal | [^blocked-reply] |
| `guardrails.quota` | A daily turn limit per client IP | [^quota] |
| `guardrails.disclosure` | The host's check on the state before a decision sends it to the model | [^disclosure] |

## Tasks

- Audit every path data takes into and out of an agent, beyond the boundaries above. Include data the kernel cannot read as text, such as images and audio. Add each path with no check to the gaps.
- Raise `prompt_leak` recall on paraphrased leaks without a model on egress. It finds every SPL reply that keeps 60% or more of the prompt's four-word runs, and none under 10%. Next step: try matching that ignores word order and stems words, and shorter runs of rare words. Tune on SPL's train split only, then score once on its test split and on the recorded Tensor Trust runs. Keep precision at 0.99 or above and the p99 time near today's 7 ms.

[^tool-kind]: [`toolKindOf`, src/kernel/tools/execute.ts:126](../src/kernel/tools/execute.ts#L126)
[^boundaries]: [`BOUNDARIES`, src/guardrails/boundaries.ts:61](../src/guardrails/boundaries.ts#L61)
[^boundary-meta]: [`BOUNDARY_META`, src/guardrails/boundaries.ts:116](../src/guardrails/boundaries.ts#L116)
[^inbound]: [`INBOUND_BOUNDARIES`, src/guardrails/boundaries.ts:44](../src/guardrails/boundaries.ts#L44)
[^crossings]: [`TOOL_CROSSINGS`, src/guardrails/boundaries.ts:23](../src/guardrails/boundaries.ts#L23)
[^kinds]: [`TOOL_KINDS`, src/guardrails/boundaries.ts:15](../src/guardrails/boundaries.ts#L15)
[^outbound]: [`OUTBOUND_BOUNDARIES`, src/guardrails/boundaries.ts:58](../src/guardrails/boundaries.ts#L58)
[^detectors]: [`DETECTORS`, src/guardrails/detectors.ts:32](../src/guardrails/detectors.ts#L32)
[^groups]: [`DETECTOR_GROUPS`, src/guardrails/detectors.ts:214](../src/guardrails/detectors.ts#L214)
[^actions]: [`DETECT_ACTIONS`, src/guardrails/detectors.ts:53](../src/guardrails/detectors.ts#L53)
[^detect-field]: [`detectFields`, src/kernel/schema.ts:577](../src/kernel/schema.ts#L577)
[^meta]: [`DETECTOR_META`, src/guardrails/detectors.ts:297](../src/guardrails/detectors.ts#L297). The defaults are built by the helpers `everywhere`, `leaving`, `returned` and `shown`, at [src/guardrails/detectors.ts:257](../src/guardrails/detectors.ts#L257).
[^ids]: [src/guardrails/detectors.ts:298](../src/guardrails/detectors.ts#L298)
[^financial]: [src/guardrails/detectors.ts:305](../src/guardrails/detectors.ts#L305)
[^network]: [src/guardrails/detectors.ts:312](../src/guardrails/detectors.ts#L312)
[^credentials]: [src/guardrails/detectors.ts:319](../src/guardrails/detectors.ts#L319)
[^injection]: [src/guardrails/detectors.ts:334](../src/guardrails/detectors.ts#L334)
[^tool-instructions]: [src/guardrails/detectors.ts:341](../src/guardrails/detectors.ts#L341)
[^canary-leak]: [src/guardrails/detectors.ts:349](../src/guardrails/detectors.ts#L349)
[^prompt-leak]: [src/guardrails/detectors.ts:355](../src/guardrails/detectors.ts#L355)
[^marker-leak]: [src/guardrails/detectors.ts:361](../src/guardrails/detectors.ts#L361)
[^ungiven-images]: [src/guardrails/detectors.ts:367](../src/guardrails/detectors.ts#L367)
[^ungiven-links]: [src/guardrails/detectors.ts:375](../src/guardrails/detectors.ts#L375)
[^tool-leak]: [src/guardrails/detectors.ts:383](../src/guardrails/detectors.ts#L383)
[^host-detectors]: [`HostDetector`, src/guardrails/detectors.ts:160](../src/guardrails/detectors.ts#L160)
[^taint]: [`guardrails.taint`, src/kernel/schema.ts:1216](../src/kernel/schema.ts#L1216)
[^network-field]: [`guardrails.network`, src/kernel/schema.ts:1206](../src/kernel/schema.ts#L1206)
[^blocked-reply]: [`guardrails.blockedReply`, src/kernel/schema.ts:1188](../src/kernel/schema.ts#L1188)
[^quota]: [`guardrails.quota`, src/kernel/schema.ts:1179](../src/kernel/schema.ts#L1179)
[^disclosure]: [`guardrails.disclosure`, src/kernel/schema.ts:1237](../src/kernel/schema.ts#L1237)
[^lakera]: [Lakera/b3-agent-security-benchmark-weak](https://huggingface.co/datasets/Lakera/b3-agent-security-benchmark-weak), Hugging Face
[^tt-hijack]: [Tensor Trust hijacking robustness v1](https://github.com/HumanCompatibleAI/tensor-trust-data/tree/main/benchmarks/hijacking-robustness/v1), GitHub
[^wildjailbreak]: [allenai/wildjailbreak](https://huggingface.co/datasets/allenai/wildjailbreak), eval split, Hugging Face
[^deepset]: [deepset/prompt-injections](https://huggingface.co/datasets/deepset/prompt-injections), Hugging Face
[^spml]: [reshabhs/SPML_Chatbot_Prompt_Injection](https://huggingface.co/datasets/reshabhs/SPML_Chatbot_Prompt_Injection), Hugging Face
[^llmail]: [microsoft/llmail-inject-challenge](https://huggingface.co/datasets/microsoft/llmail-inject-challenge), Phase 1, Hugging Face
[^nvidia-ipi]: [nvidia/Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1](https://huggingface.co/datasets/nvidia/Nemotron-RL-Agentic-Indirect-Prompt-Injection-v1), Hugging Face
[^injecagent]: [uiuc-kang-lab/InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent/tree/main/data), the `dh` and `ds` base test cases and the user cases, GitHub
[^asb]: [agiresearch/ASB](https://github.com/agiresearch/ASB/tree/main/data), the attack tools, normal tools and agent tasks, GitHub
[^agentdojo]: [ethz-spylab/agentdojo](https://github.com/ethz-spylab/agentdojo), its workspace suite fixtures and recorded runs, GitHub
[^agentdojo-runs]: [AgentDojo recorded runs](https://github.com/ethz-spylab/agentdojo/tree/main/runs), GitHub
[^notinject]: [leolee99/NotInject](https://huggingface.co/datasets/leolee99/NotInject), Hugging Face
[^aegis]: [nvidia/Aegis-AI-Content-Safety-Dataset-2.0](https://huggingface.co/datasets/nvidia/Aegis-AI-Content-Safety-Dataset-2.0), prompts labelled safe, Hugging Face
[^wildguard]: [allenai/wildguardmix](https://huggingface.co/datasets/allenai/wildguardmix), prompts labelled unharmful, Hugging Face
[^glaive]: [glaiveai/glaive-function-calling-v2](https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2), function responses only, Hugging Face
[^bonsai-pages]: Web search results from [Exa](https://exa.ai)'s public MCP server, the search Bonsai uses, collected by our script in the external corpus folder
[^gravitee]: [gravitee-io/pii-detection-dataset](https://huggingface.co/datasets/gravitee-io/pii-detection-dataset), Hugging Face
[^secrets]: [src/guardrails/corpus/secrets.ts](../src/guardrails/corpus/secrets.ts)
[^gitleaks]: [gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/tree/v8.30.1/cmd/generate/config/rules), the true and false positive examples in each rule's source, GitHub
[^secretbench]: [SecretBench](https://github.com/setu1421/SecretBench), its list of secret regular expressions, GitHub
[^spl]: [gabrielchua/system-prompt-leakage](https://huggingface.co/datasets/gabrielchua/system-prompt-leakage), test split, Hugging Face
[^tt-extract]: [Tensor Trust extraction detection v1](https://github.com/HumanCompatibleAI/tensor-trust-data/tree/main/detecting-extractions/v1), GitHub
[^canary-attacks]: [src/guardrails/corpus/canary-egress-attacks.ts](../src/guardrails/corpus/canary-egress-attacks.ts)
[^live-attacks]: [src/guardrails/corpus/live-attacks.ts](../src/guardrails/corpus/live-attacks.ts)
[^tt-robust]: [Tensor Trust extraction robustness v1](https://github.com/HumanCompatibleAI/tensor-trust-data/tree/main/benchmarks/extraction-robustness/v1), GitHub
