import { assertEquals } from '@std/assert';
import { PREF_DEFAULTS, type PrefStorage, readPref, writePref } from '../ui/lib/studio-prefs.ts';

/** A browser's storage, as far as preferences use it. */
function storage(held: Record<string, string> = {}): PrefStorage & { held: Record<string, string> } {
  return {
    held,
    getItem: (key) => held[key] ?? null,
    setItem: (key, value) => {
      held[key] = value;
    },
    removeItem: (key) => {
      delete held[key];
    },
  };
}

Deno.test('a preference the builder never set, or a browser that keeps nothing, reads as the default', () => {
  assertEquals(PREF_DEFAULTS, {
    editor: '',
    watch: 'on',
    filesToast: 'on',
    askShared: 'always',
    askWrites: 'always',
  });
  for (const from of [storage(), null]) {
    assertEquals(
      [readPref(from, 'editor'), readPref(from, 'watch'), readPref(from, 'askShared'), readPref(from, 'askWrites')],
      ['', 'on', 'always', 'always'],
    );
  }
  const blocked: PrefStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assertEquals(readPref(blocked, 'filesToast'), 'on');
  writePref(blocked, 'filesToast', 'off');
});

Deno.test('a choice is kept under its own key, and the default is kept as nothing', () => {
  const kept = storage();
  writePref(kept, 'editor', 'cursor');
  writePref(kept, 'watch', 'off');
  writePref(kept, 'filesToast', 'off');
  writePref(kept, 'askShared', 'never');
  writePref(kept, 'askWrites', 'destructive');
  assertEquals(kept.held, {
    'theorem.studio.editor': 'cursor',
    'theorem.studio.watch': 'off',
    'theorem.studio.files-toast': 'off',
    'theorem.studio.ask-shared': 'never',
    'theorem.studio.ask-writes': 'destructive',
  });
  assertEquals(
    [readPref(kept, 'editor'), readPref(kept, 'watch'), readPref(kept, 'askWrites')],
    ['cursor', 'off', 'destructive'],
  );
  writePref(kept, 'editor', '');
  writePref(kept, 'watch', 'on');
  writePref(kept, 'filesToast', 'on');
  writePref(kept, 'askShared', 'always');
  writePref(kept, 'askWrites', 'always');
  assertEquals(kept.held, {});
});

Deno.test('a kept text the studio does not know reads as the default, and is never written', () => {
  const kept = storage({
    'theorem.studio.editor': '/tmp/code',
    'theorem.studio.watch': 'sometimes',
    'theorem.studio.ask-writes': 'never',
  });
  assertEquals(
    [readPref(kept, 'editor'), readPref(kept, 'watch'), readPref(kept, 'askWrites')],
    ['', 'on', 'always'],
  );
  // An editor the studio does not list is not kept: the page sends only a listed command.
  writePref(kept, 'editor', 'vim');
  assertEquals(kept.held['theorem.studio.editor'], undefined);
});
