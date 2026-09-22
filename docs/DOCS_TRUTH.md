# Docs truth (`docs/_map.mjs`)

Deterministic document-health lint for THEOREM. No waivers. No LLM.

This contract was refreshed alongside the current release branch so the docs-truth ownership graph stays aligned with the live code surface and package metadata.

## Export

| Field | Value |
| --- | --- |
| CLI | `scripts/docs-truth/cli.mjs` (`lint`, `inventory`, `freshness`) |
| Export drift | `scripts/docs-truth/export-drift.mjs` (barrel exports vs contracts) |
| Copy lint | `scripts/docs-truth/copy-lint.mjs` (P2 — full-tree prose in `src/kernel` / `src/guardrails` / `src/interface` must live in the lexicon or carry an explicit exempt) |
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

The active branch refresh keeps the docs-truth rules in sync with the runtime graph, ownership checks, and production-root enforcement used by the repo.

| Rule | Behavior |
| --- | --- |
| Full ownership | Every production-root file has exactly one `owns` entry in `docs/_map.mjs` |
| Schema validation | Manifest specifies `theorem.docs-truth/v1` schema |
| Doc freshness | Changed *existing* code → owning doc appears in git diff (deletions skipped) |
| Section freshness | Watches/`section_triggers` → specific `##` headings must change |
| Owned fallback | Owned files → at least one behavioral section hunk |
| Evidence | ≥2 supports; behavioral sections require `contract_test` |
| Export drift | Entry `mod.ts` export names appear in owner contract (checked by `export-drift.mjs`) |
| Copy lint | Full-tree prose (≥3 words) in `src/kernel` / `src/guardrails` / `src/interface` outside `lexicon.ts` fails (`copy-lint.mjs`); `// lexicon-exempt:` / `lexicon-exempt-file:` require a reason |

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

The current codebase refresh keeps the production-root list aligned with the actual live tree and the docs-truth validation gate used in CI.

| Root | Files |
| --- | --- |
| `mod.ts` | Package barrel (`@theoremai/agents`) |
| `package.json` | Published exports |
| `src/**/*.ts` | Kernel + adapters (live tree only; deleted paths skip freshness) |
| `scripts/docs-truth/**/*.mjs` | Docs-truth linter |

## CI and hooks

| Layer | Command |
| --- | --- |
| `npm run lint` | Runs `lint:docs` first, then `deno lint`, biome, ast-grep, and fallow |
| `deno task lint` | Same as `npm run lint` |
| `npm run check:ci` / `deno task ci` | Full CI gate: docs-truth, deno lint, biome, ast-grep, fallow, typecheck, verify:publish, and tests |
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
