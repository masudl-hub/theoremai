# Samples the classifier bench rows from texts.jsonl: 'sample' is the full bench, 'screen' the smaller first screen.
# Usage: sample.py <sample|screen> <texts.jsonl> <out.jsonl>
import json, random, sys, collections
CAPS = {
  'sample': {'pool': 6000, 'llmail-validate': 1500, 'llmail-p2': 1000, 'bsafe-validate': 300, 'c:wildjailbreak-benign': 2000, 'c:llmail': 500, 'c:nvidia-ipi': 500, 'm2w-validate': 1099},
  'screen': {'pool': 3000, 'llmail-validate': 600, 'llmail-p2': 400, 'bsafe-validate': 0, 'c:wildjailbreak-benign': 600, 'c:llmail': 200, 'c:nvidia-ipi': 200, 'm2w-validate': 400,
             'c:glaive-tool': 300, 'c:repo-hard-benign': 300, 'c:slabs-benign': 300, 'c:asb-desc': 150, 'c:asb-instr': 150},
}
preset, src, out = sys.argv[1:4]; CAP = CAPS[preset]
by = collections.defaultdict(list)
for l in open(src):
    r = json.loads(l); by['pool' if r['g'] == 'pool' else r['set']].append(r)
rnd = random.Random(7); n = 0
with open(out, 'w') as f:
    for k in sorted(by):
        rs = by[k]; rnd.shuffle(rs)
        for r in rs[:CAP.get(k, len(rs))]: f.write(json.dumps(r) + '\n'); n += 1
        print(k, min(len(rs), CAP.get(k, len(rs))), 'of', len(rs))
print(n)
