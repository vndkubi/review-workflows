'use strict';
// Incident (vndkubi/vnstock#1, code-graph#2): a merged PR's head is already in
// the base branch, so merge-base(base branch, head) is the head itself and the
// review saw no changed files. The base is then the parent of the PR's first commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, sh, write } = require('./helpers');
const { prBase } = require('../src/lib/github');

test('a merged PR is reviewed from the parent of its first commit', () => {
  const dir = tmpDir('arw-prbase-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'a.py', 'x = 1\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const start = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['checkout', '-q', '-b', 'pr']);
  write(dir, 'a.py', 'x = 2\n');
  sh(dir, ['commit', '-q', '-am', 'one']);
  const first = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'b.py', 'y = 1\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'two']);
  const head = sh(dir, ['rev-parse', 'HEAD']);

  let asked = 0;
  const firstParent = () => (asked++, start);
  // Open PR: the merge-base, and GitHub is not asked.
  assert.equal(prBase(dir, 'main', head, firstParent), start);
  assert.equal(asked, 0);
  // Merged by fast-forward: the base branch holds the head.
  sh(dir, ['checkout', '-q', 'main']);
  sh(dir, ['merge', '-q', '--ff-only', 'pr']);
  assert.equal(prBase(dir, 'main', head, firstParent), start);
  assert.equal(asked, 1);
  // A parent that is not behind the head is refused, not trusted.
  assert.throws(() => prBase(dir, 'main', head, () => head), /cannot tell the base of the merged PR/);
  assert.throws(() => prBase(dir, 'main', first, () => null), /cannot tell the base of the merged PR/);
});
