# The BrowseSafe++ pages of the newsets2.py rows in three more views: HTML, the HTML through strip.py, and the
# accessibility tree (YAML). Same pairs and order as the Markdown rows; "seen" is worked out again for each view.
# Usage: views.py <downloads dir> <rows2.jsonl> <out.jsonl>
import json, sys, glob, os, importlib.util
import pyarrow.parquet as pq
spec = importlib.util.spec_from_file_location('strip', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'strip.py'))
ST = importlib.util.module_from_spec(spec); spec.loader.exec_module(ST)
src, rows2, out = sys.argv[1:4]
want = [r for r in map(json.loads, open(rows2)) if r['set'] == 'bspp']; keys = {r['pair'] for r in want}; bs = {}
for f in sorted(glob.glob(f'{src}/perplexity-ai__browsesafe-plus-plus/data/*.parquet')):
    for r in pq.read_table(f, columns=['entry_id', 'content_html', 'content_ax_yaml', 'injection_text_fragments_json']).to_pylist():
        k, arm = r['entry_id'].split('_')[:2]
        if k in keys: bs.setdefault(k, {})[arm] = r
with open(out, 'w') as o:
    for view in ('html', 'html-strip', 'ax'):
        for w in want:
            r = bs[w['pair']]['malicious' if w['y'] else 'benign']; frags = json.loads(bs[w['pair']]['malicious']['injection_text_fragments_json'] or '[]')
            t = r['content_ax_yaml'] if view == 'ax' else r['content_html'] or ''
            if view == 'html-strip': t = ST.strip(t)
            seen = any(f.strip() and f.strip()[:60] in t for f in frags) if w['y'] else None
            o.write(json.dumps({**{k: v for k, v in w.items() if k != 'text'}, 'set': f'bspp-{view}', 'text': t or '', 'seen': seen}) + '\n')
print(3 * len(want), 'rows')
