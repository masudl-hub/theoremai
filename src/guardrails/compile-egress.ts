/**
 * Build-time compiler for host egress rules (`@theoremjs/agents/guardrails/compile`).
 *
 * `compileEgressRules` turns the rules into the table `egressPolicy` loads;
 * `agents egress-compile` runs it on a module and writes the table as a module.
 * It imports `refa`, so it belongs in a build step, not a Worker.
 *
 * @module
 */

export { compiledEgressModule, compileEgressRules } from './egress-compiler.ts';
