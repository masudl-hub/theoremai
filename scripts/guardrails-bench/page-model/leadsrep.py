# Flag rate of each model on the newleads.py rows, by set, at the thresholds that flag 1% and 2% of the sampled pool (as
# evalnew2.py), and each source's AUC of attack against benign. Scores are <scores dir>/<rows>-<model>.json.
# Usage: leadsrep.py <clf dir> <rows dir> <scores dir> <rows,...> <models,...>
import json, sys, collections
C, R, S, names, models = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(','), sys.argv[5].split(',')
sample = [json.loads(l) for l in open(f'{C}/sample.jsonl')]; pool = [k for k, r in enumerate(sample) if r['g'] == 'pool']
def auc(p, n):
    v = sorted([(x, 1) for x in p] + [(x, 0) for x in n]); rank, i, tot = 0.0, 0, 0.0
    while i < len(v):
        j = i
        while j < len(v) and v[j][0] == v[i][0]: j += 1
        rank = (i + j + 1) / 2; tot += rank * sum(y for _, y in v[i:j]); i = j
    return (tot - len(p) * (len(p) + 1) / 2) / (len(p) * len(n)) if p and n else float('nan')
for name in names:
    rows = [json.loads(l) for l in open(f'{R}/{name}.jsonl')]; n = collections.Counter(r['set'] for r in rows)
    out = collections.defaultdict(dict); aucs = {}
    for m in models:
        ps = json.load(open(f'{C}/s-{m}.json'))['score']; pv = sorted((ps[k] for k in pool), reverse=True)
        s = json.load(open(f'{S}/{name}-{m}.json'))['score']
        for q in (0.01, 0.02):
            t = pv[int(q * len(pv))]; hit = collections.Counter(r['set'] for r, v in zip(rows, s) if v > t)
            for g in n: out[g][f'{m}@{int(q * 100)}'] = 100 * hit[g] / n[g]
        src = collections.defaultdict(lambda: ([], []))
        for r, v in zip(rows, s): src[r['set'].split('-')[0] + ('-' + r['set'].split('-')[1] if name == 'warp' else '')][1 - r['y']].append(v)
        for k, (p, q) in src.items(): aucs.setdefault(k, {})[m] = auc(p, q)
    cols = [f'{m}@{q}' for m in models for q in (1, 2)]
    print(f"\n{name}\n{'set':46} {'n':>5} " + ' '.join(f'{c[:12]:>12}' for c in cols))
    for g in sorted(n): print(f'{g[:46]:46} {n[g]:5} ' + ' '.join(f'{out[g][c]:12.1f}' for c in cols))
    for k, a in aucs.items(): print('AUC', k, ' '.join(f'{m} {v:.3f}' for m, v in a.items()))
