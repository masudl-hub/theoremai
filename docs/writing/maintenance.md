# Maintenance: a change in the code must change the doc

A doc that is true today and not checked tomorrow is a future false claim. Tie each doc to its source so the repo notices when they part.

## Three layers

1. **Ownership.** Every doc names the code it describes. Every production file has one owning doc.
2. **A check that fails.** A lint or test fails when owned code changes and the owning doc does not.
3. **A trigger before commit.** You find affected docs before the check does.

## In the theoremai repo

The repo already has layers 1 and 2 for contracts and the root README.

- `docs/_map.mjs` is the ownership graph. Each production file has one `owns` entry. Entries list the doc, the sections that must change (`section_triggers`), and the evidence (tests, validation).
- `npm run lint:docs` is the check. It runs in pre-commit and CI. It fails when:
  - an owned file changes and its owning doc is not in the diff (freshness);
  - a watched section does not change when its watched files do;
  - a barrel export is missing from the owning contract (export drift);
  - a user-facing string in the kernel, guardrails, interface or headless react code is not in the lexicon (copy lint).
- `docs/DOCS_TRUTH.md` describes the rules. Read it before you add or move a doc.

When you add a doc, add its entry to `docs/_map.mjs` in the same change. When you move code between owners, move the ownership. Never silence the lint with a comment edit. A comment-only edit counts as a change, so the lint cannot tell you did not revise the text. Revise the text.

## Layer 3: find affected docs yourself

Before you commit code:

```bash
node scripts/docs-claims.mjs affected            # since the merge base with origin/main
node scripts/docs-claims.mjs affected --base HEAD~3
```

It lists each Markdown file that mentions a declared symbol or file path in your diff. Read each one against the new code and revise it. The script finds docs that name the symbol. It cannot find a doc that describes a behaviour without naming it. For a behaviour change, also search the docs for the words that describe the behaviour.

## Make docs cheap to maintain

- **Derive, do not copy.** If a table repeats data that code owns (export lists, option names, defaults), generate it, or keep it in one place and link to it. Two copies drift.
- **Point at the source.** Say where the truth lives ("Defaults come from `src/kernel/schema.ts`") so the next editor knows what to check.
- **Fewer numbers.** Each version, count and size in prose is a future error. State a number only when the reader needs it, and take it from a file the check can see.
- **Examples as tests.** Where the repo can, compile the README's first example in CI. A broken example then fails a build, not a reader.
- **Short docs.** Every line is a line to keep true. Move maintainer detail to a contract, and consumer detail to the README. Do not repeat one in the other.
- **Delete before you add.** When you change behaviour, remove the old sentence first. Then write the new one.

## Docs outside the map

A README that `docs/_map.mjs` does not own has no check. For such a doc (for example `react/README.md`):

1. Tell the user it has no freshness check.
2. Propose an ownership entry, or a script that compiles its examples and runs `docs-claims.mjs check` in CI.
3. Do not add the entry without agreement: it changes what every later commit must touch.

## Outside Theorem repos

If the repo has no ownership map, tell the user which layers are missing. Offer the smallest working version: a list of owner files at the top of each doc, plus `docs-claims.mjs check` in CI.

## Handing over

End every doc task with a short report:

- **Proved:** claims and the evidence type (code, test, ran, measured).
- **Not proved:** claims you removed or left for the user, with the file that would settle each.
- **Stale now:** other docs that your code change or your doc change makes wrong.
- **Check status:** whether the freshness check covers this doc.
