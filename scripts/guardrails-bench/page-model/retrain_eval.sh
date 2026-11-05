# Builds pm-retrain-eval, the held-out rows retrain_report.py scores (3/11): the 19 bench-hunt sets as hunt-<set>.jsonl,
# the SpamAssassin and Ling ham emails of the Naser phishing download as email-ham.jsonl, dev-docs, and the bsafe-validate
# rows of the full bench (the 1% line). Run with bash. No row of these files trains any arm (retrain_build.py).
G=~/Development/.guardrail-data; E=$G/kaggle/pm-retrain-eval; mkdir -p $E
for f in $G/bench-hunt/sets/*.jsonl; do cp $f $E/hunt-$(basename $f); done
cp $G/devdocs/rows.jsonl $E/devdocs.jsonl
python3 -I -c "
import csv, json, collections
csv.field_size_limit(10**9); n = collections.Counter()
with open('$E/email-ham.jsonl', 'w') as o:
  for f in ['SpamAssasin', 'Ling']:
    for r in csv.DictReader(open('$G/retrain-dl/phish-naser/' + f + '.csv', errors='replace')):
      if r['label'] == '0': o.write(json.dumps({'set': f.lower() + '-ham', 'text': 'Subject: ' + r['subject'] + '\n\n' + r['body'], 'y': 0, 'category': 'ham'}) + '\n'); n[f] += 1
print(n)
n = 0
with open('$E/bsafe-validate.jsonl', 'w') as o:
  for l in open('$G/local-m22/rows/full.jsonl'):
    r = json.loads(l)
    if r.get('set') == 'bsafe-validate': o.write(json.dumps({'set': r['set'], 'text': r['text'], 'y': r['y']}) + '\n'); n += 1
print(n)"
echo '{"title":"pm-retrain-eval","id":"masudlewis/pm-retrain-eval","licenses":[{"name":"other"}]}' > $E/dataset-metadata.json
