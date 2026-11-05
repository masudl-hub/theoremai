# Arm A on every set m22 was judged on in A79 (zbatch.py's inputs), on this Mac's GPU, into kaggle/k-rA/out/out/<set>-rA.json.
# Bonsai's 300 real pages (A48) are scored for m22 and rA both; they stay on this Mac. Skips outputs that exist; stops past 8 GB swap.
S=${RETRAIN_WORK:-$HOME/Development/.guardrail-data/retrain-work}
K=/Users/masudlewis/Development/.guardrail-data/kaggle; G=$S/gd; C=$G/linear-2210/clf; PY=/Users/masudlewis/Development/.guardrail-data/venv-score/bin/python
O=$K/k-rA/out/out; mkdir -p $O
swap() { sysctl -n vm.swapusage | awk '{gsub("M","",$6); print int($6)}'; }
one() {
  m=$1; rows=$2; out=$3; [ -s $out ] && return 0
  [ $(swap) -gt 8192 ] && { echo "$(date -u '+%H:%M') swap over 8 GB, stopped before $out"; exit 1; }
  (cd $S/pm && env GUARDRAIL_DATA=$G PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.25 PYTORCH_MPS_LOW_WATERMARK_RATIO=0.2 REMAP=$C/trim/m5/remap.json TEACH=$S/mini.jsonl LIMIT=64 LOAD=$C/prune/$m EP=0 EVAL=$rows OUT=$out DEV=mps $PY -I prune.py $m 0 0 2>&1 | grep -E "scored|Error" | tail -1 | sed "s|^|$(date -u '+%H:%M') $(basename $out) |")
}
B=/Users/masudlewis/Development/.guardrail-data/linear-2210/clf/bonsai
for m in m22 rA; do one $m $B/eval300.jsonl $B/eval300-$m.json; done
one rA $K/pm-leads/tools.jsonl $O/tools-rA.json
one rA $K/pm-leads/inwild.jsonl $O/inwild-rA.json
one rA $K/pm-leads/warp.jsonl $O/warp-rA.json
one rA $K/pm-waab/waab.jsonl $O/waab-rA.json
one rA $K/k-full/out/rows/full.jsonl $O/full-rA.json
one rA $K/k-full/out/rows/bsbtest.jsonl $O/bsbtest-rA.json
one rA $K/pm-bspp/bspp.jsonl $O/bspp-rA.json
echo "$(date -u '+%H:%M') all scored"
