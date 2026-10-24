We build a guardrail for AI agents: a check that reads each web page, email, document or tool result an agent takes in, and says whether it carries instructions meant to take the agent over or make it send data out (indirect prompt injection). English text. Today's date is 2026-10-24.

Find what would make that check catch more attacks without flagging more ordinary content. That can be a model, a dataset, a paper, a method, a tool, or an argument that we are framing the problem wrongly. We do not know the whole field; look where you judge the best work is, including places we would not think to look.

A find is worth reporting when:
- it is published and we can get it: open weights, data or code, or a paper with enough detail to reproduce. Say when something is announced but not released.
- it bears on content an agent reads, not only on what a user types to a chatbot. Say how directly.
- it has evidence: scores on a named test set, an ablation, or a clear mechanism. Quote it from the primary source.
- it is new to us, or it gives a reason to look again at something we have.

For each find, give its size, licence, release date, and whether it is gated. Rank the finds by how much they could change what we do next, and say what each one would change.

Where we are, so you can judge what is new: our current check is a ~140M-parameter encoder (Horizon-Labs/prompt-injection-guard-small) and smaller models distilled from it. It must run on each page in tens of milliseconds, but a large model can still teach it or label data for it. It flags too many ordinary web pages at the recall we want. It misses most attacks that are a plain request to send data somewhere, written without override words (WAInjectBench VPI web text: 0 of 114), and about half of the attacked steps in AgentDrift. A pairwise ranking loss and matched clean/attacked page pairs helped in our tests.

If the evidence points somewhere other than this framing, say so and show it.
