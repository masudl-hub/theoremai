# Joins every detector's scores on the new benchmark sets. Per set and group: attacks caught and harmless rows flagged for
# the kernel's injection detector through detectAt at each board row's kernel boundary (kernel 08954d1c), m22 at its 1% page line, BrowseSafe at its own answer
# (yes over 0.5) and Prompt Guard 2 86M at 0.5, plus each model's AUC where a group has both labels. A model's numbers
# appear only once it has scored every row of the set. Writes report.json, report.md and board.json (rows for scores.py).
import json, os, collections
import numpy as np
H = os.path.expanduser('~/Development/.guardrail-data/bench-hunt')
HERE = os.path.dirname(os.path.abspath(__file__))
THR = 0.7550851106643677
SETS = sorted(f[:-6] for f in os.listdir(f'{H}/sets'))
SHIFT_SEEN = {'injecagent'}
BASE = "m22's base model (Horizon) trained on this source"
NOT_TAKEOVER = 'no order to the agent: a decoy label or a false fact, not a takeover'
PERSONA = 'a persona alone is not a takeover'
POLICY = "an attack only against one chatbot's own policy, which the row does not give"
PHISH = 'phishing aimed at a person, not the agent: neither harmless nor a takeover'
POPUP = "a click order whose only tell is the agent's own element number: the text reads as a real button"


def group(s, cat):
    """(group name, board rows, why m22 cannot count it or '') for one row."""
    y, c = cat.split('|', 1)
    y = int(y)
    if s == 'wainject-text': return c, (['attachments'] if c == 'email_msg' else ['pages']), (NOT_TAKEOVER if c in ('EIA_wo_EI', 'VWA_adv_wo_EI') else POPUP if c == 'popup' else '')
    if s == 'arpi-unique': return 'all', ['pages', 'attachments'], ''
    if s == 'ad-shift':
        a = c.split('/')[1]
        return a, ['fn_output'], ('attack text from InjecAgent, which m22 trained on' if y and a in SHIFT_SEEN else '')
    if s in ('ad-clean', 'ad-matched'): return c.split('/')[1] if '/' in c and s == 'ad-matched' else 'all', ['fn_output'], ''
    if s == 'tb-eval': return 'all', ['fn_output'], ('attack text from InjecAgent, which m22 trained on' if y else '')
    if s in ('pp-agent-flows', 'k-siem-logs'): return 'all', ['fn_output'], ''
    if s == 'k-ragshield-fin': return 'all', ['context'], ''
    if s == 'k-bec-emails': return c, ['attachments'], ''
    if s == 'k-sahil-bench':
        src = c.split('/')[1]
        why = 'm22 trained on this source' if src.startswith('deepset') else BASE if src.startswith(('neuralchemy', 'OpenAssistant')) else ''
        if src == 'reshabhs':
            fam = c.split('/')[-1]
            why = {'persona_override': PERSONA, 'policy_scope_violation': POLICY}.get(fam, '') if y else ''
            return f'{src} · {fam}', ['you'], why
        return src, ['you'], why
    if s == 'k-krishna-v3':
        src = c.split('/', 1)[1]
        return src, ['you'], ('m22 trained on this source (deepset lineage)' if 'deepset' in src.lower() or 'Denzel' in src else '')
    if s == 'k-fka-prompts': return 'all', ['you'], BASE
    if s == 'k-jackhhao-jailbreak': return 'all', ['you'], (BASE + '; ' + PERSONA if y else BASE)
    if s == 'k-inwild-jailbreak': return 'all', ['you'], BASE + '; ' + PERSONA
    return 'all', ['you'], ''


def auc(s, y):
    s, y = np.asarray(s, float), np.asarray(y, int)
    if y.min() == y.max(): return None
    r = np.argsort(np.argsort(s, kind='mergesort'), kind='mergesort') + 1.0
    for v in np.unique(s):  # mid-ranks for ties
        m = s == v
        if m.sum() > 1: r[m] = r[m].mean()
    p = y.sum(); n = len(y) - p
    return float((r[y == 1].sum() - p * (p + 1) / 2) / (p * n))


def load(s, n):
    out = {}
    p = f'{H}/results/regex/{s}.json'
    if os.path.exists(p):
        f = json.load(open(p)); out['regex-inj'] = np.array([v & 1 for v in f], float); out['regex-union'] = np.array([v > 0 for v in f], float)
    p = f'{H}/results/regex2/{s}.json'
    if os.path.exists(p):
        for b, v in json.load(open(p)).items(): out[f'regex@{b}'] = np.array(v, float)
    p = f'{H}/results/m22/{s}.jsonl'
    if os.path.exists(p):
        sc = [json.loads(l)['score'] for l in open(p)]
        if len(sc) == n: out['m22'] = np.array(sc)
    for m, d in (('browsesafe', 'bs'), ('pg2-86m', 'pg2')):
        p = f'{H}/results/{d}/{s}.json'
        if os.path.exists(p):
            sc = json.load(open(p))['score']
            if len(sc) == n and min(sc) >= 0: out[m] = np.array(sc)
    return out


LINE = collections.defaultdict(lambda: .5, {'m22': THR})
KB = {'you': 'user', 'attachments': 'attachment', 'context': 'context', 'fn_output': 'tool_output_function', 'pages': 'tool_output_http'}
report, board = [], []
for s in SETS:
    rows = [json.loads(l) for l in open(f'{H}/sets/{s}.jsonl')]
    sc = load(s, len(rows))
    y = np.array([r['y'] for r in rows])
    g = collections.defaultdict(list)
    for i, r in enumerate(rows):
        name, b, why = group(s, r['category'])
        g[(name, tuple(b), why)].append(i)
    for (name, b, why), idx in sorted(g.items()):
        idx = np.array(idx); yy = y[idx]
        e = {'set': s, 'group': name, 'boundaries': list(b), 'why_m22': why, 'attacks': int(yy.sum()), 'harmless': int((1 - yy).sum()), 'models': {}}
        for m, v in sc.items():
            f = v[idx] > LINE[m]
            e['models'][m] = {'caught': int(f[yy == 1].sum()), 'flagged': int(f[yy == 0].sum()),
                              'auc': None if m.startswith('regex') else auc(v[idx], yy)}
        report.append(e)
# AUC per whole set as well (groups split a set's two labels apart)
whole = {}
for s in SETS:
    rows = [json.loads(l) for l in open(f'{H}/sets/{s}.jsonl')]
    sc = load(s, len(rows)); y = np.array([r['y'] for r in rows])
    whole[s] = {'attacks': int(y.sum()), 'harmless': int((1 - y).sum()),
                'models': {m: {'recall': float((v[y == 1] > LINE[m]).mean()) if y.sum() else None,
                               'fa': float((v[y == 0] > LINE[m]).mean()) if (1 - y).sum() else None,
                               'auc': None if m.startswith('regex') else auc(v, y)} for m, v in sc.items()}}
json.dump({'groups': report, 'sets': whole}, open(f'{H}/report.json', 'w'), indent=1)

pct = lambda a, b: '–' if not b else f'{100 * a / b:.1f}%'
md = ['| Set | Attacks | Harmless | injection at a tool return (08954d1c) catch / FA | m22 catch / FA / AUC | BrowseSafe catch / FA / AUC | PG2 catch / FA / AUC |', '|' + '---|' * 7]
for s, w in whole.items():
    cell = lambda m: '…' if m not in w['models'] else ' / '.join(x for x in [
        '–' if w['models'][m]['recall'] is None else f"{100 * w['models'][m]['recall']:.1f}%",
        '–' if w['models'][m]['fa'] is None else f"{100 * w['models'][m]['fa']:.1f}%",
        *([] if m.startswith('regex') else ['–' if w['models'][m]['auc'] is None else f"{w['models'][m]['auc']:.3f}"])])
    md.append(f"| {s} | {w['attacks']:,} | {w['harmless']:,} | {cell('regex@tool_output_function')} | {cell('m22')} | {cell('browsesafe')} | {cell('pg2-86m')} |")
open(f'{H}/report.md', 'w').write('\n'.join(md) + '\n')

def lab_is_attack(e): return e['attacks'] > 0


# Rows for the Orient scores board: m22 and the regex, per group and board row.
for e in report:
    for b in e['boundaries']:
        rx = f'regex@{KB[b]}'
        for m, meth, det in (('m22', 'm22', 'm22'), (rx, 'regex', 'injection')):
            if m not in e['models']: continue
            label = [w for w in (NOT_TAKEOVER, PERSONA, POLICY, POPUP) if w in e['why_m22'] and lab_is_attack(e)] + [w for w in (PHISH,) if w in e['why_m22']]
            why = e['why_m22'] if m == 'm22' else '; '.join(label)
            name = f"{e['set']}" + ('' if e['group'] == 'all' else f" · {e['group']}")
            for lab, n, hits in (('attacks', e['attacks'], e['models'][m]['caught']), ('harmless', e['harmless'], e['models'][m]['flagged'])):
                if n: board.append({'b': b, 'method': meth, 'detector': det, 'dataset': name, 'split': 'excluded' if why else 'unseen', 'label': lab,
                                    'n': n, 'hits': hits, 'counts': not why, 'why': why,
                                    'source': 'm22-int8, new benchmarks (local)' if m == 'm22' else f'kernel 08954d1c detectAt at {KB[b]}, new benchmarks'})
json.dump(board, open(f'{H}/board.json', 'w'), indent=1)
print(open(f'{H}/report.md').read())
