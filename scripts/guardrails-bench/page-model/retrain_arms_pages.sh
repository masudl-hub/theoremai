# Arms B-F on waab and WARP only (A85): which added part costs page attacks. Weights come from the Modal volume `retrain`;
# scores go to kaggle/k-<arm>/out/out/<set>-<arm>.json. rival_bar.py reads them. Skips outputs that exist; stops past 8 GB swap.
S=${RETRAIN_WORK:-$HOME/Development/.guardrail-data/retrain-work}
K=/Users/masudlewis/Development/.guardrail-data/kaggle; G=$S/gd; C=$G/linear-2210/clf; PY=/Users/masudlewis/Development/.guardrail-data/venv-score/bin/python
swap() { sysctl -n vm.swapusage | awk '{gsub("M","",$6); print int($6)}'; }
one() {
  m=$1; rows=$2; out=$3; [ -s $out ] && return 0
  [ $(swap) -gt 8192 ] && { echo "$(date -u '+%H:%M') swap over 8 GB, stopped before $out"; exit 1; }
  (cd $S/pm && env GUARDRAIL_DATA=$G PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.25 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.2 REMAP=$C/trim/m5/remap.json TEACH=$S/mini.jsonl LIMIT=64 LOAD=$C/prune/$m EP=0 EVAL=$rows OUT=$out DEV=mps $PY -I prune.py $m 0 0 2>&1 | grep -E "scored|Error" | tail -1 | sed "s|^|$(date -u '+%H:%M') $(basename $out) |")
}
for m in rB rC rD rE rF; do
  [ -s $C/prune/$m/model.safetensors ] || (cd ~ && MODAL_PROFILE=retrain $PY -m modal volume get retrain out/$m $C/prune/ 2>&1 | tail -1)
  O=$K/k-$m/out/out; mkdir -p $O
  one $m $K/pm-waab/waab.jsonl $O/waab-$m.json
  one $m $K/pm-leads/warp.jsonl $O/warp-$m.json
done
echo "$(date -u '+%H:%M') arms scored"
