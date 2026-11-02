# Horizon small cut to the chosen layers and the 76k-token vocabulary, trained to copy Horizon on its windows (teach4.jsonl),
# then scored on EVAL with score.py's windows. Saves to prune/<name> when the SELECT metric on held-out windows improves.
# DEV=cuda AMP=1 trains in fp16 (a T4 has no bf16). On MPS the cache is emptied every 100 batches, or it grows past 40 GB. NOSCORE=1 stops after training. LOAD=<dir> starts from a saved model. QUANT=8 or 4 scores with the weights of a q_g_w build.
# SRC=<dir> cuts from a saved cut model instead of Horizon; TMAP then names the Horizon layer behind each kept layer.
# LOSS=bce copies Horizon's probability; LOSS=mse copies its logit. HID=<weight> also copies the hidden state of the Horizon layer
# behind each kept layer (Horizon runs alongside). SCHED=cos warms up for 6% of steps, then decays the learning rate to 0.
# SELECT=agree (at 0.5), auc (against Horizon's 0.5 label), or top (how many of Horizon's top 2% of held-out windows the cut also ranks top 2%).
# LOSS=rank adds a pairwise loss on Horizon's order within each batch. TAIL=<k> weights windows near Horizon's top-5% logit by up to 1+k.
# PAGE=<weight> batches every window of each page, 4 at a time, and also copies Horizon's score for them (the highest window). MERGE=<a> starts each kept layer as
# (1-a) of itself plus a of the mean of the dropped layers nearest it. LENS=<weight> copies Horizon's score read from the layer behind
# each kept layer through Horizon's own head. FRAC=<f> trains on that share of training pages (a cut that needs a ruling, R4). HID, LENS and MERGE need SRC unset or TMAP.
# SETS=<sets.json> (teach_set.py sets) and WEIGHT=<set>=<w>,... scale the loss and the rank pairs on every window of those sets.
# MIL=1 trains on row labels alone (a row is an attack if its top teach label is over 0.5): each batch is B rows, and only the window the current model ranks top in each row takes the loss. LOSS=bce. MIX=<w> also copies the teach logit on one random window of each row, at weight w.
# DEV=xla runs on a TPU: every batch is padded to a fixed length and row count, since each new shape compiles again. AMP stays off.
# EMBK=<k> scores with the word table cut to rank k, as a table of k columns and a k x 384 projection would hold it. FACT=<k> trains with that table and projection, from the rank-k cut, and saves their product.
# A stop signal (SIGTERM, as the swap guard sends) or every CKPT=<n> batches saves prune/<name>/ckpt.pt; the same command resumes from it.
# Usage: prune.py <name> <layers> <epochs>
import os, sys, json, time, math, random, copy, signal, importlib.util, torch, torch.nn.functional as F
from transformers import AutoModelForSequenceClassification, AutoTokenizer
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
D = S.MODELS['hz-small'][0]
def build(layers, remap, src, merge=0.0):
    full = AutoModelForSequenceClassification.from_pretrained(src).eval(); cfg = copy.deepcopy(full.config)
    cfg.num_hidden_layers = len(layers); cfg.layer_types = [full.config.layer_types[i] for i in layers]; cfg.vocab_size = len(remap['keep'])
    m = AutoModelForSequenceClassification.from_config(cfg)
    sd = {k: v for k, v in full.state_dict().items() if '.layers.' not in k}
    if full.config.vocab_size != len(remap['keep']): sd['model.embeddings.tok_embeddings.weight'] = sd['model.embeddings.tok_embeddings.weight'][remap['keep']].clone()
    near = {new: [j for j in range(full.config.num_hidden_layers) if j not in layers and min(layers, key=lambda o: (abs(o - j), o)) == old] for new, old in enumerate(layers)}
    for new, old in enumerate(layers):
        for k, v in full.model.layers[old].state_dict().items():
            sd[f'model.layers.{new}.{k}'] = v.clone()
            if merge and near[new]: sd[f'model.layers.{new}.{k}'] = (1 - merge) * v + merge * torch.stack([full.model.layers[j].state_dict()[k] for j in near[new]]).mean(0)
    missing, unexpected = m.load_state_dict(sd, strict=False)
    if missing or unexpected: raise SystemExit(f'weights: {missing} {unexpected}')
    return m
class Fact(torch.nn.Module):
    def __init__(self, w, r):
        super().__init__(); u, v, h = torch.linalg.svd(w.float(), full_matrices=False); self.t = torch.nn.Parameter(u[:, :r] * v[:r]); self.p = torch.nn.Parameter(h[:r])
    def forward(self, x): return self.t[x] @ self.p
def auc(s, y):
    order = sorted(range(len(s)), key=lambda k: s[k]); ranks = [0.0] * len(s)
    for r, k in enumerate(order): ranks[k] = r + 1
    npos = sum(y); nneg = len(y) - npos
    return (sum(r for r, v in zip(ranks, y) if v) - npos * (npos + 1) / 2) / max(npos * nneg, 1)
if __name__ == '__main__':
    name, layers, EP = sys.argv[1], [int(x) for x in sys.argv[2].split(',')], int(sys.argv[3])
    remap = json.load(open(os.environ.get('REMAP', f'{S.WORK}/trim/m5/remap.json'))); lut = {t: k for k, t in enumerate(remap['keep'])}; unk = remap['unk']
    tok = AutoTokenizer.from_pretrained(D); src = os.environ.get('SRC', D)
    m = AutoModelForSequenceClassification.from_pretrained(os.environ['LOAD']) if os.environ.get('LOAD') else build(layers, remap, src, float(os.environ.get('MERGE', '0')))
    FACT = int(os.environ.get('FACT', '0')); E = m.model.embeddings
    if FACT: E.tok_embeddings = Fact(E.tok_embeddings.weight.data, FACT)
    amp = os.environ.get('AMP') == '1'; scaler = torch.amp.GradScaler('cuda', enabled=amp); out_dir = f'{S.WORK}/prune/{name}'
    LOSS = os.environ.get('LOSS', 'bce'); HID = float(os.environ.get('HID', '0')); SELECT = os.environ.get('SELECT', 'agree')
    TAIL = float(os.environ.get('TAIL', '0')); PAGE = float(os.environ.get('PAGE', '0')); LENS = float(os.environ.get('LENS', '0'))
    tmap = [int(x) for x in os.environ['TMAP'].split(',')] if os.environ.get('TMAP') else layers
    dev = os.environ.get('DEV', 'mps'); XLA = dev == 'xla'
    if XLA: import torch_xla, torch_xla.core.xla_model as xm; dev = torch_xla.device(); m.config.reference_compile = False
    m.to(dev).train(); random.seed(7); torch.manual_seed(7)
    def shape(seqs, fill):
        L = max(len(q) for q in seqs)
        if XLA: L = min(b for b in (32, 64, 128, 256, 512) if b >= L); seqs = seqs + seqs[:1] * (fill - len(seqs))
        return seqs, L
    teacher = AutoModelForSequenceClassification.from_pretrained(D).eval().to(dev) if HID or LENS else None
    if teacher is not None:
        for q in teacher.parameters(): q.requires_grad_(False)
    W = [json.loads(l) for l in open(os.environ.get('TEACH', f'{S.WORK}/distil/teach4.jsonl'))]
    if os.environ.get('LIMIT'): W = W[: int(os.environ['LIMIT'])]
    from array import array  # a compact token store: Python int lists of every window run a T4 host out of memory past a few hundred thousand windows
    oids, ids = ([] if HID or LENS else None), []
    for w in W:
        q = tok(w.pop('text'), add_special_tokens=False)['input_ids'][:510]; ids.append(array('i', [lut.get(t, unk) for t in q]))
        if oids is not None: oids.append(array('i', q))
    p = [w['p'] for w in W]
    tl = [math.log(min(max(v, 1e-7), 1 - 1e-7) / (1 - min(max(v, 1e-7), 1 - 1e-7))) for v in p]
    owners = sorted({w['owner'] for w in W}); random.shuffle(owners); hold = set(owners[: len(owners) // 10])
    keep = set(o for o in owners if o not in hold and random.random() < float(os.environ.get('FRAC', '1')))
    tr = [k for k, w in enumerate(W) if w['owner'] in keep]; va = [k for k, w in enumerate(W) if w['owner'] in hold]
    q95 = sorted(tl[k] for k in tr)[int(0.95 * len(tr))]; wt = [1 + TAIL * math.exp(-((tl[k] - q95) / 2) ** 2) for k in range(len(W))]
    swt = [1.0] * len(W)
    if os.environ.get('WEIGHT'):
        sets = json.load(open(os.environ['SETS'])); sw = {a: float(b) for a, b in (x.split('=') for x in os.environ['WEIGHT'].split(','))}
        swt = [sw.get(sets[w['owner']], 1.0) for w in W]
    MIL, MIX = os.environ.get('MIL') == '1', float(os.environ.get('MIX', '0')); peak = {}
    for k, w in enumerate(W): peak[w['owner']] = max(peak.get(w['owner'], 0.0), p[k])
    goal = [float(peak[w['owner']] > .5) for w in W] if MIL else p
    cls, sep = lut[tok.cls_token_id], lut[tok.sep_token_id]
    def batch(ks, src_ids=None, c=cls, e=sep, fill=0):
        seqs, L = shape([[c] + list((src_ids or ids)[k]) + [e] for k in ks], fill)
        x = torch.tensor([q + [0] * (L - len(q)) for q in seqs], device=dev); return x, (x != 0).long()
    def forward(x, am, hidden=False):
        with torch.autocast('cuda', dtype=torch.float16, enabled=amp): o = m(input_ids=x, attention_mask=am, output_hidden_states=hidden)
        lg = o.logits.float(); return lg[:, 1] - lg[:, 0], o.hidden_states
    def logit(x, am): return forward(x, am)[0]
    def lens(net, h, am, last):
        if not last: h = net.model.final_norm(h)
        mk = am[..., None].to(h.dtype); lg = net.classifier(net.drop(net.head((h * mk).sum(1) / mk.sum(1)))).float(); return lg[:, 1] - lg[:, 0]
    def pages():
        by = {}
        for k in tr: by.setdefault(W[k]['owner'], []).append(k)
        groups = [g[i:i + 4] for g in by.values() for g in [random.sample(g, len(g))] for i in range(0, len(g), 4)]; random.shuffle(groups); out, cur = [], []
        for g in groups:
            if len(cur) + len(g) > B: out.append(cur); cur = []
            cur = cur + g
        return out + ([cur] if cur else [])
    def rows():
        by = {}
        for k in tr: by.setdefault(W[k]['owner'], []).append(k)
        g = sorted(by.values(), key=lambda v: sum(len(ids[k]) for k in v) + random.random() * 64); return [sum(g[i:i + B], []) for i in range(0, len(g), B)]
    def tops(ks):
        got = {}; c = sorted(ks, key=lambda k: len(ids[k])); m.eval()
        with torch.no_grad():
            for s in range(0, len(c), 64):
                for k, v in zip(c[s:s + 64], logit(*batch(c[s:s + 64], fill=64)).tolist()):
                    if W[k]['owner'] not in got or v > got[W[k]['owner']][1]: got[W[k]['owner']] = (k, v)
        m.train(); return [k for k, _ in got.values()]
    def evalv():
        m.eval(); out = []
        with torch.no_grad():
            for s in range(0, len(va), 32): out += logit(*batch(va[s:s + 32], fill=32)).tolist()[:len(va[s:s + 32])]
        m.train(); y = [p[k] > .5 for k in va]; n = max(len(va) // 50, 1); evalv.n = n
        top_t = set(sorted(range(len(va)), key=lambda i: -p[va[i]])[:n]); top_s = set(sorted(range(len(va)), key=lambda i: -out[i])[:n])
        return {'agree': round(sum((o > 0) == v for o, v in zip(out, y)) / max(len(va), 1), 4), 'auc': round(auc(out, y), 4), 'top': len(top_t & top_s)}
    print('layers', layers, 'train', len(tr), 'val', len(va), 'loss', LOSS, 'hid', HID, 'select', SELECT, 'before', evalv(), 'of', evalv.n, flush=True)
    opt = torch.optim.AdamW(m.parameters(), lr=float(os.environ.get('LR', '5e-5')), weight_decay=0.01); B = int(os.environ.get('B', '16')); t0 = time.time()
    steps = EP * math.ceil((len({W[k]['owner'] for k in tr}) if MIL else len(tr)) / B); warm = max(int(0.06 * steps), 1)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda i: min((i + 1) / warm, 0.5 * (1 + math.cos(math.pi * min(i, steps) / steps))) if os.environ.get('SCHED') == 'cos' else 1.0)
    best = -1.0; ck = f'{out_dir}/ckpt.pt'; CK = int(os.environ.get('CKPT', '0')); stop = []; signal.signal(signal.SIGTERM, lambda *a: stop.append(1))
    r = torch.load(ck, weights_only=False) if os.path.exists(ck) else None
    if r:
        m.load_state_dict(r['model']); opt.load_state_dict(r['opt']); sched.load_state_dict(r['sched']); scaler.load_state_dict(r['scaler'])
        random.setstate(r['rng']); torch.set_rng_state(r['trng']); best = r['best']; tr[:] = r['tr']
        if r.get('crng') is not None and dev == 'cuda': torch.cuda.set_rng_state_all(r['crng'])
        if r.get('crng') is not None and dev == 'mps': torch.mps.set_rng_state(r['crng']); print('resumed', r['ep'], r['nb'], flush=True)
    def save(ep, nb, bs, tot):
        os.makedirs(out_dir, exist_ok=True)
        (xm.save if XLA else torch.save)({'model': m.state_dict(), 'opt': opt.state_dict(), 'sched': sched.state_dict(), 'scaler': scaler.state_dict(), 'rng': random.getstate(),
                    'trng': torch.get_rng_state(), 'crng': torch.cuda.get_rng_state_all() if dev == 'cuda' else torch.mps.get_rng_state() if dev == 'mps' else None, 'best': best, 'ep': ep, 'nb': nb, 'bs': bs, 'tot': tot, 'tr': tr}, ck + '.tmp'); os.replace(ck + '.tmp', ck)
    for ep in range(r['ep'] if r else 0, EP):
        if r and ep == r['ep'] and r['bs']: bs, tot, first = r['bs'], r['tot'], r['nb'] + 1
        else: tr.sort(key=lambda k: len(ids[k]) + random.random() * 64); bs = rows() if MIL else pages() if PAGE else [tr[s:s + B] for s in range(0, len(tr), B)]; random.shuffle(bs); tot, first = 0, 0
        for nb, ks in enumerate(bs):
            if nb < first: continue
            if MIL: alt = list({W[k]['owner']: k for k in random.sample(ks, len(ks))}.values()); ks = tops(ks)
            x, am = batch(ks); out, hs = forward(x, am, hidden=bool(HID or LENS)); t = torch.tensor([tl[k] for k in ks], device=dev); sv = torch.tensor([swt[k] for k in ks], device=dev); w = torch.tensor([wt[k] for k in ks], device=dev) * sv
            if LOSS == 'bce': loss = (F.binary_cross_entropy_with_logits(out, torch.tensor([goal[k] for k in ks], device=dev), reduction='none') * w).mean()
            else: loss = (((out - t) ** 2) * w).mean() / 16
            if LOSS == 'rank':
                pr = (t[:, None] > t[None, :] + 1).float() * sv[:, None] * sv[None, :]; loss = loss + (F.softplus(-(out[:, None] - out[None, :])) * pr).sum() / pr.sum().clamp(min=1)
            if PAGE:
                ow = [W[k]['owner'] for k in ks]; g = {o: [i for i, v in enumerate(ow) if v == o] for o in set(ow)}
                loss = loss + PAGE * sum((out[ix].max() - t[ix].max()) ** 2 for ix in g.values()) / len(g) / 16
            if HID or LENS:
                with torch.no_grad(), torch.autocast('cuda', dtype=torch.float16, enabled=amp):
                    th = teacher(*batch(ks, oids, tok.cls_token_id, tok.sep_token_id), output_hidden_states=True).hidden_states
                    tlens = [lens(teacher, th[j + 1], am, j + 1 == len(th) - 1) for j in tmap[:-1]] if LENS else []
                mk = am[..., None].float()
                for i, j in enumerate(tmap):
                    a, b = hs[i + 1].float(), th[j + 1].float()
                    if HID: loss = loss + HID * (((a - b) ** 2) * mk).sum() / ((b ** 2) * mk).sum().clamp(min=1e-6) / len(tmap)
                    if LENS and i < len(tmap) - 1:
                        with torch.autocast('cuda', dtype=torch.float16, enabled=amp): sl = lens(m, hs[i + 1], am, False)
                        loss = loss + LENS * F.mse_loss(sl, tlens[i]) / 16 / (len(tmap) - 1)
            opt.zero_grad(); scaler.scale(loss).backward()
            if MIL and MIX: scaler.scale(MIX * ((logit(*batch(alt)) - torch.tensor([tl[k] for k in alt], device=dev)) ** 2).mean() / 16).backward()
            scaler.step(opt); scaler.update(); sched.step()
            if XLA: torch_xla.sync()
            tot += loss.item() * len(ks)
            if dev == 'mps' and nb % 100 == 99: torch.mps.empty_cache()
            if stop: save(ep, nb, bs, tot); print('stopped at', ep, nb, flush=True); sys.exit(3)
            if CK and nb % CK == CK - 1: save(ep, nb, bs, tot)
        v = evalv(); print('ep', ep, 'loss', round(tot / len(tr), 4), v, round(time.time() - t0), 's', flush=True)
        if v[SELECT] > best:
            best = v[SELECT]; f = E.tok_embeddings
            if FACT: E.tok_embeddings = torch.nn.Embedding.from_pretrained((f.t @ f.p).detach())
            m.save_pretrained(out_dir, **({'state_dict': {k: v.detach().cpu() for k, v in m.state_dict().items()}} if XLA else {})); E.tok_embeddings = f; json.dump(remap, open(f'{out_dir}/remap.json', 'w')); print('saved', ep, flush=True)
        if ep + 1 < EP: save(ep + 1, -1, None, 0)
    if os.path.exists(ck): os.remove(ck)
    if not EP: os.makedirs(out_dir, exist_ok=True)
    if os.environ.get('NOSCORE'): sys.exit(0)
    if os.environ.get('EMBK'):
        with torch.no_grad():
            r, w = int(os.environ['EMBK']), m.model.embeddings.tok_embeddings.weight; u, v, h = torch.linalg.svd(w.float(), full_matrices=False)
            print('rank', r, 'keeps', round(float((v[:r] ** 2).sum() / (v ** 2).sum()), 4), 'of the table', flush=True); w.copy_(u[:, :r] @ torch.diag(v[:r]) @ h[:r])
    if os.environ.get('QUANT'):  # the weights of trim.py's q_g_w builds, read back as floats: int8 embedding table, Linear weights at QUANT bits, symmetric, blocks of 32
        bits, top = int(os.environ['QUANT']), lambda b: 2 ** (b - 1) - 1
        with torch.no_grad():
            for x in m.modules():
                if isinstance(x, torch.nn.Embedding): w = x.weight; s = w.abs().max() / top(8); w.copy_((w / s).round() * s)
                elif isinstance(x, torch.nn.Linear):
                    for b in x.weight.split(32, 1): s = b.abs().amax(1, keepdim=True).clamp_min(1e-12) / top(bits); b.copy_((b / s).round() * s)
    m.eval(); rows = [json.loads(l) for l in open(os.environ.get('EVAL', f'{S.WORK}/sample.jsonl'))]; allw, owner = [], []
    for i, r in enumerate(rows):
        ws, _ = S.windows(tok, r['text']); allw += [[lut.get(t, unk) for t in w] for w in ws]; owner += [i] * len(ws)
    order = sorted(range(len(allw)), key=lambda k: len(allw[k])); prob = [0.0] * len(allw); t1 = time.time()
    with torch.no_grad():
        for s in range(0, len(order), 32):
            ks = order[s:s + 32]; seqs, L = shape([allw[k] for k in ks], 32); x = torch.tensor([q + [0] * (L - len(q)) for q in seqs], device=dev)
            for k, v in zip(ks, torch.sigmoid(logit(x, (x != 0).long())).tolist()): prob[k] = v
    score = [0.0] * len(rows)
    for k, i in enumerate(owner): score[i] = max(score[i], prob[k])
    json.dump({'model': name, 'windows': len(allw), 'secs': time.time() - t1, 'ntok': [], 'score': score, 'prob': prob, 'owner': owner}, open(os.environ.get('OUT', f'{S.WORK}/s-{name}.json'), 'w'))
    print(name, 'scored', len(rows), 'texts', len(allw), 'windows', round(time.time() - t1), 's')
