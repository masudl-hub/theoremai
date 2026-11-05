# Scores m22, then each retrain arm as it lands on the Modal volume, on every pm-retrain-eval file, on this Mac's GPU.
# Stops a model's scoring if swap passes 8 GB (SSD wear). Run with bash; TODO="A B" limits the arms.
S=${RETRAIN_WORK:-$HOME/Development/.guardrail-data/retrain-work}
K=/Users/masudlewis/Development/.guardrail-data/kaggle; G=$S/gd; C=$G/linear-2210/clf; PY=/Users/masudlewis/Development/.guardrail-data/venv-score/bin/python
M() { MODAL_PROFILE=retrain /Users/masudlewis/Development/.guardrail-data/venv-score/bin/modal "$@"; }
swap() { sysctl -n vm.swapusage | awk '{gsub("M","",$6); print int($6)}'; }
score() {
  m=$1; mkdir -p $S/out/scores-$m
  for p in $K/pm-retrain-eval/*.jsonl; do
    n=$(basename $p .jsonl); [ -s $S/out/scores-$m/$n.json ] && continue
    [ $(swap) -gt 8192 ] && { echo "$(date -u '+%H:%M') $m swap over 8 GB, stopped before $n"; return 1; }
    (cd $S/pm && env GUARDRAIL_DATA=$G PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.25 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.2 REMAP=$C/trim/m5/remap.json TEACH=$S/mini.jsonl LIMIT=64 LOAD=$C/prune/$m EP=0 EVAL=$p OUT=$S/out/scores-$m/$n.json DEV=mps $PY -I prune.py $m 0 0 2>&1 | grep -E "scored|Error" | tail -1 | sed "s/^/$(date -u '+%H:%M') /")
  done
}
score m22
todo="${TODO:-A B C D E F}"
while [ -n "$todo" ]; do
  left=""
  for a in $todo; do
    if M volume ls retrain out/r$a 2>/dev/null | grep -q done.json; then
      d=$C/prune/r$a; mkdir -p $d
      for f in config.json model.safetensors remap.json done.json train.log; do M volume get retrain out/r$a/$f $d/$f --force >/dev/null 2>&1; done
      if [ -s $d/model.safetensors ] && ! M volume ls retrain out/r$a 2>/dev/null | grep -q ckpt.pt; then echo "$(date -u '+%H:%M') r$a landed: $(cat $d/done.json)"; score r$a; else echo "$(date -u '+%H:%M') r$a ended without a model: $(cat $d/done.json)"; fi
    else left="$left $a"; fi
  done
  todo=$(echo $left); [ -n "$todo" ] && sleep 600
done
echo "$(date -u '+%H:%M') all scored"
