# More training texts for the cut models, for Horizon to label with label.py. Drops any text that a bench row holds.
#   fair:  every TaskTracker poisoned paragraph (v1 and v2) with its clean paragraph, and every SEP train item,
#          clean and instructed. Texts with a phrase of the two nvidia-ipi templates are dropped, so nvidia-ipi stays unseen.
#   quick: the corpus nvidia-ipi rows that no sample, screen or newsets row holds.
#   pages: BrowseSafe++ train pairs that newsets2.py did not draw, English pages only, both pages of each as Markdown;
#          all of them, or PAIRS of them at random (a cut that needs a ruling, R4).
#   bsb:   BrowseSafe-Bench train pages as raw HTML. A page that holds 120 characters from the middle of a BrowseSafe bench row is
#          dropped, since A37 drew the bsafe-validate rows from this split with a title line added.
#   pia:   PIArena rows whose context and injected task no bench row holds, as Horizon's eval suite builds them: the context
#          cut to 6,000 characters, and the task put in at a sentence boundary (attack) or left out (benign). Then the
#          agentic-prompt-injection-5k and boundary-pairs train splits. Reads them from new-2810/.
# Usage: [PAIRS=n] extra2.py <fair|quick|pages|bsb|pia> <data dir> <out.jsonl>
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
        for x in d: put(f'tasktracker-{v}', 1, x['final_text_paragraph']); put(f'tasktracker-{v}', 0, x['orig_text'])
    for x in json.load(open(f'{D}/sep-dl/datasets/train_dataset.json')):
        put('sep', 1, x['data_prompt_instructed']); put('sep', 0, x['data_prompt_clean'])
elif mode == 'pages':
    import pyarrow.parquet as pq
    drawn = {json.loads(l).get('pair') for l in open(f'{C}/newsets/rows2.jsonl')}; bs = {}
    for f in sorted(glob.glob(f'{D}/downloads/perplexity-ai__browsesafe-plus-plus/data/*.parquet')):
        for r in pq.read_table(f, columns=['entry_id', 'content_markdown', 'language_page']).to_pylist():
            k, arm = r['entry_id'].split('_')[:2]; bs.setdefault(k, {})[arm] = r
    pairs = sorted(k for k, v in bs.items() if k not in drawn and set(v) == {'malicious', 'benign'} and all(x['language_page'] == ['en'] for x in v.values()))
    for k in random.sample(pairs, min(int(os.environ['PAIRS']), len(pairs))) if os.environ.get('PAIRS') else pairs:
        for arm in ('malicious', 'benign'): put('bspp-train', int(arm == 'malicious'), bs[k][arm]['content_markdown'] or '')
elif mode == 'bsb':
    import pyarrow.parquet as pq, bisect
    bench = [r['text'] for f in (f'{C}/texts.jsonl', f'{C}/sample.jsonl', f'{C}/screen.jsonl') for r in map(json.loads, open(f)) if 'bsafe' in r['set'] or 'browsesafe' in r['set']]
    pages = pq.read_table(f'{D}/new-2210b/browsesafe/train.parquet').to_pylist(); starts, at = [], 0
    for r in pages: starts.append(at); at += len(r['content']) + 1
    blob, drop = '\x00'.join(r['content'] for r in pages), set()
    for t in {t[len(t) // 2: len(t) // 2 + 120] for t in bench if len(t) > 400}:
        i = blob.find(t)
        while i >= 0: drop.add(bisect.bisect_right(starts, i) - 1); i = blob.find(t, i + 1)
    for k, r in enumerate(pages):
        if k not in drop: put('bsb-train', int(r['label'] == 'yes'), r['content'])
    print(len(drop), 'pages dropped for a bench row')
elif mode == 'pia':
    import pyarrow.parquet as pq
    blob = '\x00'.join(ev)
    for f in sorted(glob.glob(f'{D}/new-2810/piarena/*.parquet')):
        for r in pq.read_table(f).to_pylist():
            if r['context'][:300] in blob or r['injected_task'] in blob: continue
            ctx = r['context'][:6000]; m = ctx.rfind('. ', 0, random.randint(0, len(ctx))); cut = m + 2 if m > 0 else 0
            put('piarena-train', 1, ctx[:cut] + ' ' + r['injected_task'] + ' ' + ctx[cut:]); put('piarena-train', 0, ctx)
    for d, s in (('a5k', 'a5k-train'), ('bp', 'bp-train')):
        for r in pq.read_table(f'{D}/new-2810/{d}/train.parquet').to_pylist(): put(s, int(r['label']), r['text'])
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
