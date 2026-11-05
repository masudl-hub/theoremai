# Writes one arm's training windows and set names: teach8r (as m22 trained on it) followed by the arm's components,
# each component's owners offset past the last.
# python -I compose.py <arm> <teach8r.jsonl> <sets8.json> <retrain dir> <out teach.jsonl> <out sets.json>
import json, sys
arm, teach, sets8, R, out, osets = sys.argv[1:7]
sets = json.load(open(sets8)); base = len(sets); n = 0
with open(out, 'w') as o:
    for l in open(teach): o.write(l); n += 1
    for c in json.load(open(f'{R}/arms.json'))[arm]:
        cs = json.load(open(f'{R}/sets-{c}.json'))
        for l in open(f'{R}/comp-{c}.jsonl'):
            w = json.loads(l); w['owner'] += base; o.write(json.dumps(w) + '\n'); n += 1
        sets += cs; base += len(cs)
json.dump(sets, open(osets, 'w'))
print(arm, n, 'windows', base, 'owners', flush=True)
