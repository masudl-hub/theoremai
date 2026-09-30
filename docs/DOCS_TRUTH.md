# Docs truth (`docs/_map.mjs`)

Deterministic document-health lint for THEOREM. No waivers. No LLM.

## Export

| Field | Value |
| --- | --- |
| CLI | `scripts/docs-truth/cli.mjs` (`lint`, `inventory`, `freshness`) |
| Export drift | `scripts/docs-truth/export-drift.mjs` (barrel exports vs contracts) |
| Copy lint | `scripts/docs-truth/copy-lint.mjs` (P2 — full-tree prose in `src/kernel` / `src/guardrails` / `src/interface` and the headless `react/src` directories (not `ui/`) must live in the lexicon or carry an explicit exempt) |
| Graph | `docs/_map.mjs` |

## Ownership

| Path | Role |
| --- | --- |
| `scripts/docs-truth/graph.mjs` | Graph load, ownership, evidence, freshness |
| `scripts/docs-truth/cli.mjs` | `lint`, `inventory`, `freshness` |
| `scripts/docs-truth/export-drift.mjs` | Entrypoint export vs contract drift |
| `scripts/docs-truth/copy-lint.mjs` | Emit-site copy vs lexicon (P2) |
| `scripts/docs-truth/graph.test.mjs` | Contract tests |
| `docs/_map.mjs` | Export → doc ownership graph |

## Rules

| Rule | Behavior |
| --- | --- |
| Full ownership | Every production-root file has exactly one `owns` entry in `docs/_map.mjs` |
| Schema validation | Manifest specifies `theorem.docs-truth/v1` schema |
| Doc freshness | Changed *existing* code → owning doc appears in the diff (deletions skipped). "Changed" is `THEOREM_DOCS_BASE...HEAD` (default `origin/main`) plus staged and unstaged edits; a comment-only edit counts |
| Section freshness | Watches/`section_triggers` → specific `##` headings must change |
| Owned fallback | Owned files → at least one behavioral section hunk |
| Evidence | ≥ `min_evidence_supports` supports (default 2); behavioral sections require `contract_test` or `validation` evidence |
| Export drift | Every `export { name }` / `export type { Name }` in a published entry point (each `deno.json` export, not only `mod.ts` files) appears in the contract of the graph entry that owns that export (`export-drift.mjs`) |
| Copy lint | A string literal of ≥3 alphabetic words in `src/kernel` / `src/guardrails` / `src/interface` or headless `react/src` (`client`, `components`, `hooks`, `server`) fails outside `src/guardrails/lexicon.ts` (`copy-lint.mjs`). `react/src/ui` owns its wording and is not scanned. `// lexicon-exempt: <reason>` goes on the same or previous line; `lexicon-exempt-file: <reason>` goes in the first 40 lines of a non-runtime fixture module |

## Package vs repo documentation

Two documentation surfaces. Do not mix them in the publish tarball.

| Surface | Lives in | Ships in package? | Maintained by |
| --- | --- | --- | --- |
| **Package docs** | `README.md` (consumer how-to) | Yes | docs-truth entry `package` — export tables, public API, boundary |
| **Repo contracts** | `docs/contracts/*.md`, `docs/DOCS_TRUTH.md`, `docs/_map.mjs` | **No** | docs-truth module entries — ownership, freshness, evidence |

Publish gates:

| Gate | Rule |
| --- | --- |
| `package.json` `files` | Must not include `docs/` |
| `.npmignore` | Excludes `docs/` and `src/**/*.md` |
| `deno.json` `publish.exclude` | Includes `docs/` and `src/**/*.md` |
| `scripts/verify-publish-bundle.ts` | Asserts the above before publish |
| `scripts/build-npm.ts` | Strips residual `*.md` from the dnt output tree (except root README) |

Contracts live under `docs/contracts/` (repo-only). Module code under `src/` stays
owned by those contracts for freshness — change code, update the matching contract.

## Production roots

| Root | Files |
| --- | --- |
| `mod.ts` | Package barrel (`@theoremjs/agents`) |
| `package.json` | Published exports |
| `src/**/*.ts` | Kernel + adapters (live tree only; deleted paths skip freshness) |
| `scripts/docs-truth/**/*.mjs` | Docs-truth linter |

## CI and hooks

| Layer | Command |
| --- | --- |
| `npm run lint` | Runs `lint:docs` first, then `deno lint`, biome, ast-grep, and fallow |
| `deno task lint` | Same as `npm run lint` |
| `npm run check:ci` / `deno task ci` | Full CI gate: docs-truth, deno lint, biome, ast-grep, verify:publish, fallow, typecheck (`mod.ts`, the subprocess probe fixtures the tests spawn unchecked, `scripts/*.ts`, and `react/` via its own `tsc`, since it builds against the kernel as the `@theoremjs/agents` package), and tests (publish check before fallow, which writes `coverage/`) |
| CI | `lint:docs` (with `THEOREM_DOCS_BASE`), `deno lint`, then `lint:biome` + `lint:ast-grep` + `lint:fallow` (`FALLOW_AUDIT_BASE=origin/<base>`) |
| Pre-commit | `npm run lint:docs` (auto-installed by `prepare` / `hooks:install`) |
| Pre-push | `fallow audit --base origin/main` (uses `coverage/coverage-final.json` when present) |

`lint:fallow` runs Istanbul coverage, then `fallow audit --base $FALLOW_AUDIT_BASE` (default `origin/main`), then full-tree `health` / `dupes` / `dead-code`. No threshold waivers.

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
        { "kind": "contract_test", "path": "scripts/docs-truth/graph.test.mjs" }
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
