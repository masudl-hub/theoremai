import { type LabelOverrides, labelText } from '../guardrails/labels.ts';
import type { WireFunctionTool } from './turn-events.ts';
import type { ModelRequest, ResolvedGeneration } from './types.ts';

/** The tool a structured turn with tools answers through. */
export const ANSWER_TOOL = 'final_answer';

/**
 * True when the turn's structured output comes from the answer tool, not from a response format.
 *
 * why: Many endpoints refuse a response format beside tools, and many models given both answer in
 * JSON at once without calling a tool. Read it off the turn's generation, not one step's: the
 * step that must answer has its tools taken away, and still answers through this tool.
 */
export function answersByTool(
  generation: Pick<ResolvedGeneration, 'structured' | 'tools'>,
): boolean {
  return generation.structured !== null && generation.tools.wire.length > 0;
}

/** The request with the answer tool in place of the response format, when the turn answers by tool. */
export function withAnswerTool(
  request: ModelRequest,
  generation: Pick<ResolvedGeneration, 'structured' | 'tools'>,
  labels: LabelOverrides | undefined,
): ModelRequest {
  const { structured } = generation;
  if (!structured || !answersByTool(generation)) return request;
  const tool: WireFunctionTool = {
    type: 'function',
    name: ANSWER_TOOL,
    description: labelText('structured.answer_tool', {}, labels),
    parameters: structured.jsonSchema,
  };
  return { ...request, structured: null, wireTools: [...(request.wireTools ?? []), tool] };
}
