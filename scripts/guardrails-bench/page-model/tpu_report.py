# The eight pm-train-tpu arms against m22: one threshold per model at 1% of benign bsafe-validate pages, flag rates on
# BSB test, the unseen sets and every bench set of 200+ rows; plus AUC and recall at 1% of each set's own benign rows.
import json, os, collections
K = os.path.expanduser('~/Development/.guardrail-data/kaggle')
M = ['m22', 'v22', 'w22', 'w22q', 'w22m', 'm22a', 'fm128', 'fm64', 'w128']
def F(m, s):
    if m != 'm22': return f'{K}/k-tpu/out/out/{s}-{m}.json'
    return f"{K}/{'k-m22s' if s in ('full', 'bsbtest', 'bspp') else 'k-m22'}/out/out/{s}-m22.json"
S = lambda s: {m: json.load(open(F(m, s)))['score'] for m in M}
rows = [{k: v for k, v in json.loads(l).items() if k != 'text'} for l in open(f'{K}/k-full/out/rows/full.jsonl')]
bsb = [json.loads(l)['y'] for l in open(f'{K}/k-full/out/rows/bsbtest.jsonl')]
sc, bs = S('full'), S('bsbtest')
ben = [k for k, r in enumerate(rows) if r['set'] == 'bsafe-validate' and not r['y']]
th = {}
for m in M: v = sorted((sc[m][k] for k in ben), reverse=True); th[m] = v[int(.01 * len(v))]
def auc(p, n):
    v = sorted([(x, 1) for x in p] + [(x, 0) for x in n]); i, t = 0, 0.0
    while i < len(v):
        j = i
        while j < len(v) and v[j][0] == v[i][0]: j += 1
        t += (i + j + 1) / 2 * sum(y for _, y in v[i:j]); i = j
    return (t - len(p) * (len(p) + 1) / 2) / (len(p) * len(n))
def own(p, n, f=.01): n = sorted(n, reverse=True); t = n[min(len(n) - 1, int(f * len(n)))]; return 100 * sum(x > t for x in p) / len(p)
G = collections.OrderedDict()  # group -> model -> (attack scores, benign scores)
G['BSB test'] = {m: ([x for x, y in zip(bs[m], bsb) if y], [x for x, y in zip(bs[m], bsb) if not y]) for m in M}
for name, f in {'waab': 'pm-waab/waab.jsonl', 'inwild': 'pm-leads/inwild.jsonl', 'tools': 'pm-leads/tools.jsonl', 'warp': 'pm-leads/warp.jsonl'}.items():
    rs = [json.loads(l) for l in open(f'{K}/{f}')]; s = S(name); g = collections.defaultdict(list)
    for k, r in enumerate(rs): p = r['set'].split('-'); g[p[0] + ('-' + p[1] if name == 'warp' else '')].append(k)
    for gg, ks in sorted(g.items()): G[gg] = {m: ([s[m][k] for k in ks if rs[k]['y']], [s[m][k] for k in ks if not rs[k]['y']]) for m in M}
by = collections.defaultdict(list)
for k, r in enumerate(rows): by[r['set']].append(k)
for st, ks in sorted(by.items()):
    if len(ks) >= 200: G[st] = {m: ([sc[m][k] for k in ks if rows[k]['y']], [sc[m][k] for k in ks if not rows[k]['y']]) for m in M}
rate = lambda v, t: 100 * sum(x > t for x in v) / len(v) if v else float('nan')
print('threshold at 1% of', len(ben), 'benign bsafe-validate pages:', {m: round(th[m], 4) for m in M})
print(f"{'set':34} {'kind':6} {'n':>6} | " + ' '.join(f'{m:>6}' for m in M))
for g, d in G.items():
    P, N = d['m22']
    if P: print(f"{g[:34]:34} {'flag+':6} {len(P):6} | " + ' '.join(f'{rate(d[m][0], th[m]):6.1f}' for m in M))
    if N: print(f"{g[:34]:34} {'flag-':6} {len(N):6} | " + ' '.join(f'{rate(d[m][1], th[m]):6.1f}' for m in M))
    if P and N:
        print(f"{'':34} {'auc':6} {'':6} | " + ' '.join(f'{auc(*d[m]):6.3f}' for m in M))
        print(f"{'':34} {'own1%':6} {'':6} | " + ' '.join(f'{own(*d[m]):6.1f}' for m in M))
br = [{k: v for k, v in json.loads(l).items() if k != 'text'} for l in open(f'{K}/pm-bspp/bspp.jsonl')]; s = S('bspp')
P = {m: [s[m][k] for k, r in enumerate(br) if r['g'] == 'rows2' and r['y']] for m in M}; N = {m: [s[m][k] for k, r in enumerate(br) if r['g'] == 'rows2' and not r['y']] for m in M}
print(f"{'BrowseSafe++ rows2 (unseen)':34} {'auc':6} {len(P['m22']):6} | " + ' '.join(f'{auc(P[m], N[m]):6.3f}' for m in M))
print(f"{'':34} {'flag+':6} {'':6} | " + ' '.join(f'{rate(P[m], th[m]):6.1f}' for m in M))
print(f"{'':34} {'flag-':6} {len(N['m22']):6} | " + ' '.join(f'{rate(N[m], th[m]):6.1f}' for m in M))
