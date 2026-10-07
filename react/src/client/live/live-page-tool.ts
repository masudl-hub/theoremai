/** The page's result for a call: the tool's output schema checks it, then the model reads it. */
export type PageToolAnswer = { output: unknown };

/** One page tool: what the page does for a call the model made, and what it tells the model. */
export type PageTool = (
  args: Record<string, unknown>,
  call: { callId: string },
) => PageToolAnswer | Promise<PageToolAnswer>;

/**
 * The page's tools, by name: each answers a tool the profile declares with
 * `answeredBy: 'page'`. Any other tool runs on the relay, gates and all.
 */
export type PageTools = Record<string, PageTool>;

/** What a host gives a live call. */
export type LiveCallOptions = {
  /** The value chosen for each of the profile's `inputs.slots`, read as the call starts. */
  slots?: Record<string, string>;
  /**
   * What the page tells the agent: any JSON. It goes with the call's opening, and
   * again whenever it changes, as background the agent reads without replying.
   */
  context?: unknown;
  pageTools?: PageTools;
};

/**
 * Where the page's tools and the profile's disagree, for the builder: a page
 * tool with no handler here leaves the model unanswered, and a handler for a
 * tool the profile does not give the page never runs.
 */
export function pageToolMismatch(
  declared: readonly string[],
  handled: readonly string[],
): { unanswered: string[]; unused: string[] } {
  return {
    unanswered: declared.filter((name) => !handled.includes(name)),
    unused: handled.filter((name) => !declared.includes(name)),
  };
}
