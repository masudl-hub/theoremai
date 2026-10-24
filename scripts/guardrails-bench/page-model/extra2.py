# More training texts for the cut models, for Horizon to label with label.py. Drops any text that a bench row holds.
#   fair:  TaskTracker poisoned paragraphs (v1 and v2, 4,000 of each) with their clean paragraphs, and 3,000 SEP train items,
#          clean and instructed. Texts with a phrase of the two nvidia-ipi templates are dropped, so nvidia-ipi stays unseen.
#   quick: the corpus nvidia-ipi rows that no sample, screen or newsets row holds.
# Usage: extra2.py <fair|quick> <data dir> <out.jsonl>
import json, sys, random
mode, D, out = sys.argv[1:4]; C = f'{D}/linear-2210/clf'
ev = set()
for f in (f'{C}/texts.jsonl', f'{C}/sample.jsonl', f'{C}/screen.jsonl', f'{C}/newsets/rows2.jsonl'): ev |= {json.loads(l)['text'] for l in open(f)}
NV = ('PRIORITY MESSAGE', 'forgot to mention', 'URGENT: Before complet')
rows, seen = [], set()
def put(s, y, t):
    if t and t not in ev and t not in seen and (mode == 'quick' or not any(p in t for p in NV)): seen.add(t); rows.append({'set': s, 'y': y, 'text': t})
random.seed(7)
if mode == 'fair':
    for v in ('v1', 'v2'):
        d = json.load(open(f'{D}/tasktracker-build/src/task_tracker/dataset_creation/dataset_sampled/dataset_out_poisoned_{v}.json'))
        for x in random.sample(d, 4000): put(f'tasktracker-{v}', 1, x['final_text_paragraph']); put(f'tasktracker-{v}', 0, x['orig_text'])
    for x in random.sample(json.load(open(f'{D}/sep-dl/datasets/train_dataset.json')), 3000):
        put('sep', 1, x['data_prompt_instructed']); put('sep', 0, x['data_prompt_clean'])
else:
    sample = set()
    for f in (f'{C}/sample.jsonl', f'{C}/screen.jsonl', f'{C}/newsets/rows2.jsonl'): sample |= {json.loads(l)['text'] for l in open(f)}
    ev = sample
    for l in open(f'{D}/guardrail-corpus/eval.jsonl'):
        r = json.loads(l)
        if 'nvidia' in str(r['source']): put('nvidia-ipi', r['attack'], r['text'])
with open(out, 'w') as o:
    for r in rows: o.write(json.dumps(r) + '\n')
print(len(rows), {s: sum(r['set'] == s for r in rows) for s in sorted({r['set'] for r in rows})})
