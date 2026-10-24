# Horizon small cut to the chosen layers and the 76k-token vocabulary, trained to copy Horizon on its windows (teach4.jsonl),
# then scored on EVAL with score.py's windows. Saves to prune/<name> when the SELECT metric on held-out windows improves.
# DEV=cuda AMP=1 trains in fp16 (a T4 has no bf16). NOSCORE=1 stops after training. LOAD=<dir> starts from a saved model.
# SRC=<dir> cuts from a saved cut model instead of Horizon; TMAP then names the Horizon layer behind each kept layer.
# LOSS=bce copies Horizon's probability; LOSS=mse copies its logit. HID=<weight> also copies the hidden state of the Horizon layer
# behind each kept layer (Horizon runs alongside). SCHED=cos warms up for 6% of steps, then decays the learning rate to 0.
# SELECT=agree (at 0.5), auc (against Horizon's 0.5 label), or top (how many of Horizon's top 2% of held-out windows the cut also ranks top 2%).
# LOSS=rank adds a pairwise loss on Horizon's order within each batch. TAIL=<k> weights windows near Horizon's top-5% logit by up to 1+k.
# PAGE=<weight> batches up to 4 windows of each page and also copies Horizon's score for them (the highest window). MERGE=<a> starts each kept layer as
# (1-a) of itself plus a of the mean of the dropped layers nearest it. LENS=<weight> copies Horizon's score read from the layer behind
# each kept layer through Horizon's own head. FRAC=<f> trains on that share of training pages. HID, LENS and MERGE need SRC unset or TMAP.
# Usage: prune.py <name> <layers> <epochs>
import os, sys, json, time, math, random, copy, importlib.util, torch, torch.nn.functional as F
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
    amp = os.environ.get('AMP') == '1'; scaler = torch.amp.GradScaler('cuda', enabled=amp); out_dir = f'{S.WORK}/prune/{name}'
    LOSS = os.environ.get('LOSS', 'bce'); HID = float(os.environ.get('HID', '0')); SELECT = os.environ.get('SELECT', 'agree')
    TAIL = float(os.environ.get('TAIL', '0')); PAGE = float(os.environ.get('PAGE', '0')); LENS = float(os.environ.get('LENS', '0'))
    tmap = [int(x) for x in os.environ['TMAP'].split(',')] if os.environ.get('TMAP') else layers
    dev = os.environ.get('DEV', 'mps'); m.to(dev).train(); random.seed(7); torch.manual_seed(7)
    teacher = AutoModelForSequenceClassification.from_pretrained(D).eval().to(dev) if HID or LENS else None
    if teacher is not None:
        for q in teacher.parameters(): q.requires_grad_(False)
    W = [json.loads(l) for l in open(os.environ.get('TEACH', f'{S.WORK}/distil/teach4.jsonl'))]
    if os.environ.get('LIMIT'): W = W[: int(os.environ['LIMIT'])]
    oids = [tok(w['text'], add_special_tokens=False)['input_ids'][:510] for w in W]; ids = [[lut.get(t, unk) for t in q] for q in oids]; p = [w['p'] for w in W]
    tl = [math.log(min(max(v, 1e-7), 1 - 1e-7) / (1 - min(max(v, 1e-7), 1 - 1e-7))) for v in p]
    owners = sorted({w['owner'] for w in W}); random.shuffle(owners); hold = set(owners[: len(owners) // 10])
    keep = set(o for o in owners if o not in hold and random.random() < float(os.environ.get('FRAC', '1')))
    tr = [k for k, w in enumerate(W) if w['owner'] in keep]; va = [k for k, w in enumerate(W) if w['owner'] in hold]
    q95 = sorted(tl[k] for k in tr)[int(0.95 * len(tr))]; wt = [1 + TAIL * math.exp(-((tl[k] - q95) / 2) ** 2) for k in range(len(W))]
    cls, sep = lut[tok.cls_token_id], lut[tok.sep_token_id]
    def batch(ks, src_ids=None, c=cls, e=sep):
        seqs = [[c] + (src_ids or ids)[k] + [e] for k in ks]; L = max(len(q) for q in seqs)
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
        groups = [random.sample(g, min(len(g), 4)) for g in by.values()]; random.shuffle(groups); out, cur = [], []
        for g in groups:
            if len(cur) + len(g) > B: out.append(cur); cur = []
            cur = cur + g
        return out + ([cur] if cur else [])
    def evalv():
        m.eval(); out = []
        with torch.no_grad():
            for s in range(0, len(va), 32): out += logit(*batch(va[s:s + 32])).tolist()
        m.train(); y = [p[k] > .5 for k in va]; n = max(len(va) // 50, 1); evalv.n = n
        top_t = set(sorted(range(len(va)), key=lambda i: -p[va[i]])[:n]); top_s = set(sorted(range(len(va)), key=lambda i: -out[i])[:n])
        return {'agree': round(sum((o > 0) == v for o, v in zip(out, y)) / max(len(va), 1), 4), 'auc': round(auc(out, y), 4), 'top': len(top_t & top_s)}
    print('layers', layers, 'train', len(tr), 'val', len(va), 'loss', LOSS, 'hid', HID, 'select', SELECT, 'before', evalv(), 'of', evalv.n, flush=True)
    opt = torch.optim.AdamW(m.parameters(), lr=float(os.environ.get('LR', '5e-5')), weight_decay=0.01); B = int(os.environ.get('B', '16')); t0 = time.time()
    steps = EP * math.ceil(len(tr) / B); warm = max(int(0.06 * steps), 1)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda i: min((i + 1) / warm, 0.5 * (1 + math.cos(math.pi * min(i, steps) / steps))) if os.environ.get('SCHED') == 'cos' else 1.0)
    best = -1.0
    for ep in range(EP):
        tr.sort(key=lambda k: len(ids[k]) + random.random() * 64); bs = pages() if PAGE else [tr[s:s + B] for s in range(0, len(tr), B)]; random.shuffle(bs); tot = 0
        for ks in bs:
            x, am = batch(ks); out, hs = forward(x, am, hidden=bool(HID or LENS)); t = torch.tensor([tl[k] for k in ks], device=dev); w = torch.tensor([wt[k] for k in ks], device=dev)
            if LOSS == 'bce': loss = (F.binary_cross_entropy_with_logits(out, torch.tensor([p[k] for k in ks], device=dev), reduction='none') * w).mean()
            else: loss = (((out - t) ** 2) * w).mean() / 16
            if LOSS == 'rank':
                pr = (t[:, None] > t[None, :] + 1).float(); loss = loss + (F.softplus(-(out[:, None] - out[None, :])) * pr).sum() / pr.sum().clamp(min=1)
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
            opt.zero_grad(); scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step(); tot += loss.item() * len(ks)
        v = evalv(); print('ep', ep, 'loss', round(tot / len(tr), 4), v, round(time.time() - t0), 's', flush=True)
        if v[SELECT] > best: best = v[SELECT]; m.save_pretrained(out_dir); json.dump(remap, open(f'{out_dir}/remap.json', 'w')); print('saved', ep, flush=True)
    if not EP: os.makedirs(out_dir, exist_ok=True)
    if os.environ.get('NOSCORE'): sys.exit(0)
    m.eval(); rows = [json.loads(l) for l in open(os.environ.get('EVAL', f'{S.WORK}/sample.jsonl'))]; allw, owner = [], []
    for i, r in enumerate(rows):
        ws, _ = S.windows(tok, r['text']); allw += [[lut.get(t, unk) for t in w] for w in ws]; owner += [i] * len(ws)
    order = sorted(range(len(allw)), key=lambda k: len(allw[k])); prob = [0.0] * len(allw); t1 = time.time()
    with torch.no_grad():
        for s in range(0, len(order), 32):
            ks = order[s:s + 32]; L = max(len(allw[k]) for k in ks); x = torch.tensor([allw[k] + [0] * (L - len(allw[k])) for k in ks], device=dev)
            for k, v in zip(ks, torch.sigmoid(logit(x, (x != 0).long())).tolist()): prob[k] = v
    score = [0.0] * len(rows)
    for k, i in enumerate(owner): score[i] = max(score[i], prob[k])
    json.dump({'model': name, 'windows': len(allw), 'secs': time.time() - t1, 'ntok': [], 'score': score, 'prob': prob, 'owner': owner}, open(os.environ.get('OUT', f'{S.WORK}/s-{name}.json'), 'w'))
    print(name, 'scored', len(rows), 'texts', len(allw), 'windows', round(time.time() - t1), 's')
