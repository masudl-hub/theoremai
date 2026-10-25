# Wall time to score one whole page, by page type: tokenise, cut score.py's 512-token windows, run all of a page's windows as one
# batch, take the highest. Up to N pages per type (seed 0) from sample.jsonl and newsets/rows2.jsonl (BrowseSafe++ by its page field).
# Each page runs REP times after a warm-up; the median counts. Also records the gate's score from s-/s2- files so the cascade
# (gate on every page, Horizon small on the share the gate passes) can be costed per page.
# Usage: [DEV=mps|cpu] [THREADS=4] [N=25] [REP=3] pagelat.py <clf dir> <out.json> <model[=prune dir]>,...
import json, sys, os, random, time, statistics, importlib.util
import torch
from transformers import AutoModelForSequenceClassification
here = os.path.dirname(os.path.abspath(__file__)); spec = importlib.util.spec_from_file_location('score', f'{here}/score.py')
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
C, out, specs = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
dev = os.environ.get('DEV', 'mps'); N = int(os.environ.get('N', '25')); REP = int(os.environ.get('REP', '3'))
torch.set_num_threads(int(os.environ.get('THREADS', '4')))
sample = [json.loads(l) for l in open(f'{C}/sample.jsonl')]; rows2 = [json.loads(l) for l in open(f'{C}/newsets/rows2.jsonl')]
SETS = ['bsafe-validate', 'm2w-validate', 'c:bonsai-pages', 'c:bonsai-tools', 'dtap-validate', 'hermes-glm-tool-errors', 'glaive-tool',
        'gravitee-validate', 'llmail-validate', 'c:nvidia-ipi', 'c:injecagent']
groups = {s: [('sample', k) for k, r in enumerate(sample) if r['set'] == s] for s in SETS}
for k, r in enumerate(rows2):
    if r['set'] == 'bspp': groups.setdefault(f"bspp {r['page']}", []).append(('rows2', k))
    if r['set'] in ('hzeval:bipia', 'hzeval:piarena'): groups.setdefault(r['set'][7:], []).append(('rows2', k))
rnd = random.Random(0); pick = {g: sorted(rnd.sample(v, min(N, len(v)))) for g, v in groups.items()}
text = lambda src, k: (sample if src == 'sample' else rows2)[k]['text']
sync = (lambda: torch.mps.synchronize()) if dev == 'mps' else (lambda: None)
res = {'dev': dev, 'threads': torch.get_num_threads(), 'pages': {g: [list(p) for p in v] for g, v in pick.items()}, 'ms': {}, 'windows': {}, 'ntok': {}}
for spec_ in specs:
    name, _, d = spec_.partition('=')
    tok, m, f, pos = S.load('hz-small'); lut = None
    if d:
        m = AutoModelForSequenceClassification.from_pretrained(d); f = lambda ids, am: m(input_ids=ids, attention_mask=am).logits
        remap = json.load(open(f'{d}/remap.json')); lut = {t: k for k, t in enumerate(remap['keep'])}; unk = remap['unk']
    m.to(dev).eval()
    def page(t):
        ws, n = S.windows(tok, t)
        if lut: ws = [[lut.get(i, unk) for i in w] for w in ws]
        L = max(map(len, ws)); ids = torch.tensor([w + [0] * (L - len(w)) for w in ws], device=dev)
        am = torch.tensor([[1] * len(w) + [0] * (L - len(w)) for w in ws], device=dev)
        with torch.no_grad(): p = torch.softmax(f(ids, am).float(), -1)[:, pos].max().item()
        sync(); return len(ws), n
    for _ in range(3): page(text(*pick['bsafe-validate'][0]))
    res['ms'][name] = {}
    for g, v in pick.items():
        ms = []
        for src, k in v:
            ts = []
            for _ in range(REP):
                t0 = time.perf_counter(); nw, n = page(text(src, k)); ts.append(1000 * (time.perf_counter() - t0))
            ms.append(statistics.median(ts)); res['windows'].setdefault(g, {})[f'{src}:{k}'] = nw; res['ntok'].setdefault(g, {})[f'{src}:{k}'] = n
        res['ms'][name][g] = ms
        print(name, g, f'{statistics.median(ms):.0f} ms', flush=True)
    del m
json.dump(res, open(out, 'w'))
