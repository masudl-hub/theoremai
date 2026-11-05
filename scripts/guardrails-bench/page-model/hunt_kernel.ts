// Which rows the kernel's injection detector flags on each new set, through detectAt with every detector on flag
// (kernel 08954d1c, exported read-only), at each kernel boundary a board row maps to.
// Writes <out>/<set>.json: { <boundary>: one 0 or 1 per row }.
import '/Users/masudlewis/Development/theoremai/tests/fixtures/test-host.ts';
import { detectAt } from '/Users/masudlewis/Development/theoremai/src/guardrails/detect-at.ts';
import { resolveDetect } from '/Users/masudlewis/Development/theoremai/src/guardrails/detectors.ts';
import { DETECT_RULES } from '/Users/masudlewis/Development/theoremai/src/guardrails/rules.ts';

const [sets, out] = Deno.args;
const FLAG_ALL = resolveDetect('flag');
const RULE = DETECT_RULES.injection;
// The same four callable tools the old eval list named, so a row that names one matches as it did before.
const TOOL_SCOPE = { fromTool: true, callable: ['send_email', 'send_money', 'read_inbox', 'get_channel_messages'] };
const AT = ['user', 'attachment', 'context', 'tool_output_function', 'tool_output_http'] as const;
for (const e of [...Deno.readDirSync(sets)].sort((a, b) => a.name.localeCompare(b.name))) {
  const t0 = Date.now();
  const texts = (await Deno.readTextFile(`${sets}/${e.name}`)).split('\n').filter(Boolean).map((l) => JSON.parse(l).text ?? '');
  const res: Record<string, number[]> = {};
  for (const b of AT) res[b] = texts.map((t) => (detectAt(t, b, FLAG_ALL, b.startsWith('tool_') ? TOOL_SCOPE : {}).hits.some((h) => h.rule === RULE || h.rule.startsWith(`${RULE}:`)) ? 1 : 0));
  await Deno.writeTextFile(`${out}/${e.name.replace('.jsonl', '.json')}`, JSON.stringify(res));
  console.log(e.name, texts.length, AT.map((b) => res[b].reduce((a, x) => a + x, 0)).join(' '), Date.now() - t0, 'ms');
}
