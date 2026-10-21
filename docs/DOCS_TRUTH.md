# Docs truth (`docs/_map.mjs`)

Deterministic document-health lint for THEOREM. No waivers. No LLM.

## Export

| Field | Value |
| --- | --- |
| CLI | `scripts/docs-truth/cli.mjs` (`lint`, `inventory`, `freshness`) |
| Export drift | `scripts/docs-truth/export-drift.mjs` (barrel exports vs contracts) |
| Copy lint | `scripts/docs-truth/copy-lint.mjs` (P2 — full-tree prose in `src/kernel` / `src/guardrails` / `src/interface` the headless `react/src` directories (not `ui/`), and `web/src` must live in the labels or carry an explicit exempt) |
| Release notes | `scripts/docs-truth/release-notes.mjs` (each version's notes in `docs/releases/`, in the five sections) |
| Graph | `docs/_map.mjs` |

## Ownership

| Path | Role |
| --- | --- |
| `scripts/docs-truth/graph.mjs` | Graph load, ownership, evidence, freshness |
| `scripts/docs-truth/cli.mjs` | `lint`, `inventory`, `freshness` |
| `scripts/docs-truth/export-drift.mjs` | Entrypoint export vs contract drift |
| `scripts/docs-truth/copy-lint.mjs` | Emit-site copy vs labels (P2) |
| `scripts/docs-truth/release-notes.mjs` | Release notes shape |
| `scripts/docs-truth/release-notes.test.mjs` | Release notes tests |
| `scripts/docs-truth/graph.test.mjs` | Contract tests |
| `docs/_map.mjs` | Entrypoint and document ownership graph |
| `react/README.md` | Consumer guide owned by the `react-package` entry |
| `web/README.md` | Consumer guide owned by the `web-package` entry |

## Rules

| Rule | Behavior |
| --- | --- |
| Full ownership | Every production-root file has exactly one `owns` entry in `docs/_map.mjs` |
| Schema validation | Manifest specifies `theorem.docs-truth/v1` schema |
| Doc freshness | Changed existing production or explicitly mapped files require their owning or watching document in the diff. Deleted files are skipped. The base is `THEOREM_DOCS_BASE...HEAD` (default `origin/main`), plus staged and unstaged edits. |
| Section freshness | Watches/`section_triggers` → specific `##` headings must change, read from one diff between the fork point with the base and the working tree, so uncommitted edits cannot shift a hunk into the wrong section |
| Owned fallback | Owned files → at least one behavioral section hunk |
| Evidence | ≥ `min_evidence_supports` supports (default 2); behavioral sections require `contract_test` or `validation` evidence |
| Export drift | Every `export { name }` / `export type { Name }` in a published entry point (each `deno.json` export, not only `mod.ts` files) appears in the contract of the graph entry that owns that export (`export-drift.mjs`) |
| Copy lint | A string literal of ≥3 alphabetic words in `src/kernel` / `src/guardrails` / `src/interface` headless `react/src` (`client`, `components`, `hooks`), or `web/src` (`client`, `server`) fails outside `src/guardrails/labels.ts` (`copy-lint.mjs`). `react/src/ui` owns its wording and is not scanned. `// labels-exempt: <reason>` goes on the string line, or above it in the same statement; `labels-exempt-file: <reason>` goes in the first 40 lines of a non-runtime fixture module |
| Release notes | `docs/releases/v<version>.md` exists for the `package.json` version. Every `docs/releases/v*.md` opens with `# v<version>`, then has the `##` sections Summary, What's New, What's Fixed, Breaking Changes, and Notes, in that order. No section is empty (`None.` when there is nothing) and no notes link a pull request (`release-notes.mjs`) |

## Package vs repo documentation

Two documentation surfaces. Do not mix them in the publish tarball.

| Surface | Lives in | Ships in package? | Maintained by |
| --- | --- | --- | --- |
| **Package docs** | `README.md`, `react/README.md`, `web/README.md` | Yes, in their respective packages | Entries `package`, `react-package` and `web-package` |
| **Repo contracts** | `docs/contracts/*.md`, `docs/DOCS_TRUTH.md`, `docs/_map.mjs` | **No** | docs-truth module entries — ownership, freshness, evidence |

Publish gates:

| Gate | Rule |
| --- | --- |
| `package.json` `files` | Must not include `docs/` |
| `.npmignore` | Excludes `docs/` and `src/**/*.md` |
| `deno.json` `publish.exclude` | Includes `docs/` and `src/**/*.md` |
| `scripts/verify-publish-bundle.ts` | Asserts the above before publish |
| `scripts/build-npm.ts` | Strips residual `*.md` from the dnt output tree (except root README) |
| `scripts/build-npm-react.ts` | Type-checks the local Studio prototype, then removes its emitted files from the React package |
| `scripts/build-npm-web.ts` | Builds the web package and copies its audio worklet beside the emitted files |

Package verification rejects Studio modules in the agents, React and web build output, and any React import in the web source or build.

Contracts live under `docs/contracts/` (repo-only). Module code under `src/` stays
owned by those contracts for freshness — change code, update the matching contract.

## Production roots

| Root | Files |
| --- | --- |
| `mod.ts` | Package barrel (`@theoremjs/agents`) |
| `package.json` | Published exports |
| `src/**/*.ts` | Kernel + adapters (live tree only; deleted paths skip freshness) |
| `scripts/docs-truth/**/*.mjs` | Docs-truth linter; changes require the relevant section of this document |

Explicit mappings also monitor files outside these production roots.
The `react-package` entry monitors `react/src/` and `react/package.json`.
This includes TypeScript, TSX, JavaScript worklets, and stylesheets. Changes require `react/README.md` in the diff.
Its provider and session watches require updates to the relevant README sections.
The `web-package` entry monitors `web/src/` and `web/package.json` the same way. Changes require `web/README.md` in the diff.

## CI and hooks

| Layer | Command |
| --- | --- |
| `npm run lint` | Runs `lint:docs` first, then `deno lint`, biome, ast-grep, and fallow |
| `deno task lint` | Same as `npm run lint` |
| `npm run check:ci` / `deno task ci` | Full CI gate: docs-truth, deno lint, biome, ast-grep, verify:publish, fallow, typecheck (`mod.ts`, the subprocess probe fixtures the tests spawn unchecked, `scripts/*.ts`, and `web/` and `react/` each via its own `tsc`, since each builds against the kernel as the `@theoremjs/agents` package), and the tests, run once with coverage for fallow (`lint:fallow`, last) |
| CI | `lint` job: `lint:docs` (with `THEOREM_DOCS_BASE`), `deno lint`, `lint:biome`, `lint:ast-grep`. `check` job: typechecks, `verify:publish`, studio tests, then `lint:fallow` (`FALLOW_AUDIT_BASE=origin/<base>`), which runs the test suite once with coverage |
| Pre-commit | `npm run lint:docs` (auto-installed by `prepare` / `hooks:install`) |
| Pre-push | `fallow audit` against the branch's upstream, or `FALLOW_AUDIT_BASE` (uses the generated coverage report when present) |

`lint:fallow` runs the test suite once, in parallel, with coverage (`npm run coverage`), then `fallow audit --base $FALLOW_AUDIT_BASE` (default `origin/main`) against it. `lint:fallow:deep` runs full-tree `health` / `dupes` / `dead-code`. No threshold waivers.

Fallow: `docs/_map.mjs` is listed under `dynamicallyLoaded` in `.fallowrc.jsonc`
(docs-truth imports it at runtime; static analysis cannot see the edge).

Re-install manually: `npm run hooks:install`

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "scripts/docs-truth/cli.mjs" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "scripts/docs-truth/graph.mjs" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Rules": {
      "supports": [
        { "kind": "source", "path": "scripts/docs-truth/graph.mjs" },
        { "kind": "source", "path": "scripts/docs-truth/copy-lint.mjs" },
        { "kind": "source", "path": "scripts/docs-truth/release-notes.mjs" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" },
        { "kind": "contract_test", "path": "scripts/docs-truth/release-notes.test.mjs" }
      ]
    },
    "Package vs repo documentation": {
      "supports": [
        { "kind": "config", "path": "package.json" },
        { "kind": "config", "path": "deno.json" },
        { "kind": "config", "path": ".npmignore" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    },
    "Production roots": {
      "supports": [
        { "kind": "graph", "path": "docs/_map.mjs" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    },
    "CI and hooks": {
      "supports": [
        { "kind": "config", "path": "package.json" },
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
      ]
    }
  }
}
```
