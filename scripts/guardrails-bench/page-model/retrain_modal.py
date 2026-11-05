# Retraining arms for m22 on Modal, one GPU each: m22's own recipe (row labels only, MIL, from t22n, 22 layers, cut vocabulary,
# one epoch, AMP) on teach8r plus each arm's components from pm-retrain1 (arms.json); arm E starts from m22 at LR 1e-5.
# Checkpoints live on the volume, so a restarted container resumes. score() scores a trained arm on every pm-retrain-eval file.
#   MODAL_PROFILE=retrain modal run retrain_modal.py::probe --gpu A10G      timing on the first 60,000 windows of arm A
#   MODAL_PROFILE=retrain modal run --detach retrain_modal.py::launch --arms A,B,C,D,E,F --gpu A10G
#   MODAL_PROFILE=retrain modal run --detach retrain_modal.py::score_arms --models m22,rA,rB
# The volume `retrain` holds in/ (pm-teach7, pm-teach8, pm-t22, pm-m22, pm-mil, pm-retrain1, pm-retrain-eval, mini.jsonl) and out/.
import modal, os
app = modal.App('pm-retrain')
vol = modal.Volume.from_name('retrain')
image = modal.Image.debian_slim(python_version='3.12').pip_install('torch==2.8.0', 'transformers==5.3.0', 'tokenizers==0.22.2', 'safetensors==0.8.0', 'huggingface_hub', 'numpy')
V = '/vol'


def body(a, limit=0, name=None):
    import subprocess, shutil, json, gzip, time, threading, glob
    from huggingface_hub import snapshot_download
    I = f'{V}/in'; W = '/tmp/rt'; G = f'{W}/gd'; C = f'{G}/linear-2210/clf'; m = name or f'r{a}'; os.makedirs(W, exist_ok=True)
    snapshot_download('Horizon-Labs/prompt-injection-guard-small', local_dir=f'{G}/hf-models/Horizon-Labs__prompt-injection-guard-small', allow_patterns=['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'])
    os.makedirs(f'{C}/trim/m5', exist_ok=True); shutil.copy(f'{I}/pm-teach7/remap.json', f'{C}/trim/m5/remap.json'); REMAP = f'{C}/trim/m5/remap.json'
    sets7 = json.load(open(f'{I}/pm-teach7/sets7.json')); SETS = f'{W}/sets8.json'; json.dump(sets7 + json.load(open(f'{I}/pm-teach8/sets-u.json')), open(SETS, 'w'))
    over7, overu = (json.load(open(f'{I}/pm-teach8/{x}.json')) for x in ('over7', 'overu')); TEACHR = f'{W}/teach8r.jsonl'
    with gzip.open(f'{I}/pm-teach7/teach7.jsonl.gz', 'rt') as r, open(TEACHR, 'w') as c:
        for k, l in enumerate(r):
            if str(k) in over7: w = json.loads(l); w['p'] = over7[str(k)]; l = json.dumps(w) + '\n'
            c.write(l)
        for k, l in enumerate(open(f'{I}/pm-teach8/teach-u.jsonl')):
            w = json.loads(l); w['owner'] += len(sets7)
            if str(k) in overu: w['p'] = overu[str(k)]
            c.write(json.dumps(w) + '\n')
    R = f'{I}/pm-retrain1'; TEACH = f'{W}/teach-{a}.jsonl'; ASETS = f'{W}/sets-{a}.json'
    subprocess.run(f'python -I {R}/compose.py {a} {TEACHR} {SETS} {R} {TEACH} {ASETS}', shell=True, check=True); os.remove(TEACHR)
    os.makedirs(f'{W}/pm', exist_ok=True); shutil.copy(f'{I}/pm-teach7/score.py', f'{W}/pm'); shutil.copy(f'{I}/pm-mil/mil-prune.py', f'{W}/pm/prune.py')
    for s in ('t22n', 'm22'):
        os.makedirs(f'{C}/prune/{s}', exist_ok=True); [shutil.copy(f'{I}/pm-{"t22" if s == "t22n" else s}/{s}-{x}', f'{C}/prune/{s}/{x}') for x in ('config.json', 'model.safetensors')]
        shutil.copy(f'{I}/pm-{"t22" if s == "t22n" else s}/remap.json', f'{C}/prune/{s}/remap.json')
    out = f'{V}/out/{m}'; os.makedirs(out, exist_ok=True); os.symlink(out, f'{C}/prune/{m}')  # checkpoints and the model land on the volume
    env = dict(os.environ, GUARDRAIL_DATA=G, DEV='cuda', AMP='1', B='32', NOSCORE='1', REMAP=REMAP, LR='1e-5' if a == 'E' else '2e-5', SCHED='cos',
               CKPT='0' if limit else '2000', MIL='1', LOSS='bce', SELECT='auc', TEACH=TEACH, SETS=ASETS, LOAD=f'{C}/prune/{"m22" if a == "E" else "t22n"}', **({'LIMIT': str(limit)} if limit else {}))
    done = []
    def commit():
        while not done: time.sleep(300); vol.commit()
    threading.Thread(target=commit, daemon=True).start()
    t = time.time(); p = subprocess.run(f'cd {W}/pm && python -I prune.py {m} {",".join(map(str, range(22)))} 1 2>&1 | tee {out}/train.log | grep -vE "Loading weights|Writing model"', shell=True, env=env)
    done.append(1); secs = time.time() - t; print(m, 'rc', p.returncode, round(secs), 's', flush=True)
    json.dump({'rc': p.returncode, 'secs': secs, 'gpu': os.environ.get('MODAL_GPU', '')}, open(f'{out}/done.json', 'w')); vol.commit()
    return secs


@app.function(image=image, volumes={V: vol}, gpu='L4', cpu=2, memory=24576, timeout=24 * 3600, retries=modal.Retries(max_retries=2, initial_delay=60.0))
def train(a: str, limit: int = 0, name: str = ''):
    return body(a, limit, name or None)


@app.function(image=image, volumes={V: vol}, gpu='A10G', cpu=2, memory=16384, timeout=6 * 3600)
def score(m: str):
    import subprocess, shutil, glob
    from huggingface_hub import snapshot_download
    I = f'{V}/in'; W = '/tmp/rs'; G = f'{W}/gd'; C = f'{G}/linear-2210/clf'; O = f'{V}/out/scores-{m}'; os.makedirs(O, exist_ok=True)
    snapshot_download('Horizon-Labs/prompt-injection-guard-small', local_dir=f'{G}/hf-models/Horizon-Labs__prompt-injection-guard-small', allow_patterns=['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'])
    os.makedirs(f'{C}/trim/m5', exist_ok=True); shutil.copy(f'{I}/pm-teach7/remap.json', f'{C}/trim/m5/remap.json')
    os.makedirs(f'{W}/pm', exist_ok=True); shutil.copy(f'{I}/pm-teach7/score.py', f'{W}/pm'); shutil.copy(f'{I}/pm-mil/mil-prune.py', f'{W}/pm/prune.py')
    shutil.copytree(f'{V}/out/{m}', f'{C}/prune/{m}', ignore=shutil.ignore_patterns('ckpt.pt*', 'train.log'))
    for p in sorted(glob.glob(f'{I}/pm-retrain-eval/*.jsonl')):
        n = os.path.basename(p)[:-6]
        env = dict(os.environ, GUARDRAIL_DATA=G, REMAP=f'{C}/trim/m5/remap.json', TEACH=f'{I}/mini.jsonl', LIMIT='64', LOAD=f'{C}/prune/{m}', EP='0', EVAL=p, OUT=f'{O}/{n}.json', DEV='cuda')
        r = subprocess.run(f'cd {W}/pm && python -I prune.py {m} 0 0 2>&1 | grep -E "scored|Error" | tail -1', shell=True, env=env, capture_output=True, text=True); print(n, r.stdout.strip(), flush=True)
        vol.commit()


@app.local_entrypoint()
def score_arms(models: str = 'rD,rE,rF'):
    for m, r in zip(models.split(','), score.map(models.split(','), return_exceptions=True)): print(m, r)


@app.local_entrypoint()
def probe(gpu: str = 'L4'):
    print(gpu, train.with_options(gpu=gpu).remote('A', 60000, f'probe-{gpu}'))


@app.local_entrypoint()
def launch(arms: str = 'A,B,C,D,E,F', gpu: str = 'L4'):
    f = train.with_options(gpu=gpu)
    for a, s in zip(arms.split(','), f.starmap([(a,) for a in arms.split(',')], return_exceptions=True)): print(a, s)
