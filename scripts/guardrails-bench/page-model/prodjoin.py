import json,os,collections,sys
import numpy as np
K=os.path.expanduser('~/Development/.guardrail-data/kaggle'); P=sys.argv[1]
def rows(f): return [{k:v for k,v in json.loads(l).items() if k!='text'} for l in open(f)]
def sc(d,s,m='m22'): return np.array(json.load(open(f'{K}/{d}/out/out/{s}-{m}.json'))['score'])
fl=lambda n:np.array(json.load(open(f'{P}/{n}.json')))
fr=rows(f'{K}/k-full/out/rows/full.jsonl'); fs=sc('k-m22s','full'); ff=fl('full')
assert len(fr)==len(fs)==len(ff)
ben=np.array([r['set']=='bsafe-validate' and r['y']==0 for r in fr])
v=np.sort(fs[ben])[::-1]; th={b:v[int(b*len(v))] for b in (.005,.01,.02,.05)}
print('m22 thresholds',{k:round(float(x),4) for k,x in th.items()},'benign pages',ben.sum())
G=collections.OrderedDict()
def add(name,y,s,f): G[(name,y)]=(s,f)
br=rows(f'{K}/k-full/out/rows/bsbtest.jsonl'); bs=sc('k-m22s','bsbtest'); bf=fl('bsbtest'); y=np.array([r['y'] for r in br])
for t in (1,0): add('BSB test',t,bs[y==t],bf[y==t])
pr=rows(f'{K}/pm-bspp/bspp.jsonl'); ps=sc('k-m22s','bspp'); pf=fl('bspp'); y=np.array([r['y'] for r in pr]); g=np.array([r.get('g')=='rows2' for r in pr])
for t in (1,0): add('BrowseSafe++ unseen',t,ps[g&(y==t)],pf[g&(y==t)])
for n,f in {'waab':'pm-waab/waab.jsonl','inwild':'pm-leads/inwild.jsonl','tools':'pm-leads/tools.jsonl','warp':'pm-leads/warp.jsonl'}.items():
    r=rows(f'{K}/{f}'); s=sc('k-m22',n); ffl=fl(n); assert len(r)==len(s)==len(ffl)
    d=collections.defaultdict(list)
    for k,x in enumerate(r):
        p=x['set'].split('-'); d[(p[0]+('-'+p[1] if n=='warp' else ''),x['y'])].append(k)
    for (a,t),ks in sorted(d.items()): add(a,t,s[ks],ffl[ks])
by=collections.defaultdict(list)
for k,r in enumerate(fr): by[(r['set'],r['y'])].append(k)
for (a,t),ks in sorted(by.items()):
    if len(ks)>=200: add(a,t,fs[ks],ff[ks])
print(f"{'set':30} y {'n':>6} {'prod any':>8} {'prod inj':>8} {'m22 .5%':>8} {'m22 1%':>8} {'m22 2%':>8} {'m22 5%':>8}")
for (a,t),(s,f) in G.items():
    print(f"{a[:30]:30} {t} {len(s):6} {100*(f>0).mean():8.1f} {100*((f&1)>0).mean():8.1f} "+' '.join(f'{100*(s>th[b]).mean():8.1f}' for b in th))
