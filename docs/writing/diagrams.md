# Diagrams

A diagram earns its place when it shows something prose shows slowly: flow, ownership, order in time, or a split between two places.

## Decide

| The doc describes | Use |
| --- | --- |
| One source feeding several places (profile to server and browser) | Boxes and arrows |
| A request and its replies in order | Sequence diagram |
| States and the moves between them (a gate: pending, approved, denied) | State diagram |
| Who owns what, or layers | Nested boxes or a table |
| The shape of an API call or config | A code block. Do not draw it |
| A list of parallel facts | A table. Do not draw it |

If the diagram only repeats the sentence above it, delete the diagram.

## Pick the format by where the doc ships

| Doc ships to | Format | Why |
| --- | --- | --- |
| npm README (`README.md`, `react/README.md`) | ASCII or box-drawing, in a ```` ```text ```` fence | npmjs.com did not render Mermaid when this guide was written. Check a published page if it matters. Plain text works everywhere |
| GitHub-only pages (`docs/`, contracts, proposals) | Mermaid in a ```` ```mermaid ```` fence | GitHub renders it, and the source is easy to diff |
| JSR or any other page you have not tested | ASCII | Plain text renders everywhere |
| The site | Whatever the site's components render | Check the site code first |

## Draw ASCII so it does not break

- Use box-drawing characters (`┌ ─ ┐ │ └ ┘ ┬ ┴ ▼ ►`), not `+ - |`. They look better and align in every monospace font.
- Keep every line the same width. Build the diagram in a script and print `len(line)` for each line. Do not trust your eye: some tools count bytes, not characters.
- Keep it under 70 columns. Narrower than that survives phone screens and side panels.
- Use real names from the code in the boxes (`createTheoremHandler`), not paraphrases. A reader can search for them.
- Label every arrow that carries something ("describe", "turn"). An unlabelled arrow is a guess.
- One diagram per idea. Two diagrams in one section means the section needs splitting.
- Put a text fence around it, and one plain sentence before it that says what it shows.

Example (verified widths, 67 columns):

```text
                  ┌─────────────────────────────┐
                  │        agent profile        │
                  │   models · inputs · tools   │
                  │     output · guardrails     │
                  └──────────────┬──────────────┘
                                 │
                ┌────────────────┴────────────────┐
                ▼                                 ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│ SERVER                        │ │ BROWSER                       │
│ createTheoremHandler          │ │ <TheoremChat />               │
│                               │ │ useTheoremInterface()         │
│ runs the profile              │ │ shows only what the           │
│ enforces guardrails and gates │ │ profile allows                │
└───────────────┬───────────────┘ └───────────────┬───────────────┘
                └─ HTTP: describe · turn · steer ─┘
```

## Mermaid rules

- Keep node labels to 4 words. Move detail into the sentence.
- Use `sequenceDiagram` for request flows, `stateDiagram-v2` for gates, `flowchart LR` for pipelines.
- Name nodes with code names, as for ASCII.
- Do not use colour to carry meaning. Dark mode and print remove it.

## Prove the diagram

A diagram makes claims too. Each box, name and arrow needs a source in the code (`docs/writing/proof.md`). If the diagram shows "browser asks the server to describe the profile", find the route that does it.
