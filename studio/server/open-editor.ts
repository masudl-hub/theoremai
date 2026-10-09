/**
 * Opens one of the project's files in the builder's editor, on a line. The
 * studio starts the editor's own command and never a shell, and only for a
 * file the project's setup reads.
 *
 * @module
 */

import { basename } from 'node:path';
import type { OpenAnswer, OpenRequest } from './save-wire.ts';

/** How an editor's command takes a file and a line. */
type LineForm = (file: string, line: number) => string[];

const goto: LineForm = (file, line) => ['-g', `${file}:${line}`];
const colon: LineForm = (file, line) => [`${file}:${line}`];
const lineFlag: LineForm = (file, line) => ['--line', String(line), file];

/** The editors that open in a window of their own, by command name. One that runs in a terminal is not here. */
const EDITORS: Record<string, LineForm> = {
  code: goto,
  'code-insiders': goto,
  codium: goto,
  cursor: goto,
  windsurf: goto,
  positron: goto,
  zed: colon,
  zeditor: colon,
  subl: colon,
  idea: lineFlag,
  webstorm: lineFlag,
  pycharm: lineFlag,
  phpstorm: lineFlag,
  goland: lineFlag,
  rubymine: lineFlag,
  clion: lineFlag,
  rider: lineFlag,
  fleet: lineFlag,
  mate: (file, line) => ['-l', String(line), file],
};

/** The command an editor setting names: `code --wait` is `code`. */
const commandOf = (editor: string) => editor.trim().split(/\s+/)[0] ?? '';

/** An editor's command name as the table has it: `/usr/local/bin/Code.exe` is `code`. */
function editorName(editor: string): string {
  return basename(commandOf(editor)).toLowerCase().replace(/\.(exe|cmd|sh)$/, '');
}

/**
 * The editor the studio starts: the one the command named, else the first of the environment's
 * that opens in a window, else VS Code. A terminal editor in `$EDITOR` is passed over, since the
 * studio has no terminal to run it in.
 */
export function chosenEditor(flag: string | undefined, environment: readonly (string | undefined)[]): string {
  if (flag?.trim()) return flag;
  return environment.find((editor) => editor !== undefined && editorName(editor) in EDITORS) ?? 'code';
}

/** The command that opens `file` at `line` in an editor, or undefined when the studio does not know the editor. */
export function editorCommand(
  editor: string,
  file: string,
  line: number | undefined,
): { command: string; args: string[] } | undefined {
  const form = EDITORS[editorName(editor)];
  if (!form) return undefined;
  return { command: commandOf(editor), args: line === undefined ? [file] : form(file, line) };
}

/** What opening needs from the machine. */
export interface EditorHost {
  /** The editor's command, as the builder set it. */
  editor: string;
  /** The absolute path of a project file named from the project's folder, or undefined when the project has none there. */
  place(file: string): string | undefined;
  /** Starts a command without a shell. False when it did not start. */
  start(command: string, args: string[]): boolean;
}

function isOpenRequest(body: unknown): body is OpenRequest {
  const { file, line } = (body ?? {}) as Partial<OpenRequest>;
  return typeof file === 'string' && (line === undefined || (Number.isInteger(line) && line > 0));
}

/** Opens the file a request names. The answer says which editor, or why not and the place to go to by hand. */
export function openInEditor(host: EditorHost, request: OpenRequest): OpenAnswer {
  const path = host.place(request.file);
  if (path === undefined) return { ok: false, reason: 'file' };
  const editor = editorName(host.editor);
  const place = request.line === undefined ? path : `${path}:${request.line}`;
  const run = editorCommand(host.editor, path, request.line);
  if (!run) return { ok: false, reason: 'editor', editor, place };
  return host.start(run.command, run.args) ? { ok: true, editor } : { ok: false, reason: 'failed', editor, place };
}

/**
 * What the studio answers a request to open a file with, as a status and a body. Undefined when
 * the request is not one.
 */
export async function answerOpen(
  host: EditorHost,
  at: string,
  request: Request,
): Promise<{ status: number; body: unknown } | undefined> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== at) return undefined;
  const body: unknown = await request.json().catch(() => null);
  return isOpenRequest(body) ? { status: 200, body: openInEditor(host, body) } : { status: 400, body: {} };
}
