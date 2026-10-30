# Score rows from the sets checked on 28/10 (research/leads-2810.md). Reads them from new-2810/leads/.
#   inwild: In-Page Prompt Injection in the Wild, page-body slices whose page is English or has no language. y=1 for the
#           reviewed true positives (fp=0) whose prompt is in the slice, y=0 for the reviewed false positives (fp=1); one row
#           per distinct slice. The slice is cut from a JSON crawl record, so its escapes are undone. Set inwild-attack-<goal>
#           by the first objective column set (exfiltration first, the crawler notices of Data Protection last), inwild-benign, or inwild-benign-prompt when the reviewers named a prompt.
#   warp:   WARP browser steps, as the agent's accessibility tree. y=1 when a payload witness of that trajectory is in the step,
#           y=0 for its steps where no witness is on screen either (a GitLab tree is often cut before the issue text, so a step
#           whose screenshot shows a witness that its text lacks is left out); one row per distinct step text. Set warp-<site>-<attack|clean>.
#   tools:  mcp-fault-bench tool results (mcpfault-ok, mcpfault-error, y=0), and AgentInjectionBench conversations as the
#           tool results joined (aib-<category>, y=1 unless benign).
# Usage: newleads.py <inwild|warp|tools> <data dir> <out.jsonl>
import json, sys, glob, re, os, collections
mode, D, out = sys.argv[1:4]; L = f'{D}/new-2810/leads'; rows, seen = [], set()
def put(s, y, t, **k):
    if t and t not in seen: seen.add(t); rows.append({'set': s, 'y': y, 'text': t, **k})
norm = lambda s: re.sub(r'\W+', '', s.lower())
if mode == 'inwild':
    import pandas as pd
    d = pd.read_csv(glob.glob(f'{L}/gh-SoheilKhodayari*/data/dataset.csv')[0], dtype=str).fillna('')
    d = d[(d.position == 'http_body') & (d.lang_html.str.startswith('en') | (d.lang_html == '')) & d.fp.isin(['0', '1'])]
    pri = ('Data Exfiltration', 'System Disruption / Degradation|Command', 'System Disruption / Degradation|Constraint', 'System Disruption / Degradation|Model',
           'General Instruction', 'System Disruption / Degradation|Garbage', 'Content & Reputation', 'AI Bot', 'Data Protection')
    goals = [c for p in pri for c in d.columns if c.startswith(p)]
    unesc = lambda t: re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), t).replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\\/', '/').replace('\\\\', '\\')
    for r in d.to_dict('records'):
        t = unesc(r['text'])
        if r['fp'] == '1': put('inwild-benign-prompt' if r['prompt'] else 'inwild-benign', 0, t); continue
        if norm(r['prompt'])[:30] not in norm(r['text']): continue
        g = next((c for c in goals if r[c] in ('1', '1.0')), 'none')
        put(f"inwild-attack-{g.split('|')[-1].split(' (')[0].lower().replace(' ', '-').replace('/', '')}", 1, t)
elif mode == 'warp':
    for h in sorted(glob.glob(f'{L}/hf-warp/x/**/history.json', recursive=True)):
        t = os.path.dirname(h); w, shown = set(), set()
        for f in glob.glob(f'{t}/pvpo/step_*.json'):
            s = json.load(open(f))
            if s.get('matched_witness_text'): w.add(s['matched_witness_text']); shown.add(s['step_idx'])
        site = 'gitlab' if '_gitlab_' in t else 'reddit'
        for i, s in enumerate(json.load(open(h))['history']):
            o = (s.get('agentlab') or {}).get('observation_text') or ''; a = any(x in o for x in w)
            if w and (a or i not in shown): put(f"warp-{site}-{'attack' if a else 'clean'}", int(a), o)
else:
    for f in glob.glob(f'{L}/gh-brvtl_mcp-fault-bench/results/runs/*/claude.jsonl'):
        for l in open(f):
            try: m = json.loads(l).get('message') or {}
            except json.JSONDecodeError: continue
            for c in m.get('content') or [] if isinstance(m.get('content'), list) else []:
                if isinstance(c, dict) and c.get('type') == 'tool_result':
                    v = c['content'] if isinstance(c['content'], str) else '\n'.join(x.get('text', '') for x in c['content'] if isinstance(x, dict))
                    put('mcpfault-error' if c.get('is_error') else 'mcpfault-ok', 0, v)
    for l in open(glob.glob(f'{L}/gh-ppradyoth_AgentInjectionBench/data/agent_injection_bench.jsonl')[0]):
        r = json.loads(l); t = '\n\n'.join(m['content'] for m in r['conversation'] if m['role'] == 'tool_result' and m.get('content'))
        put(f"aib-{r['attack_category']}", int(r['attack_category'] != 'benign'), t)
with open(out, 'w') as o:
    for r in rows: o.write(json.dumps(r) + '\n')
print(len(rows), dict(sorted(collections.Counter(r['set'] for r in rows).items())))
