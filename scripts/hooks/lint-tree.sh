#!/usr/bin/env sh
# Runs a command on a commit or tree as git holds it, the way CI will see it.
# why: a hook that reads the working tree passes on what isn't pushed and fails on what isn't
# committed. Several sessions share this tree, so neither is rare.
# usage: lint-tree.sh <commit-or-tree> <command>
set -e
tree=$1
root=$(git rev-parse --show-toplevel)
snapshot=$(mktemp -d)
trap 'rm -rf "$snapshot"' EXIT
git archive "$tree" | tar -x -C "$snapshot"
for packages in . react web studio; do
  if [ -d "$root/$packages/node_modules" ]; then
    ln -s "$root/$packages/node_modules" "$snapshot/$packages/node_modules"
  fi
done
# why: a hook inherits these, and they would point the command back at the shared repository.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
cd "$snapshot"
sh -c "$2"
