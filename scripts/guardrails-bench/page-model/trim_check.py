# ONNX builds from trim.py against PyTorch (full vocabulary, unk mapping) on the first two windows of every 40th row.
# Usage: NETS=q_g_w8.onnx,... trim_check.py <trim dir> <rows.jsonl>
import os, sys, json, importlib.util, numpy as np, torch, onnxruntime as ort
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
out = sys.argv[1]; r = json.load(open(f'{out}/remap.json')); keep = r['keep']; pos = {t: k for k, t in enumerate(keep)}
tok, m, f, _ = S.load('hz-small')
rows = [json.loads(l) for l in open(sys.argv[2])][:4000:40]
sess = {n: ort.InferenceSession(f'{out}/{n}', providers=['CPUExecutionProvider']) for n in os.environ.get('NETS', 'model.onnx,model_int8.onnx').split(',')}
diff = {n: [] for n in sess}; agree = {n: 0 for n in sess}; tot = 0
for row in rows:
    for w in S.windows(tok, row['text'])[0][:2]:
        w = [t if t in pos else tok.unk_token_id for t in w]
        with torch.no_grad(): pt = torch.softmax(f(torch.tensor([w]), torch.ones(1, len(w), dtype=torch.long)), -1)[0, 1].item()
        ids = np.array([[pos[t] for t in w]], dtype=np.int64); am = np.ones_like(ids); tot += 1
        for n, s in sess.items():
            lg = s.run(None, {'input_ids': ids, 'attention_mask': am})[0][0]; p = float(np.exp(lg[1]) / np.exp(lg).sum())
            diff[n].append(abs(p - pt)); agree[n] += (p > 0.5) == (pt > 0.5)
print('windows', tot)
for n in sess: print(n, 'max diff', round(max(diff[n]), 4), 'mean', round(float(np.mean(diff[n])), 5), 'agree', agree[n], 'of', tot)
