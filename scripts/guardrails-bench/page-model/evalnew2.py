# Flag rate of each model on the newsets2.py rows, by subset, at the thresholds that flag 1% and 2% of the sampled E1 pool
# (as evalc.py). Thresholds need the model's scores on sample.jsonl (s-<m>.json); a model without them is left out.
# BrowseSafe++ splits by "seen" and strategy, zn by family and English (an empty lang counts as English) or not, each eval-suite config by label.
# Usage: evalnew2.py <clf dir> <models,...>
import json, sys, collections
C, models = sys.argv[1], sys.argv[2].split(',')
rows = [json.loads(l) for l in open(f'{C}/newsets/rows2.jsonl')]
sample = [json.loads(l) for l in open(f'{C}/sample.jsonl')]; pool = [k for k, r in enumerate(sample) if r['g'] == 'pool']
def groups(r):
    y = 'attack' if r['y'] else 'benign'
    if r['set'] == 'bspp':
        if not r['y']: return ['bspp benign']
        return ['bspp attack', f"bspp attack seen={r['seen']}", f"bspp attack {r['strategy']}"]
    if r['set'] == 'zn': return [f"zn {y} {r['family']} {'en' if r['lang'] in ('en', '') else 'other'}"]
    return [f"{r['set'][7:]} {y}"]
out = collections.defaultdict(dict); n = collections.Counter(g for r in rows for g in groups(r))
for m in models:
    ps = json.load(open(f'{C}/s-{m}.json'))['score']; pv = sorted((ps[k] for k in pool), reverse=True)
    s = json.load(open(f'{C}/newsets/s2-{m}.json'))['score']
    for q in (0.01, 0.02):
        t = pv[int(q * len(pv))]; hit = collections.Counter()
        for r, v in zip(rows, s):
            for g in groups(r): hit[g] += v > t
        for g in n: out[g][f'{m}@{int(q * 100)}'] = 100 * hit[g] / n[g]
cols = [f'{m}@{q}' for m in models for q in (1, 2)]
print(f"{'subset':44} {'n':>5} " + ' '.join(f'{c[:12]:>12}' for c in cols))
for g in sorted(n): print(f'{g[:44]:44} {n[g]:5} ' + ' '.join(f'{out[g][c]:12.1f}' for c in cols))
