/**
 * `POST <base>/probe`: one text sent across every guardrail boundary of the draft, each on a
 * scripted model, so no key is spent and no host is reached. With `only`, the draft reads with that
 * detector alone: what the others would catch passes there.
 *
 * @module
 */
import { type ProfileDefinition, z } from '@theoremjs/agents';
import { readBody } from '@theoremjs/react/server';
import { type GuardrailProbeAnswer, PROBE_TEXT_LIMIT, runGuardrailProbes } from '../guardrail-probe.ts';
import { PROBE_BATTERY } from '../probe-battery.ts';
import type { StructuredRegistration, ToolRegistration } from '../registrations.ts';
import type { StudioDependency } from '../runtime-scope.ts';
import { errorJson, noStoreJson } from './draft-replies.ts';

/** A probed text some boundary let through, and what each boundary's guardrails did with it. */
export type ProbeEntry = {
  text: string;
  /** The draft's guardrails as written. */
  guardrails: unknown;
  answers: readonly Pick<GuardrailProbeAnswer, 'boundary' | 'status' | 'taint' | 'guardrails' | 'passed'>[];
};

function part<T>() {
  return z.custom<T>((value) => typeof value === 'object' && value !== null);
}

/** The draft as every studio request carries it, and the text to probe with. The kernel checks the draft when it registers it. */
const probeRequestSchema = z.object({
  profile: part<ProfileDefinition>(),
  customTools: z.array(part<ToolRegistration>()).optional(),
  structured: part<StructuredRegistration>().optional(),
  dependencies: z.array(part<StudioDependency>()).optional(),
  text: z.string().min(1).max(PROBE_TEXT_LIMIT),
  only: z.string().min(1).max(200).optional(),
});

/** A battery text is known already: what passes it is no news to a reviewer. */
function isBatteryText(text: string): boolean {
  return PROBE_BATTERY.some((entry) => entry.text === text);
}

/**
 * Runs the text across every boundary and answers with what the guardrails did at each. A text
 * some boundary passed, run with every detector and not one of the battery's, goes to `onPassed`
 * through `defer`, after the answer: one that fails never fails a probe.
 */
export async function draftProbe(
  request: Request,
  onPassed: ((entry: ProbeEntry, at: Date) => Promise<void>) | undefined,
  defer: (work: Promise<unknown>) => void,
): Promise<Response> {
  let labels: ProfileDefinition['labels'];
  try {
    const body = await readBody(request, probeRequestSchema);
    labels = body.profile.labels;
    const answers = await runGuardrailProbes({
      profile: body.profile,
      customTools: body.customTools ?? [],
      structured: body.structured,
      dependencies: body.dependencies,
      text: body.text,
      only: body.only,
      signal: request.signal,
    });
    const isNews = body.only === undefined && answers.some((answer) => answer.status === 'passed') &&
      !isBatteryText(body.text);
    if (onPassed && isNews) {
      defer(
        onPassed({ text: body.text, guardrails: body.profile.guardrails, answers }, new Date()).catch((error: unknown) => {
          console.error('studio probe: onPassed failed', error);
        }),
      );
    }
    return noStoreJson({ answers });
  } catch (err) {
    return errorJson(err, labels);
  }
}
