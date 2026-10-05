# Agent instructions

These instructions apply to every coding agent and every person who works in this repo.

## Writing documentation

Before you write, change or review any documentation, read [`docs/writing/README.md`](docs/writing/README.md) and follow it. Documentation means a README, a file in `docs/`, a changelog entry or JSDoc.

Two commands help. Run them from the repo root:

```bash
node scripts/docs-claims.mjs check path/to/doc.md   # every name in the doc exists in the code
node scripts/docs-claims.mjs affected               # docs that mention what your change touched
```

`npm run lint:docs` enforces ownership and freshness for contracts and the root `README.md`. Treat its failures like any lint error.
