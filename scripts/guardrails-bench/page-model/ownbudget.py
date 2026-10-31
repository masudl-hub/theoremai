# Each set against its own benign rows: AUC and recall at 1% and 5% of them, so a threshold that moves between sets does not count as a gain.
# Usage: ownbudget.py   (reads the Kaggle output dirs under ~/Development/.guardrail-data/kaggle)
import json, os, collections
K=os.path.expanduser('~/Development/.guardrail-data/kaggle')
rows=[json.loads(l) for l in open(f'{K}/k-full/out/rows/full.jsonl')]
bsb=[json.loads(l)['y'] for l in open(f'{K}/k-full/out/rows/bsbtest.jsonl')]
M=['hz-small','hz-cv','hzT2','hzS2','t22n','t22w']
def F(m,s): return f'{K}/k-t22s/out/out/{s}-{m}.json' if m.startswith('t22') else f'{K}/k-full/out/out/{s}-{m}.json'
sc={m:json.load(open(F(m,'full')))['score'] for m in M}; bs={m:json.load(open(F(m,'bsbtest')))['score'] for m in M}
def auc(p,n):
    v=sorted([(x,1) for x in p]+[(x,0) for x in n]); i,t=0,0.0
    while i<len(v):
        j=i
        while j<len(v) and v[j][0]==v[i][0]: j+=1
        t+=(i+j+1)/2*sum(y for _,y in v[i:j]); i=j
    return (t-len(p)*(len(p)+1)/2)/(len(p)*len(n))
def own(p,n,f):
    n=sorted(n,reverse=True); t=n[min(len(n)-1,int(f*len(n)))]; return 100*sum(x>t for x in p)/len(p)
G={}
v=[k for k,r in enumerate(rows) if r['set']=='bsafe-validate']
G['bsafe-validate']={m:([sc[m][k] for k in v if rows[k]['y']],[sc[m][k] for k in v if not rows[k]['y']]) for m in M}
G['BSB test']={m:([x for x,y in zip(bs[m],bsb) if y],[x for x,y in zip(bs[m],bsb) if not y]) for m in M}
R={'waab':'pm-waab/waab.jsonl','inwild':'pm-leads/inwild.jsonl','tools':'pm-leads/tools.jsonl','warp':'pm-leads/warp.jsonl'}
for name,f in R.items():
    rs=[json.loads(l) for l in open(f'{K}/{f}')]
    s={m:json.load(open(f"{K}/{'k-t22/out/out' if m.startswith('t22') else 'k-diag/out/out'}/{name}-{m}.json"))['score'] for m in M}
    g=collections.defaultdict(list)
    for k,r in enumerate(rs):
        p=r['set'].split('-'); g[p[0]+('-'+p[1] if name=='warp' else '')].append(k)
    for gg,ks in g.items():
        P=[k for k in ks if rs[k]['y']]; N=[k for k in ks if not rs[k]['y']]
        if P and N: G[gg]={m:([s[m][k] for k in P],[s[m][k] for k in N]) for m in M}
print(f"{'set':16} {'n+':>5} {'n-':>5} | "+' '.join(f'{m[:7]:>7}' for m in M))
for g,d in G.items():
    a=d[M[0]]; print(f"{g:16} {len(a[0]):5} {len(a[1]):5} AUC "+' '.join(f'{auc(*d[m]):7.3f}' for m in M))
    for f in (.01,.05): print(f"{'':28} {f*100:.0f}% "+' '.join(f'{own(*d[m],f):7.1f}' for m in M))
# BrowseSafe++ held-out English pairs, t22 arms only for now
br=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f'{K}/pm-bspp/bspp.jsonl')]
print('bspp g',collections.Counter(r['g'] for r in br))
for m in ('t22n','t22w'):
    s=json.load(open(F(m,'bspp')))['score']; assert len(s)==len(br)
    for g in ('rows2','unseen-old'):
        P=[s[k] for k,r in enumerate(br) if r['g']==g and r['y']]; N=[s[k] for k,r in enumerate(br) if r['g']==g and not r['y']]
        print(m,g,len(P),len(N),f'AUC {auc(P,N):.3f} rec@1 {own(P,N,.01):.1f} rec@5 {own(P,N,.05):.1f}', 'seen in training' if g!='rows2' else 'unseen')
