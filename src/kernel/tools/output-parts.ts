import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { MEDIA_INPUT_KIND_VALUES } from '../schema.ts';
import { type ToolOutputPart, toolOutputPartRecord } from '../turn-events.ts';
import type { Equals } from '../util/exact-type.ts';
import { isRecord } from '../util/record.ts';
import type { SchemaIssue } from './schema-issues.ts';

const mimeType = z.string().regex(/\S/);
const metadata = z.record(z.string(), z.unknown()).optional();

const textPart = z.strictObject({ type: z.literal('text'), text: z.string() });
const mediaPart = z.strictObject({
  type: z.enum(MEDIA_INPUT_KIND_VALUES),
  mimeType,
  data: z.string().min(1),
  sent: z.literal(true).optional(),
  metadata,
});
/** A reference part: the person is shown it through the app's own resolver. */
export const toolOutputRefPartSchema = z.strictObject({
  type: z.enum(MEDIA_INPUT_KIND_VALUES),
  mimeType,
  uri: z.string().min(1),
  metadata,
});
const toolOutputPartInput = z.union([textPart, mediaPart, toolOutputRefPartSchema]);
true satisfies Equals<z.infer<typeof toolOutputPartInput>, ToolOutputPart>;

/**
 * A part a tool returns in its `parts`. A field the part does not name, empty bytes or an empty
 * reference fail the call as `invalid_output`, never dropped: put your own values in `metadata`.
 */
export const toolOutputPartSchema: z.ZodType<ToolOutputPart> = toolOutputPartInput;

/** The kind of part `value` is meant to be: text, a reference (it names a `uri`), or media bytes. */
function partShapeOf(value: unknown) {
  if (isRecord(value) && value.type === 'text') return textPart;
  return isRecord(value) && 'uri' in value ? toolOutputRefPartSchema : mediaPart;
}

/** Where an output's `parts` break {@link toolOutputPartSchema}, each issue on its own part's field. */
export function toolOutputPartIssues(output: unknown): SchemaIssue[] {
  if (!isRecord(output) || output.parts === undefined) return [];
  const list = z.array(z.unknown()).safeParse(output.parts);
  if (!list.success) return list.error.issues.map((issue) => atParts(issue, []));
  return list.data.flatMap((part, index) => {
    const checked = partShapeOf(part).safeParse(part);
    return checked.success ? [] : checked.error.issues.map((issue) => atParts(issue, [index]));
  });
}

function atParts(issue: SchemaIssue, at: readonly PropertyKey[]): SchemaIssue {
  return { path: ['parts', ...at, ...issue.path], message: issue.message };
}

/** The `parts` of an output whose parts had no {@link toolOutputPartIssues}. */
export function checkedToolOutputParts(output: unknown): ToolOutputPart[] | undefined {
  if (!isRecord(output) || output.parts === undefined) return undefined;
  const parts = z.array(toolOutputPartRecord).safeParse(output.parts);
  if (!parts.success) {
    throw new TheoremError('internal', 'Tool parts were read before they were checked'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return parts.data.length > 0 ? parts.data : undefined;
}
