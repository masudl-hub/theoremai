# Compares a teacher scored on a stratified pick (score_mlx.py) with students on the same rows. Each model's threshold flags
# 2% of the threshold pool (sample.jsonl rows with g = pool), with each picked pool row weighted by its set's size over its
# picked count, so the pick stands for the whole pool. The teacher also runs at its own answer, P(yes) > 0.5.
# Usage: teacher.py <clf dir> <teacher> <student>,...
import json, sys, collections
C, T, studs = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
src = {'s': [json.loads(l) for l in open(f'{C}/sample.jsonl')], 's2': [json.loads(l) for l in open(f'{C}/newsets/rows2.jsonl')]}
path = lambda p, m: f'{C}/s-{m}.json' if p == 's' else f'{C}/newsets/s2-{m}.json'
ts = {p: json.load(open(path(p, T))) for p in src}
pick = {p: ts[p]['pick'] for p in src}
rows = src['s']; full = collections.Counter(r['set'] for r in rows if r['g'] == 'pool')
pool = [i for i in pick['s'] if rows[i]['g'] == 'pool']; got = collections.Counter(rows[i]['set'] for i in pool)
def thr(score, q=0.02):
    w = sorted(((score[i], full[rows[i]['set']] / got[rows[i]['set']]) for i in pool), reverse=True)
    tot, acc = sum(x for _, x in w), 0.0
    for v, x in w:
        acc += x
        if acc > q * tot: return v
models = {T: {p: ts[p]['score'] for p in src}} | {m: {p: json.load(open(path(p, m)))['score'] for p in src} for m in studs}
cuts = {f'{m} 2%': (m, thr(sc['s'])) for m, sc in models.items()} | {f'{T} 0.5': (T, 0.5)}
groups = collections.defaultdict(list)
for p in src:
    for i in pick[p]:
        r = src[p][i]
        if p == 's' and r['g'] == 'pool': continue
        g = f"bspp {r['page']}" if r['set'] == 'bspp' else r['set']
        groups[(g, r['y'])].append((p, i))
out = {'cuts': {k: t for k, (_, t) in cuts.items()}, 'flag': {}}
print(f"{'set':34} {'y':>1} {'n':>4} " + ' '.join(f'{k[:14]:>14}' for k in cuts))
for (g, y), v in sorted(groups.items()):
    line = []
    for k, (m, t) in cuts.items():
        f = sum(models[m][p][i] > t for p, i in v) / len(v); out['flag'].setdefault(k, {})[f'{g}:{y}'] = f; line.append(f'{100 * f:14.1f}')
    print(f'{g[:34]:34} {y:>1} {len(v):>4} ' + ' '.join(line))
print('thresholds', {k: round(t, 4) for k, (_, t) in cuts.items()}, 'teacher secs', round(ts['s']['secs'] + ts['s2']['secs']))
json.dump(out, open(f'{C}/teacher-{T}.json', 'w'))
