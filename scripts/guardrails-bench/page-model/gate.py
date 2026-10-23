# A student gates Horizon window by window: Horizon reads only the windows the student passes at a loose threshold.
# The student's window threshold passes a share of the pool's windows; Horizon's threshold is then set so that a row flags when one of its windows passes both, and 2% of pool rows flag.
# Usage: gate.py <student>   (reads sample.jsonl, win/hz-sample.json, win/<student>-sample.json, and the Bonsai pair *-bonsai300.json)
import json, sys, os, collections
DATA = os.path.expanduser(os.environ.get('GUARDRAIL_DATA', '~/Development/.guardrail-data'))
WORK = os.environ.get('PAGE_MODEL_WORK', f'{DATA}/linear-2210/clf'); st = sys.argv[1]
rows = [json.loads(l) for l in open(f'{WORK}/sample.jsonl')]
hz = json.load(open(f'{WORK}/win/hz-sample.json')); ss = json.load(open(f'{WORK}/win/{st}-sample.json'))['wscore']
hb = json.load(open(f'{WORK}/win/hz-bonsai300.json')); sb = json.load(open(f'{WORK}/win/{st}-bonsai300.json'))['wscore']
assert len(ss) == len(hz['prob']) and len(sb) == len(hb['prob'])
key = lambda r: f"{r['set']}:{r['y']}" if r['set'] == 'bsafe-validate' else r['set']
COLS = ['llmail-p2', 'dtap-validate', 'bsafe-validate:1', 'm2w-validate', 'bsafe-validate:0']
pw = sorted((s for s, o in zip(ss, hz['owner']) if rows[o]['g'] == 'pool'), reverse=True); npool = sum(r['g'] == 'pool' for r in rows)
def per_row(prob, wsc, owner, n, ts):
    best = [-1.0] * n; sent = [0] * n; tot = [0] * n
    for p, s, o in zip(prob, wsc, owner):
        tot[o] += 1
        if s > ts: sent[o] += 1; best[o] = max(best[o], p)
    return best, sent, tot
print('loose sent(pool windows) m2w-windows-sent bonsai-windows-sent bonsai-max-per-page bonsai-flag ' + ' '.join(COLS))
for loose in (0.02, 0.05, 0.10, 0.20, 0.40, 1.0):
    ts = pw[min(int(loose * len(pw)), len(pw) - 1)] if loose < 1 else -1e9
    best, sent, tot = per_row(hz['prob'], ss, hz['owner'], len(rows), ts)
    pb = sorted((best[k] for k, r in enumerate(rows) if r['g'] == 'pool'), reverse=True); th = pb[int(0.02 * npool)]
    by = collections.defaultdict(lambda: [0, 0])
    for k, r in enumerate(rows):
        if r['g'] == 'val': by[key(r)][0] += best[k] > th; by[key(r)][1] += 1
    m2 = [k for k, r in enumerate(rows) if r['g'] == 'val' and r['set'] == 'm2w-validate']
    bb, bs, bt = per_row(hb['prob'], sb, hb['owner'], len(hb['score']), ts)
    print(f"{loose:.2f} {sum(s > ts for s in pw)}/{len(pw)} {sum(sent[k] for k in m2)}/{sum(tot[k] for k in m2)} {sum(bs)}/{sum(bt)} {max(bs)} {sum(v > th for v in bb)}/{len(bb)} " + ' '.join(f'{by[c][0]}/{by[c][1]}' for c in COLS))
