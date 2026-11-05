# Overnight scoring of the new benchmark sets, one result file per set and model, so a stop loses one set at most.
# m22 (CPU, 4 threads) and BrowseSafe (MLX, GPU) run side by side; Prompt Guard 2 86M runs after m22. Order: agent and page sets first.
H=~/Development/.guardrail-data/bench-hunt
PM=~/Development/theoremai-bench/scripts/guardrails-bench/page-model
VS=~/Development/.guardrail-data/venv-score/bin/python
VM=~/Development/.guardrail-data/venv-mlx/bin/python
SETS=(pp-agent-flows pp-attacks pp-benign-hard ad-clean ad-matched ad-shift tb-eval wainject-text arpi-unique k-ragprobe-attacks k-ragshield-fin k-cyberprince k-siem-logs k-bec-emails k-jackhhao-jailbreak k-fka-prompts k-inwild-jailbreak k-krishna-v3 k-sahil-bench)
mkdir -p $H/results/m22 $H/results/bs $H/results/pg2
cd /tmp
(
  for s in $SETS[@]; do
    [ -f $H/results/m22/$s.done ] && continue
    THREADS=4 $VS -I $PM/devdocs_score.py $H/sets/$s.jsonl $H/results/m22/$s.jsonl > $H/results/m22/$s.log 2>&1 && touch $H/results/m22/$s.done
    echo "m22 $s exit $? $(date '+%H:%M')" >> $H/results/run.log
  done
  for s in $SETS[@]; do
    [ -f $H/results/pg2/$s.json ] && continue
    $VS -I $PM/score.py pg2-86m $H/sets/$s.jsonl $H/results/pg2/$s.json > $H/results/pg2/$s.log 2>&1
    echo "pg2 $s exit $? $(date '+%H:%M')" >> $H/results/run.log
  done
  echo "cpu done $(date '+%H:%M')" >> $H/results/run.log
) &
(
  for s in $SETS[@]; do
    [ -f $H/results/bs/$s.json ] && continue
    $VM -I $PM/score_mlx.py ~/Development/.guardrail-data/hf-models/browsesafe-mlx4 $H/sets/$s.jsonl $H/results/bs/$s.json > $H/results/bs/$s.log 2>&1
    echo "bs $s exit $? $(date '+%H:%M')" >> $H/results/run.log
  done
  echo "gpu done $(date '+%H:%M')" >> $H/results/run.log
) &
wait
echo "all done $(date '+%H:%M')" >> $H/results/run.log
