
# Writing Theorem documentation

This guide is for every agent and every person that writes docs in this repo: Claude Code, Cursor, Copilot, Gemini, Codex or a human. Tool-specific files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/writing-docs.mdc`, `.github/copilot-instructions.md`) only point here. This folder is the only copy. Edit it here.

Theorem documentation does five things. Each rule below exists to do one of them.

1. It is easy to read for people who do not read English as a first language.
2. It shows structure in pictures where a picture is faster than words.
3. It starts from what the reader wants to do, not from what the code contains.
4. It is true. The code proves every claim.
5. It stays true. A change in the code makes the doc fail until someone revises it.

Read the file for each step when you reach it. Do not load all of them at the start.

| File | Read it when |
| --- | --- |
| [`writing.md`](writing.md) | You write or edit sentences (step 4). It has the rules, the 20% you may relax, and before/after examples. |
| [`diagrams.md`](diagrams.md) | You decide whether a diagram helps, and which kind (step 5). |
| [`proof.md`](proof.md) | You verify claims (step 6). It has the evidence table and the traps. |
| [`maintenance.md`](maintenance.md) | You make the doc fail when the code changes (step 7). |

## Procedure

### 1. Find the reader and the job

Write one line before you write any doc: **who** reads it, **what they are trying to do**, and **what they can do after**. If you cannot fill the three parts, ask the user. A doc without a job becomes a list of everything the code contains.

Pick the doc type from the reader's job:

| Reader's job | Doc type | Opens with |
| --- | --- | --- |
| Decide whether to use Theorem | Package README, npm page | The one idea, then the shortest working example |
| Do a task | Guide or how-to | The goal, then numbered steps |
| Look up a name, option or default | Reference or contract | A table, ordered by what readers look up most |
| Understand why it works this way | Explanation | The problem the design solves |
| Change the code | Contract in `docs/contracts/` | Who owns what, what must stay true |

Do not mix types in one section. A reference table inside a how-to step hides both.

### 2. Establish the use case for every feature

For each feature, answer in the doc: **why would the reader want this, and what are they trying to do when they reach for it?** Put the answer in the first sentence under the heading, in the reader's terms.

- Weak: "`chatRef` exposes the chat controller."
- Strong: "Use `chatRef` when your page must start, stop or read the chat from outside the component, for example to clear the chat when the user signs out."

A feature with no use case that you can write down is a candidate for deletion from the doc, or a question to the user. Say which.

### 3. Collect evidence before you write

Open the code first, not the old doc. An old doc is a list of claims, not evidence. For each thing you will state, find its source now (see step 6). Keep a short ledger as you go: claim, file and line or test or command output. You do not paste the ledger into the doc. You use it to write, then to check.

### 4. Write in simplified technical English

Read [`writing.md`](writing.md). The short version:

- One idea per sentence. Aim for 20 words or fewer. Procedures: 25 or fewer.
- Active voice. The subject does the action: "The handler strips the system prompt."
- One term for one thing, everywhere. Define it once, in bold, on first use. Never swap `profile` for `config` or `definition` to avoid repeating yourself. Repeating the word is correct.
- Steps are imperative and numbered: "Mount the handler."
- No idioms, no figures of speech, no phrasal verbs where a plain verb exists ("start", not "spin up").
- Say what a thing does, not what it "helps with" or "enables".
- Gloss jargon on first use in one clause. The reader is smart and may not be an ML specialist.

### 5. Add a diagram when it is faster than the words

Read [`diagrams.md`](diagrams.md). Add a diagram when the doc describes flow, ownership, order in time, or a split between two places. Do not add one to decorate. Prefer ASCII for anything that ships in an npm README, because npm does not render Mermaid. Use Mermaid on GitHub-only pages. Use a code block when the shape of the code is the point.

### 6. Prove every claim against the code

Read [`proof.md`](proof.md). The rule: **a sentence goes in only when you have seen its source in this session.** Then run the check:

```bash
node scripts/docs-claims.mjs check path/to/doc.md
```

It fails on any code span that names a path, package or identifier that does not exist. It proves names, not meaning. You still read the code behind every behaviour, default and limit. Type-check or run every code example. If you cannot prove a claim, delete it or tell the user it is unverified. Do not soften it with "usually" or "typically".

### 7. Make the doc fail when the code moves

Read [`maintenance.md`](maintenance.md). In short: tie the doc to its source, so a code change forces a doc change. In the theoremai repo, `docs/_map.mjs` and `npm run lint:docs` already do this for contracts and the root README. For any other doc, make sure an owner entry or a check exists, or tell the user it has none. Before you commit code, run:

```bash
node scripts/docs-claims.mjs affected
```

It lists every doc that mentions a symbol or path your change touched. Re-read each one.

### 8. Check the finished doc

Run this list. Fix what fails.

- [ ] The three-part line (who, job, outcome) is true of the finished doc.
- [ ] Every feature section opens with its use case.
- [ ] The first example runs as written. You ran it, or type-checked it.
- [ ] No sentence over 25 words, outside tables and code.
- [ ] No term has two names. No name has two meanings.
- [ ] `docs-claims.mjs check` passes.
- [ ] Links point to files that exist on the branch the reader will read. A link to a file that is not pushed yet is a broken link: say so.
- [ ] The doc names its source of truth (files or contract) where the repo expects it.
- [ ] For a package README: it makes sense on npmjs.com, with no repo-relative links and no Mermaid.

Report to the user what you proved, what you could not prove, and which docs the change makes stale.

## Theorem-specific facts to respect

- **Two documentation surfaces.** Package docs (`README.md`, `react/README.md`) ship to npm and speak to consumers. Repo contracts (`docs/contracts/*.md`) never ship and speak to maintainers. Never put maintainer ownership notes in a README, or consumer how-to in a contract.
- **A package README is frozen per version.** A new README appears on npm only after a new release. Say so when you hand it over.
- **Words the user sees live in the kernel lexicon.** If a doc quotes UI or error text, copy it from the lexicon or catalog. Do not paraphrase it.
- **Do not over-comment code to document it.** Comments go stale. Put explanation in the doc, and keep comments for the one thing the code cannot say.
- **Do not decide for the user.** If two accurate wordings imply different product decisions, ask. Do not pick one and present it as settled.
