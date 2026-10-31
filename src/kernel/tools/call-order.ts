import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { StepCall } from '../stages.ts';

const FIELD = 'after';

function orderField() {
  return z.array(z.string()).optional().describe(labelText('tool.after_field'));
}

/** `input` with the model's `after` field. A tool's own `after` is refused, never replaced. */
export function withCallOrder<TIn>(name: string, input: z.ZodType<TIn>): z.ZodType<TIn> {
  const ordered = (schema: z.ZodType): z.ZodType => {
    if (schema instanceof z.ZodObject) {
      if (FIELD in schema.shape) {
        throw new TheoremError(
          'config',
          `Tool '${name}' sets after, and its input already has a field of that name`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }
      return schema.safeExtend({ [FIELD]: orderField() });
    }
    if (schema instanceof z.ZodDiscriminatedUnion) {
      const options = (schema.options as z.ZodType[]).map(ordered);
      return z.discriminatedUnion(
        schema.def.discriminator,
        options as unknown as [z.core.$ZodTypeDiscriminable],
      );
    }
    if (schema instanceof z.ZodUnion) {
      return z.union((schema.options as z.ZodType[]).map(ordered));
    }
    throw new TheoremError(
      'config',
      `Tool '${name}' sets after, which needs an object input or a union of objects`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  };
  return ordered(input) as z.ZodType<TIn>;
}

/** The call's input without `after`, and the tool names `after` held. */
export function splitCallOrder(
  tool: { after?: boolean },
  input: unknown,
): { input: unknown; names: readonly string[] } {
  if (!tool.after || typeof input !== 'object' || input === null) return { input, names: [] };
  const { [FIELD]: names, ...rest } = input as Record<string, unknown>;
  return { input: rest, names: (names as readonly string[] | undefined) ?? [] };
}

/**
 * The ids of each named tool's other calls in the step; a name with none stays, to be refused. A
 * call outside a step, as in a live session, has nothing to wait on.
 */
export function stepCallIds(
  names: readonly string[],
  callId: string,
  stepCalls: readonly StepCall[] | undefined,
): string[] {
  if (!stepCalls) return [];
  return names.flatMap((name) => {
    const ids = stepCalls
      .filter((call) => call.tool === name && call.callId !== callId)
      .map((call) => call.callId);
    return ids.length > 0 ? ids : [name];
  });
}
