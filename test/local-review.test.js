'use strict';
// Self-review before a PR: each mode yields an immutable (base, head) pair in
// its own worktree and leaves the user's branch, index and files untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, makeRepo } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-local-runs-');
process.env.ARW_WT_DIR = tmpDir('arw-local-wt-');

const { prepareLocal, localRunId } = require('../src/lib/local-review');
const { publish } = require('../src/lib/publish');

function userState(dir) {
  return { head: sh(dir, ['rev-parse', 'HEAD']), status: sh(dir, ['status', '--porcelain']), stash: sh(dir, ['stash', 'list']), branches: sh(dir, ['branch', '--list']) };
}

function changedFiles(dir, base, head) {
  return sh(dir, ['diff', '--name-only', base, head]).split('\n').filter(Boolean).sort();
}

test('branch mode: commits since the merge-base with the base branch', () => {
  const repo = makeRepo();
  sh(repo.dir, ['checkout', '-q', '-b', 'feature', repo.base]);
  write(repo.dir, 'billing/fees.py', 'def late_fee(days):\n    return days * 2\n');
  sh(repo.dir, ['commit', '-q', '-am', 'ACME-9 flat late fee']);
  const before = userState(repo.dir);
  const local = prepareLocal({ dir: repo.dir, base: 'main', mode: 'branch' });
  assert.equal(local.prepared.head, before.head);
  assert.equal(local.prepared.base, repo.base, 'merge-base, not the tip of main');
  assert.deepEqual(changedFiles(repo.dir, local.prepared.base, local.prepared.head), ['billing/fees.py']);
  assert.match(local.prepared.info.body, /ACME-9 flat late fee/);
  assert.equal(local.repo, `local/${path.basename(repo.dir)}`);
  assert.equal(`${local.repo.replace('/', '__')}__${local.pr}`, localRunId({ dir: repo.dir, mode: 'branch' }));
  assert.ok(local.prepared.checkout.startsWith(process.env.ARW_WT_DIR));
  assert.equal(sh(local.prepared.checkout, ['rev-parse', 'HEAD']), before.head);
  assert.deepEqual(userState(repo.dir), before);
  assert.throws(() => prepareLocal({ dir: repo.dir, base: 'nope' }), /base "nope" not found/);
  sh(repo.dir, ['checkout', '-q', 'main']);
  assert.throws(() => prepareLocal({ dir: repo.dir, base: 'main' }), /no commits beyond main/);
});

test('staged mode: a snapshot of the index, leaving index and files as they were', () => {
  const repo = makeRepo();
  assert.throws(() => prepareLocal({ dir: repo.dir, mode: 'staged' }), /nothing is staged/);
  write(repo.dir, 'billing/fees.py', 'def late_fee(days):\n    return days * 3\n');
  sh(repo.dir, ['add', 'billing/fees.py']);
  write(repo.dir, 'src/main/java/com/acme/OrderService.java', 'unstaged edit\n');
  const before = userState(repo.dir);
  const local = prepareLocal({ dir: repo.dir, mode: 'staged' });
  assert.equal(local.prepared.base, repo.head);
  assert.deepEqual(changedFiles(repo.dir, local.prepared.base, local.prepared.head), ['billing/fees.py'], 'unstaged edits are not part of it');
  assert.match(fs.readFileSync(path.join(local.prepared.checkout, 'billing/fees.py'), 'utf8'), /days \* 3/);
  assert.deepEqual(userState(repo.dir), before);
  assert.equal(local.prepared.local.mode, 'staged');
});

test('worktree mode: all tracked edits; untracked files are not included', () => {
  const repo = makeRepo();
  assert.throws(() => prepareLocal({ dir: repo.dir, mode: 'worktree' }), /no tracked changes/);
  write(repo.dir, 'billing/fees.py', 'def late_fee(days):\n    return days * 4\n');
  sh(repo.dir, ['add', 'billing/fees.py']);
  write(repo.dir, 'src/main/java/com/acme/OrderService.java', 'unstaged edit\n');
  write(repo.dir, 'scratch.txt', 'untracked\n');
  const before = userState(repo.dir);
  const local = prepareLocal({ dir: repo.dir, mode: 'worktree' });
  assert.deepEqual(changedFiles(repo.dir, local.prepared.base, local.prepared.head), ['billing/fees.py', 'src/main/java/com/acme/OrderService.java']);
  assert.deepEqual(userState(repo.dir), before, 'no stash entry, index and files untouched');
  // A second run reuses the same run id and replaces the worktree.
  const again = prepareLocal({ dir: repo.dir, mode: 'worktree' });
  assert.equal(again.pr, local.pr);
  assert.notEqual(again.pr, prepareLocal({ dir: repo.dir, mode: 'staged' }).pr, 'modes get separate runs');
});

test('a local review cannot be published to GitHub, only previewed', () => {
  const runDir = tmpDir('arw-local-run-');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ identity: { repo: 'local/shop', pr: 123456, local: { mode: 'staged' } } }));
  let called = false;
  assert.throws(() => publish(runDir, { createPendingReview: () => { called = true; } }), /local review: there is no pull request/);
  assert.equal(called, false);
});
