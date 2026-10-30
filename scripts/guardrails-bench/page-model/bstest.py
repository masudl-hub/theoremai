# Rows from BrowseSafe-Bench's own test split, to check a BrowseSafe scorer against its model card: every page, or with N
# (a cut that needs a ruling, R4) N "yes" and N "no" pages drawn with seed 7, the raw HTML as text, y = 1 for "yes". Score them with score_mlx.py, then read the score file
# with "check": recall, false alarms, precision and F1 at each threshold.
# Usage: [N=n] bstest.py rows <browsesafe-bench test.parquet> <out.jsonl>
#        bstest.py check <rows.jsonl> <score json> <threshold>,...
import json, os, random, sys
if sys.argv[1] == 'rows':
    import pyarrow.parquet as pq
    src, out = sys.argv[2:4]; N = os.environ.get('N')
    te = pq.read_table(src).to_pylist(); r = random.Random(7)
    pick = r.sample([x for x in te if x['label'] == 'yes'], int(N)) + r.sample([x for x in te if x['label'] == 'no'], int(N)) if N else te
    with open(out, 'w') as f:
        for x in pick: f.write(json.dumps({'text': x['content'], 'y': int(x['label'] == 'yes')}) + '\n')
else:
    y = [json.loads(l)['y'] for l in open(sys.argv[2])]; d = json.load(open(sys.argv[3])); s = d['score']
    for t in map(float, sys.argv[4].split(',')):
        tp = sum(a > t and b for a, b in zip(s, y)); fp = sum(a > t and not b for a, b in zip(s, y)); P = sum(y)
        r, p = tp / P, tp / max(tp + fp, 1)
        print(f'threshold {t}: recall {r:.3f}, false alarms {fp / (len(y) - P):.3f}, precision {p:.3f}, F1 {2 * p * r / (p + r):.3f}')
    print(f"{d['secs'] / len(y):.1f} s a page")
