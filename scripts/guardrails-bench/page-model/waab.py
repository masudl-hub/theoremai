# Web Agent Attack Benchmark (umariqbal, CC BY 4.0): 1,091 real landing pages, each with one injected attack, as GenTree.
# Writes each page twice as page text: attacked (y=1, set waab-<direction>-<channel>) and clean, without the attack's
# elements (y=0, set waab-clean). Text is each element's text and its placeholder or aria-label, in tree order (children by
# bni), main document first, then each frame's document. Scripts and styles are left out.
# Usage: waab.py <benchmark dir> <out.jsonl>
import json, gzip, sys, collections
src, out = sys.argv[1:3]; SKIP = {'script', 'style', 'noscript', 'template'}
def text(page, drop):
    kids = collections.defaultdict(list); el = {e['bni']: e for e in page['elements']}
    for e in page['elements']: kids[(e['doc_index'], e['parent_bni'])].append(e['bni'])
    parts = []
    def walk(b):
        e = el[b]
        if b in drop or e['tag'] in SKIP: return
        for t in (e.get('text'), e['attrs'].get('placeholder'), e['attrs'].get('aria-label')):
            if t and t.strip(): parts.append(t.strip())
        for c in sorted(kids[(e['doc_index'], b)]): walk(c)
    for d in sorted({e['doc_index'] for e in page['elements']}):
        roots = [e['bni'] for e in page['elements'] if e['doc_index'] == d and (e['parent_bni'] is None or e['parent_bni'] not in el or el[e['parent_bni']]['doc_index'] != d)]
        for r in sorted(roots): walk(r)
    return '\n'.join(parts)
n = collections.Counter()
with open(out, 'w') as o:
    for r in map(json.loads, open(f'{src}/benchmark.jsonl')):
        page = json.load(gzip.open(f"{src}/{r['file']}", 'rt')); a = r['attack']; ins = set(a['inserted_bnis'])
        s = f"waab-{a['direction']}-{a['channel']}"; t1, t0 = text(page, set()), text(page, ins)
        assert a['payload'][:40] in t1 or a['direction'] == 'inbound', r['site']
        o.write(json.dumps({'set': s, 'y': 1, 'site': r['site'], 'category': r['category'], 'text': t1}) + '\n')
        o.write(json.dumps({'set': 'waab-clean', 'y': 0, 'site': r['site'], 'category': r['category'], 'text': t0}) + '\n'); n[s] += 1
print(dict(n))
