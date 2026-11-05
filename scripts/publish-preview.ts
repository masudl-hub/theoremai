/**
 * Publishes the four npm packages as one preview, from publish-npm-preview.yml. A run whose commit
 * is no longer the branch tip publishes nothing, and `next` moves only once all four are up.
 */

/** The package folders, in the order they publish: each one's dependencies come before it. */
const PREVIEW_PACKAGES = ['npm', 'web/npm', 'react/npm', 'studio/npm'] as const;

/** The tag each package publishes under before the set is whole; `next` follows it. */
export const STAGING_TAG = 'preview-staging';

export interface PreviewRun {
  /** The commit this run built. */
  sha: string;
  /** The version all four packages carry. */
  version: string;
  /** The branch tip as the remote has it now. */
  tip: () => Promise<string>;
  /** The package name in a folder's package.json. */
  name: (dir: string) => Promise<string>;
  /** Runs `npm` with `args` in `dir`; throws when it fails. */
  npm: (args: string[], dir: string) => Promise<void>;
  log: (line: string) => void;
}

export type PreviewOutcome = 'tagged' | 'stale' | 'stale_after_publish';

/** Publishes the set when `sha` is the tip, then moves `next` to it if `sha` is still the tip. */
export async function publishPreview(run: PreviewRun): Promise<PreviewOutcome> {
  // why: the concurrency group runs previews one at a time but not in push order, so an older run
  // that gets the slot last would move `next` back to its commit.
  if ((await run.tip()) !== run.sha) {
    run.log(`Skipped ${run.version}: the branch has moved past ${run.sha}.`);
    return 'stale';
  }
  const names: string[] = [];
  for (const dir of PREVIEW_PACKAGES) {
    await run.npm(['publish', '--access', 'public', '--provenance', '--tag', STAGING_TAG], dir);
    names.push(await run.name(dir));
  }
  if ((await run.tip()) !== run.sha) {
    run.log(`Published ${run.version} without moving next: the branch has moved past ${run.sha}.`);
    return 'stale_after_publish';
  }
  for (const name of names)
    await run.npm(['dist-tag', 'add', `${name}@${run.version}`, 'next'], '.');
  run.log(`Moved next to ${run.version}.`);
  return 'tagged';
}

async function command(cmd: string, args: string[], cwd: string): Promise<string> {
  const { code, stdout } = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: 'piped',
    stderr: 'inherit',
  }).output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} with exit ${code}`);
  return new TextDecoder().decode(stdout);
}

if (import.meta.main) {
  const env = (key: string) => {
    const value = Deno.env.get(key);
    if (!value) throw new Error(`${key} is not set`);
    return value;
  };
  const branch = env('GITHUB_REF_NAME');
  const sha = env('GITHUB_SHA');
  const version = JSON.parse(await Deno.readTextFile('package.json')).version as string;
  const outcome = await publishPreview({
    sha,
    version,
    tip: async () =>
      (await command('git', ['ls-remote', 'origin', `refs/heads/${branch}`], '.')).split(/\s/)[0],
    name: async (dir) => JSON.parse(await Deno.readTextFile(`${dir}/package.json`)).name,
    npm: async (args, dir) => void (await command('npm', args, dir)),
    log: console.log,
  });
  const summary = Deno.env.get('GITHUB_STEP_SUMMARY');
  if (summary) await Deno.writeTextFile(summary, `Preview outcome: ${outcome}\n`, { append: true });
}
