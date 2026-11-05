/**
 * A tool's reader: a decision agent that keeps the passages of the tool's output that bear on the
 * model's question, so the model reads less. The kernel has no such setting. A host writes it at
 * `post_tool`, and this is the studio's.
 */

import type {
  DecisionQuestion,
  DecisionResult,
  StageContext,
  StageHandler,
  StageResult,
} from '@theoremjs/agents';
import type { ToolRegistration } from './registrations.ts';

/** The decision agent that reads a tool's output, and what it asks of each passage. */
export interface ToolReader {
  profile: string;
  questions: Record<string, DecisionQuestion>;
}

/** Runs a reader on one passage. */
export type ReadPassage = (
  reader: ToolReader,
  state: { question: string; passage: string },
) => Promise<DecisionResult>;

/** Each tool with a reader, by the tool's name. */
export function toolReaders(tools: readonly ToolRegistration[]): Map<string, ToolReader> {
  return new Map(
    tools.flatMap((tool) =>
      tool.type !== 'agent' && tool.stageAgent && tool.stageQuestions
        ? [
            [tool.name, { profile: tool.stageAgent, questions: tool.stageQuestions }] as [
              string,
              ToolReader,
            ],
          ]
        : [],
    ),
  );
}

/** Every choice question came out on its first choice, which keeps the passage. */
function kept(reader: ToolReader, result: DecisionResult): boolean {
  return Object.entries(reader.questions).every(([id, question]) => {
    if (question.type !== 'choice') return true;
    const answer = result.answers[id];
    return answer?.type === 'choice' && answer.choice === Object.keys(question.criteria)[0];
  });
}

async function readOutput(
  reader: ToolReader,
  ctx: StageContext,
  read: ReadPassage,
): Promise<StageResult | undefined> {
  const { outputRaw: output, input } = ctx;
  const question = (input as { question?: unknown } | undefined)?.question;
  if (typeof output !== 'string' || typeof question !== 'string') return undefined;
  const passages = output
    .split(/\n\s*\n/)
    .map((passage) => passage.trim())
    .filter(Boolean);
  try {
    const results = await Promise.all(
      passages.map((passage) => read(reader, { question, passage })),
    );
    const left = passages.filter((_, at) => {
      const result = results[at];
      return result !== undefined && kept(reader, result);
    });
    return left.length === passages.length ? undefined : { mutate: { output: left.join('\n\n') } };
  } catch {
    // why: A filter that failed drops nothing: the model reads the page whole.
    return undefined;
  }
}

/** Runs each tool's reader on its finished output. */
export function toolReaderStage(
  readers: ReadonlyMap<string, ToolReader>,
  read: ReadPassage,
): StageHandler {
  return (ctx) => {
    if (ctx.stage !== 'post_tool' || ctx.failure || ctx.callNotStarted || ctx.awaiting) return;
    const reader = ctx.tool ? readers.get(ctx.tool) : undefined;
    return reader && readOutput(reader, ctx, read);
  };
}

/** One handler for a turn: `steer` keeps its stages, and `readers` adds what it asks. */
export function bothStages(steer: StageHandler, readers: StageHandler): StageHandler {
  return async (ctx) => {
    const [steered, filtered] = await Promise.all([steer(ctx), readers(ctx)]);
    return steered || filtered ? { ...steered, ...filtered } : undefined;
  };
}
