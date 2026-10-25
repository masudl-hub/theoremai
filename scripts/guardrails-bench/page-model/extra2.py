# More training texts for the cut models, for Horizon to label with label.py. Drops any text that a bench row holds.
#   fair:  TaskTracker poisoned paragraphs (v1 and v2, 4,000 of each) with their clean paragraphs, and 3,000 SEP train items,
#          clean and instructed. Texts with a phrase of the two nvidia-ipi templates are dropped, so nvidia-ipi stays unseen.
#   quick: the corpus nvidia-ipi rows that no sample, screen or newsets row holds.
#   pages: BrowseSafe++ train pairs that newsets2.py did not draw, English pages only, both pages of each as Markdown;
#          PAIRS of them (default 4,000) at random.
# Usage: [PAIRS=n] extra2.py <fair|quick|pages> <data dir> <out.jsonl>
import json, sys, random, os, glob
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
elif mode == 'pages':
    import pyarrow.parquet as pq
    drawn = {json.loads(l).get('pair') for l in open(f'{C}/newsets/rows2.jsonl')}; bs = {}
    for f in sorted(glob.glob(f'{D}/downloads/perplexity-ai__browsesafe-plus-plus/data/*.parquet')):
        for r in pq.read_table(f, columns=['entry_id', 'content_markdown', 'language_page']).to_pylist():
            k, arm = r['entry_id'].split('_')[:2]; bs.setdefault(k, {})[arm] = r
    pairs = sorted(k for k, v in bs.items() if k not in drawn and set(v) == {'malicious', 'benign'} and all(x['language_page'] == ['en'] for x in v.values()))
    for k in random.sample(pairs, min(int(os.environ.get('PAIRS', '4000')), len(pairs))):
        for arm in ('malicious', 'benign'): put('bspp-train', int(arm == 'malicious'), bs[k][arm]['content_markdown'] or '')
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
