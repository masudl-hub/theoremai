/**
 * Compiler for a host's own patterns (`@theoremjs/agents/guardrails/compile`).
 *
 * `compileDetect` gives every detector's `patterns` the table the stream holds by, for a
 * host that compiles as it starts; `agents detect-compile` writes the tables as a module at
 * build time. `compileEgressRules` does the same for `egressPolicy`'s rules.
 * It imports `refa`, so it belongs in a build step or a server's startup, not a Worker.
 *
 * @module
 */

export {
  compileDetect,
  compileDetectTables,
  compiledDetectModule,
  compiledEgressModule,
  compileEgressRules,
  compilePatterns,
} from './egress-compiler.ts';
