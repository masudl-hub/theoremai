# Scores rows with Perplexity's BrowseSafe (Qwen3-30B-A3B, MLX 4-bit) as score.py does: the text in chunks of CHUNK
# tokens, each chunk sent alone as the user message, the score of a chunk P("yes") over "yes" and "no" at the first
# answer token, and a row's score its highest chunk. PICK=<json list> scores only those row indices; the rest get -1.
# Usage: [CHUNK=8192] [PICK=idx.json] score_mlx.py <mlx model dir> <rows.jsonl> <out.json>
import json, sys, os, time
import mlx.core as mx
from mlx_lm import load
d, src, out = sys.argv[1:4]
CHUNK = int(os.environ.get('CHUNK', '8192'))
model, tok = load(d)
yes, no = (tok.encode(w, add_special_tokens=False) for w in ('yes', 'no'))
assert len(yes) == 1 and len(no) == 1, (yes, no)
rows = [json.loads(l) for l in open(src)]
pick = json.load(open(os.environ['PICK'])) if os.environ.get('PICK') else list(range(len(rows)))
score, prob, owner, t0 = [-1.0] * len(rows), [], [], time.time()
for n, i in enumerate(pick):
    ids = tok.encode(rows[i]['text'], add_special_tokens=False) or tok.encode(' ', add_special_tokens=False)
    for s in range(0, len(ids), CHUNK):
        msg = [{'role': 'user', 'content': tok.decode(ids[s:s + CHUNK])}]
        x = mx.array(tok.apply_chat_template(msg, add_generation_prompt=True))[None]
        h = model.model(x)[:, -1:]; lg = (model.lm_head(h) if hasattr(model, 'lm_head') else model.model.embed_tokens.as_linear(h))[0, -1]; p = mx.softmax(mx.stack([lg[yes[0]], lg[no[0]]]).astype(mx.float32))[0].item()
        prob.append(p); owner.append(i); score[i] = max(score[i], p)
    if n % 50 == 0: print(n, len(pick), f'{time.time() - t0:.0f} s', flush=True)
json.dump({'model': 'browsesafe', 'windows': len(prob), 'secs': time.time() - t0, 'score': score, 'prob': prob, 'owner': owner, 'pick': pick}, open(out, 'w'))
