# Turns every new benchmark into rows for devdocs_score.py and score_mlx.py: one rows.jsonl per set under <out>/sets/,
# each line {text, set, y, category}. Prints the counts. Run with python -I.
import sys, os, json, csv, ast, collections
csv.field_size_limit(10 ** 9)
G = os.path.expanduser('~/Development/.guardrail-data')
H = f'{G}/bench-hunt'
OUT = f'{H}/sets'
os.makedirs(OUT, exist_ok=True)
K = f'{H}/kaggle'
counts = {}


def write(name, rows):
    rows = [r for r in rows if r['text'] and r['text'].strip()]
    with open(f'{OUT}/{name}.jsonl', 'w') as f:
        for r in rows:
            f.write(json.dumps({'text': r['text'], 'set': name, 'y': int(r['y']), 'category': f"{int(r['y'])}|{r.get('cat', '')}"}) + '\n')
    counts[name] = collections.Counter(int(r['y']) for r in rows)


def jl(p): return [json.loads(l) for l in open(p)]
def rcsv(p): return list(csv.DictReader(open(p, newline='', errors='replace')))


A = f'{H}/out-adtb'
write('ad-clean', [{'text': r['text'], 'y': 0, 'cat': f"{r['suite']}/{r['function']}"} for r in jl(f'{A}/agentdojo_benign_outputs.jsonl')])
write('ad-matched', [{'text': r['text'], 'y': r['label'], 'cat': f"{r['suite']}/{r['attack']}"} for r in jl(f'{A}/agentdojo_pairs.jsonl')])
write('ad-shift', [{'text': r['text'], 'y': r['label'], 'cat': f"{r['suite']}/{r['attack']}"} for r in jl(f'{A}/agentdojo_pairs_shift.jsonl')])
write('tb-eval', [{'text': r['text'], 'y': r['label'], 'cat': f"{r['suite']}/{r['attack']}"} for r in jl(f'{A}/taubench_eval.jsonl')])

W = f'{G}/downloads/wainjectbench/data/text'
wa = []
for y, d in [(0, 'benign'), (1, 'malicious')]:
    for f in sorted(os.listdir(f'{W}/{d}')):
        wa += [{'text': r['text'], 'y': y, 'cat': f[:-6]} for r in jl(f'{W}/{d}/{f}')]
write('wainject-text', wa)

seen = {}
for r in jl(f'{H}/dl-arpi/dataset.jsonl'):
    s = seen.setdefault(r['payload'], {'text': r['payload'], 'y': 1, 'cats': set()})
    s['cats'].add(f"{r['scenario']}/{r['attack_name']}/{r['prefix_name']}")
write('arpi-unique', [{'text': s['text'], 'y': 1, 'cat': sorted(s['cats'])[0]} for s in seen.values()])

P = f'{H}/dl-pp'
write('pp-attacks', [{'text': r['text'], 'y': 1, 'cat': r['category']} for r in jl(f'{P}/attacks.jsonl')])
write('pp-benign-hard', [{'text': r['text'], 'y': 0, 'cat': r['category']} for r in jl(f'{P}/benign-hard.jsonl')])
af = []
for r in jl(f'{P}/agent-flows.jsonl'):
    src = r['sources'] if isinstance(r['sources'], list) else ast.literal_eval(r['sources'])
    af.append({'text': '\n\n'.join(s['text'] for s in src), 'y': r['label'] == 'attack', 'cat': f"{r['scenario']}/{r['expect_reason']}"})
write('pp-agent-flows', af)

write('k-sahil-bench', [{'text': r['text'], 'y': r['label'] == '1', 'cat': f"{r['split']}/{r['source']}/{r['technique_family']}"}
                        for r in rcsv(f'{K}/prompt-injection-detection-benchmark/prompt_injection_detection.csv')])
write('k-ragshield-fin', [{'text': r['retrieved_context'], 'y': r['label'] == '1', 'cat': r['attack_type']}
                          for r in rcsv(f'{K}/financial-indirect-prompt-injection-data/RAGShield_GAT_Financial_Indirect_Prompt_Injection_10000.csv')])
write('k-krishna-v3', [{'text': r['text'], 'y': r['label'] == 'injection', 'cat': f"{r['split']}/{r['source'][:40]}"}
                       for r in rcsv(f'{K}/prompt-injection-and-jailbreak-detection-dataset/v3update20001.csv')])
write('k-cyberprince', [{'text': r['prompt'], 'y': r['label'] == 'malicious', 'cat': r['attack_type']}
                        for r in jl(f'{K}/prompt-injection-and-benign-prompt-dataset/Prompt_INJECTION_And_Benign_DATASET.jsonl')])
write('k-jackhhao-jailbreak', [{'text': r['prompt'], 'y': r['type'] == 'jailbreak', 'cat': r['type']}
                               for r in rcsv(f'{K}/indirect-prompt-injection/Hugging Face jailbreak_dataset_full.csv')])
write('k-fka-prompts', [{'text': r['prompt'], 'y': 0, 'cat': r['type']} for r in rcsv(f'{K}/indirect-prompt-injection/Hugging Face prompts chats..csv')])
write('k-inwild-jailbreak', [{'text': r['Prompt'], 'y': 1, 'cat': 'jailbreak'} for r in rcsv(f'{K}/prompt-injection-in-the-wild/jailbreak_prompts.csv')])
rp = []
for r in jl(f'{K}/ragprobe-bench/attacks.jsonl'):
    if r['kind'] != 'attack': continue
    t = r['payload'].replace('{marker_a}', 'ZEBRA').replace('{marker_b}', 'QUARTZ')
    if r.get('cover'): t = r['cover'].replace('{payload}', t) if '{payload}' in r['cover'] else r['cover'] + '\n\n' + t
    rp.append({'text': t, 'y': 1, 'cat': f"{r['vector']}/{r['technique']}"})
write('k-ragprobe-attacks', rp)
bec = rcsv(f'{K}/adversarial-bec-email-dataset/synthetic_emails.csv')
becp = rcsv(f'{K}/adversarial-bec-email-dataset/synthetic_emails_poisoned.csv')
# Phishing orders to the person count as attacks: an agent reading the inbox could carry them out (Masud, 3/11).
write('k-bec-emails', [{'text': f"Subject: {r['subject']}\n\n{r['body']}", 'y': 1, 'cat': 'clean'} for r in bec]
      + [{'text': f"Subject: {p['subject']}\n\n{p['body']}", 'y': 1, 'cat': 'homoglyph'} for r, p in zip(bec, becp) if r['body'] != p['body']])
STD = {'Mozilla/5.0', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
siem, hdr = [], None
with open(f'{K}/adversarial-siem-indirect-prompt-injection-logs/datasetIBM.csv', newline='') as fh:
    rd = csv.reader(fh); hdr = next(rd)
    for row in rd:
        ua = row[7]
        std = ua in STD or not ua.startswith('Mozilla/5.0') or any(t in ua for t in ('X11;', 'Macintosh;', 'Win64; x64) AppleWebKit', 'iPhone;'))
        siem.append({'text': ','.join(hdr) + '\n' + ','.join(row), 'y': not std, 'cat': row[2]})
write('k-siem-logs', siem)

for k, c in counts.items(): print(f'{k:24s} attacks {c[1]:6,d}  harmless {c[0]:6,d}')
print('total', sum(sum(c.values()) for c in counts.values()))
