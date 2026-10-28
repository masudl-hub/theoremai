# The student's training texts and labels, in three steps:
#   teach_set.py train <train.jsonl> <texts.jsonl> <train2.jsonl>      drop texts that a bench row also holds
#   teach_set.py extra <extra-raw.jsonl> <texts.jsonl> <extra.jsonl>   the same, and keep only benign bench texts
#   teach_set.py merge <train2.jsonl> <teach.jsonl> <teach-extra.jsonl> <teach4.jsonl>
#   teach_set.py append <teach.jsonl> <labelled.jsonl>... <out.jsonl>   adds labelled windows, each file's owners offset past the last
#   [CAP=0.01] teach_set.py truth <labelled.jsonl> <raw.jsonl> <out.jsonl> caps Horizon's label at CAP on every window of a page
#                                                                       whose own label is benign, so the student does not learn Horizon's false alarms
#   [K=10] teach_set.py thin <labelled.jsonl> <out.jsonl>               keeps K windows of each page: Horizon's highest, then others at random
# merge drops out-of-scope windows (wildjailbreak and spml, ruling R2) and offsets extra owners past train2.
import json, sys, collections
step = sys.argv[1]
if step in ('train', 'extra'):
    src, texts, out = sys.argv[2:5]; ev = set(json.loads(l)['text'] for l in open(texts)); n = 0
    with open(out, 'w') as o:
        for l in open(src):
            r = json.loads(l)
            if r['text'] in ev or (step == 'extra' and (r['set'].startswith('c:') or r['y'] != 0)): continue
            o.write(l); n += 1
    print(n)
elif step == 'merge':
    train2, teach, extra, out = sys.argv[2:6]; sets = [json.loads(l)['set'] for l in open(train2)]; base = len(sets); n = collections.Counter()
    with open(out, 'w') as o:
        for l in open(teach):
            w = json.loads(l)
            if sets[w['owner']] in ('c:wildjailbreak', 'c:spml', 'c:spml-benign'): continue
            o.write(l); n['teach'] += 1
        for l in open(extra):
            w = json.loads(l); w['owner'] += base; o.write(json.dumps(w) + '\n'); n['extra'] += 1
    print(dict(n))
elif step == 'truth':
    import os
    lab, raw, out = sys.argv[2:5]; ys = [json.loads(l)['y'] for l in open(raw)]; cap = float(os.environ.get('CAP', '0.01')); n = collections.Counter()
    with open(out, 'w') as o:
        for l in open(lab):
            w = json.loads(l)
            if ys[w['owner']] == 0 and w['p'] > cap: w['p'] = cap; n['capped'] += 1
            n['windows'] += 1; o.write(json.dumps(w) + '\n')
    print(dict(n))
elif step == 'thin':
    import os, random
    lab, out = sys.argv[2:4]; k = int(os.environ.get('K', '10')); pages = collections.defaultdict(list); random.seed(7)
    for l in open(lab): w = json.loads(l); pages[w['owner']].append(w)
    with open(out, 'w') as o:
        for ws in pages.values():
            top = max(ws, key=lambda w: w['p']); rest = [w for w in ws if w is not top]
            for w in [top] + random.sample(rest, min(k - 1, len(rest))): o.write(json.dumps(w) + '\n')
    print(sum(min(k, len(ws)) for ws in pages.values()), 'of', sum(len(ws) for ws in pages.values()))
elif step == 'append':
    *srcs, out = sys.argv[2:]; base = 0; n = collections.Counter()
    with open(out, 'w') as o:
        for k, f in enumerate(srcs):
            top = base
            for l in open(f):
                w = json.loads(l); w['owner'] += base; top = max(top, w['owner'] + 1); o.write(json.dumps(w) + '\n'); n[k] += 1
            base = top
    print(dict(n))
