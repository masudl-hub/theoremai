# CLI (`@theoremai/agents/cli`)

Profile inspection and stress-test CLI. On npm this entry is also the
`agents` binary. Hosts must register profiles (and providers) in-process
before commands that execute turns — the CLI does not embed app profiles.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremai/agents/cli` / `jsr:@theoremai/agents/cli` |
| Module | `src/cli/index.ts` |
| Binary | `agents` (npm `bin`) |

## Ownership

| Path | Role |
| --- | --- |
| `src/cli/index.ts` | Argument parser + command dispatch |
| `src/cli/event-log.ts` | Shared `run`/`test` event printing + `--trace` capture |
| `src/cli/commands/*` | `bench`, `fuzz`, `test`, `run`, `profile`, `guardrails-eval` |
| `src/cli/matrix/*` | Permutation synthesizer + fixtures |

## Commands

```text
agents <command> [options]
```

| Command | Purpose |
| --- | --- |
| `verify:guardrails-api` | Real-provider red-team of Theorem-owned guardrails (~95 adversarial cases); `--category`, `--limit`, `--inbound-only` |
| `verify:canary-api` | Alias for `verify:guardrails-api` |
| `fuzz` | Adversarial inbound sanitization fuzzer; exit `1` on expected miss |
| `fuzz-canary` | Adversarial canary egress fuzzer (`runTurn` stream gate + Live batch gate); exit `1` on bypass |
| `guardrails-eval` | Score guardrail detectors against external corpora (`--cache-dir`, `--limit`) |
| `bench` | Synthetic kernel performance benchmark (`--chunks`, `--iterations`, `--warmup`) |
| `test` | Stress matrix or custom profile tests (`--profile`, `--all`, `--lite`, `--matrix`, `--mode`, `--search`, `--map`, `--verbose`, `--trace`, `--trace-dir`) |
| `run` | Execute a turn with streaming output (`--profile`, `--prompt`, `--mode`, `--verbose`, `--trace`, `--trace-dir`, …) |
| `profile list` / `profile show <id>` | Inspect registered profile blueprints (text, image, speech, live, decision). `run` and `test` remain turn paths; decision profiles run through host code with `runDecision`. |
| `help` | Usage |

Exit code `1` on failed `test` runs. `run` requires `--profile` (or `-p`).
`profile show` and `test` list custom tools from the kernel's `profileToolAllow`,
so profile types without a `tools` block (`speech`, `decision`) show `none`.
A passing `test` prints the turn's token total (`sumTokens` over every model
call's `tokens` event), followed by `, includes estimates` when any call's
count was estimated: `✓ STATUS: PASSED (took 2.31s, 1234 tokens, includes estimates)`.
`TestRunResult.tokens` carries the full sum.
Both `test` and `run` print Google `code_execution_*` (and other) `evidence`
events when a host-supplied provider yields them — hosts still must pass an
explicit `ModelProvider` (the CLI never reads API keys).

### Diagnostics flags (`run`, `test`)

| Flag | Effect |
| --- | --- |
| `--verbose`, `-v` | Print `errorInternal` and `evidence.raw` while the turn runs; with `--trace`, also print the record's upstream rows (`theorem.upstream.row`) after it |
| `--trace` | Attach a trace sink; dump the full `TraceRecord` JSON after each turn |
| `--trace-dir <path>` | Also append trace JSONL under the given directory (in addition to `--trace` console dump) |

```bash
agents run --profile my.agent --prompt "ping" --verbose --trace
agents test --profile my.agent --lite --trace --trace-dir /var/log/theorem
```
## Matrix and fixtures

| Module | Role |
| --- | --- |
| `matrix/synthesizer.ts` | Builds valid permutation cases (modes, optional tools, reasoning) |
| `matrix/fixtures.ts` | Shared harness fixtures (not product personas) |

Tool stress / matrix allowlists are `profile.tools.allow` plus each selected
model's `builtInTools` (via `pickModel` / union across `models`). Builtin
conflict resolution uses registered tool `type === 'builtin'` metadata.
The matrix respects those allowlists — e.g. `--search` only applies when
`googleSearch` is allowlisted, while file/voice synthesizers run only for profiles the kernel's `profileInputs`
gives turn inputs (`text`, `image`).

## Exported API

The entry module is the CLI program itself (side-effect main when run as a
bin). Prefer `deno task agents` / `npx @theoremai/agents` over importing commands in
application code.

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/cli/index.ts" },
        { "kind": "config", "path": "package.json" }
      ]
    },
    "Ownership": {
      "supports": [
        { "kind": "source", "path": "src/cli/index.ts" },
        { "kind": "graph", "path": "docs/_map.mjs" }
      ]
    },
    "Commands": {
      "supports": [
        { "kind": "source", "path": "src/cli/index.ts" },
        { "kind": "source", "path": "src/cli/commands/run.ts" },
        { "kind": "contract_test", "path": "tests/cli/cli.test.ts" }
      ]
    },
    "Matrix and fixtures": {
      "supports": [
        { "kind": "source", "path": "src/cli/matrix/synthesizer.ts" },
        { "kind": "contract_test", "path": "tests/cli/cli.test.ts" }
      ]
    },
    "Exported API": {
      "supports": [
        { "kind": "source", "path": "src/cli/index.ts" },
        { "kind": "contract_test", "path": "tests/cli/cli.test.ts" }
      ]
    }
  }
}
```
