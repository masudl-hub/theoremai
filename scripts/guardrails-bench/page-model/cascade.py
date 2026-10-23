# E1 AND a classifier: E1 at a loose threshold, the classifier's threshold set so that both together flag q of the pool.
# Usage: cascade.py <model>   (reads sample.jsonl and s-<model>.json)
import json, sys, os, collections
DATA = os.path.expanduser(os.environ.get('GUARDRAIL_DATA', '~/Development/.guardrail-data'))
WORK = os.environ.get('PAGE_MODEL_WORK', f'{DATA}/linear-2210/clf'); model = sys.argv[1]
rows = [json.loads(l) for l in open(f'{WORK}/sample.jsonl')]; sc = json.load(open(f'{WORK}/s-{model}.json'))['score']
sd = json.load(open(os.environ.get('E1_SCORES', f'{WORK}/../web/sd2-E1.json')))
e1v = {(s, i): v for s, i, y, v in sd['rows']}; e1p = {(s, i): v for (s, i), v in zip(sd['poolIds'], sd['pool'])}
e1 = [(e1p if r['g'] == 'pool' else e1v).get((r['set'], r['i'])) for r in rows]
pool = [(e, s) for r, e, s in zip(rows, e1, sc) if r['g'] == 'pool' and e is not None]
fullpool = sorted(sd['pool'], reverse=True)
COLS = ['llmail-validate', 'llmail-p2', 'dtap-validate', 'bsafe-validate:1', 'm2w-validate', 'bsafe-validate:0']
key = lambda r: f"{r['set']}:{r['y']}" if r['set'] == 'bsafe-validate' else r['set']
print('loose q pool ' + ' '.join(COLS))
for q in (0.01, 0.02):
    for loose in (q, 0.05, 0.10, 0.20, 0.40, 1.0):
        te = fullpool[min(int(loose * len(fullpool)), len(fullpool) - 1)] if loose < 1 else -1e9
        cand = sorted((s for e, s in pool if e > te), reverse=True); k = int(q * len(pool))
        ts = cand[k] if k < len(cand) else -1e9
        flag = lambda e, s: e is not None and e > te and s > ts
        by = collections.defaultdict(lambda: [0, 0])
        for r, e, s in zip(rows, e1, sc):
            if r['g'] == 'val' and e is not None: by[key(r)][0] += flag(e, s); by[key(r)][1] += 1
        print(f'{loose:.2f} {int(q*100)}% {sum(flag(e, s) for e, s in pool)}/{len(pool)} ' + ' '.join(f'{by[c][0]}/{by[c][1]}' for c in COLS))
