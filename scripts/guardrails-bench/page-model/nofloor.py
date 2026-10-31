# The windows of a teach file that FLOOR raised on rows of one set, with Horizon's own label: {line: p}, for an arm that keeps Horizon's label there.
# Usage: nofloor.py <teach.jsonl> <sets.json> <set> <out.json> <lab.jsonl.gz>...   (the label files in teach order, up to the last that holds the set)
import json, sys, gzip, itertools
teach, sets, name, out, *labs = sys.argv[1:]; sets = json.load(open(sets)); over = {}; n = 0
lab = itertools.chain.from_iterable(gzip.open(f, 'rt') for f in labs)
with open(teach) as t:
    for k, (a, b) in enumerate(zip(t, lab)):
        w, x = json.loads(a), json.loads(b)
        if w['text'] != x['text']: raise SystemExit(f'line {k} differs')
        n += 1
        if sets[w['owner']] == name and w['p'] > x['p']: over[k] = x['p']
json.dump(over, open(out, 'w')); print(n, 'lines read,', len(over), 'windows')
