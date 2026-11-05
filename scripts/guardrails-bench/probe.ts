/** labels-exempt-file: benchmark runner — not runtime user or model copy (P2) */
import type { Boundary } from '../../src/guardrails/boundaries.ts';
import { detectAt, isScoped } from '../../src/guardrails/detect-at.ts';
import {
  DETECTOR_BOUNDARIES,
  DETECTORS,
  type DetectAction,
  type Detector,
  type DetectorRule,
  type DetectSpec,
  type ResolvedDetect,
  resolveDetect,
} from '../../src/guardrails/detectors.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import type { ProbeOutcome } from '../../studio/guardrail-bench.ts';
import {
  PROBE_READS,
  PROBE_TEXT_LIMIT,
  type ProbeBoundary,
  runGuardrailProbe,
} from '../../studio/guardrail-probe.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  compileWorkspace,
  createExampleDraft,
  workspaceFromDraft,
  workspaceRunAgent,
} from '../../studio/mod.ts';

const DETECTOR_OF = new Map<string, Detector>(
  Object.entries(DETECT_RULES).map(([detector, rule]) => [rule, detector as Detector]),
);

/** Every detector on `flag`: each match is recorded and nothing changes, so what crosses stays readable. */
const FLAG_ALL: ResolvedDetect = resolveDetect('flag');

const ALONE = new Map<string, ResolvedDetect>();

/** One detector on `flag` at one boundary, the others off: what that detector alone costs there. */
function alone(detector: Detector, boundary: Boundary): ResolvedDetect {
  const key = `${detector}@${boundary}`;
  let matrix = ALONE.get(key);
  if (!matrix) {
    const at: Partial<Record<Boundary, DetectAction>> = {};
    at[boundary] = 'flag';
    const spec: Partial<Record<Detector, DetectorRule>> = {};
    for (const each of DETECTORS)
      spec[each] = each === detector ? { action: 'ignore', at } : 'ignore';
    matrix = resolveDetect(spec);
    ALONE.set(key, matrix);
  }
  return matrix;
}

/** The detectors that read the kernel boundary a probe boundary crosses. */
export function detectorsAt(boundary: ProbeBoundary): Detector[] {
  const read = PROBE_READS[boundary];
  return DETECTORS.filter((detector) => DETECTOR_BOUNDARIES[detector].includes(read));
}

function timeEach(text: string, boundary: ProbeBoundary): ProbeOutcome['detectorMs'] {
  const read = PROBE_READS[boundary];
  const out: ProbeOutcome['detectorMs'] = {};
  for (const detector of detectorsAt(boundary)) {
    if (isScoped(detector)) continue;
    const start = performance.now();
    detectAt(text, read, alone(detector, read));
    out[detector] = performance.now() - start;
  }
  return out;
}

function namedDetectors(rules: readonly string[]): Detector[] {
  return [...new Set(rules.flatMap((rule) => DETECTOR_OF.get(rule) ?? []))];
}

/** The example agent with every detector on `flag`, compiled once per worker. */
export function benchAgent() {
  const compiled = compileWorkspace(workspaceFromDraft(createExampleDraft()), ON_OWN_KEYS);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const run = workspaceRunAgent(compiled, 'travel.concierge');
  if (!run) throw new Error('The example draft has no travel.concierge agent.');
  const detect: DetectSpec = 'flag';
  return { ...run, profile: { ...run.profile, guardrails: { ...run.profile.guardrails, detect } } };
}

/** `agent` with `system` as its whole system prompt, all of it private. */
function withSystem(agent: ReturnType<typeof benchAgent>, system: string) {
  const { profile } = agent;
  if (!('identity' in profile)) throw new Error(`${profile.id} takes no system prompt.`);
  return { ...agent, profile: { ...profile, identity: { ...profile.identity, system } } };
}

export async function probeOne(
  agent: ReturnType<typeof benchAgent>,
  boundary: ProbeBoundary,
  text: string,
  system?: string,
): Promise<ProbeOutcome> {
  const detectorMs = timeEach(text, boundary);
  if (text.length > PROBE_TEXT_LIMIT) {
    const start = performance.now();
    const detection = detectAt(text, PROBE_READS[boundary], FLAG_ALL);
    const ms = performance.now() - start;
    const rules = [...new Set(detection.hits.map((hit) => hit.rule))];
    return {
      status: rules.length > 0 ? 'flagged' : 'passed',
      via: 'detect',
      read: detectorsAt(boundary).filter((detector) => !isScoped(detector)),
      detectors: namedDetectors(rules),
      rules,
      ms,
      detectorMs,
    };
  }
  const start = performance.now();
  const turn = system ? withSystem(agent, system) : agent;
  const result = await runGuardrailProbe({ ...turn, probe: { boundary, text } });
  const ms = performance.now() - start;
  const rules = [
    ...new Set(result.guardrails.flatMap((event) => event.hits.map((hit) => hit.rule))),
  ];
  const detectors = namedDetectors(rules);
  return {
    status: result.status,
    via: 'probe',
    read: detectorsAt(boundary),
    detectors,
    rules,
    ms,
    detectorMs,
    ...(detectors.length > 0 ? { events: result.guardrails } : {}),
  };
}
