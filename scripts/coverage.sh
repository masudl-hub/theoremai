#!/usr/bin/env sh
# Test coverage for fallow's CRAP scores, written to coverage/coverage-final.json.
# Deno's raw V8 output goes to a directory of this run's own: `deno coverage`
# reads every .json in the directory it is given, so a shared one takes in
# another run's files (a concurrent run's coverage-final.json fails its read).
# Given lcov files, it joins those instead of running the tests: CI runs them
# in shards, and each shard converts its own output while its Deno cache still
# holds the transpiled sources `deno coverage` reads.
set -eu
cd "$(dirname "$0")/.."
raw=$(mktemp -d)
trap 'rm -rf "$raw"' EXIT
if [ $# -gt 0 ]; then
  cat "$@" > "$raw/lcov.info"
else
  deno test --parallel --allow-read --allow-write --allow-net --allow-env --allow-sys --allow-run --ignore=npm/ --coverage="$raw/v8" tests/
  deno coverage "$raw/v8" --lcov --output="$raw/lcov.info"
fi
node scripts/lcov-to-istanbul.mjs "$raw/lcov.info" coverage/coverage-final.json
