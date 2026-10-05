# Proof: every claim comes from the code

The reader trusts a doc as much as the code. A false line in a doc costs more than a missing line: the reader cannot tell which lines to doubt.

## The rule

A sentence goes in only when you have seen its source in this session. An old doc, a commit message, a comment, your memory and another agent's summary are leads. They are not sources.

## What counts as evidence

| Claim | Evidence you need |
| --- | --- |
| A name exists (function, prop, route, flag) | `git grep -w name`, and you read the declaration |
| A signature or type | The declaration, or a type-check of a snippet that uses it |
| A default value | The constant or the `??` in the code. Read the line, copy the value |
| A behaviour | A test that asserts it, or you run it and read the output |
| A limit, version or size | Measure it. Example: the TypeScript floor was found by compiling against 5.4, 5.7, 6.0 and 7.0 |
| An order of events | Follow the code path, or read a trace |
| "Always" or "never" | Find the code path that would break it. If you cannot exclude it, say what you checked |
| A link | The file exists on the branch the reader reads |
| A code example | You ran it, or you type-checked it, against the current build |
| What the published package contains | Build the package and read its tree. Do not infer it from the source tree |

## The ledger

Keep a ledger while you work: claim, source (file:line, test name, command), result. Use it to write and to check. Keep it in your scratch space, not in the doc. When a source is a command, keep the command.

## Check names automatically

```bash
node scripts/docs-claims.mjs check path/to/doc.md
```

It reads every inline code span in the doc. It fails for a path that does not exist, a package that no `package.json` or `deno.json` names, and an identifier that no code file contains. Run it every time you finish a draft.

It proves that a name exists. It does not prove that the sentence about the name is true. That part is yours.

## Verify examples

- Put each example in a scratch file and compile it against the repo. For TypeScript, use the package's own `tsc` or `deno check`.
- Examples must use only public exports. Import from the published entry points, not from `src/`.
- Run examples that have side effects against a stub, not a live provider.

## Traps

- **Renamed things.** A prop renamed in the code still reads fine in the old doc. Grep for the exact spelling. (Example: a draft used `ref={chat}`. The prop is `chatRef`.)
- **Version drift.** Peer versions change. Point at `peerDependencies` instead of copying numbers, or copy the number from the file you just read.
- **A test that passes for the wrong reason.** If a test is your evidence, read its assertion.
- **Unpushed links.** A doc link to a file that is on your branch only is a 404 for the reader until it merges.
- **Behaviour in a dependency.** If the library does it (retries, parsing), name the library in the doc. Do not describe it as Theorem's own.
- **Stale comments in the code.** A comment is a claim too. Believe the code under it.
- **Subagent notes.** A note that says "unverified" is a lead. Verify it yourself before you use it.

## When you cannot prove it

Do one of these, in this order:

1. Delete the claim.
2. Ask the user to confirm it, and say which file would settle it.
3. State it as unverified in your report to the user. Never as a fact in the doc.

Do not use "usually", "typically" or "should" to cover a claim you did not check.
