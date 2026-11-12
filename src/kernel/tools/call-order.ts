import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { StepCall } from '../stages.ts';
import { zodJsonSchema } from './schema.ts';

const FIELD = 'after';

function orderField() {
  return z.array(z.string()).optional().describe(labelText('tool.after_field'));
}

/** `input` with a field the kernel adds for the model. A tool's own field of that name is refused, never replaced. */
export function withModelField<TIn>(
  name: string,
  input: z.ZodType<TIn>,
  field: string,
  shape: () => z.ZodType,
): z.ZodType<TIn> {
  const ordered = (schema: z.ZodType): z.ZodType => {
    if (schema instanceof z.ZodObject) {
      if (field in schema.shape) {
        throw new TheoremError(
          'config',
          `Tool '${name}' sets ${field}, and its input already has a field of that name`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
        );
      }
      return schema.safeExtend({ [field]: shape() });
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
      `Tool '${name}' sets ${field}, which needs an object input or a union of objects`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  };
  return ordered(input) as z.ZodType<TIn>;
}

/** `input` with the model's `after` field. */
export function withCallOrder<TIn>(name: string, input: z.ZodType<TIn>): z.ZodType<TIn> {
  return withModelField(name, input, FIELD, orderField);
}

/**
 * A registered tool's input schema as the tool declared it: without the `after` field the kernel
 * added for the model, and a union without the root `type` its JSON Schema was given. Registering
 * the tool again from it adds the field once, to the same union.
 */
export function declaredInputSchema(tool: {
  after?: boolean;
  inputSchema: Record<string, unknown>;
}): Record<string, unknown> {
  const declared = zodJsonSchema(tool.inputSchema);
  return tool.after ? withoutField(declared, FIELD) : declared;
}

function withoutField(schema: Record<string, unknown>, field: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && Object.hasOwn(properties, field)) {
    const { [field]: _added, ...rest } = properties as Record<string, unknown>;
    out.properties = rest;
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter((name) => name !== field);
    }
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options)) {
      out[key] = options.map((option) =>
        option && typeof option === 'object'
          ? withoutField(option as Record<string, unknown>, field)
          : option,
      );
    }
  }
  return out;
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
