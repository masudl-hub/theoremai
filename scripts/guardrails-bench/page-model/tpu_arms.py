# Eight arms, one TPU chip each, on teach8 with Horizon's own label on c:repo-hard, each then scored on every set. Row labels throughout; MIX anchors one window of each row to the teach logit; FACT is the word table's columns.
import subprocess, os, shutil, glob, json, time, signal, gzip, threading
T0 = time.time(); TRAIN_END, END = T0 + 6.5 * 3600, T0 + 8.6 * 3600  # Kaggle ends a TPU session at 9 hours
ARMS = {'v22': dict(LOAD='u22r'), 'w22': dict(MIX='1', LOAD='u22r'), 'w22q': dict(MIX='.25', LOAD='u22r'), 'w22m': dict(MIX='1', LOAD='m22'), 'm22a': dict(MIX='1', LOAD='t22n'), 'fm128': dict(FACT='128', LOAD='m22'), 'fm64': dict(FACT='64', LOAD='m22'), 'w128': dict(MIX='1', FACT='128', LOAD='u22r')}
def sh(c): r = subprocess.run(c, shell=True, capture_output=True, text=True); print(c[-200:], '\n', r.stdout[-1500:], r.stderr[-1500:], flush=True)
def run(c, env, end):
    p = subprocess.Popen(c, shell=True, env=env, start_new_session=True)
    try: return p.wait(timeout=max(60, end - time.time()))
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGTERM)
        try: p.wait(timeout=600)
        except subprocess.TimeoutExpired: os.killpg(p.pid, signal.SIGKILL)
        return -1
sh('pip install -q transformers==5.3.0 tokenizers==0.22.2 safetensors==0.8.0 2>&1 | tail -2; pip list 2>/dev/null | grep -E "^(torch|torch.xla|transformers) "; free -g | head -2; nproc')
from huggingface_hub import snapshot_download
import pyarrow.parquet as pq
f = lambda n: os.path.dirname(glob.glob(f'/kaggle/input/**/{n}', recursive=True)[0])
G = '/kaggle/working/gd'; C = f'{G}/linear-2210/clf'; O = '/kaggle/working/out'; R = '/kaggle/working/rows'; os.makedirs(O, exist_ok=True); os.makedirs(R, exist_ok=True); os.environ['GUARDRAIL_DATA'] = G
T, T8, S1 = f('sets7.json'), f('sets-u.json'), f('hzS1-config.json')
snapshot_download('Horizon-Labs/prompt-injection-guard-small', local_dir=f'{G}/hf-models/Horizon-Labs__prompt-injection-guard-small', allow_patterns=['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'])
os.makedirs(f'{C}/trim/m5', exist_ok=True); shutil.copy(f'{T}/remap.json', f'{C}/trim/m5/remap.json'); REMAP = f'{C}/trim/m5/remap.json'
TG = glob.glob(f'{T}/teach7.jsonl*')[0]; TEACHR = '/kaggle/working/teach8r.jsonl'
sets7 = json.load(open(f'{T}/sets7.json')); SETS = '/kaggle/working/sets8.json'; json.dump(sets7 + json.load(open(f'{T8}/sets-u.json')), open(SETS, 'w'))
over7, overu = (json.load(open(f'{T8}/{x}.json')) for x in ('over7', 'overu'))
with (gzip.open(TG, 'rt') if TG.endswith('.gz') else open(TG)) as a, open(TEACHR, 'w') as c:
    for k, l in enumerate(a):
        if str(k) in over7: w = json.loads(l); w['p'] = over7[str(k)]; l = json.dumps(w) + '\n'
        c.write(l)
    for k, l in enumerate(open(f'{T8}/teach-u.jsonl')):
        w = json.loads(l); w['owner'] += len(sets7)
        if str(k) in overu: w['p'] = overu[str(k)]
        c.write(json.dumps(w) + '\n')
os.makedirs('/kaggle/working/pm', exist_ok=True); shutil.copy(f'{T}/score.py', '/kaggle/working/pm'); shutil.copy(f"{f('xla-prune.py')}/xla-prune.py", '/kaggle/working/pm/prune.py')
for m, q in (('t22n', 't22n-config.json'), ('u22r', 'u22r-config.json'), ('m22', 'm22-config.json')):
    d = f(q); os.makedirs(f'{C}/prune/{m}', exist_ok=True); [shutil.copy(f'{d}/{m}-{x}', f'{C}/prune/{m}/{x}') for x in ('config.json', 'model.safetensors')]; shutil.copy(f'{d}/remap.json', f'{C}/prune/{m}/remap.json')
for n in ('full', 'bspp'):
    p = glob.glob(f'/kaggle/input/**/{n}.jsonl*', recursive=True)[0]
    with (gzip.open(p, 'rt') if p.endswith('.gz') else open(p)) as a, open(f'{R}/{n}.jsonl', 'w') as b: shutil.copyfileobj(a, b)
d = snapshot_download('perplexity-ai/browsesafe-bench', repo_type='dataset', local_dir='/kaggle/working/bsb', allow_patterns=['*test*'])
with open(f'{R}/bsbtest.jsonl', 'w') as o:
    for p in glob.glob(f'{d}/**/*test*.parquet', recursive=True):
        for x in pq.read_table(p, columns=['content', 'label']).to_pylist():
            y = int(x['label'] == 'yes'); o.write(json.dumps({'set': f"bsbtest-{'attack' if y else 'benign'}", 'y': y, 'text': x['content'] or ''}) + '\n')
shutil.rmtree('/kaggle/working/bsb', ignore_errors=True)
for n, q in (('waab', 'waab.jsonl'), ('inwild', 'inwild.jsonl'), ('tools', 'tools.jsonl'), ('warp', 'warp.jsonl')): shutil.copy(f'{f(q)}/{q}', f'{R}/{n}.jsonl')
for n in ('rows2', 'drift'): shutil.copy(f'{S1}/{n}.jsonl', f'{R}/{n}.jsonl')
print('data ready', round(time.time() - T0), 's', flush=True)
def chip(k): return dict(os.environ, PJRT_DEVICE='TPU', TPU_VISIBLE_CHIPS=str(k), TPU_CHIPS_PER_PROCESS_BOUNDS='1,1,1', TPU_PROCESS_BOUNDS='1,1,1', CLOUD_TPU_TASK_ID='0', TPU_PROCESS_PORT=str(8476 + k), ALLOW_MULTIPLE_LIBTPU_LOAD='1')
open('/kaggle/working/chip.py', 'w').write("import os, torch, torch_xla\nd = torch_xla.device(); x = torch.ones(8, 8, device=d); print('chip', os.environ.get('TPU_VISIBLE_CHIPS'), d, (x @ x).sum().item(), flush=True)\n")
ps = [subprocess.Popen('python -I /kaggle/working/chip.py 2>&1 | tail -2', shell=True, env=chip(k), start_new_session=True, stdout=subprocess.PIPE, text=True) for k in range(8)]; good = []
for k, p in enumerate(ps):
    try: o = p.communicate(timeout=420)[0]; print(k, o[-300:], flush=True); good += [k] if f'chip {k}' in o else []
    except subprocess.TimeoutExpired: os.killpg(p.pid, signal.SIGKILL); print(k, 'no answer', flush=True)
print('chips that work alone', good, flush=True)
single = len(good) < 8
if single: ARMS = dict(list(ARMS.items())[:1]); print('chips will not run apart, so one arm on the whole TPU process', flush=True)
base = dict(DEV='xla', B='32', NOSCORE='1', REMAP=REMAP, SETS=SETS, LR='2e-5', SCHED='cos', CKPT='2000', TEACH=TEACHR, MIL='1', LOSS='bce', SELECT='auc')
L = ','.join(map(str, range(22)))
def env(k): return dict(os.environ, PJRT_DEVICE='TPU') if single else chip(k)
def arm(m, w, k):
    t = time.time(); r = run(f'cd /kaggle/working/pm && exec python -I prune.py {m} {L} 1 > {O}/{m}.log 2>&1', dict(env(k), **base, **dict(w, LOAD=f"{C}/prune/{w['LOAD']}")), TRAIN_END)
    print(m, 'chip', k, 'rc', r, round(time.time() - t), 's', open(f'{O}/{m}.log').read()[-500:], flush=True)
    if os.path.exists(f'{C}/prune/{m}/ckpt.pt'): shutil.copy(f'{C}/prune/{m}/ckpt.pt', f'{O}/{m}-ckpt.pt')
    if r != 0 or not os.path.exists(f'{C}/prune/{m}/model.safetensors'): return
    shutil.copytree(f'{C}/prune/{m}', f'{O}/model-{m}')
    for n in ('tools', 'inwild', 'warp', 'waab', 'drift', 'rows2', 'bsbtest', 'full', 'bspp'):
        if time.time() > END - 300: print(m, 'out of time before', n, flush=True); break
        t = time.time(); r = run(f'cd /kaggle/working/pm && REMAP={REMAP} TEACH={TEACHR} LIMIT=64 LOAD={C}/prune/{m} EP=0 EVAL={R}/{n}.jsonl OUT={O}/{n}-{m}.json DEV=xla exec python -I prune.py {m} 0 0 > {O}/{m}-{n}.log 2>&1', env(k), END)
        print(m, n, 'rc', r, round(time.time() - t), 's', flush=True)
th = [threading.Thread(target=arm, args=(m, w, k)) for k, (m, w) in enumerate(ARMS.items())]; [t.start() for t in th]
while any(t.is_alive() for t in th):
    time.sleep(1800); print(round((time.time() - T0) / 3600, 1), 'h', {m: int(os.path.getmtime(f'{C}/prune/{m}/ckpt.pt') - T0) if os.path.exists(f'{C}/prune/{m}/ckpt.pt') else None for m in ARMS}, flush=True)
print('done', sorted(os.listdir(O)), flush=True)
shutil.rmtree(G, ignore_errors=True); shutil.rmtree('/kaggle/working/pm', ignore_errors=True); shutil.rmtree(R); os.remove(TEACHR)
