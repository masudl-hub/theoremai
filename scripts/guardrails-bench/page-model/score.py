# Scores every row with one classifier: the max positive-class probability over 512-token windows. Also writes each window's probability (prob) and row (owner).
# W: window tokens (default 512). A positive index of -1 is a multi-label head: sigmoid of logit 0, its attack presence.
# KEEP and MINC: tokens seen fewer than MINC times in the KEEP counts file become unk, as in the cut vocabulary.
# Usage: score.py <model> <rows.jsonl> <out.json>
import json, sys, time, os, torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification, DebertaV2Config, DebertaV2Model
from safetensors.torch import load_file
DATA = os.path.expanduser(os.environ.get('GUARDRAIL_DATA', '~/Development/.guardrail-data'))
M = f'{DATA}/hf-models'
WORK = os.environ.get('PAGE_MODEL_WORK', f'{DATA}/linear-2210/clf')
snap = lambda n: f'{M}/{n}'
KEEP = {int(t) for t, c in json.load(open(os.environ['KEEP'])).items() if c >= int(os.environ['MINC'])} if os.environ.get('KEEP') else None
MODELS = {
  'hz-small': (f'{M}/Horizon-Labs__prompt-injection-guard-small', 1), 'hz-base': (f'{M}/Horizon-Labs__prompt-injection-guard-base', 1),
  'piguard': (f'{M}/leolee99__PIGuard', 1), 'pg2-22m': (snap('meta-llama--Llama-Prompt-Guard-2-22M'), 1),
  'pg2-86m': (snap('meta-llama--Llama-Prompt-Guard-2-86M'), 1), 'protectai-v2': (snap('protectai--deberta-v3-base-prompt-injection-v2'), 1),
  'deepset': (snap('deepset--deberta-v3-base-injection'), 1), 'ts-large': (snap('testsavantai--prompt-injection-defender-large-v0'), 1),
  'ts-base': (snap('testsavantai--prompt-injection-defender-base-v0'), 1),
  'hz-large': (f'{M}/Horizon-Labs__prompt-injection-guard-large', 1),
  'wolf-small': (f'{M}/patronus-studio__wolf-defender-prompt-injection-small', 1), 'wolf-base': (f'{M}/patronus-studio__wolf-defender-prompt-injection', 1),
  'sheltron-68m': (f'{M}/sheltron-ai__prompt-guard-68m', -1),
}
MPS = ('hz-', 'wolf-', 'sheltron-')
class PIG(torch.nn.Module):
    def __init__(self, d):
        super().__init__(); cfg = DebertaV2Config.from_dict({**json.load(open(f'{d}/config.json')), 'model_type': 'deberta-v2'})
        self.deberta = DebertaV2Model(cfg); self.classifier = torch.nn.Linear(cfg.hidden_size, cfg.num_labels)
        missing, unexpected = self.load_state_dict(load_file(f'{d}/model.safetensors'), strict=False)
        if [k for k in missing if 'position_ids' not in k] or [k for k in unexpected if not k.startswith('pooler.')]: raise SystemExit(f'piguard weights: {missing} {unexpected}')
    def forward(self, input_ids, attention_mask): return self.classifier(self.deberta(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0, :])
def load(name):
    d, pos = MODELS[name]; tok = AutoTokenizer.from_pretrained(d, trust_remote_code=False)
    if name == 'piguard': m = PIG(d); f = lambda ids, am: m(ids, am)
    else: m = AutoModelForSequenceClassification.from_pretrained(d, trust_remote_code=False); f = lambda ids, am: m(input_ids=ids, attention_mask=am).logits
    with torch.no_grad():
        for t in list(m.parameters()) + list(m.buffers()): t.data = t.data.clone()  # off the drive's memory map
    return tok, m.eval(), f, pos
def windows(tok, text, W=int(os.environ.get('W', '512')), overlap=64):
    ids = tok(text, add_special_tokens=False, truncation=False)['input_ids']; n = W - 2; step = n - overlap
    if KEEP is not None: ids = [i if i in KEEP else tok.unk_token_id for i in ids]
    parts = [ids[i:i + n] for i in range(0, max(len(ids) - overlap, 1), step)] or [[]]
    return [[tok.cls_token_id] + p + [tok.sep_token_id] for p in parts], len(ids)
if __name__ == '__main__':
    name, src, out = sys.argv[1:4]; dev = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() and name.startswith(MPS) else 'cpu'  # DeBERTa runs faster on CPU than MPS
    tok, m, f, pos = load(name); m.to(dev); rows = [json.loads(l) for l in open(src)]
    allw, owner, ntok = [], [], []
    for i, r in enumerate(rows):
        ws, n = windows(tok, r['text']); allw += ws; owner += [i] * len(ws); ntok.append(n)
    order = sorted(range(len(allw)), key=lambda k: len(allw[k])); prob = [0.0] * len(allw); t0 = time.time(); B = 32
    pad = tok.pad_token_id if tok.pad_token_id is not None else 0
    with torch.no_grad():
        for s in range(0, len(order), B):
            ks = order[s:s + B]; L = max(len(allw[k]) for k in ks)
            ids = torch.tensor([allw[k] + [pad] * (L - len(allw[k])) for k in ks], device=dev)
            am = torch.tensor([[1] * len(allw[k]) + [0] * (L - len(allw[k])) for k in ks], device=dev)
            lg = f(ids, am).float(); p = (torch.sigmoid(lg[:, 0]) if pos < 0 else torch.softmax(lg, -1)[:, pos]).tolist()
            for k, v in zip(ks, p): prob[k] = v
    score = [0.0] * len(rows)
    for k, i in enumerate(owner): score[i] = max(score[i], prob[k])
    json.dump({'model': name, 'windows': len(allw), 'secs': time.time() - t0, 'ntok': ntok, 'score': score, 'prob': prob, 'owner': owner}, open(out, 'w'))
    print(name, len(allw), 'windows', round(time.time() - t0), 's')
