# Contributing to Theorem

This page is for people and agents who change the Theorem repo. If you want to use Theorem in an application, please read the [README](README.md) instead.

After you read this page, you can set up the repo, run the checks that CI runs, and find the document that you must update when you change code.

## Set up

```bash
npm install
deno install
```

`npm install` also installs the git hooks. The pre-commit hook runs `npm run lint:docs`. The pre-push hook runs `fallow audit --base main`. Please do not skip a hook. If a hook fails, fix the cause.

## Run the checks

| Command | What it checks |
| --- | --- |
| `npm run test` | The Deno test suite. |
| `npm run lint` | Docs truth, Deno lint, Biome, ast-grep and Fallow. |
| `npm run check:react` | Type-check and theme check for `@theoremjs/react`. |
| `deno publish --dry-run` | The JSR package. |
| `npm run build:npm` | Builds the npm package into `npm/`. Run `cd npm && npm pack` to see the tarball. |
| `deno task verify:provider-smoke` | One real OpenRouter turn. It reads `OPENROUTER_API_KEY` from the shell, or from the file that `THEOREM_ENV_FILE` names. |

Never suppress a check. `npm run lint:docs` fails on a `biome-ignore`, `fallow-ignore`, `deno-lint-ignore`, `eslint-disable` or `@ts-expect-error` comment. Fix the cause. Every comment in `src/` and `react/src/` opens with `why:`, `invariant:`, `probed <date>:` or `license:`. The rules are in [`docs/writing/maintenance.md`](docs/writing/maintenance.md#comments-in-code).

Biome is the only formatter. Run `npx biome check --write <file>`.

To dry-run an npm publish when the current version is already on the registry, use a prerelease version first. CI does this for you.

```bash
cd npm
npm version 0.0.0-pr.local --no-git-tag-version
npm publish --dry-run --access public --tag ci-validate
```

The required `publish-dry-run` job in CI runs the JSR and npm dry runs on every pull request.

## Run the security scans locally

CI runs the same scans in the `Security` and `Mutation testing` workflows.

```bash
semgrep scan --config p/typescript --config p/secrets --metrics=off --error \
  --exclude tests --exclude npm --exclude studio --exclude tmp \
  src react/src mod.ts scripts
snyk test --all-projects --dev --exclude=studio,npm,tmp --severity-threshold=medium
snyk code test --severity-threshold=medium
npx stryker run stryker.guardrails.config.json --mutate src/guardrails/canary.ts --concurrency 4
```

The full guardrails mutation sweep has about 4,600 mutants. It takes more than an hour on one machine. Mutate only the files that you changed before you push. A merge to `main` mutates the files that it changes. The full sweep runs every week, or on demand:

```bash
gh workflow run mutation.yml --ref main
```

## Write documentation

Theorem keeps two kinds of documentation apart.

| Surface | Who reads it | In the npm package? |
| --- | --- | --- |
| `README.md`, `react/README.md` | People who use Theorem | Yes |
| `docs/contracts/*.md` | People who change Theorem | No |

Before you write or change any documentation, read [`docs/writing/README.md`](docs/writing/README.md). It is the one guide for every agent and every person. Two commands help:

```bash
node scripts/docs-claims.mjs check path/to/doc.md   # every name in the doc exists in the code
node scripts/docs-claims.mjs affected               # docs that mention what your change touched
```

`npm run lint:docs` makes a doc fail when its code changes. The rules are in [`docs/DOCS_TRUTH.md`](docs/DOCS_TRUTH.md) and the ownership graph is in [`docs/_map.mjs`](docs/_map.mjs). When you change code, update the contract that owns it.

| Contract | Owns |
| --- | --- |
| [`docs/contracts/kernel.md`](docs/contracts/kernel.md) | `@theoremjs/agents/kernel` and the headless `@theoremjs/agents/interface` |
| [`docs/contracts/stages.md`](docs/contracts/stages.md) | Turn stages |
| [`docs/contracts/providers.md`](docs/contracts/providers.md) | `@theoremjs/agents/providers` |
| [`docs/contracts/guardrails.md`](docs/contracts/guardrails.md) | `@theoremjs/agents/guardrails` |
| [`docs/contracts/observability.md`](docs/contracts/observability.md) | `@theoremjs/agents/observability` and its `jsonl`, `openinference` and `phoenix` entrypoints |
| [`docs/contracts/host.md`](docs/contracts/host.md) | `@theoremjs/agents/host` |
| [`docs/contracts/cli.md`](docs/contracts/cli.md) | `@theoremjs/agents/cli` |
| [`docs/contracts/presets.md`](docs/contracts/presets.md) | `@theoremjs/agents/presets` |
| [`docs/contracts/presets-google.md`](docs/contracts/presets-google.md) | `@theoremjs/agents/presets/google` |

Two migration notes explain past cuts: [`docs/MIGRATION-tool-system.md`](docs/MIGRATION-tool-system.md) (the old per-turn dynamic tools) and [`docs/MIGRATION-boundary.md`](docs/MIGRATION-boundary.md) (studio, quota, lexicon and composer moved out of the package).

## Keep the package boundary

The rule is: **the host decides, Theorem runs.** The [Package Boundary](README.md#package-boundary) section of the README states what Theorem must never do and lists the four invariants (P1 to P4) with the test that checks each. Do not copy that text here. Read it, and keep your change inside it.

## Publish

Only a maintainer publishes. JSR and npm publish from separate commands, and the `npm/` folder is the only folder that goes to npm. A new README appears on npmjs.com only after a new release.
