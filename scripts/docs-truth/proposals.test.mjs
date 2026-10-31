import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalProblems, proposalStatus } from './proposals.mjs';

const doc = (status) => `# A proposal\n\n**Status:** ${status}. What that means here.\n`;
const file = 'docs/proposals/a.md';

test('the third line declares one of the four statuses', () => {
  assert.deepEqual(proposalStatus(doc('building')), { status: 'building' });
  assert.ok(proposalStatus(doc('sketch')).problem);
  assert.ok(proposalStatus('# A proposal\n\nStatus: built.\n').problem);
  assert.ok(proposalStatus('# A proposal\n\nSome text.\n\n**Status:** built. Late.\n').problem);
});

test('a realized proposal cannot say nothing is built', () => {
  const problems = proposalProblems({ [file]: doc('proposal') }, { kernel: { realizes: [file] } });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /realizes it/);
});

test('a building or built proposal names the entry that says what shipped', () => {
  assert.equal(proposalProblems({ [file]: doc('built') }, {}).length, 1);
  assert.equal(proposalProblems({ [file]: doc('building') }, {}).length, 1);
  assert.deepEqual(
    proposalProblems({ [file]: doc('built') }, { kernel: { realizes: [file] } }),
    [],
  );
});

test('a proposal or a historical record stands alone, and realizes names only proposals', () => {
  assert.deepEqual(proposalProblems({ [file]: doc('proposal') }, {}), []);
  assert.deepEqual(proposalProblems({ [file]: doc('historical') }, {}), []);
  assert.equal(
    proposalProblems({}, { kernel: { realizes: ['docs/proposals/missing.md'] } }).length,
    1,
  );
});
