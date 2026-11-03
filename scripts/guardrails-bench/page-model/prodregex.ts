// Which rows today's kernel regex detectors fire on, per set file. Reads text only as strings.
import '/Users/masudlewis/Development/theoremai/tests/fixtures/test-host.ts';
import { DETECTORS } from '/Users/masudlewis/Development/theoremai/src/guardrails/eval/mod.ts';
import { TextLineStream } from 'jsr:@std/streams@1/text-line-stream';
const K = `${Deno.env.get('HOME')}/Development/.guardrail-data/kaggle`;
const out = Deno.args[0];
const FILES: Record<string, string> = {
  waab: `${K}/pm-waab/waab.jsonl`, inwild: `${K}/pm-leads/inwild.jsonl`, tools: `${K}/pm-leads/tools.jsonl`,
  warp: `${K}/pm-leads/warp.jsonl`, bsbtest: `${K}/k-full/out/rows/bsbtest.jsonl`, full: `${K}/k-full/out/rows/full.jsonl`,
  bspp: `${K}/pm-bspp/bspp.jsonl`,
};
const inj = DETECTORS.find((d) => d.id === 'injection.spans')!;
const dir = DETECTORS.find((d) => d.id === 'tool-directives')!;
for (const [name, path] of Object.entries(FILES)) {
  const t0 = Date.now();
  const flags: number[] = [];
  const f = await Deno.open(path);
  for await (const line of f.readable.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())) {
    if (!line) continue;
    const text = JSON.parse(line).text ?? '';
    flags.push((inj.fires(text) ? 1 : 0) + (dir.fires(text) ? 2 : 0));
  }
  await Deno.writeTextFile(`${out}/${name}.json`, JSON.stringify(flags));
  console.log(name, flags.length, Date.now() - t0, 'ms');
}
