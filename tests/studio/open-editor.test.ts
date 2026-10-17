import { assertEquals } from '@std/assert';
import { editorLabel, STUDIO_EDITORS, studioEditor } from '../../studio/editors.ts';
import {
  answerOpen,
  chosenEditor,
  defaultEditor,
  defaultOpener,
  type EditorHost,
  editorCommand,
  installedCommands,
  openInEditor,
} from '../../studio/server/open-editor.ts';

Deno.test('the editor is the one the command names, else one of the environment that opens a window, else VS Code', () => {
  assertEquals(chosenEditor('cursor', ['zed']), 'cursor');
  assertEquals(chosenEditor('', ['vim', 'zed --wait']), 'zed --wait');
  assertEquals(chosenEditor(undefined, [undefined, 'nvim']), 'code');
  assertEquals(chosenEditor('  ', []), 'code');
});

Deno.test('each editor is started on the line the way its own command takes one', () => {
  const at = (editor: string) => editorCommand(editor, '/p/inputs.ts', 14);
  assertEquals(at('code --wait'), { command: 'code', args: ['-g', '/p/inputs.ts:14'] });
  assertEquals(at('/usr/local/bin/Cursor'), {
    command: '/usr/local/bin/Cursor',
    args: ['-g', '/p/inputs.ts:14'],
  });
  assertEquals(at('zed')?.args, ['/p/inputs.ts:14']);
  assertEquals(at('webstorm.cmd')?.args, ['--line', '14', '/p/inputs.ts']);
  assertEquals(at('mate')?.args, ['-l', '14', '/p/inputs.ts']);
  assertEquals(editorCommand('code', '/p/inputs.ts', undefined)?.args, ['/p/inputs.ts']);
  assertEquals([at('vim'), at('')], [undefined, undefined]);
});

/** A machine whose project holds `inputs.ts`, and what it was asked to start. */
function machine(over: Partial<EditorHost> = {}) {
  const started: string[][] = [];
  const host: EditorHost = {
    editor: 'code',
    place: (file) => (file === 'inputs.ts' ? '/p/inputs.ts' : undefined),
    start: (command, args) => started.push([command, ...args]) > 0,
    ...over,
  };
  return { host, started };
}

Deno.test('Open starts the editor on a project file, and says where to go when it cannot', () => {
  const { host, started } = machine();
  assertEquals(openInEditor(host, { file: 'inputs.ts', line: 14 }), { ok: true, editor: 'code' });
  assertEquals(started, [['code', '-g', '/p/inputs.ts:14']]);

  // A file the project's setup does not read is never opened.
  assertEquals(openInEditor(host, { file: '../.env', line: 1 }), { ok: false, reason: 'file' });
  assertEquals(started.length, 1);

  assertEquals(openInEditor(machine({ editor: 'vim' }).host, { file: 'inputs.ts', line: 14 }), {
    ok: false,
    reason: 'editor',
    editor: 'vim',
    place: '/p/inputs.ts:14',
  });
  assertEquals(openInEditor(machine({ start: () => false }).host, { file: 'inputs.ts' }), {
    ok: false,
    reason: 'failed',
    editor: 'code',
    place: '/p/inputs.ts',
  });
});

Deno.test('Open answers its own address, and refuses a body that is not a file and a line', async () => {
  const { host, started } = machine();
  const at = (path: string, method: string, body?: unknown) =>
    answerOpen(
      host,
      '/api/studio/open',
      new Request(`http://127.0.0.1:4983${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  assertEquals(await at('/api/studio/open', 'GET'), undefined);
  assertEquals(await at('/api/studio/save', 'POST', { file: 'inputs.ts' }), undefined);
  for (const body of [
    undefined,
    {},
    { file: 1 },
    { file: 'inputs.ts', line: 0 },
    { file: 'inputs.ts', line: '3' },
  ]) {
    assertEquals(await at('/api/studio/open', 'POST', body), { status: 400, body: {} });
  }
  assertEquals(started, []);
  assertEquals(await at('/api/studio/open', 'POST', { file: 'inputs.ts', line: 3 }), {
    status: 200,
    body: { ok: true, editor: 'code' },
  });
});

Deno.test('the page names the editor only by a command Settings offers', async () => {
  const { host, started } = machine({ editor: '/usr/local/bin/Code --wait' });
  assertEquals(defaultEditor(host), 'code');
  assertEquals(openInEditor(host, { file: 'inputs.ts', line: 14, editor: 'cursor' }), {
    ok: true,
    editor: 'cursor',
  });
  assertEquals(started, [['cursor', '-g', '/p/inputs.ts:14']]);

  const post = (body: unknown) =>
    answerOpen(
      host,
      '/api/studio/open',
      new Request('http://127.0.0.1:4983/api/studio/open', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  // A path, a command with arguments, a name the studio does not list, or an object's own members: none is started.
  for (const editor of [
    '/tmp/code',
    'code --wait',
    'Code',
    'vim',
    'sh',
    'constructor',
    '__proto__',
    '',
    3,
  ]) {
    assertEquals(await post({ file: 'inputs.ts', editor }), { status: 400, body: {} });
  }
  assertEquals(started.length, 1);
  assertEquals(await post({ file: 'inputs.ts', line: 2, editor: 'cursor' }), {
    status: 200,
    body: { ok: true, editor: 'cursor' },
  });
  assertEquals(started[1], ['cursor', '-g', '/p/inputs.ts:2']);
});

Deno.test('each listed editor has one command and a name, and Settings offers two of them', () => {
  const commands = STUDIO_EDITORS.map((editor) => editor.command);
  assertEquals(new Set(commands).size, commands.length);
  assertEquals(
    STUDIO_EDITORS.filter((editor) => editor.choice).map((editor) => editor.label),
    ['VS Code', 'Cursor'],
  );
  for (const editor of STUDIO_EDITORS) {
    assertEquals(editorCommand(editor.command, '/p/a.ts', 1)?.command, editor.command);
  }
  assertEquals([editorLabel('subl'), editorLabel('vim')], ['Sublime Text', 'vim']);
  assertEquals([studioEditor('constructor'), studioEditor('toString')], [undefined, undefined]);
});

Deno.test("when the editor does not start, the machine's default editor opens the file", () => {
  assertEquals(defaultOpener('darwin', '/p/inputs.ts'), {
    command: 'open',
    args: ['-t', '/p/inputs.ts'],
  });
  assertEquals(defaultOpener('linux', '/p/inputs.ts'), {
    command: 'xdg-open',
    args: ['/p/inputs.ts'],
  });
  // Windows runs a script by default, so nothing is started there.
  assertEquals(defaultOpener('windows', '/p/inputs.ts'), undefined);

  // `code` is not on this machine; `open` is.
  const started: string[][] = [];
  const start = (command: string, args: string[]) =>
    started.push([command, ...args]) > 0 && command === 'open';
  const missing = machine({ os: 'darwin', start });
  assertEquals(openInEditor(missing.host, { file: 'inputs.ts', line: 14 }), {
    ok: true,
    editor: 'code',
    byDefault: true,
  });
  assertEquals(started, [
    ['code', '-g', '/p/inputs.ts:14'],
    [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '-g',
      '/p/inputs.ts:14',
    ],
    ['open', '-t', '/p/inputs.ts'],
  ]);

  // VS Code is installed, but its command is not on the path: the app's own command is started.
  const inApp: string[][] = [];
  const installed = machine({
    os: 'darwin',
    home: '/Users/b',
    start: (command, args) => inApp.push([command, ...args]) > 0 && command.startsWith('/Users/b/'),
  });
  assertEquals(openInEditor(installed.host, { file: 'inputs.ts', line: 14 }), {
    ok: true,
    editor: 'code',
  });
  assertEquals(
    inApp.map(([command]) => command),
    [
      'code',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Users/b/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    ],
  );
  assertEquals(installedCommands('zed', 'darwin', '/Users/b'), []);
  assertEquals(installedCommands('code', 'linux', '/home/b'), []);
  // An editor the studio cannot start on a line goes the same way.
  assertEquals(
    openInEditor(machine({ os: 'darwin', editor: 'vim' }).host, { file: 'inputs.ts' }).ok,
    true,
  );
  // Still only a file the project's setup reads.
  assertEquals(openInEditor(missing.host, { file: '../.env' }), { ok: false, reason: 'file' });
  // Where there is no default, the answer is as before.
  assertEquals(
    openInEditor(machine({ os: 'windows', start: () => false }).host, { file: 'inputs.ts' }),
    {
      ok: false,
      reason: 'failed',
      editor: 'code',
      place: '/p/inputs.ts',
    },
  );
});
