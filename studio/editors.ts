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
  /** One the builder can choose in Settings. The others are started only when the studio command or the environment names them. */
  choice?: true;
  /**
   * Where the macOS app keeps its command, from an Applications folder. The app is often installed
   * without its command on the path, and the studio starts it from here then.
   */
  macCommand?: string;
}

export const STUDIO_EDITORS: readonly StudioEditor[] = [
  {
    command: 'code',
    label: 'VS Code',
    form: 'goto',
    choice: true,
    macCommand: 'Visual Studio Code.app/Contents/Resources/app/bin/code',
  },
  {
    command: 'cursor',
    label: 'Cursor',
    form: 'goto',
    choice: true,
    macCommand: 'Cursor.app/Contents/Resources/app/bin/cursor',
  },
  { command: 'zed', label: 'Zed', form: 'colon' },
  { command: 'windsurf', label: 'Windsurf', form: 'goto' },
  { command: 'webstorm', label: 'WebStorm', form: 'line-flag' },
  { command: 'subl', label: 'Sublime Text', form: 'colon' },
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

/** Whether a command is one the builder can choose in Settings, so one a page may name. */
export function isEditorChoice(command: string): boolean {
  return studioEditor(command)?.choice === true;
}

/** An editor's name as the builder reads it: `code` is VS Code. One the studio does not know keeps its command. */
export function editorLabel(command: string): string {
  return studioEditor(command)?.label ?? command;
}
