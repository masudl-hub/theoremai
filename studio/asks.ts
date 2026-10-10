/**
 * The question the studio puts before a real run of a tool that writes: which tool, how it is
 * set, what the run sends and where. A tool that only reads is run unasked.
 *
 * @module
 */

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

/** Which of a project's tools the studio makes ask, and which it cannot. */
export interface StudioAsks {
  /** The tools that ask before each run here and would not in the application. */
  asked: string[];
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
  const runs = (tool: AskTool) => (tool.type === 'agent' && tool.profile ? allowed(tool.profile) : []);
  const inside = new Set(tools.flatMap(runs));
  const writes = (tool: AskTool, seen: Set<string>): boolean => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    if (tool.access !== 'read-only') return true;
    return runs(tool).some((name) => {
      const inner = named.get(name);
      return inner !== undefined && writes(inner, seen);
    });
  };
  // A provider's built-in tool runs on the provider and never stops on a question.
  const writing = tools.filter((tool) => tool.type !== 'builtin' && writes(tool, new Set()));
  return {
    asked: writing
      .filter((tool) => !inside.has(tool.name) && tool.permission !== 'always_confirm')
      .map((tool) => tool.name),
    inside: writing.filter((tool) => inside.has(tool.name)).map((tool) => tool.name),
  };
}
