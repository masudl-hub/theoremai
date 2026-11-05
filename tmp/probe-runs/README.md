# Local probe runs

Store live provider traces and similar probe outputs here. They stay on this machine. Git ignores the run folders; only this README is tracked.

## Layout

```text
tmp/probe-runs/
  README.md                 ← this file (tracked)
  YYYY-MM-DD-<topic>/       ← one folder per campaign (ignored)
    *.trace.json            ← Studio / OTEL records from a turn
    notes.md                ← optional: what you were checking
```

Name the folder by date and topic, for example `2026-10-26-research-thoughts`.

## What belongs here

- Real `.trace.json` captures from record or probe scripts
- Short notes that say which model, key lane, and question the run answers
- Inputs you want when you review guardrails, replay, or Goals openers

Do not put API keys in these files. Do not commit run folders.

## Using a run

1. Open the folder in the studio (import trace) or pass the records to `openingFromRecords` / `recordedFeed`.
2. For a Goals-bar check: `judgeResearchOpening(openingFromRecords(records))`.
3. When a take is worth shipping as a fixture, copy it into `studio/cookbooks/fixtures/` through the normal record path — do not link the fixture at a `tmp/` path.

## Current local campaigns

| Folder | What it was for |
| --- | --- |
| `2026-10-26-research-thoughts/` | Free OpenRouter / Gemini research first turns: thought vs tool interleaving |
| `2026-10-26-research-brief/` | Goals attachable research brief (`research-brief.md` / `.txt`) for the experience example |
