import assert from 'node:assert/strict';
import test from 'node:test';
import { notesProblems, SECTIONS } from './release-notes.mjs';

const notes = (sections, body) =>
  ['# v1.2.3', '', ...sections.flatMap((section) => [`## ${section}`, '', body(section), ''])].join(
    '\n',
  );
const keeps = (body) => notes(SECTIONS, body);

test('notes with the five sections in order, each said or None., keep the pattern', () => {
  assert.deepEqual(
    notesProblems(
      keeps((s) => (s === 'Breaking Changes' ? 'None.' : `- ${s} item.`)),
      '1.2.3',
    ),
    [],
  );
});

test('a missing, extra or reordered section breaks it', () => {
  const none = () => 'None.';
  const missing = SECTIONS.filter((section) => section !== "What's Fixed");
  assert.equal(notesProblems(notes(missing, none), '1.2.3').length, 1);
  assert.equal(notesProblems(notes([...SECTIONS, 'Thanks'], none), '1.2.3').length, 1);
  assert.equal(notesProblems(notes([...SECTIONS].reverse(), none), '1.2.3').length, 1);
});

test('an empty section, a wrong title or a pull request list breaks it', () => {
  assert.match(
    notesProblems(
      keeps((s) => (s === 'Notes' ? '' : 'None.')),
      '1.2.3',
    )[0],
    /"## Notes" is empty/,
  );
  assert.match(
    notesProblems(
      keeps(() => 'None.'),
      '1.2.4',
    )[0],
    /first line/,
  );
  const listed = keeps(() => '- https://github.com/masudl-hub/theoremai/pull/27');
  assert.match(notesProblems(listed, '1.2.3')[0], /pull requests/);
});
