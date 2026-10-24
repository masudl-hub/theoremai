# Agent traces as step lists for egress-replay.ts.
#   hermes:     both Hermes agent trace configs (glm, kimi); system and user text given, every call and result in order.
#   agentdrift: the task-disjoint test split; the task and world given. Also writes <rows.jsonl>, one classifier row per
#               tool output: injection_point and failed_injection outputs are attacks, benign outputs of benign and
#               hard-negative trajectories are benign, the rest are left out.
# Usage: egress-steps.py hermes <data dir> <steps.jsonl>
#        egress-steps.py agentdrift <data dir> <steps.jsonl> <rows.jsonl>
import json, sys, re, collections
mode, D, steps_out = sys.argv[1:4]; n = collections.Counter()
with open(steps_out, 'w') as out:
    if mode == 'hermes':
        import pyarrow.parquet as pq
        for d in ('glm', 'kimi'):
            for r in pq.read_table(f'{D}/hermes-agent-traces/{d}/train.parquet').to_pylist():
                steps = []
                for m in r['conversations']:
                    v = m['value']
                    if m['from'] in ('system', 'human'): steps.append({'k': 'given', 'text': v})
                    elif m['from'] == 'gpt':
                        for c in re.findall(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', v, re.S):
                            try: j = json.loads(c)
                            except ValueError: continue
                            steps.append({'k': 'call', 'tool': j['name'], 'args': j.get('arguments', {})})
                    elif m['from'] == 'tool':
                        for c in re.findall(r'<tool_response>\s*(.*?)\s*</tool_response>', v, re.S):
                            try: j = json.loads(c); tool, body = j.get('name', '?'), j.get('content', c)
                            except ValueError: tool, body = '?', c
                            steps.append({'k': 'result', 'tool': tool, 'text': body if isinstance(body, str) else json.dumps(body)})
                out.write(json.dumps({'id': f"{d}:{r['id']}", 'steps': steps}) + '\n'); n[d] += 1
    else:
        with open(sys.argv[4], 'w') as rows:
            for l in open(f'{D}/guardrail-corpus/AgentDrift/repo/data_taskdisjoint/test.jsonl'):
                t = json.loads(l); cat = t['category']
                steps = [{'k': 'given', 'text': t['task']}, {'k': 'given', 'text': json.dumps(t['world'])}]
                for k, st in enumerate(t['steps']):
                    steps += [{'k': 'call', 'tool': st['tool'], 'args': st['args']}, {'k': 'result', 'tool': st['tool'], 'text': st['obs']}]
                    if st['label'] in ('injection_point', 'failed_injection'): y = 1
                    elif st['label'] == 'benign' and cat in ('benign', 'hard_negative'): y = 0
                    else: continue
                    g = f"drift {cat} {'attack' if y else 'benign'}"; n[g] += 1
                    rows.write(json.dumps({'set': g, 'y': y, 'i': f"{t['id']}:{k}", 'agent': t['agent'], 'text': st['obs']}) + '\n')
                out.write(json.dumps({'id': t['id'], 'category': cat, 'steps': steps}) + '\n'); n['traces'] += 1
print(dict(n))
