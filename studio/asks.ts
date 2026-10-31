/**
 * The question the studio puts before a real run of a tool that writes: which tool, how it is
 * set, what the run sends, and where. A tool that only reads is run unasked.
 *
 * @module
 */

import type { StageHandler } from '@theoremjs/agents';
import type { ToolSpecDraft } from './draft.ts';

/** What the builder reads before a tool that writes runs. */
export interface WriteAsk {
  tool: string;
  access: Exclude<ToolSpecDraft['access'], 'read-only'>;
  /** The request the run makes, as `METHOD address`. */
  sends: string;
  /** The input the run sends, as the JSON the builder typed. */
  input: string;
}

/**
 * The question to put before the editor's Test of `tool`, or undefined when the test needs none:
 * the tool only reads, or the test only lists an MCP server's tools and calls none.
 */
export function writeAsk(tool: ToolSpecDraft, input: string): WriteAsk | undefined {
  if (tool.access === 'read-only' || tool.toolType !== 'http') return undefined;
  return {
    tool: tool.toolName,
    access: tool.access,
    sends: `${tool.method ?? 'GET'} ${tool.endpoint ?? ''}`.trim(),
    input: input.trim() || '{}',
  };
}

/** What the question says above the input. */
export function writeAskLine(ask: WriteAsk): string {
  const set = ask.access === 'destructive' ? 'destructive' : 'read and write';
  return `It is set as ${set}. Run sends a real request: ${ask.sends}`;
}

/** A registered tool, as far as asking goes. An agent tool names the profile it runs. */
export interface AskTool {
  name: string;
  type: string;
  access: string;
  permission: string;
  profile?: string;
}

/** The header a run carries the builder's choice of which tools that write ask in. */
export const ASK_WRITES_HEADER = 'x-theorem-studio-ask-writes';
/** The same on a live socket's address: a browser's `WebSocket` sends no headers. */
export const ASK_WRITES_PARAM = 'ask-writes';

/** Which of a project's tools the studio makes ask, and which it cannot. */
export interface StudioAsks {
  /** The tools that ask before each run here and would not in the application. */
  asked: string[];
  /** Those of `asked` that can reach a destructive tool: they ask whatever the builder chose. */
  destructive: string[];
  /**
   * The tools that write and run unasked: a called agent runs them, and a question inside a called
   * agent has no one to answer it. The call to that agent asks instead.
   */
  inside: string[];
}

/**
 * The tools the studio makes ask before each run: every one that writes, and every agent tool
 * whose agent can reach one that writes. A tool a called agent runs is left as it is, because the
 * kernel refuses a called agent whose tool can stop on a question.
 */
export function studioAsks(
  tools: readonly AskTool[],
  allowed: (profile: string) => readonly string[],
): StudioAsks {
  const named = new Map(tools.map((tool) => [tool.name, tool]));
  const runs = (tool: AskTool) =>
    tool.type === 'agent' && tool.profile ? allowed(tool.profile) : [];
  const inside = new Set(tools.flatMap(runs));
  const reaches = (tool: AskTool, is: (tool: AskTool) => boolean, seen: Set<string>): boolean => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    if (is(tool)) return true;
    return runs(tool).some((name) => {
      const inner = named.get(name);
      return inner !== undefined && reaches(inner, is, seen);
    });
  };
  // A provider's built-in tool runs on the provider and never stops on a question.
  const writing = tools.filter(
    (tool) =>
      tool.type !== 'builtin' && reaches(tool, (each) => each.access !== 'read-only', new Set()),
  );
  const asked = writing.filter(
    (tool) => !inside.has(tool.name) && tool.permission !== 'always_confirm',
  );
  return {
    asked: asked.map((tool) => tool.name),
    destructive: asked
      .filter((tool) => reaches(tool, (each) => each.access === 'destructive', new Set()))
      .map((tool) => tool.name),
    inside: writing.filter((tool) => inside.has(tool.name)).map((tool) => tool.name),
  };
}

/** What a question the studio puts before a tool that writes says. */
const STUDIO_ASK_SUMMARY = 'The studio asks before every run of a tool that writes.';

/**
 * The studio's question before each run of an `asked` tool, as a stage. The tool's registration
 * is left as the project set it, so the project's own code reads its own setting. A call the
 * builder already approved where it stopped is not asked again. `destructiveOnly` reads the run's
 * own choice, since the builder can change it between two runs.
 */
export function studioAskStage(
  { asked, destructive }: StudioAsks,
  destructiveOnly: () => boolean,
): StageHandler | undefined {
  if (asked.length === 0) return undefined;
  return (ctx) =>
    ctx.stage === 'pre_tool' &&
    !ctx.approved &&
    ctx.tool !== undefined &&
    (destructiveOnly() ? destructive : asked).includes(ctx.tool)
      ? { confirm: { summary: STUDIO_ASK_SUMMARY } }
      : undefined;
}
