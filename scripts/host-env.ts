/**
 * Env loading for the live verify scripts. Keys come from `THEOREM_ENV_FILE`,
 * or the host app's `.env.local` beside this repo when that is unset.
 * Variables already set in the shell win over the file.
 *
 * @module
 */

/** The host app checkout's env file, resolved from this script, not the cwd. */
const HOST_APP_ENV_FILE = new URL('../../theoremai-frontend/.env.local', import.meta.url);

/** Set each `KEY=value` line not already set. False when the file cannot be read. */
function loadEnvFile(path: string | URL): boolean {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (Deno.env.get(key) !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    Deno.env.set(key, val);
  }
  return true;
}

/** Load the verify scripts' env file and say which one, if any, was read. */
export function loadHostEnv(): void {
  const path = Deno.env.get('THEOREM_ENV_FILE') ?? HOST_APP_ENV_FILE;
  if (loadEnvFile(path)) {
    console.log(`Loaded env from ${path instanceof URL ? path.pathname : path}`);
  }
}
