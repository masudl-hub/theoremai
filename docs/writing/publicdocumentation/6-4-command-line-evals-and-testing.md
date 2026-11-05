# Command-Line Evals & Testing

Automated evaluation and regression testing must integrate into continuous integration (CI) workflows, pre-push git hooks, and headless test runners. Spinning up web browsers or HTTP servers to verify model behavior introduces flakiness, latency, and unnecessary architectural complexity.

Theorem includes a dedicated command-line interface in [`@theoremjs/agents/cli`](file:///Users/masudlewis/Development/theoremai/docs/contracts/cli.md). The `agents` binary runs eval suites against real or recorded traces, executes multimodal stress matrices, introspects registered profile blueprints, and runs adversarial guardrail fuzzers.

---

## Command Inventory

| Command | Purpose | Key Flags |
| :--- | :--- | :--- |
| [`agents eval`](#1-eval-suite-execution-agents-eval) | Evaluates a test suite module against live models or recorded trace cassettes | `--recorded`, `--trials`, `--threshold`, `--concurrency`, `--max-cost-usd`, `--json` |
| [`agents test`](#2-stress-testing-matrix-agents-test) | Runs synthetic matrix stress tests or quick liveness pings against a profile | `--lite`, `--matrix`, `--mode`, `--trace`, `--trace-dir`, `--verbose` |
| [`agents run`](#3-interactive-turn-execution-agents-run) | Executes a single turn against a registered profile with live streaming output | `--profile`, `--prompt`, `--mode`, `--trace`, `--verbose` |
| [`agents profile`](#4-profile-introspection-agents-profile) | Introspects registered profile definitions, models, inputs, and tool allowlists | `list`, `show <id>` |
| [`agents verify:guardrails-api`](#5-adversarial-red-teaming--fuzzing) | Runs adversarial penetration test suite against inbound sanitizers and egress canaries | `--category`, `--limit`, `--inbound-only` |
| [`agents bench`](#6-synthetic-kernel-benchmarks-agents-bench) | Microbenchmarks internal kernel event dispatch, latency, and throughput | `--chunks`, `--iterations`, `--warmup` |

---

## Installation & Invocation

The CLI is packaged inside `@theoremjs/agents`. It runs on Node (v20+), Deno, and Bun:

```bash
# Direct execution via npx
npx @theoremjs/agents <command> [options]

# Using Deno tasks
deno task agents <command> [options]

# Global or local npm binary
agents <command> [options]
```

> [!NOTE]
> The CLI operates on `defaultKernelScope`. Theorem's CLI does not manage API keys or embed application profiles directly. When running commands that execute live model calls (`run`, `test`, `eval`), the host application registers providers and key vaults in-process before delegating to the CLI.

---

## 1. Eval Suite Execution (`agents eval`)

The `eval` command evaluates an [`EvalSuite`](6-3-evals-and-benchmarks.md) module against live providers or recorded trace files.

### Live Suite Execution

Run a test suite against live models with concurrency and cost guardrails:

```bash
agents eval ./evals/harbor-clearance.eval.ts \
  --trials 3 \
  --concurrency 2 \
  --threshold 0.95 \
  --max-cost-usd 2.50 \
  --trace-dir /var/log/theorem/evals
```

- **`--trials <k>`**: Number of repetitions per test case, overriding the suite's default `trials.repeat`.
- **`--concurrency <n>`**: Number of concurrent trial runs in flight (defaults to `1`).
- **`--threshold <fraction>`**: The required fraction of decided cases that must pass for exit code `0` (defaults to `1.0`, meaning 100% pass required).
- **`--max-cost-usd <n>`**: Cost ceiling. The runner stops launching new trials once accumulated model spend crosses this dollar limit.
- **`--trace-dir <path>`**: Appends full `TraceRecord` events as JSON Lines (`.jsonl`) under the target directory.

### Offline Cassette Grading

To run deterministic, zero-cost CI checks without hitting external provider APIs, grade previously recorded trace cassettes:

```bash
agents eval ./evals/harbor-clearance.eval.ts \
  --recorded ./tests/cassettes/harbor/ \
  --threshold 1.0 \
  --json
```

When `--recorded` points to a trace file or directory, the CLI skips upstream network requests and evaluates the suite's graders directly against the recorded execution history.

---

## 2. Stress Testing Matrix (`agents test`)

The `test` command validates that a profile handles edge cases, attachments, voice clips, and model switching without unexpected errors:

```bash
# Quick ping test on the profile's 'fast' model
agents test --profile harbor.desk --lite

# Full multimodal stress matrix
agents test --profile harbor.desk --matrix --trace
```

### Lite vs. Matrix Modes

- **Lite (`--lite`)**: Sends a minimal text ping on the `fast` model alias (if configured and `allowModelSelect` is enabled).
- **Matrix / Stress (`--matrix`)**: Synthesizes a comprehensive multimodal request using synthetic test fixtures:
  - Injects a standard text prompt.
  - Attaches generated synthetic media (PNG, PDF, or CSV) matching the profile's `inputs.attachments.accept` allowlist.
  - Attaches a generated 16kHz WAV voice clip if `inputs.voice` is enabled.
  - Routes requests to the `smart` model alias to test complex reasoning and tool call generation.

A successful test prints duration, token counts, and cost estimates:

```text
▶ [THEOREM TEST] harbor.desk (Stress Matrix)
  Profile:     harbor.desk (Model: smart)
  Custom:      harbor_get_vessel, harbor_clear_quay
  Builtins:    googleSearch
  Attachments: 1 file(s) | Voice: yes
  ------------------------------------------------------------
✓ STATUS: PASSED (took 2.14s, 1420 tokens, includes estimates)
```

---

## 3. Interactive Turn Execution (`agents run`)

Execute a single prompt from the terminal with real-time streaming output and event logging:

```bash
agents run \
  --profile harbor.desk \
  --prompt "Vessel VSL-409 requesting clearance for Berth 4." \
  --mode smart \
  --verbose \
  --trace
```

### Diagnostic Flags

- **`--verbose`, `-v`**: Prints raw internal error details (`errorInternal`) and upstream evidence payloads (`evidence.raw`) during turn execution.
- **`--trace`**: Dumps the complete `TraceRecord` JSON structure to standard error upon turn completion.
- **`--trace-dir <dir>`**: Persists trace JSON Lines files to disk for downstream telemetry pipelines.

---

## 4. Profile Introspection (`agents profile`)

Inspect registered profiles in the default kernel registry to verify allowed inputs, model configurations, and tool permissions:

```bash
# List all registered profiles
agents profile list

# Show detailed specification for one profile
agents profile show harbor.desk
```

The output displays profile metadata, accepted inputs (text, voice, attachments), model bindings, and allowed custom/built-in tools:

```text
 • Profile: harbor.desk      (handle: dispatch) [text]
   - Models:     fast (gemini-3.5-flash-lite), smart (gemini-3.1-pro)
   - Inputs:     text | attachments [image/png, application/pdf]
   - Tools:      harbor_get_vessel, harbor_clear_quay
----------------------------------------------------------------------
```

---

## 5. Adversarial Red-Teaming & Fuzzing

The CLI includes built-in security fuzzers and red-teaming test suites for validating guardrails:

```bash
# Run real-provider adversarial red-team suite (~95 attack vectors)
agents verify:guardrails-api --category prompt_injection

# Fuzz canary token egress gates
agents fuzz-canary

# Compile regex detection rules into optimized tables
agents detect-compile ./src/guardrails/custom-rules.ts --out ./src/guardrails/compiled.ts
```

- **`verify:guardrails-api`**: Executes a battery of known prompt injections, jailbreaks, and indirect injection vectors against registered guardrail detectors, asserting that malicious payloads are intercepted.
- **`fuzz-canary`**: Generates high-entropy canary tokens and injects them into streaming replies, asserting that canary leaks are stopped before egress.
- **`detect-compile`**: Compiles pattern dictionaries into static lookup tables for high-speed pattern matching.

---

## 6. Synthetic Kernel Benchmarks (`agents bench`)

To measure overhead introduced by the Theorem kernel itself (isolated from external network latency), run synthetic microbenchmarks:

```bash
agents bench --chunks 200 --iterations 50 --warmup 5
```

The benchmark registers an in-memory mock provider and measures:
- **Time to First Event (TTFE)**: Wall-clock time required to resolve profile models and initialize kernel state.
- **Time to First Token (TTFT)**: Latency from turn request to first streamed text delta.
- **Throughput**: Chunks and tokens processed per second across multiple parallel turns.

---

## Related Guides

* **[Trace Spans Catalog](6-1-trace-spans-catalog.md)**: Catalog of kernel trace spans and telemetry structures emitted by `--trace`.
* **[Telemetry Destinations](6-2-telemetry-destinations.md)**: Exporting trace files collected via `--trace-dir` into OpenTelemetry and Datadog.
* **[Evals & Benchmarks](6-3-evals-and-benchmarks.md)**: Authoring `EvalSuite` specifications and custom trajectory graders.
* **[The Four Boundaries](4-1-the-four-boundaries.md)**: Guardrail enforcement tested by `verify:guardrails-api` and `fuzz-canary`.
