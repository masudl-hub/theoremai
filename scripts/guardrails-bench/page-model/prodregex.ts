// Which rows today's kernel regex detectors fire on, per set file. Reads text only as strings.
import '/Users/masudlewis/Development/theoremai/tests/fixtures/test-host.ts';
import { DETECTORS } from '/Users/masudlewis/Development/theoremai/src/guardrails/eval/mod.ts';

async function* lines(path: string) {
  let rest = '';
  for await (const chunk of (await Deno.open(path)).readable.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    yield* parts;
  }
  yield rest;
}
const K = `${Deno.env.get('HOME')}/Development/.guardrail-data/kaggle`;
const out = Deno.args[0];
const FILES: Record<string, string> = {
  waab: `${K}/pm-waab/waab.jsonl`,
  inwild: `${K}/pm-leads/inwild.jsonl`,
  tools: `${K}/pm-leads/tools.jsonl`,
  warp: `${K}/pm-leads/warp.jsonl`,
  bsbtest: `${K}/k-full/out/rows/bsbtest.jsonl`,
  full: `${K}/k-full/out/rows/full.jsonl`,
  bspp: `${K}/pm-bspp/bspp.jsonl`,
};
function detector(id: string) {
  const d = DETECTORS.find((x) => x.id === id);
  if (!d) throw new Error(`the eval module has no detector ${id}`);
  return d;
}
const inj = detector('injection.spans');
const dir = detector('tool-directives');
for (const [name, path] of Object.entries(FILES)) {
  const t0 = Date.now();
  const flags: number[] = [];
  for await (const line of lines(path)) {
    if (!line) continue;
    const text = JSON.parse(line).text ?? '';
    flags.push((inj.fires(text) ? 1 : 0) + (dir.fires(text) ? 2 : 0));
  }
  await Deno.writeTextFile(`${out}/${name}.json`, JSON.stringify(flags));
  console.log(name, flags.length, Date.now() - t0, 'ms');
}
