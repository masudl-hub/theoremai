/**
 * The editors the studio can start on a line of a file: the ones that open in a window of their
 * own. One that runs in a terminal is not here, since the studio has no terminal to run it in.
 *
 * @module
 */

/** How an editor's command takes a file and a line: `-g file:line`, `file:line`, `--line n file` or `-l n file`. */
export type EditorLineForm = 'goto' | 'colon' | 'line-flag' | 'l-flag';

/** An editor the studio can start, by the command that starts it. */
export interface StudioEditor {
  command: string;
  /** The editor's name, as the builder reads it. */
  label: string;
  form: EditorLineForm;
  /** One of the few the settings list first. */
  common?: true;
}

export const STUDIO_EDITORS: readonly StudioEditor[] = [
  { command: 'code', label: 'VS Code', form: 'goto', common: true },
  { command: 'cursor', label: 'Cursor', form: 'goto', common: true },
  { command: 'zed', label: 'Zed', form: 'colon', common: true },
  { command: 'windsurf', label: 'Windsurf', form: 'goto', common: true },
  { command: 'webstorm', label: 'WebStorm', form: 'line-flag', common: true },
  { command: 'subl', label: 'Sublime Text', form: 'colon', common: true },
  { command: 'code-insiders', label: 'VS Code Insiders', form: 'goto' },
  { command: 'codium', label: 'VSCodium', form: 'goto' },
  { command: 'positron', label: 'Positron', form: 'goto' },
  { command: 'zeditor', label: 'Zed (zeditor)', form: 'colon' },
  { command: 'idea', label: 'IntelliJ IDEA', form: 'line-flag' },
  { command: 'pycharm', label: 'PyCharm', form: 'line-flag' },
  { command: 'phpstorm', label: 'PhpStorm', form: 'line-flag' },
  { command: 'goland', label: 'GoLand', form: 'line-flag' },
  { command: 'rubymine', label: 'RubyMine', form: 'line-flag' },
  { command: 'clion', label: 'CLion', form: 'line-flag' },
  { command: 'rider', label: 'Rider', form: 'line-flag' },
  { command: 'fleet', label: 'Fleet', form: 'line-flag' },
  { command: 'mate', label: 'TextMate', form: 'l-flag' },
];

/** The editor a command names, or undefined when the studio cannot start it on a line. */
export function studioEditor(command: string): StudioEditor | undefined {
  return STUDIO_EDITORS.find((editor) => editor.command === command);
}

/** An editor's name as the builder reads it: `code` is VS Code. One the studio does not know keeps its command. */
export function editorLabel(command: string): string {
  return studioEditor(command)?.label ?? command;
}
