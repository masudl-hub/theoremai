# Would a page check run in parallel with the model's next step finish in time? For each Bonsai model step that follows a
# remote read (an http tool or search_web) in a recorded trace, this estimates the read's size as the growth of the step's
# input tokens over the step before (less that step's output), and the check's wall time from a line fitted to pagelat.py's
# (tokens, ms) points. It counts a check as in time for actions when it ends before the step does, and in time for text
# when it ends before the step's first chunk. Because few recorded steps follow a read, it also pairs every recorded chat step
# with every page pagelat.py timed, by page group: the share of pairs where the measured check ends before the step.
# Usage: parcheck.py <lat json>,... <trace file>...
import json, sys, statistics
lats, traces = sys.argv[1].split(','), sys.argv[2:]
READS = {'search_web'}
fits = {}
for p in lats:
    d = json.load(open(p))
    for m, groups in d['ms'].items():
        xs, ys = [], []
        for g, ms in groups.items():
            for (src, k), y in zip(d['pages'][g], ms): xs.append(d['ntok'][g][f'{src}:{k}']); ys.append(y)
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
        fits[f"{m} {d['dev']}"] = (my - b * mx, b)
steps, allsteps = [], []
for t in traces:
    for line in open(t):
        try: r = json.loads(line)
        except ValueError: continue
        spans = sorted(r.get('spans', []), key=lambda s: int(s['startTimeUnixNano']))
        by = {}
        for s in spans: by.setdefault(s.get('parentSpanId'), []).append(s)
        for kids in by.values():
            chats = [s for s in kids if s['attributes'].get('gen_ai.operation.name') == 'chat']
            allsteps += [((int(c['endTimeUnixNano']) - int(c['startTimeUnixNano'])) / 1e6, 1000 * c['attributes'].get('gen_ai.response.time_to_first_chunk', 0)) for c in chats]
            for a, b in zip(chats, chats[1:]):
                a0, a1, b0 = int(a['startTimeUnixNano']), int(a['endTimeUnixNano']), int(b['startTimeUnixNano'])
                tools = [s for s in kids if s['name'].startswith('execute_tool') and a1 <= int(s['startTimeUnixNano']) < b0]
                if not any(s['attributes'].get('theorem.tool.origin') == 'http' or s['attributes'].get('gen_ai.tool.name') in READS for s in tools): continue
                A, B = a['attributes'], b['attributes']
                grow = B['gen_ai.usage.input_tokens'] - A['gen_ai.usage.input_tokens'] - (A['gen_ai.usage.output_tokens'] - A.get('gen_ai.usage.reasoning.output_tokens', 0))
                steps.append({'tok': max(grow, 0), 'step': (int(b['endTimeUnixNano']) - b0) / 1e6,
                              'first': 1000 * B.get('gen_ai.response.time_to_first_chunk', 0) or None, 'model': B.get('gen_ai.request.model'),
                              'tools': [s['attributes']['gen_ai.tool.name'] for s in tools], 'fin': B.get('gen_ai.response.finish_reasons')})
q = lambda v, p: sorted(v)[min(len(v) - 1, int(p * len(v)))]
toks, step, first = [s['tok'] for s in steps], [s['step'] for s in steps], [s['first'] for s in steps if s['first']]
print(f'{len(steps)} steps after a remote read; read tokens p50 {q(toks, .5)} p90 {q(toks, .9)} max {max(toks)}')
print(f'step ms p10 {q(step, .1):.0f} p50 {q(step, .5):.0f}; first chunk ms p10 {q(first, .1):.0f} p50 {q(first, .5):.0f}')
out = {'steps': steps, 'fits': fits, 'rows': {}}
for name, (a, b) in fits.items():
    chk = [a + b * s['tok'] for s in steps]
    act = sum(c <= s['step'] for c, s in zip(chk, steps)) / len(steps)
    txt = [c <= s['first'] for c, s in zip(chk, steps) if s['first']]
    over = sorted(max(0, c - s['step']) for c, s in zip(chk, steps))
    out['rows'][name] = {'check_p50': q(chk, .5), 'check_p90': q(chk, .9), 'in_time_actions': act, 'in_time_text': sum(txt) / len(txt), 'wait_max': over[-1]}
    print(f'{name:16} check p50 {q(chk, .5):5.0f} p90 {q(chk, .9):5.0f} ms; in time for actions {act:.0%}, for first text {sum(txt) / len(txt):.0%}; worst wait {over[-1]:.0f} ms')
A, F = [a for a, _ in allsteps], [f for _, f in allsteps if f]
print(f'{len(A)} recorded chat steps: step ms p10 {q(A, .1):.0f} p50 {q(A, .5):.0f}; first chunk ms p10 {q(F, .1):.0f} p50 {q(F, .5):.0f}')
out['cross'] = {}
for p in lats:
    d = json.load(open(p))
    for m, groups in d['ms'].items():
        for g, ms in groups.items():
            act = sum(c <= a for c in ms for a in A) / (len(ms) * len(A)); txt = sum(c <= f for c in ms for f in F) / (len(ms) * len(F))
            out['cross'][f"{m} {d['dev']} {g}"] = {'in_time_actions': act, 'in_time_text': txt}
            if g.startswith('bspp') or g in ('c:bonsai-pages', 'bsafe-validate', 'm2w-validate'): print(f"{m:10} {d['dev']:4} {g:20} in time for actions {act:.1%}, for first text {txt:.1%}")
json.dump(out, open('parcheck.json', 'w'))
