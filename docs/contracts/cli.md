# CLI (`@theoremjs/agents/cli`)

Profile inspection and stress-test CLI. On npm this entry is also the
`agents` binary. Hosts must register profiles (and providers) in-process
before commands that execute turns — the CLI does not embed app profiles.

## Export

| Field | Value |
| --- | --- |
| Import | `@theoremjs/agents/cli` / `jsr:@theoremjs/agents/cli` |
| Module | `src/cli/index.ts` |
| Binary | `agents` (npm `bin` → `src/cli/bin.ts`) |

## Ownership

| Path | Role |
| --- | --- |
| `src/cli/index.ts` | Argument parser + command dispatch (`main`) |
| `src/cli/bin.ts` | The `agents` executable: runs `main` on the process arguments |
| `src/cli/event-log.ts` | Shared `run`/`test` event printing + `--trace` capture |
| `src/cli/commands/*` | `bench`, `fuzz`, `test`, `run`, `eval`, `profile` |
| `src/cli/matrix/*` | Permutation synthesizer + fixtures |

## Commands

```text
agents <command> [options]
```

| Command | Purpose |
| --- | --- |
| `verify:guardrails-api` | Real-provider red-team of Theorem-owned guardrails (~95 adversarial cases); `--category`, `--limit`, `--inbound-only` |
| `verify:canary-api` | Alias for `verify:guardrails-api` |
| `cassettes:record` | Repo-only task: record real-provider turns for offline replay (`--model`, `--only`, `--missing`, `--stale`) |
| `cassettes:update` | Repo-only task: replay every cassette offline and keep the outcomes it now produces |
| `detect-compile <module>` | Compile the patterns in a module's exported `guardrails.detect` setting into the tables each detector's `compiled` takes (`--out <path>`, `--export <name>`, default `detect`); exit `1` on a pattern it cannot compile |
| `egress-compile <module>` | Compile a module's exported egress rules for `egressPolicy` (`--out <path>`, `--export <name>`, default `rules`); exit `1` on a rule it cannot compile |
| `fuzz` | Adversarial inbound sanitization fuzzer; exit `1` on expected miss |
| `fuzz-canary` | Adversarial canary egress fuzzer (`runTurn` stream gate + Live batch gate; an attack's turns are one turn's provider calls, or one session's cycles); exit `1` on bypass |
| `guardrails:eval` | Repo-only task, not in the published CLI: score guardrail detectors against external corpora (`--cache-dir`, `--limit`) |
| `bench` | Synthetic kernel performance benchmark (`--chunks`, `--iterations`, `--warmup`) |
| `test` | Stress matrix or custom profile tests (`--profile`, `--all`, `--lite`, `--matrix`, `--mode`, `--search`, `--map`, `--verbose`, `--trace`, `--trace-dir`) |
| `run` | Execute a turn with streaming output (`--profile`, `--prompt`, `--mode`, `--verbose`, `--trace`, `--trace-dir`, …) |
| `eval <suite>` | Run an eval suite module live, or grade recorded traces (`--recorded <file\|dir>`, `--trials <k>`, `--concurrency <n>`, `--max-cost-usd <n>`, `--threshold <fraction>`, `--trace-dir`, `--json`); exit `1` below the threshold or on a budget stop |
| `profile list` / `profile show <id>` | Inspect registered profile blueprints (text, image, speech, live, decision). `run` and `test` remain turn paths; decision profiles run through host code with `runDecision`. |
| `help` | Usage |

Exit code `1` on failed `test` runs. `run` requires `--profile` (or `-p`).
`eval` takes the suite module's path (`export default` an `EvalSuite`, see
`docs/contracts/evals.md`); it prints one row per case (trials passed, errored,
ungraded) and, for a failed case, every result that failed a trial in the
grader's words. Live mode needs a provider the host passes to `evalCommand` or
the suite module exports as `provider`. A text judge needs a provider too
(`judgeProvider` in `evalCommand`'s host argument, the suite's `judgeProvider`
export, else the agent's) and a Jev judge a key (`judgeDecision` in the host
argument, else the suite's `judgeDecision` export); the CLI creates no
provider and reads no key. `--threshold` is the fraction of decided cases
that must pass for exit `0` (default `1`); a case whose trials errored too
often to decide counts neither way, and a run that decided none exits `1`. Trials start in suite order, `--concurrency`
at a time (default `1`), and are reported in suite order whatever finished
first.
Every command runs on the default kernel scope (`defaultKernelScope`): the
profiles and tools it sees are the ones registered through the global API.
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
| `matrix/synthesizer.ts` | Builds the requests `test` sends |
| `matrix/fixtures.ts` | Synthetic media: PNG, PDF, WAV (generated), CSV, plain text; `getFixtureForMime` picks by MIME |

`test --matrix` sends two requests per profile (`synthesizeMatrixCombos`);
plain `test` sends one (`buildCustomTurnRequest`): Stress, or Lite with
`--lite`, with `--mode` setting its model. Host and decision profiles run no
model turn and are skipped. **Lite** is a one-line text ping,
on model `fast` when `allowModelSelect` is set and `fast` exists. **Stress** sends
a text prompt plus one attachment and one voice clip where the profile accepts
them, on `smart` (or the last model) when `allowModelSelect` is set. The
attachment is the first of PNG, PDF, plain text that `inputs.attachments.accept`
lists, else its first MIME; the voice clip is the WAV fixture when
`inputs.voice.accept` is non-empty. Only `text` and `image` profiles have
`inputs` (`profileInputs`), so other types get the text prompt alone. Both
requests always carry text, so a profile with `inputs.text: false` fails them
at ingress.

The matrix sets no tools; the profile's allowlist applies as on any turn.
`--search` and `--map` add nothing to the request: they throw unless the
selected model's `builtInTools` include `googleSearch` / `googleMaps`.

## Exported API

The entry module exports `main(args?)`, which reads the process arguments by
default; `src/cli/bin.ts` runs it as the `agents` binary. It runs on Node
(20 and up), Deno and Bun.

Prefer `deno task agents` / `npx @theoremjs/agents` over importing commands in
application code.

```theorem-evidence
{
  "sections": {
    "Export": {
      "supports": [
        { "kind": "source", "path": "src/cli/index.ts" },
        { "kind": "source", "path": "src/cli/bin.ts" },
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
        { "kind": "source", "path": "src/cli/commands/eval.ts" },
        { "kind": "contract_test", "path": "tests/cli/cli.test.ts" },
        { "kind": "contract_test", "path": "tests/cli/eval.test.ts" }
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
