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
