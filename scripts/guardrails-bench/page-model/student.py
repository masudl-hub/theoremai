# A static-embedding student of Horizon small: token vectors, mean over K-token chunks, a small MLP, max over chunks.
# ARCH=meanmax also feeds the max over each chunk; ARCH=conv adds two convolutions over the token vectors (local word order).
# Trained on the teacher's per-window probabilities (TEACH). LOAD=<file.pt> skips training and prints the held-out agreement.
# WINDOWS=1 scores each of Horizon's 512-token windows of every EVAL row instead (wscore, in score.py's window order).
# Usage: student.py <name> <K> <H> <epochs>   (writes logits for EVAL to OUT)
import json, sys, time, random, os, torch, torch.nn.functional as F
from tokenizers import Tokenizer
from safetensors.torch import load_file
DATA = os.path.expanduser(os.environ.get('GUARDRAIL_DATA', '~/Development/.guardrail-data'))
WORK = os.environ.get('PAGE_MODEL_WORK', f'{DATA}/linear-2210/clf')
P = f'{DATA}/hf-models/minishlab__potion-base-8M'; ARCH = os.environ.get('ARCH', 'mean')
name, K, H, EP = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
tok = Tokenizer.from_file(f'{P}/tokenizer.json'); tok.no_padding(); tok.no_truncation()
E0 = load_file(f'{P}/model.safetensors')['embeddings'].float(); V, D = E0.shape
enc = lambda ts: [e.ids[1:-1] for e in tok.encode_batch(ts)]
class S(torch.nn.Module):
    def __init__(s):
        super().__init__(); s.E = torch.nn.Embedding(V, D, padding_idx=0); s.E.weight.data.copy_(E0)
        s.f = torch.nn.Sequential(torch.nn.Linear(2 * D if ARCH == 'meanmax' else D, H), torch.nn.GELU(), torch.nn.Linear(H, 1))
        if ARCH == 'conv': s.c1 = torch.nn.Conv1d(D, D, 5, padding=2); s.c2 = torch.nn.Conv1d(D, D, 5, padding=2)
    def chunks(s, ids, m):  # ids (B, L) -> logits (B, nchunks), masked
        x = s.E(ids) * m[..., None]; st = K // 2
        if ARCH == 'conv': h = F.gelu(s.c1(x.transpose(1, 2))) * m[:, None]; h = F.gelu(s.c2(h)) * m[:, None]; x = (x + h.transpose(1, 2)) * m[..., None]
        cs = F.pad(x.cumsum(1), (0, 0, 1, 0)); cm = F.pad(m.cumsum(1), (1, 0))
        L = ids.shape[1]; a = torch.arange(0, max(L - st, 1), st, device=ids.device); b = (a + K).clamp(max=L)
        n = (cm[:, b] - cm[:, a]); mu = (cs[:, b] - cs[:, a]) / n.clamp(min=1)[..., None]
        if ARCH == 'meanmax':
            xp = F.pad(x.masked_fill(m[..., None] == 0, -1e4), (0, 0, 0, K), value=-1e4); mx = xp.unfold(1, K, st)[:, : a.shape[0]].amax(-1).clamp(min=-10)
            mu = torch.cat([mu, mx], -1)
        return s.f(mu).squeeze(-1).masked_fill((n == 0) | (a[None] >= (m.sum(1, keepdim=True) - st).clamp(min=1)), -1e4)
    def forward(s, ids, m): return s.chunks(ids, m).max(1).values
def batch(seqs, dev, cap=640):
    L = max(1, max(len(q) for q in seqs)); L = min(L, cap)
    ids = torch.tensor([q[:L] + [0] * (L - len(q[:L])) for q in seqs], device=dev); return ids, (ids != 0).float()
if __name__ == '__main__':
    dev = 'mps'; random.seed(7); torch.manual_seed(7)
    W = [json.loads(l) for l in open(os.environ.get('TEACH', f'{WORK}/distil/teach4.jsonl'))]; ids = enc([w['text'] for w in W]); p = [w['p'] for w in W]
    owners = sorted({w['owner'] for w in W}); random.shuffle(owners); hold = set(owners[: len(owners) // 10])
    tr = [k for k, w in enumerate(W) if w['owner'] not in hold]; va = [k for k, w in enumerate(W) if w['owner'] in hold]
    m = S().to(dev); opt = torch.optim.AdamW(m.parameters(), lr=3e-3, weight_decay=0.0)
    pos = sum(p[k] > 0.5 for k in tr) / len(tr); print('train', len(tr), 'val', len(va), 'teacher-pos', round(pos, 3))
    def evalv():
        m.eval(); out = []
        with torch.no_grad():
            for s in range(0, len(va), 128): ks = va[s:s + 128]; out += torch.sigmoid(m(*batch([ids[k] for k in ks], dev))).tolist()
        m.train(); agree = sum((o > 0.5) == (p[k] > 0.5) for o, k in zip(out, va)) / len(va)
        tp = sum(o > 0.5 and p[k] > 0.5 for o, k in zip(out, va)); fn = sum(o <= 0.5 and p[k] > 0.5 for o, k in zip(out, va)); fp = sum(o > 0.5 and p[k] <= 0.5 for o, k in zip(out, va))
        return round(agree, 4), tp, fn, fp
    t0 = time.time()
    if os.environ.get('LOAD'): m.load_state_dict(torch.load(os.environ['LOAD'])); EP = 0; print('held-out windows', len(va), 'agree/tp/fn/fp', evalv())
    for ep in range(EP):
        random.shuffle(tr); tot = 0
        for s in range(0, len(tr), 64):
            ks = tr[s:s + 64]; x, mk = batch([ids[k] for k in ks], dev); y = torch.tensor([p[k] for k in ks], device=dev)
            loss = F.binary_cross_entropy_with_logits(m(x, mk), y); opt.zero_grad(); loss.backward(); opt.step(); tot += loss.item() * len(ks)
        print('ep', ep, 'loss', round(tot / len(tr), 4), 'val agree/tp/fn/fp', evalv(), round(time.time() - t0), 's', flush=True)
    if not os.environ.get('LOAD'): torch.save(m.state_dict(), f'{WORK}/distil/{name}.pt')
    R = [json.loads(l) for l in open(os.environ.get('EVAL', f'{WORK}/sample.jsonl'))]; m.eval().to('cpu'); sc = []; t1 = time.time(); ntok = 0
    texts = [r['text'] for r in R]
    if os.environ.get('WINDOWS'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); SC = importlib.util.module_from_spec(spec); spec.loader.exec_module(SC)
        from transformers import AutoTokenizer
        th = AutoTokenizer.from_pretrained(SC.MODELS['hz-small'][0], trust_remote_code=False)
        texts = [th.decode(w[1:-1]) for t in texts for w in SC.windows(th, t)[0]]; t1 = time.time()
    with torch.no_grad():
        for t in texts:
            q = enc([t])[0] or [0]; ntok += len(q); x = torch.tensor([q]); sc.append(m(x, (x != 0).float())[0].item())
    secs = time.time() - t1
    json.dump({'model': name, 'windows': len(texts), 'secs': secs, 'ntok': ntok, ('wscore' if os.environ.get('WINDOWS') else 'score'): sc}, open(os.environ.get('OUT', f'{WORK}/s-{name}.json'), 'w'))
    print(name, 'scored', len(texts), 'texts', round(secs, 1), 's cpu,', round(1000 * secs / len(texts), 2), 'ms/text')
