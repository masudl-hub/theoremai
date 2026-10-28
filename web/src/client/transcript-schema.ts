/**
 * The transcript's blocks as the wire carries them: the host stores them, and
 * the browser reads the host's conversation back through this schema.
 *
 * @module
 */

import {
  reasoningPartSchema,
  TURN_STOP_KINDS,
  type TurnEvent,
  type TurnStop,
  turnEventSchema,
  z,
} from '@theoremjs/agents';
import { guardrailEventSchema } from '@theoremjs/agents/guardrails';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import type { Equals } from '@theoremjs/agents/kernel';

// why: The block shapes' event parts have one schema, the turn event's; a probe event reuses it.
function eventPart<T>(probe: (value: unknown) => unknown) {
  return z.custom<T>((value) => turnEventSchema.safeParse(probe(value)).success);
}

type ToolCall = Extract<TranscriptBlock, { kind: 'tool' }>['tool'];
type ToolCallState = NonNullable<ToolCall['state']>;
const TOOL_CALL_STATE_PHASES = [
  'running',
  'gate',
  'complete',
  'error',
  'cancel',
] as const satisfies readonly ToolCallState['phase'][];
const toolCallState = z.custom<ToolCallState>((value) => {
  const parsed = turnEventSchema.safeParse({ type: 'tool', tool: value });
  if (!parsed.success || parsed.data.type !== 'tool' || !('phase' in parsed.data.tool)) {
    return false;
  }
  const { phase } = parsed.data.tool;
  return TOOL_CALL_STATE_PHASES.some((statePhase) => statePhase === phase);
});

const argumentsRecord = z.record(z.string(), z.unknown());
const toolCall = z.object({
  operationId: z.string().optional(),
  name: z.string(),
  callId: z.string(),
  arguments: argumentsRecord,
  draft: z.string().optional(),
  reasoning: z.array(reasoningPartSchema).optional(),
  stepId: z.string().optional(),
  edited: z.object({ from: argumentsRecord, to: argumentsRecord }).optional(),
  activity: z.string().optional(),
  activityPast: z.string().optional(),
  outputDraft: z.string().optional(),
  state: toolCallState.optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  artifacts: z.array(z.unknown()),
  get steps() {
    return z.array(toolCall).optional();
  },
});
true satisfies Equals<z.infer<typeof toolCall>, ToolCall>;

const turnStop = z.object({ kind: z.enum(TURN_STOP_KINDS), native: z.string().optional() });
true satisfies Equals<z.infer<typeof turnStop>, TurnStop>;

const blockId = { id: z.string() };
const transcriptBlock = z.discriminatedUnion('kind', [
  z.object({ ...blockId, kind: z.literal('user-text'), text: z.string() }),
  z.object({
    ...blockId,
    kind: z.enum(['user-attachment', 'user-voice']),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    data: z.string().optional(),
  }),
  z.object({ ...blockId, kind: z.literal('thought'), text: z.string() }),
  z.object({ ...blockId, kind: z.literal('text'), text: z.string() }),
  z.object({ ...blockId, kind: z.literal('tool'), tool: toolCall }),
  z.object({
    ...blockId,
    kind: z.literal('structured'),
    value: z.unknown(),
    draft: z.string().optional(),
  }),
  z.object({
    ...blockId,
    kind: z.literal('media'),
    mimeType: z.string(),
    data: z.string().optional(),
    url: z.string().optional(),
    previewUrl: z.string().optional(),
  }),
  z.object({
    ...blockId,
    kind: z.literal('grounding'),
    grounding: eventPart<Extract<TurnEvent, { type: 'grounding' }>['grounding']>((grounding) => ({
      type: 'grounding',
      grounding,
    })),
  }),
  z.object({
    ...blockId,
    kind: z.literal('citation'),
    sources: eventPart<Extract<TurnEvent, { type: 'citation' }>['sources']>((sources) => ({
      type: 'citation',
      sources,
    })),
    callId: z.string().optional(),
  }),
  z.object({
    ...blockId,
    kind: z.literal('evidence'),
    evidence: eventPart<Extract<TurnEvent, { type: 'evidence' }>['evidence']>((evidence) => ({
      type: 'evidence',
      evidence,
    })),
  }),
  z.object({ ...blockId, kind: z.literal('guardrail'), guardrail: guardrailEventSchema }),
  z.object({ ...blockId, kind: z.literal('error'), message: z.string() }),
  z.object({
    ...blockId,
    kind: z.literal('turn-done'),
    stop: turnStop.optional(),
    tokens: eventPart<Extract<TurnEvent, { type: 'tokens' }>['tokens']>((tokens) => ({
      type: 'tokens',
      tokens,
    })).optional(),
    interactionId: z.string().optional(),
    compaction: z.boolean().optional(),
    workedMs: z.number().optional(),
    endedAt: z.number().optional(),
  }),
]);
true satisfies Equals<z.infer<typeof transcriptBlock>, TranscriptBlock>;
/** One transcript block, as a host stores it and the browser reads it back. */
export const transcriptBlockSchema: z.ZodType<TranscriptBlock> = transcriptBlock;
