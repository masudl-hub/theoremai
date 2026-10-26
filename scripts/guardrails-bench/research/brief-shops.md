We build a guardrail for AI agents: a check that reads each web page, email, document or tool result an agent takes in, and says whether it carries instructions meant to take the agent over or make it send data out (indirect prompt injection). Today's date is 2026-10-25.

We want to know what shipping products and platforms do about prompt injection today. For each shop named below, find out from its own documentation, engineering posts, security pages, open-source code or system cards:
- whether it detects prompt injection at all, and on what: the user's input, tool results and fetched pages, the model's output, or outbound actions;
- how: a classifier (which one, its size, open or not), an LLM judge, a hosted third-party service (Lakera, Model Armor, Prompt Shields, Bedrock Guardrails and the like), rules or patterns, or no detector but containment (sandboxing, permission prompts, allow-lists, separating trusted from untrusted content, human confirmation);
- what it does on a hit: block, warn, ask the user, strip the content, log only; and whether the customer can set that;
- any published numbers: attack success rate, recall, false alarms, latency, and the test set behind them.

Report "no public information found" for a shop rather than guess. Say when a feature is announced but not shipped, and when the source is a third party rather than the shop.

Shops: {SHOPS}

Kind "product" fits most finds; name it "<shop>: <feature>". In the summary, put the shops side by side: who detects, with what, where in the loop, and what they do on a hit. Then say which approaches look strongest on evidence and which look like marketing.
