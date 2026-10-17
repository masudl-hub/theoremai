/**
 * Compiler for a host's own patterns (`@theoremjs/agents/guardrails/compile`).
 *
 * `compileDetect` gives every detector's `patterns` the table the stream holds by, for a
 * host that compiles as it starts; `agents detect-compile` writes the tables as a module at
 * build time. `slowPatternProblem` says what makes one pattern slow on hostile text, for a
 * host that checks patterns it takes from elsewhere, such as a tool schema's. It imports `refa`, so it belongs in a build step or a server's startup, not a Worker.
 *
 * @module
 */

export {
  compileDetect,
  compileDetectTables,
  compiledDetectModule,
  compilePatterns,
  slowPatternProblem,
} from './egress-compiler.ts';
