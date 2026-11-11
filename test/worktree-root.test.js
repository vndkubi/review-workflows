'use strict';
// Incident (11 Nov 2026, vndkubi/ecommerce-jhipter#1): ARW_WT_DIR was given as
// a relative path (wt/refactor-luna). ARW_RUNS_DIR is resolved, ARW_WT_DIR was
// not, and the PR worktree is added by git running in the SOURCE repository:
// it was created inside that repository (<source>/wt/refactor-luna/...), and
// the review stopped at the first diff with "spawnSync git ENOENT".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-wtroot-runs-');
const { worktreeRoot, worktreeDir } = require('../src/lib/runs');

test('a relative ARW_WT_DIR names a directory under the current one, never under the reviewed repository', () => {
  const saved = process.env.ARW_WT_DIR;
  try {
    process.env.ARW_WT_DIR = 'wt/refactor-luna';
    assert.equal(worktreeRoot(), path.resolve('wt/refactor-luna'));
    assert.ok(path.isAbsolute(worktreeDir('vndkubi/ecommerce-jhipter', 1)));
    assert.equal(worktreeDir('vndkubi/ecommerce-jhipter', 1), path.join(path.resolve('wt/refactor-luna'), 'vndkubi__ecommerce-jhipter__1'));
    const abs = tmpDir('arw-wtroot-');
    process.env.ARW_WT_DIR = abs;
    assert.equal(worktreeRoot(), path.resolve(abs));
  } finally {
    if (saved === undefined) delete process.env.ARW_WT_DIR;
    else process.env.ARW_WT_DIR = saved;
  }
});
