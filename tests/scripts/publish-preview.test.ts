import { assertEquals, assertRejects } from '@std/assert';
import { type PreviewRun, publishPreview, STAGING_TAG } from '../../scripts/publish-preview.ts';

const NAMES: Record<string, string> = {
  npm: '@theoremjs/agents',
  'web/npm': '@theoremjs/web',
  'react/npm': '@theoremjs/react',
  'studio/npm': '@theoremjs/studio',
};

/** A registry that keeps each package's versions and tags, as npm does. */
class Registry {
  versions = new Map<string, Set<string>>();
  tags = new Map<string, Map<string, string>>();

  publish(name: string, version: string, tag: string) {
    if (!this.versions.has(name)) this.versions.set(name, new Set());
    this.versions.get(name)?.add(version);
    this.tag(name, version, tag);
  }

  tag(name: string, version: string, tag: string) {
    if (!this.tags.has(name)) this.tags.set(name, new Map());
    this.tags.get(name)?.set(tag, version);
  }

  /** What `next` names for every package. */
  next() {
    return Object.values(NAMES).map((name) => this.tags.get(name)?.get('next'));
  }
}

/** A run of the new script against `registry`, with the tip given per call. */
function run(
  registry: Registry,
  sha: string,
  version: string,
  tips: string[],
  failIn?: string,
): PreviewRun {
  let current = '';
  return {
    sha,
    version,
    tip: async () => {
      current = tips.shift() ?? current;
      return await Promise.resolve(current);
    },
    name: (dir) => Promise.resolve(NAMES[dir]),
    npm: (args, dir) => {
      if (dir === failIn) return Promise.reject(new Error(`publish failed in ${dir}`));
      if (args[0] === 'publish') registry.publish(NAMES[dir], version, args[args.length - 1]);
      else {
        const [name, at] = args[2].split(/@(?=[^@]+$)/);
        registry.tag(name, at, args[3]);
      }
      return Promise.resolve();
    },
    log: () => {},
  };
}

const NEWER = { sha: 'a9dd1465', version: '0.3.4-next.823.ga9dd146' };
const OLDER = { sha: '30c3749c', version: '0.3.4-next.821.g30c3749' };

Deno.test('an older run that gets the slot last publishes nothing and leaves next on the newer set', async () => {
  const registry = new Registry();
  const newer = await publishPreview(run(registry, NEWER.sha, NEWER.version, [NEWER.sha]));
  const older = await publishPreview(run(registry, OLDER.sha, OLDER.version, [NEWER.sha]));
  assertEquals([newer, older], ['tagged', 'stale']);
  assertEquals(registry.next(), Array(4).fill(NEWER.version));
  for (const name of Object.values(NAMES)) {
    assertEquals([...(registry.versions.get(name) ?? [])], [NEWER.version]);
  }
});

Deno.test('next moves to all four packages, after all four are published', async () => {
  const registry = new Registry();
  await publishPreview(run(registry, NEWER.sha, NEWER.version, [NEWER.sha]));
  assertEquals(registry.next(), Array(4).fill(NEWER.version));
  for (const name of Object.values(NAMES)) {
    assertEquals(registry.tags.get(name)?.get(STAGING_TAG), NEWER.version);
  }
});

Deno.test('a publish that fails part way leaves next on the last whole set', async () => {
  const registry = new Registry();
  await publishPreview(run(registry, OLDER.sha, OLDER.version, [OLDER.sha]));
  await assertRejects(
    () => publishPreview(run(registry, NEWER.sha, NEWER.version, [NEWER.sha], 'react/npm')),
    Error,
    'publish failed in react/npm',
  );
  assertEquals(registry.next(), Array(4).fill(OLDER.version));
});

Deno.test('a push during the publish leaves next for the newer run to move', async () => {
  const registry = new Registry();
  const outcome = await publishPreview(
    run(registry, OLDER.sha, OLDER.version, [OLDER.sha, NEWER.sha]),
  );
  assertEquals(outcome, 'stale_after_publish');
  assertEquals(registry.next(), Array(4).fill(undefined));
});
