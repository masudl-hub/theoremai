# Flag rates at 0.5% to 20% of the benign bsafe-validate pages, one threshold per model, on BrowseSafe-Bench test, the unseen sets and each bench set of 200 rows or more.
# Usage: pagebudget.py   (reads the Kaggle output dirs under ~/Development/.guardrail-data/kaggle)
import json, os, collections, bisect
K=os.path.expanduser('~/Development/.guardrail-data/kaggle')
rows=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f'{K}/k-full/out/rows/full.jsonl')]
bsb=[json.loads(l)['y'] for l in open(f'{K}/k-full/out/rows/bsbtest.jsonl')]
M=['hz-small','hz-cv','hzT2','hzS2','t22n','t22w']
def F(m,s): return f'{K}/k-t22s/out/out/{s}-{m}.json' if m.startswith('t22') else f'{K}/k-full/out/out/{s}-{m}.json'
sc={m:json.load(open(F(m,'full')))['score'] for m in M}; bs={m:json.load(open(F(m,'bsbtest')))['score'] for m in M}
ben=[k for k,r in enumerate(rows) if r['set']=='bsafe-validate' and not r['y']]
BUD=[.005,.01,.02,.05,.10,.20]
th={m:{} for m in M}
for m in M:
    v=sorted((sc[m][k] for k in ben),reverse=True)
    for b in BUD: th[m][b]=v[int(b*len(v))]
print('threshold from',len(ben),'benign bsafe-validate pages'); print('thr',{m:[round(th[m][b],4) for b in BUD] for m in M})
R={'waab':'pm-waab/waab.jsonl','inwild':'pm-leads/inwild.jsonl','tools':'pm-leads/tools.jsonl','warp':'pm-leads/warp.jsonl'}
un={}
for name,f in R.items():
    rs=[json.loads(l) for l in open(f'{K}/{f}')]
    s={m:json.load(open(f"{K}/{'k-t22/out/out' if m.startswith('t22') else 'k-diag/out/out'}/{name}-{m}.json"))['score'] for m in M}
    g=collections.defaultdict(list)
    for k,r in enumerate(rs):
        p=r['set'].split('-'); g[(p[0]+('-'+p[1] if name=='warp' else ''),r['y'])].append(k)
    for kk,ks in g.items(): un[kk]=(s,ks)
def rate(vals,t): return 100*sum(x>t for x in vals)/len(vals)
tab=collections.OrderedDict()
tab[('BSB test',1,len(bsb)-bsb.count(0))]=lambda m,t:rate([v for v,y in zip(bs[m],bsb) if y],t)
tab[('BSB test',0,bsb.count(0))]=lambda m,t:rate([v for v,y in zip(bs[m],bsb) if not y],t)
for (g,y),(s,ks) in sorted(un.items()):
    tab[(g,y,len(ks))]=(lambda s,ks:lambda m,t:rate([s[m][k] for k in ks],t))(s,ks)
by=collections.defaultdict(list)
for k,r in enumerate(rows): by[(r['set'],r['y'])].append(k)
for g in sorted(by):
    if g[0]=='bsafe-validate' and g[1]==0: continue
    if len(by[g])>=200: tab[(g[0],g[1],len(by[g]))]=(lambda ks:lambda m,t:rate([sc[m][k] for k in ks],t))(by[g])
for b in (.01,.05,.10):
    print(f'\nflag % at {b*100:.0f}% of benign bsafe-validate pages'); print(f"{'set':26} y {'n':>6} "+' '.join(f'{m[:8]:>8}' for m in M))
    for (g,y,n),fn in tab.items(): print(f'{g[:26]:26} {y} {n:6} '+' '.join(f'{fn(m,th[m][b]):8.1f}' for m in M))
