# Release notes

Each release has notes for a builder who uses the `@theoremjs` packages and decides whether to upgrade. After reading them, the builder knows what they gain, what was wrong before, and what they must change.

The notes for version `X.Y.Z` live in `docs/releases/vX.Y.Z.md`. Write them in the release pull request, beside the version bump. When the version is published, the `Publish npm` workflow posts the file as the GitHub release `vX.Y.Z`. `npm run lint:docs` fails when the version in `package.json` has no notes file, or when the file breaks the pattern below.

## The pattern

The file has these five sections, as `##` headings, in this order. Every section is present. A section with nothing to say holds the one word `None.`

| Section | What goes in it |
| --- | --- |
| `## Summary` | The gist of the release in one to three sentences: what a builder can do now that they could not before. No list. |
| `## What's New` | New features and new public APIs. |
| `## What's Fixed` | Behavior that was wrong and is now right. |
| `## Breaking Changes` | Each change that makes a builder change their code or their setup. |
| `## Notes` | Anything else a builder needs: upgrade order, peer versions, removals, known issues. |

## How to write each item

- **What's New.** One bullet per feature. Open with the name in bold, then say what the builder can do with it, in their terms. Name each export and its package: `createMemoryToolExecution` from `@theoremjs/agents`.
- **What's Fixed.** One bullet per fix. Say what the builder saw before, then what happens now.
- **Breaking Changes.** One bullet per change. Say what changed, who it affects, and what to do. Show the old and new code when a name or a signature changed.
- Follow [`docs/writing/writing.md`](../writing/writing.md): short sentences, active voice, one term for one thing.
- Every claim is true of the released code. Check each name with `node scripts/docs-claims.mjs check docs/releases/vX.Y.Z.md`.

## What stays out

Leave out work a builder cannot see: CI, tests, cassettes, mutation runs, refactors, internal renames, and docs-only changes. Do not list pull requests. A change goes in only for what it does for the builder.
