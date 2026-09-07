# Docs truth (`docs/_map.mjs`)

Deterministic document-health lint for THEORUM. No waivers. No LLM.

## Export

| Field | Value |
| --- | --- |
| CLI | `scripts/docs-truth/cli.mjs` (`lint`, `inventory`, `freshness`) |
| Export drift | `scripts/docs-truth/export-drift.mjs` |
| Graph | `docs/_map.mjs` |

## Ownership

| Path | Role |
| --- | --- |
| `scripts/docs-truth/graph.mjs` | Graph load, ownership, evidence, freshness |
| `scripts/docs-truth/cli.mjs` | `lint`, `inventory`, `freshness` |
| `scripts/docs-truth/export-drift.mjs` | Entrypoint export vs contract drift |
| `scripts/docs-truth/graph.test.mjs` | Contract tests |
| `docs/_map.mjs` | Export → doc ownership graph |

## Rules

| Rule | Behavior |
| --- | --- |
| Full ownership | Every production-root file has exactly one `owns` entry |
| Doc freshness | Changed *existing* code → owning doc appears in git diff (deletions skipped) |
| Section freshness | Watches/`section_triggers` → specific `##` headings must change |
| Owned fallback | Owned files → at least one behavioral section hunk |
| Evidence | ≥2 supports; behavioral sections require `contract_test` |
| Export drift | Entry `mod.ts` export names appear in owner contract |

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
| `mod.ts` | Package barrel |
| `package.json` | Published exports |
| `src/**/*.ts` | Kernel + adapters (live tree only; deleted paths skip freshness) |
| `scripts/docs-truth/**/*.mjs` | Docs-truth linter |

## CI and hooks

| Layer | Command |
| --- | --- |
| `npm run lint` | Runs `lint:docs` first, then biome / ast-grep / fallow |
| `deno task lint` | Same as `npm run lint` |
| CI | `npm run lint:docs` with `THEORUM_DOCS_BASE=origin/<base>` |
| Pre-commit | `npm run lint:docs` (auto-installed by `prepare` on `npm install`) |

Fallow: `docs/_map.mjs` is listed under `dynamicallyLoaded` in `.fallowrc.jsonc`
(docs-truth imports it at runtime; static analysis cannot see the edge).

Re-install manually: `npm run hooks:install`

```theorum-evidence
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
