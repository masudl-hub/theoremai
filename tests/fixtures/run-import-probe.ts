const REPO_ROOT = new URL('../..', import.meta.url);

export interface ImportProbeResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runImportProbe(relativeScript: string): Promise<ImportProbeResult> {
  const script = new URL(relativeScript, import.meta.url);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-read', '--allow-env', script.pathname],
    cwd: REPO_ROOT,
    env: { ...Deno.env.toObject(), THEORUM_IMPORT_PROBE: '1' },
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

export function loadedModules(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('LOADED:'))
    .map((line) => line.slice('LOADED:'.length));
}

export function stdoutBeforeMarker(stdout: string, marker: string): string {
  const index = stdout.indexOf(marker);
  return index === -1 ? stdout : stdout.slice(0, index);
}

export function loadedBetween(stdout: string, startMarker: string, endMarker: string): string[] {
  const start = stdout.indexOf(startMarker);
  const end = stdout.indexOf(endMarker);
  if (start === -1) {
    return loadedModules(stdout);
  }
  const sliceStart = start + startMarker.length;
  const sliceEnd = end === -1 ? stdout.length : end;
  return loadedModules(stdout.slice(sliceStart, sliceEnd));
}
