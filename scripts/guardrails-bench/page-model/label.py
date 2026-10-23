# Teacher labels per 512-token window: Horizon small's positive probability for each window of each text.
# Usage: label.py <texts.jsonl> <out.jsonl>
import os, json, sys, time, importlib.util, torch
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
src, out = sys.argv[1:3]; dev = 'mps'
tok, m, f, pos = S.load('hz-small'); m.to(dev); rows = [json.loads(l) for l in open(src)]
allw, owner = [], []
for i, r in enumerate(rows):
    ws, _ = S.windows(tok, r['text']); allw += ws; owner += [i] * len(ws)
order = sorted(range(len(allw)), key=lambda k: len(allw[k])); prob = [0.0] * len(allw); t0 = time.time(); B = 32; pad = tok.pad_token_id
with torch.no_grad():
    for s in range(0, len(order), B):
        ks = order[s:s + B]; L = max(len(allw[k]) for k in ks)
        ids = torch.tensor([allw[k] + [pad] * (L - len(allw[k])) for k in ks], device=dev)
        am = torch.tensor([[1] * len(allw[k]) + [0] * (L - len(allw[k])) for k in ks], device=dev)
        lg = f(ids, am).float(); p = torch.softmax(lg, -1)[:, pos].tolist()
        for k, v in zip(ks, p): prob[k] = v
with open(out, 'w') as o:
    for k, (w, i) in enumerate(zip(allw, owner)): o.write(json.dumps({'owner': i, 'p': prob[k], 'text': tok.decode(w[1:-1])}) + '\n')
print(len(allw), 'windows', round(time.time() - t0), 's')
