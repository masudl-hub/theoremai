# Horizon token counts over the student's training texts, for the vocabulary cut.
# Usage: vocab.py <out.json> <texts.jsonl>...
import os, json, sys, collections, importlib.util
from transformers import AutoTokenizer
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
tok = AutoTokenizer.from_pretrained(S.MODELS['hz-small'][0]); c = collections.Counter()
for f in sys.argv[2:]:
    for l in open(f): c.update(tok(json.loads(l)['text'], add_special_tokens=False)['input_ids'])
json.dump(c, open(sys.argv[1], 'w')); tot = sum(c.values()); print('vocab', len(tok), 'seen', len(c), 'tokens', tot)
for mn in (1, 2, 5, 10): ks = [t for t, n in c.items() if n >= mn]; print('min', mn, 'keep', len(ks), 'cover', round(sum(c[t] for t in ks) / tot, 5))
