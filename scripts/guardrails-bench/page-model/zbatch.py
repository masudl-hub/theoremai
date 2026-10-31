# Rescores saved window probabilities with no new model run: ensembles of two models, length gates and other row pools. AUC on each set's own benign rows, flag rate at 1% of the benign bsafe-validate pages.
# Usage: zbatch.py [hz model] [cut model]   (reads the Kaggle output dirs under ~/Development/.guardrail-data/kaggle)
import json, os, sys, collections
import numpy as np
K=os.path.expanduser('~/Development/.guardrail-data/kaggle')
A,B=(sys.argv[1:3]+['hz-small','t22n'])[:2] if len(sys.argv)<3 else sys.argv[1:3]
def path(m,s):
    if s in('full','bsbtest','bspp'): return f"{K}/{dict(t='k-t22s',u='k-u22s',m='k-m22s',f='k-m22s')[m[0]] if m[0] in 'tumf' else 'k-bspp' if s=='bspp' else 'k-full'}/out/out/{s}-{m}.json"
    return f"{K}/{dict(t='k-t22',u='k-u22',m='k-m22',f='k-m22').get(m[0],'k-diag')}/out/out/{s}-{m}.json"
lg=lambda p:np.log(np.clip(p,1e-7,1-1e-7)/(1-np.clip(p,1e-7,1-1e-7)))
def maxby(v,o,n):
    r=np.full(n,-np.inf); np.maximum.at(r,o,v); return r
def methods(s):
    a,b=[json.load(open(path(m,s))) for m in (A,B)]
    assert a['owner']==b['owner'],s
    o=np.array(a['owner']); N=np.array(json.load(open(path('hz-small',s)))['ntok'],float).clip(1); n=len(N); x,y=lg(np.array(a['prob'])),lg(np.array(b['prob']))
    H,T=maxby(x,o,n),maxby(y,o,n); R={A:H,B:T,'mean':maxby((x+y)/2,o,n),'and':maxby(np.minimum(x,y),o,n),'or':np.maximum(H,T)}
    for c in (64,128,256): w=np.minimum(1,N/c); R[f'switch{c}']=w*T+(1-w)*H
    for c in (1,2): R[f'lenpen{c}']=T+c*np.minimum(0,np.log(N/64))
    top=np.full(n,np.nan); second=np.full(n,np.nan); d=collections.defaultdict(list)
    for k,i in enumerate(o): d[i].append(y[k])
    med=np.zeros(n)
    for i,v in d.items():
        v=sorted(v,reverse=True); top[i]=v[0]; second[i]=v[1] if len(v)>1 else v[0]; med[i]=np.median(v) if len(v)>1 else 0
    R['top2']=(top+second)/2; R['contrast']=top-med
    return R
def auc(p,n):
    v=np.concatenate([p,n]); o=np.argsort(v); r=np.empty(len(v)); s=v[o]; i=0
    while i<len(s):
        j=np.searchsorted(s,s[i],side='right'); r[o[i:j]]=(i+j+1)/2; i=j
    return (r[:len(p)].sum()-len(p)*(len(p)+1)/2)/(len(p)*len(n))
full=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f'{K}/k-full/out/rows/full.jsonl')]
F=methods('full'); fy=np.array([r['y'] for r in full]); fs=np.array([r['set'] for r in full])
M=list(F); ben=np.where((fs=='bsafe-validate')&(fy==0))[0]
BUDGETS=(0.1,0.5,1,2,5)
th={m:np.sort(F[m][ben])[::-1][int(.01*len(ben))] for m in M}
G={}  # name: (scores per method, y)
v=np.where(fs=='bsafe-validate')[0]; G['bsafe-validate']=({m:F[m][v] for m in M},fy[v])
b=methods('bsbtest'); by=np.array([json.loads(l)['y'] for l in open(f'{K}/k-full/out/rows/bsbtest.jsonl')]); G['BSB test']=(b,by)
br=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f'{K}/pm-bspp/bspp.jsonl')]; s=methods('bspp')
k=np.array([r['g']=='rows2' for r in br]); G['BSpp unseen']=({m:s[m][k] for m in M},np.array([r['y'] for r in br])[k])
for name,f in {'waab':'pm-waab/waab.jsonl','inwild':'pm-leads/inwild.jsonl','tools':'pm-leads/tools.jsonl','warp':'pm-leads/warp.jsonl'}.items():
    rs=[{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f'{K}/{f}')]; s=methods(name); gs=collections.defaultdict(list)
    for i,r in enumerate(rs): p=r['set'].split('-'); gs[p[0]+('-'+p[1] if name=='warp' else '')].append(i)
    for g,ks in gs.items():
        y=np.array([rs[i]['y'] for i in ks])
        G[g]=({m:s[m][ks] for m in M},y)
print('AUC on own benign rows\n'+f"{'set':16}{'n+':>6}{'n-':>6} "+' '.join(f'{m[:8]:>8}' for m in M))
for g,(s,y) in G.items():
    if y.any() and not y.all(): print(f'{g[:16]:16}{int(y.sum()):6}{int((1-y).sum()):6} '+' '.join(f'{auc(s[m][y==1],s[m][y==0]):8.3f}' for m in M))
print('\nflag % at 1% of benign bsafe-validate pages\n'+f"{'set':24}{'y':>2}{'n':>7} "+' '.join(f'{m[:8]:>8}' for m in M))
for g,(s,y) in G.items():
    for c in (1,0):
        if (g=='bsafe-validate' and c==0) or not (y==c).any(): continue
        print(f'{g[:24]:24}{c:2}{int((y==c).sum()):7} '+' '.join(f'{100*(s[m][y==c]>th[m]).mean():8.1f}' for m in M))
print('\nrecall curve: flag % at each share of the benign bsafe-validate pages; attacks, then the benign rows of the same sets\n'+f"{'set':24}{'y':>2}{'n':>7}{'model':>10} "+' '.join(f'{b:>6}%' for b in BUDGETS))
for g,(s,y) in G.items():
    for c in (1,0):
        if (g=='bsafe-validate' and c==0) or not (y==c).any(): continue
        for m in M[:2]+['or']:
            ts=[np.sort(F[m][ben])[::-1][int(b/100*len(ben))] for b in BUDGETS]
            print(f'{g[:24]:24}{c:2}{int((y==c).sum()):7}{m[:10]:>10} '+' '.join(f'{100*(s[m][y==c]>t).mean():7.1f}' for t in ts))
nt=np.array(json.load(open(path('hz-small','full')))['ntok'])
print('\nbench sets of 200 rows or more whose median row is under 128 tokens: flag % at the same thresholds\n'+f"{'set':30}{'y':>2}{'n':>7}{'tok':>6} "+' '.join(f'{m[:8]:>8}' for m in M))
for g in sorted(set(fs)):
    for c in (1,0):
        q=(fs==g)&(fy==c)
        if q.sum()>=200 and (np.median(nt[q])<128 or g=='c:wildjailbreak-benign'): print(f'{g[:30]:30}{c:2}{int(q.sum()):7}{int(np.median(nt[q])):6} '+' '.join(f'{100*(F[m][q]>th[m]).mean():8.1f}' for m in M))
