import { lexiconText } from '../../guardrails/lexicon.ts';
import type { ToolContext, ToolHandler } from './types.ts';
import { uncheckedOutput } from './unchecked-output.ts';

/**
 * The handler of a function tool the page answers (`answeredBy: 'page'`): it returns what the
 * page sent for the call (`ctx.page.output`), which the tool's `output` schema then checks. A
 * call the page never answered, or one run with no answer, fails to the model.
 */
export function pageAnswerHandler(name: string): ToolHandler<unknown, unknown> {
  return (_input: unknown, ctx: ToolContext) => {
    const { page } = ctx;
    if (page && 'output' in page) return uncheckedOutput(page.output);
    const { lexicon } = ctx.profile;
    if (page?.timedOut) throw new Error(lexiconText('tool.page_timed_out', {}, lexicon));
    throw new Error(lexiconText('tool.page_no_answer', { tool: name }, lexicon));
  };
}
