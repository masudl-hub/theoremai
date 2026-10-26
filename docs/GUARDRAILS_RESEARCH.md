# Guardrail research log

This log is for whoever works on the page classifier. It records what we learned from outside the bench: what shipping products do about prompt injection, and the papers and datasets we found. Use it to check whether an idea is already known before you start an experiment. Our own experiments are in [`GUARDRAILS_METHOD.md`](GUARDRAILS_METHOD.md).

## Where the records are

| Record | Where | What it holds |
| --- | --- | --- |
| **Ledger** | The file ledger.jsonl in `~/Development/.guardrail-data/research/` | One line for each find of the research scout: kind, name, link, licence, release date, and the exact words it rests on |
| **Run** | `~/Development/.guardrail-data/research/<run>/` | `reply.json` (the scout's full answer, with the searches it tried and the leads it could not follow) and `events.jsonl` (every tool call) |
| **Brief** | [`scripts/guardrails-bench/research/`](../scripts/guardrails-bench/research/) | The question each run answers |

The **research scout** is [`researcher.ts`](../scripts/guardrails-bench/research/researcher.ts). It searches, reads and cites. It never downloads or runs what it finds. A find that rests on a page must quote words that a tool returned in the same run. The scout removes a find that fails this check.

Note: a scout answer is a lead, not proof. Read the primary source before a find changes an experiment.

## Runs

| Run | Date | Brief | Model | Result |
| --- | --- | --- | --- | --- |
| `open-mimo` | 24/10 | [`brief-open.md`](../scripts/guardrails-bench/research/brief-open.md): detectors, data and methods for page injection | mimo-v2.6-flash | 8 finds |
| `shops-1` | 25/10 | [`brief-shops.md`](../scripts/guardrails-bench/research/brief-shops.md): gateways and model APIs | mimo-v2.6-flash | 4 finds; the full survey is in the summary |
| `shops-2b` | 25/10 | Coding agents | gemini-3.8-flash | 14 finds; most rest on papers, not on the shops' own pages |
| `shops-3` | 25/10 | Browsers, Berd, Buzz, other agent shops | mimo-v2.6-flash | 8 finds |
| `shops-4` | 25/10 | Workspace and chat assistants | mimo-v2.6-flash | 1 find; the full survey is in the summary |
| `shops-5b` | 25/10 | Model labs | mimo-v2.6-flash | 19 finds; general web search was rate-limited for the whole run |

`shops-2` and `shops-5` failed in their final call and left no answer. `shops-2b` and `shops-5b` are the reruns.

## What shipping products do (25/10)

The scout read each shop's own documentation where it could. A cell marked "third party" rests on someone else's test or report.

| Shop | Detector on what the agent reads | What happens on a hit | Published numbers |
| --- | --- | --- | --- |
| Anthropic: Claude for Chrome, Claude Code | Probes scan tool results; a second classifier reviews each action with the tool results removed | Block, or pause for the user's approval | Under 0.08% attack success on internal tests; about 1% against an adaptive attacker |
| Perplexity Comet | Fast classifiers (BrowseSafe) on every page, in parallel with the model; flagged pages go to a frontier model | Stop with a safe reply | 91% detection, over 90% F1 in under 0.5 s (Perplexity's figures, via third-party coverage) |
| Meta Muse | An ensemble of injection classifiers on all files and tool results, outside the agent's sandbox | An egress gate allows, denies, or asks the user | None found |
| Google Workspace Gemini | Injection classifiers on emails, files and web content, before the model | Content is left out, or the response is stopped | None found |
| Google DeepMind: Gemini | An LLM judge on retrieved data, plus adversarial fine-tuning | Not stated | Third party: Model Armor caught 0 of 32 injections in cloud logs (LogJack) |
| Notion AI | An LLM scans tool metadata and tool results; MCP results are XML-escaped; tool inputs are checked against their schemas | Block, or ask the user | None found |
| Microsoft Prompt Shields | A classifier for user prompts and one for documents; tool responses are in Preview | The customer chooses to annotate or block; 50–100 ms per check | Third party: 1 of 32 (LogJack) |
| OpenAI: ChatGPT agent, dots | Monitors it does not name; Safe URL checks for data sent to third parties | Block, ask, or confirm | 99.5% on a synthetic challenge set (model only, not end to end) |
| Cloudflare AI Gateway | Prompt Guard 2 86M on prompts and responses | The customer sets flag or block | None of its own; about 500 ms a request for Llama Guard 3 8B |
| AWS Bedrock Guardrails | A prompt-attack filter on user input only; the docs say it does not evaluate tool results | Block, or detect only | None found |
| NVIDIA NeMo Guardrails | YARA rules and pluggable classifiers | Omit, sanitise, or reject | None found |
| Brave Leo | No page classifier; a second model, kept from the raw page, checks actions against the user's request | Warn and ask | None found |
| xAI Grok Bot | Hooks let the customer's own server screen fetched content | Deny, or ask for approval | None found |
| Salesforce Agentforce | A beta classifier on user prompts | Report only | None found |
| Slack AI | "Context engineering"; no classifier named | Modify or stop | None found |
| LiteLLM | None of its own; hooks call Lakera, Azure, Bedrock and others | Reject, or log only | Not applicable |
| OpenRouter | A regex filter | Redact or block | None found |
| Cursor, Devin, Conductor, Goose, Windsurf, Replit, Antigravity, Zed, Atlassian Rovo, Buzz | No public detector on content; sandboxes, approvals, permissions | Ask or deny | None found |

Findings that bear on our work:

- Only Anthropic, Perplexity, Meta, Google Workspace, Notion and Microsoft scan tool results or pages. The rest rely on containment.
- Comet runs the page classifier in parallel with the model's step and holds actions until the verdict. With that design, a page check faster than the model's step adds no wait (see S9 in [`GUARDRAILS_METHOD.md`](GUARDRAILS_METHOD.md)).
- Independent tests are poor for hosted detectors on tool results: LogJack (arXiv:2604.15368) and the re-evaluation of 15 detectors (arXiv:2610.03448). The second ranks Horizon first on AgentDojo and tau-bench tool outputs.
- Not reached: the xAI, Mistral, Cohere, DeepSeek, Kimi and GLM docs, because web search was rate-limited.

## Papers and datasets to read next

| Find | Link | Why it matters to us |
| --- | --- | --- |
| Passing the Test You Trained On | [arXiv:2610.03448](https://arxiv.org/abs/2610.03448) | Benign tool outputs built from real tool calls; detector ranks do not carry over between benchmarks |
| LogJack | [arXiv:2604.15368](https://arxiv.org/abs/2604.15368) | Injections in cloud logs; the only independent test of the hosted guardrails |
| Defusing Explosive Prompts | [arXiv:2609.22510](https://arxiv.org/abs/2609.22510) | Conditional payloads that are plain requests to send data; 43–83% success on nine production agents |
| LlamaFirewall | [arXiv:2505.03574](https://arxiv.org/abs/2505.03574) | Prompt Guard 2 plus an LLM judge on the action trace; AgentDojo attack success 17.6% → 1.75% |
| Lessons from Defending Gemini | [arXiv:2505.14534](https://arxiv.org/abs/2505.14534) | Google's classifier and adversarial fine-tuning program |
| PromptArmor | [arXiv:2507.15219](https://arxiv.org/abs/2507.15219) | An LLM strips injected text before the agent reads it |
| CommandSans | [arXiv:2510.08829](https://arxiv.org/abs/2510.08829) | Token-level removal of instructions from tool outputs |
| INFUSE | [arXiv:2610.20776](https://arxiv.org/abs/2610.20776) | 41,824 attacked agent trajectories across 19 models |
| LivePI | [arXiv:2605.17986](https://arxiv.org/abs/2605.17986) | Seven input surfaces on a live machine |
| `rgeada/tool-response-injections` | [Hugging Face](https://huggingface.co/datasets/rgeada/tool-response-injections) | Paired injected and benign tool responses; it is in Horizon's training data, so it is not a fair test of Horizon |
| `3nesdeniz/agentic-prompt-injection-boundary-pairs` | [Hugging Face](https://huggingface.co/datasets/3nesdeniz/agentic-prompt-injection-boundary-pairs) | 600 benign and attack pairs across 50 agent workflows |
| `openai/ih-challenge` | [Hugging Face](https://huggingface.co/datasets/openai/ih-challenge) | OpenAI's instruction-hierarchy training data |

The ledger has every other find, with its quotes.
