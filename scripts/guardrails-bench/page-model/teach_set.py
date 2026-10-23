# The student's training texts and labels, in three steps:
#   teach_set.py train <train.jsonl> <texts.jsonl> <train2.jsonl>      drop texts that a bench row also holds
#   teach_set.py extra <extra-raw.jsonl> <texts.jsonl> <extra.jsonl>   the same, and keep only benign bench texts
#   teach_set.py merge <train2.jsonl> <teach.jsonl> <teach-extra.jsonl> <teach4.jsonl>
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
