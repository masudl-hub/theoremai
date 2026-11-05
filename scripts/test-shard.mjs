// Usage: node scripts/test-shard.mjs <shard> <shards>
// Prints the test files under tests/ that one CI shard runs, one per line. Each file goes to the
// shard with the least source so far, largest first, so the shards take about as long and every
// file runs in exactly one. The split depends only on the files, so each shard computes it alone.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [shard, shards] = process.argv.slice(2).map(Number);
if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shard >= shards) {
  throw new Error('usage: test-shard.mjs <shard> <shards>, with 0 <= shard < shards');
}

// invariant: the names `deno test tests/` takes as tests.
const TEST = /(^|[._])test\.(ts|tsx|mts|js|mjs|jsx)$/;

function testsIn(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return testsIn(path);
    return TEST.test(entry.name) ? [path] : [];
  });
}

const files = testsIn('tests')
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
const loads = Array.from({ length: shards }, () => ({ size: 0, paths: [] }));
for (const file of files) {
  const lightest = loads.reduce((least, load) => (load.size < least.size ? load : least));
  lightest.size += file.size;
  lightest.paths.push(file.path);
}
console.log(loads[shard].paths.sort().join('\n'));
