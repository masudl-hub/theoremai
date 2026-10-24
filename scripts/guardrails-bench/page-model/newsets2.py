# Writes test rows from three downloads, one JSON line a row, in score.py's shape plus columns to group by.
# BrowseSafe++: PAIRS pairs drawn at random (seed 1), both pages of each, as Markdown. "seen" says whether any injection
# fragment is in that Markdown: hidden text, comments and attributes can drop out of it.
# zn bench: its test split. Horizon eval suite: every config.
# Usage: newsets2.py <downloads dir> <out.jsonl>
import json, sys, glob, os, random
import pyarrow.parquet as pq
PAIRS = int(os.environ.get('PAIRS', '1000'))
src, out = sys.argv[1:3]; rows = []
fs = sorted(glob.glob(f'{src}/perplexity-ai__browsesafe-plus-plus/data/*.parquet'))
cols = ['entry_id', 'label', 'content_markdown', 'language_page', 'goal_class', 'injection_strategy', 'linguistic_style', 'page_type', 'injection_text_fragments_json']
bs = {}
for f in fs:
    for r in pq.read_table(f, columns=cols).to_pylist(): bs.setdefault(r['entry_id'].split('_')[0], {})[r['entry_id'].split('_')[1]] = r
pairs = sorted(k for k, v in bs.items() if set(v) == {'malicious', 'benign'}); random.seed(1)
for k in random.sample(pairs, PAIRS):
    bad = bs[k]['malicious']; frags = json.loads(bad['injection_text_fragments_json'] or '[]')
    for arm, r in bs[k].items():
        md = r['content_markdown'] or ''
        rows.append({'set': 'bspp', 'y': int(arm == 'malicious'), 'text': md, 'pair': k, 'lang': '+'.join(r['language_page'] or []),
                     'goal': bad['goal_class'], 'strategy': bad['injection_strategy'], 'style': bad['linguistic_style'], 'page': bad['page_type'],
                     'seen': any(f.strip() and f.strip()[:60] in md for f in frags) if arm == 'malicious' else None})
for r in pq.read_table(f'{src}/usezn__zn-prompt-injection-bench/data/test.parquet').to_pylist():
    rows.append({'set': 'zn', 'y': int(r['label'] == 'ataque'), 'text': r['text'], 'lang': r['lang'], 'family': r['family'], 'source': r['source']})
for f in sorted(glob.glob(f'{src}/Horizon-Labs__prompt-injection-eval-suite/data/*.parquet')):
    for r in pq.read_table(f).to_pylist():
        rows.append({'set': 'hzeval:' + os.path.basename(f)[:-8], 'y': int(r['label']), 'text': r['text'], 'lang': r['lang'], 'kind': r['kind'], 'source': r['source']})
with open(out, 'w') as o:
    for r in rows: o.write(json.dumps(r) + '\n')
print(len(rows), 'rows')
