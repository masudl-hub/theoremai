# score.py's windows and max, run through a trimmed ONNX Horizon from trim.py on the CPU.
# Usage: THREADS=4 score_onnx.py <trim dir> <net.onnx> <rows.jsonl> <out.json> <name>
import os, sys, json, time, importlib.util, numpy as np, onnxruntime as ort
from transformers import AutoTokenizer
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
d, net, src, out, name = sys.argv[1:6]; r = json.load(open(f'{d}/remap.json')); lut = np.full(300000, r['unk'], dtype=np.int64)
for k, t in enumerate(r['keep']): lut[t] = k
tok = AutoTokenizer.from_pretrained(S.MODELS['hz-small'][0])
o = ort.SessionOptions(); o.intra_op_num_threads = int(os.environ.get('THREADS', '4')); s = ort.InferenceSession(f'{d}/{net}', o, providers=['CPUExecutionProvider'])
rows = [json.loads(l) for l in open(src)]; allw, owner = [], []
for i, row in enumerate(rows):
    ws, _ = S.windows(tok, row['text']); allw += ws; owner += [i] * len(ws)
order = sorted(range(len(allw)), key=lambda k: len(allw[k])); prob = [0.0] * len(allw); t0 = time.time(); B = 16
for st in range(0, len(order), B):
    ks = order[st:st + B]; L = max(len(allw[k]) for k in ks)
    ids = np.array([allw[k] + [tok.pad_token_id] * (L - len(allw[k])) for k in ks], dtype=np.int64); am = (np.arange(L)[None] < np.array([len(allw[k]) for k in ks])[:, None]).astype(np.int64)
    lg = s.run(None, {'input_ids': lut[ids], 'attention_mask': am})[0]; e = np.exp(lg - lg.max(1, keepdims=True)); p = e[:, 1] / e.sum(1)
    for k, v in zip(ks, p): prob[k] = float(v)
score = [0.0] * len(rows)
for k, i in enumerate(owner): score[i] = max(score[i], prob[k])
json.dump({'model': name, 'windows': len(allw), 'secs': time.time() - t0, 'ntok': [], 'score': score}, open(out, 'w')); print(name, len(allw), 'windows', round(time.time() - t0), 's')
