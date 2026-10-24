/** labels-exempt-file: benchmark scoring — not runtime user or model copy (P2) */
// How often taint.remoteDestination would hold a call in recorded agent traces. Each trace is one turn: system and user
// text is given, a result of a tool REMOTE names is remote, any other result is given, and every call is checked.
// Input lines: {id, category?, steps: [{k: 'given', text} | {k: 'call', tool, args} | {k: 'result', tool, text}]}.
// Usage: deno run -R -W egress-replay.ts <steps.jsonl> <remote tool prefix,...> [hits.jsonl]   (an empty prefix makes every tool remote)
import {
  addGivenDestinations,
  addResultDestinations,
  checkDestinationGate,
  turnDestinations,
} from '../../src/guardrails/destinations.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';

type Step =
  | { k: 'given'; text: string }
  | { k: 'call'; tool: string; args: unknown }
  | { k: 'result'; tool: string; text: string };

const [src, prefixes, hitsOut] = Deno.args;
if (!src || prefixes === undefined)
  throw new Error('usage: egress-replay.ts <steps.jsonl> <remote tool prefix,...> [hits.jsonl]');
const remote = prefixes.split(',');
const policy = resolveGuardrailPolicy(undefined);
const hits: string[] = [];
let traces = 0,
  held = 0,
  calls = 0,
  heldCalls = 0,
  withRemote = 0;
const byTool = new Map<string, number>();
const byCategory = new Map<string, [held: number, traces: number]>();
async function* lines(path: string): AsyncGenerator<string> {
  const file = await Deno.open(path);
  let rest = '';
  for await (const chunk of file.readable.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    yield* parts;
  }
  yield rest;
}
for await (const line of lines(src)) {
  if (!line) continue;
  const {
    id,
    category = '',
    steps,
  } = JSON.parse(line) as { id: string; category?: string; steps: Step[] };
  const turn = turnDestinations();
  let last = '',
    any = false,
    sawRemote = false;
  for (const step of steps) {
    if (step.k === 'given') addGivenDestinations(turn, step.text);
    else if (step.k === 'call') {
      calls++;
      last = step.tool;
      const { verdict } = checkDestinationGate(turn, step.args, policy);
      if (verdict.action !== 'allow') {
        heldCalls++;
        any = true;
        byTool.set(step.tool, (byTool.get(step.tool) ?? 0) + 1);
        hits.push(
          JSON.stringify({
            id,
            category,
            tool: step.tool,
            match: verdict.hits?.map((h) => h.match),
            args: step.args,
          }),
        );
      }
    } else {
      const tool = step.tool === '?' ? last : step.tool;
      const isRemote = remote.some((p) => tool.startsWith(p));
      sawRemote ||= isRemote;
      addResultDestinations(
        turn,
        { finding: step.text },
        { origin: isRemote ? 'http' : 'local', tool, depth: 0 },
      );
    }
  }
  traces++;
  held += any ? 1 : 0;
  withRemote += sawRemote ? 1 : 0;
  const c = byCategory.get(category) ?? [0, 0];
  byCategory.set(category, [c[0] + (any ? 1 : 0), c[1] + 1]);
}
console.log(
  JSON.stringify({
    traces,
    withRemote,
    held,
    calls,
    heldCalls,
    byTool: Object.fromEntries(byTool),
    byCategory: Object.fromEntries(byCategory),
  }),
);
if (hitsOut) await Deno.writeTextFile(hitsOut, `${hits.join('\n')}\n`);
