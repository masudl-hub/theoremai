/**
 * Opens one of the project's files in the builder's editor, on a line. The
 * studio starts the editor's own command and never a shell, and only for a
 * file the project's setup reads.
 *
 * @module
 */

import { basename } from 'node:path';
import { type EditorLineForm, studioEditor } from '../editors.ts';
import type { OpenAnswer, OpenRequest } from './save-wire.ts';

/** The arguments each form of command takes for a file and a line. */
const LINE_ARGS: Record<EditorLineForm, (file: string, line: number) => string[]> = {
  goto: (file, line) => ['-g', `${file}:${line}`],
  colon: (file, line) => [`${file}:${line}`],
  'line-flag': (file, line) => ['--line', String(line), file],
  'l-flag': (file, line) => ['-l', String(line), file],
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
  return environment.find((editor) => editor !== undefined && studioEditor(editorName(editor))) ?? 'code';
}

/** The command that opens `file` at `line` in an editor, or undefined when the studio does not know the editor. */
export function editorCommand(
  editor: string,
  file: string,
  line: number | undefined,
): { command: string; args: string[] } | undefined {
  const known = studioEditor(editorName(editor));
  if (!known) return undefined;
  return { command: commandOf(editor), args: line === undefined ? [file] : LINE_ARGS[known.form](file, line) };
}

/**
 * The machine's own way to open a file in its default editor, or undefined where it has none that
 * is safe: macOS opens it as text and Linux asks the desktop. Windows is left out, since its
 * default for a script is to run it.
 */
export function defaultOpener(os: string, file: string): { command: string; args: string[] } | undefined {
  if (os === 'darwin') return { command: 'open', args: ['-t', file] };
  if (os === 'linux') return { command: 'xdg-open', args: [file] };
  return undefined;
}

/** What opening needs from the machine. */
export interface EditorHost {
  /** The editor's command, as the builder set it when the studio started. */
  editor: string;
  /** The absolute path of a project file named from the project's folder, or undefined when the project has none there. */
  place(file: string): string | undefined;
  /** Starts a command without a shell. False when it did not start. */
  start(command: string, args: string[]): boolean;
  /** The machine's kind, as `defaultOpener` takes it; without one there is no default to fall back on. */
  os?: string;
}

/**
 * A page may name the editor only by a command the studio lists, exactly: never a path or a
 * command of its own, since the studio starts what is named.
 */
function isOpenRequest(body: unknown): body is OpenRequest {
  const { file, line, editor } = (body ?? {}) as Partial<OpenRequest>;
  if (editor !== undefined && (typeof editor !== 'string' || !studioEditor(editor))) return false;
  return typeof file === 'string' && (line === undefined || (Number.isInteger(line) && line > 0));
}

/** The editor the studio starts when the page names none, by the command the studio lists it under. */
export function defaultEditor(host: EditorHost): string {
  return editorName(host.editor);
}

/**
 * Opens the file a request names, in the editor it names or else the one the studio started with.
 * The answer says which editor, or why not and the place to go to by hand. When the editor is not
 * one the studio can start, or did not start, the machine's default editor opens the file instead.
 */
export function openInEditor(host: EditorHost, request: OpenRequest): OpenAnswer {
  const path = host.place(request.file);
  if (path === undefined) return { ok: false, reason: 'file' };
  // Only a command the studio lists is taken from the page; `answerOpen` refuses any other.
  const named = request.editor !== undefined && studioEditor(request.editor) ? request.editor : host.editor;
  const editor = editorName(named);
  const place = request.line === undefined ? path : `${path}:${request.line}`;
  const run = editorCommand(named, path, request.line);
  if (run && host.start(run.command, run.args)) return { ok: true, editor };
  const other = host.os === undefined ? undefined : defaultOpener(host.os, path);
  if (other && host.start(other.command, other.args)) return { ok: true, editor, byDefault: true };
  return { ok: false, reason: run ? 'failed' : 'editor', editor, place };
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
