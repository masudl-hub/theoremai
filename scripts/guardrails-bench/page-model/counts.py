# Rows flagged per set, as caught of scored, at the thresholds that flag 1% and 2% of the sampled pool.
# E1's own threshold comes from its whole pool. Usage: counts.py <sample|screen> <s|t> [model,model,...]
import json, sys, glob, os, collections
DATA = os.path.expanduser(os.environ.get('GUARDRAIL_DATA', '~/Development/.guardrail-data'))
WORK = os.environ.get('PAGE_MODEL_WORK', f'{DATA}/linear-2210/clf')
SAMPLE, PFX = sys.argv[1], sys.argv[2]; only = sys.argv[3].split(',') if len(sys.argv) > 3 else None
rows = [json.loads(l) for l in open(f'{WORK}/{SAMPLE}.jsonl')]
sd = json.load(open(os.environ.get('E1_SCORES', f'{WORK}/../web/sd2-E1.json'))); e1 = {(s, i): v for s, i, y, v in sd['rows']}
def thr(p, q): p = sorted(p, reverse=True); return p[int(q * len(p))]
def key(r): return f"{r['set']}:{r['y']}" if r['set'] == 'bsafe-validate' else r['set']
pool_idx = [k for k, r in enumerate(rows) if r['g'] == 'pool']
models = {'E1': ([e1.get((r['set'], r['i'])) if r['g'] == 'val' else None for r in rows], sd['pool'])}
for f in sorted(glob.glob(f'{WORK}/{PFX}-*.json')):
    d = json.load(open(f)); s = d['score']; models[d['model']] = (s, [s[k] for k in pool_idx])
for m, (s, pool) in models.items():
    if only and m not in only: continue
    for q in (0.01, 0.02):
        t = thr(pool, q); by = collections.defaultdict(lambda: [0, 0])
        for r, v in zip(rows, s):
            if r['g'] == 'val' and v is not None: by[key(r)][0] += v > t; by[key(r)][1] += 1
        print(m, f'{int(q*100)}%', f'pool {sum(v > t for v in pool)}/{len(pool)}', ' '.join(f'{k}={a}/{n}' for k, (a, n) in sorted(by.items())))
