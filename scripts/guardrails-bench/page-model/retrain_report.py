# Retrain round 1 against m22 on the held-out rows of pm-retrain-eval. Each model gets its own line at 1% of the benign
# bsafe-validate pages; per set, attacks caught and harmless rows flagged at that line, counting only the rows the bench hunt
# counts (hunt_report.py's group()), plus AUC. Email ham and dev-docs are harmless only.
# Usage: retrain_report.py [models]   (default m22,rA,...,rF; a model shows once it has scored every file)
# Reads scores from $RETRAIN_WORK/out/scores-<model>/ (default ~/Development/.guardrail-data/retrain-work) and writes report.json there.
import json, os, sys, types
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); W = os.environ.get('RETRAIN_WORK', os.path.expanduser('~/Development/.guardrail-data/retrain-work')); EV = os.path.expanduser('~/Development/.guardrail-data/kaggle/pm-retrain-eval')
HP = f'{HERE}/hunt_report.py'; src = open(HP).read(); G = {'__file__': HP}; exec(src[:src.index('\ndef load(')], G); H = types.SimpleNamespace(**G)  # group() and auc() only
M = (sys.argv[1] if len(sys.argv) > 1 else 'm22,rA,rB,rC,rD,rE,rF').split(',')
files = sorted(f[:-6] for f in os.listdir(EV) if f.endswith('.jsonl'))
rows = {n: [{k: v for k, v in json.loads(l).items() if k != 'text'} for l in open(f'{EV}/{n}.jsonl')] for n in files}
sc = {}
for m in M:
    d = {}
    for n in files:
        p = f'{W}/out/scores-{m}/{n}.json'
        if not os.path.exists(p): p = f'{W}/out/scores-{m}/scores-{m}/{n}.json'  # modal volume get keeps the folder
        if os.path.exists(p): s = json.load(open(p))['score']; d[n] = np.array(s) if len(s) == len(rows[n]) else None
    if all(d.get(n) is not None for n in files): sc[m] = d
    else: print(m, 'not finished:', [n for n in files if d.get(n) is None])
M = [m for m in M if m in sc]
bv = np.array([r['y'] for r in rows['bsafe-validate']])
TH = {m: np.sort(sc[m]['bsafe-validate'][bv == 0])[::-1][int(.01 * (bv == 0).sum())] for m in M}
print('line at 1% of', int((bv == 0).sum()), 'benign bsafe-validate pages:', {m: round(float(TH[m]), 4) for m in M})
pc = lambda a: '–' if a is None else f'{100 * a:5.1f}'
print(f"{'set':34} {'n+':>6} {'n-':>6} | " + ' | '.join(f'{m:^17}' for m in M)); print(f"{'':48} | " + ' | '.join(f"{'catch':>5} {'FA':>5} {'auc':>5}" for m in M))
out = {}
for n in files:
    rs = rows[n]
    if n.startswith('hunt-'):
        s = n[5:]; keep = np.array([not H.group(s, r['category'])[2] for r in rs])
    else: keep = np.ones(len(rs), bool)
    groups = [(n, keep)]
    if n == 'email-ham': groups = [(f'email-ham · {k}', keep & np.array([r['set'] == k for r in rs])) for k in sorted({r['set'] for r in rs})]
    for g, k in groups:
        y = np.array([r['y'] for r in rs])[k]
        if not len(y): continue
        cells = []
        for m in M:
            v = sc[m][n][k]; f = v > TH[m]
            a = H.auc(v, y) if 0 < y.sum() < len(y) else None
            cells.append(f"{pc(f[y == 1].mean() if y.sum() else None):>5} {pc(f[y == 0].mean() if (1 - y).sum() else None):>5} {'–' if a is None else f'{a:.3f}':>5}")
            out.setdefault(g, {})[m] = {'caught': int(f[y == 1].sum()), 'flagged': int(f[y == 0].sum()), 'auc': a}
        print(f"{g[:34]:34} {int(y.sum()):6} {int((1 - y).sum()):6} | " + ' | '.join(cells))
json.dump({'line': {m: float(TH[m]) for m in M}, 'groups': out}, open(f'{W}/report.json', 'w'), indent=1)
