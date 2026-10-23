# Horizon small cut to the chosen layers and the 76k-token vocabulary, trained to copy Horizon's
# window probabilities (teach4.jsonl), then scored on EVAL with score.py's windows. Usage: prune.py <name> <layers> <epochs>
import os, sys, json, time, random, copy, importlib.util, torch, torch.nn.functional as F
from transformers import AutoModelForSequenceClassification, AutoTokenizer
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
D = S.MODELS['hz-small'][0]
def build(layers, remap):
    full = AutoModelForSequenceClassification.from_pretrained(D).eval(); cfg = copy.deepcopy(full.config)
    cfg.num_hidden_layers = len(layers); cfg.layer_types = [full.config.layer_types[i] for i in layers]; cfg.vocab_size = len(remap['keep'])
    m = AutoModelForSequenceClassification.from_config(cfg)
    sd = {k: v for k, v in full.state_dict().items() if '.layers.' not in k}; sd['model.embeddings.tok_embeddings.weight'] = sd['model.embeddings.tok_embeddings.weight'][remap['keep']].clone()
    for new, old in enumerate(layers):
        for k, v in full.model.layers[old].state_dict().items(): sd[f'model.layers.{new}.{k}'] = v.clone()
    missing, unexpected = m.load_state_dict(sd, strict=False)
    if missing or unexpected: raise SystemExit(f'weights: {missing} {unexpected}')
    return m, full
if __name__ == '__main__':
    name, layers, EP = sys.argv[1], [int(x) for x in sys.argv[2].split(',')], int(sys.argv[3])
    remap = json.load(open(os.environ.get('REMAP', f'{S.WORK}/trim/m5/remap.json'))); lut = {t: k for k, t in enumerate(remap['keep'])}; unk = remap['unk']
    tok = AutoTokenizer.from_pretrained(D); m, full = build(layers, remap); del full
    dev = os.environ.get('DEV', 'mps'); m.to(dev).train(); random.seed(7); torch.manual_seed(7)
    W = [json.loads(l) for l in open(os.environ.get('TEACH', f'{S.WORK}/distil/teach4.jsonl'))]
    if os.environ.get('LIMIT'): W = W[: int(os.environ['LIMIT'])]
    ids = [[lut.get(t, unk) for t in tok(w['text'], add_special_tokens=False)['input_ids'][:510]] for w in W]; p = [w['p'] for w in W]
    owners = sorted({w['owner'] for w in W}); random.shuffle(owners); hold = set(owners[: len(owners) // 10])
    tr = [k for k, w in enumerate(W) if w['owner'] not in hold]; va = [k for k, w in enumerate(W) if w['owner'] in hold]
    cls, sep = lut[tok.cls_token_id], lut[tok.sep_token_id]
    def batch(ks):
        seqs = [[cls] + ids[k] + [sep] for k in ks]; L = max(len(q) for q in seqs)
        x = torch.tensor([q + [0] * (L - len(q)) for q in seqs], device=dev); return x, (x != 0).long()
    def logit(x, am): lg = m(input_ids=x, attention_mask=am).logits.float(); return lg[:, 1] - lg[:, 0]
    def evalv():
        m.eval(); out = []
        with torch.no_grad():
            for s in range(0, len(va), 32): out += torch.sigmoid(logit(*batch(va[s:s + 32]))).tolist()
        m.train(); return round(sum((o > .5) == (p[k] > .5) for o, k in zip(out, va)) / max(len(va), 1), 4)
    print('layers', layers, 'train', len(tr), 'val', len(va), 'agree before', evalv(), flush=True)
    opt = torch.optim.AdamW(m.parameters(), lr=float(os.environ.get('LR', '5e-5')), weight_decay=0.01); B = int(os.environ.get('B', '16')); t0 = time.time()
    for ep in range(EP):
        tr.sort(key=lambda k: len(ids[k]) + random.random() * 64); bs = [tr[s:s + B] for s in range(0, len(tr), B)]; random.shuffle(bs); tot = 0
        for ks in bs:
            loss = F.binary_cross_entropy_with_logits(logit(*batch(ks)), torch.tensor([p[k] for k in ks], device=dev)); opt.zero_grad(); loss.backward(); opt.step(); tot += loss.item() * len(ks)
        print('ep', ep, 'loss', round(tot / len(tr), 4), 'agree', evalv(), round(time.time() - t0), 's', flush=True)
    m.save_pretrained(f'{S.WORK}/prune/{name}'); json.dump(remap, open(f'{S.WORK}/prune/{name}/remap.json', 'w'))
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
    json.dump({'model': name, 'windows': len(allw), 'secs': time.time() - t1, 'ntok': [], 'score': score}, open(os.environ.get('OUT', f'{S.WORK}/s-{name}.json'), 'w'))
    print(name, 'scored', len(rows), 'texts', len(allw), 'windows', round(time.time() - t1), 's')
