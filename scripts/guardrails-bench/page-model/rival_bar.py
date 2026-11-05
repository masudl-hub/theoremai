# The rival bar (R5) for m22 and every A84 arm. Per set, each rival (BrowseSafe, Prompt Guard 2) at 0.5, as it ships; each model's
# catch at the rival's false alarm rate on that set's own harmless rows, minus the rival's catch, and the worse of the two gaps.
# Attack-only sets compare catch at the model's 1% bsafe-validate line; harmless-only sets compare flags there. Negative is short.
# Then AUC and catch at fixed false alarm rates on waab and WARP reddit. Reads saved scores only: waab and WARP from the Mac runs
# in kaggle/k-<model>/ and the pass-1 rival chunks in out-pass1-final/; the bench-hunt sets from retrain-work/ and bench-hunt/results/.
import json, os, glob, numpy as np
D=os.path.expanduser('~/Development/.guardrail-data'); K=f'{D}/kaggle'; P=os.path.expanduser('~/Development/theoremai-bench/scripts/guardrails-bench/page-model')
h=open(f'{P}/hunt_report.py').read(); H={'__file__':f'{P}/hunt_report.py'}; exec(h[:h.index('\ndef load(')],H)
W=f'{D}/retrain-work'; LINE=json.load(open(f'{W}/report.json'))['line']; M=['m22','rA','rB','rC','rD','rE','rF']
def rowmax(p,n):
    d=json.load(open(p)); r=np.full(n,-1.0); np.maximum.at(r,np.array(d['owner']),np.array(d['prob'])); return r
G={}
for s,f in {'waab':f'{K}/pm-waab/waab.jsonl','warp':f'{K}/pm-leads/warp.jsonl'}.items():
    rs=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f)]; n=len(rs); idx=np.array(json.load(open(f'{D}/modal-up/pass1/{s}.idx.json'))); assert len(idx)==n
    sc={m:rowmax(f"{K}/{'k-m22' if m=='m22' else 'k-'+m}/out/out/{s}-{m}.json",n) for m in M}
    for m,d in (('BS','browsesafe'),('PG2','pg2-86m')): sc[m]=np.concatenate([json.load(open(p))['score'] for p in sorted(glob.glob(f'{D}/out-pass1-final/out-pass1/{d}/{s}.[0-9]*.json'))])
    y=np.array([r['y'] for r in rs]); gs=np.array([r['set'].split('-')[0]+('-'+r['set'].split('-')[1] if s=='warp' else '') for r in rs])
    for g in sorted(set(gs)): k=gs==g; G[g]=({m:v[k] for m,v in sc.items()},y[k])
HB=f'{D}/bench-hunt'
for s in sorted(f[:-6] for f in os.listdir(f'{HB}/sets')):
    rows=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f'{HB}/sets/{s}.jsonl')]
    keep=np.array([not H['group'](s,r['category'])[2] for r in rows])
    if not keep.any(): continue
    hp=lambda m:next(p for p in (f'{W}/out/scores-{m}/hunt-{s}.json',f'{W}/out/scores-{m}/scores-{m}/hunt-{s}.json') if os.path.exists(p))
    sc={m:np.array(json.load(open(hp(m)))['score'])[keep] for m in M}
    for m,d in (('BS','bs'),('PG2','pg2')): sc[m]=np.array(json.load(open(f'{HB}/results/{d}/{s}.json'))['score'])[keep]
    G[s]=(sc,np.array([r['y'] for r in rows])[keep])
def ours(v,y,m,fa):
    if y.all(): return 100*(v>LINE[m]).mean()
    if not y.any(): return 100*(v>LINE[m]).mean()
    neg=np.sort(v[y==0])[::-1]; k=int(np.floor(fa*len(neg)+1e-9)); t=neg[k] if k<len(neg) else -np.inf
    return 100*(v[y==1]>t).mean()
print(f"{'set':18}{'n+':>6}{'n-':>6} {'bar':>22} | "+' '.join(f'{m:>6}' for m in M))
for g,(sc,y) in G.items():
    gaps={m:[] for m in M}; bars=[]
    for r in ('BS','PG2'):
        f=sc[r]>.5
        if y.any():
            c=100*f[y==1].mean(); fa=f[y==0].mean() if (1-y).any() else None; bars.append(f'{r} {c:.1f}'+(f'@{100*fa:.1f}' if fa is not None else ''))
            for m in M: gaps[m].append(ours(sc[m],y,m,fa or 0)-c)
        else:
            fa=100*f.mean(); bars.append(f'{r} FA {fa:.1f}')
            for m in M: gaps[m].append(fa-ours(sc[m],y,m,0))
    worst={m:min(gaps[m]) for m in M}
    print(f'{g[:18]:18}{int(y.sum()):6}{int((1-y).sum()):6} {" / ".join(bars):>22} | '+' '.join(f'{worst[m]:6.1f}' for m in M))

auc=H['auc']
for g in ('waab','warp-reddit'):
    sc,y=G[g]; print(g)
    for m in M:
        v=sc[m]; neg=np.sort(v[y==0])[::-1]
        r=lambda b:100*(v[y==1]>neg[int(b*len(neg))]).mean()
        print(f'  {m:4} AUC {auc(v,y):.4f}  catch at FA 0.1% {r(.001):5.1f}  0.5% {r(.005):5.1f}  1% {r(.01):5.1f}  2.5% {r(.025):5.1f}')
