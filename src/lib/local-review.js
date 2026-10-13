'use strict';
// Self-review before a PR exists. The review needs an immutable commit, so:
//   branch:   HEAD of the current branch vs its merge-base with --base
//   staged:   a snapshot commit of the index (git write-tree + commit-tree)
//   worktree: a snapshot of tracked changes (git stash create)
// Snapshot commits are dangling: no branch, stash or working file of the
// repository changes. The review runs in its own worktree at that commit.
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./util');
const { worktreeRoot } = require('./runs');
const git = require('./git');

const MODES = ['branch', 'staged', 'worktree'];

// A stable run number per (repository, branch, mode) so re-runs refresh the
// same run instead of piling up new ones.
function runNumber(key) {
  return (parseInt(sha256(key).slice(0, 8), 16) % 900000) + 100000;
}

function snapshotCommit(dir, mode, head) {
  const env = ['-c', 'user.name=arw', '-c', 'user.email=arw@localhost'];
  if (mode === 'staged') {
    const tree = git.git(dir, ['write-tree']).trim();
    if (tree === git.git(dir, ['rev-parse', `${head}^{tree}`]).trim()) throw new Error('nothing is staged');
    return git.git(dir, [...env, 'commit-tree', tree, '-p', head, '-m', 'arw: staged snapshot for review']).trim();
  }
  const stash = git.git(dir, [...env, 'stash', 'create', 'arw: working tree snapshot for review']).trim();
  if (!stash) throw new Error('no tracked changes in the working tree (untracked files are not included)');
  // A stash commit has the index as its second parent; review its tree as a
  // plain commit on top of HEAD.
  const tree = git.git(dir, ['rev-parse', `${stash}^{tree}`]).trim();
  return git.git(dir, [...env, 'commit-tree', tree, '-p', head, '-m', 'arw: working tree snapshot for review']).trim();
}

// Returns { repo, pr, prepared } for reviewPr.
// `head` (a commit) reviews merge-base(base, head)..head instead of the
// working copy: the "range" mode evals use to replay a known change.
function prepareLocal({ dir, base = 'main', mode = 'branch', head: headRev = null }) {
  if (headRev) mode = 'range';
  else if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const repoDir = path.resolve(dir);
  if (!fs.existsSync(repoDir) || !git.git(repoDir, ['rev-parse', '--git-dir'], { allowFail: true })) throw new Error(`${repoDir} is not a git repository`);
  const top = git.git(repoDir, ['rev-parse', '--show-toplevel']).trim();
  const branch = (git.git(top, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || 'HEAD').trim();
  const headCommit = git.revParse(top, 'HEAD');
  const baseRef = git.git(top, ['rev-parse', '--verify', '--quiet', base], { allowFail: true }) ? base : git.git(top, ['rev-parse', '--verify', '--quiet', `origin/${base}`], { allowFail: true }) ? `origin/${base}` : null;
  if (!baseRef) throw new Error(`base "${base}" not found (tried ${base} and origin/${base})`);

  let head;
  let baseSha;
  if (mode === 'range') {
    head = git.revParse(top, headRev);
    baseSha = git.mergeBase(top, baseRef, head);
    if (baseSha === head) throw new Error(`${headRev} has no commits beyond ${baseRef}`);
  } else if (mode === 'branch') {
    head = headCommit;
    baseSha = git.mergeBase(top, baseRef, head);
    if (baseSha === head) throw new Error(`${branch} has no commits beyond ${baseRef}`);
  } else {
    head = snapshotCommit(top, mode, headCommit);
    baseSha = headCommit;
  }

  const name = path.basename(top).replace(/[^A-Za-z0-9._-]/g, '_');
  const repo = `local/${name}`;
  const pr = runNumber(mode === 'range' ? `${top}\0${head}\0range` : `${top}\0${branch}\0${mode}`);
  const wt = path.join(worktreeRoot(), `local__${name}__${pr}`);
  if (fs.existsSync(wt)) {
    git.git(top, ['worktree', 'remove', '--force', wt], { allowFail: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
  git.git(top, ['worktree', 'prune'], { allowFail: true });
  git.git(top, ['worktree', 'add', '--detach', wt, head]);

  const log = git.git(top, ['log', '--format=- %s%n%b', `${baseSha}..${mode === 'range' ? head : headCommit}`], { allowFail: true }) || '';
  const title = mode === 'range'
    ? `${(git.git(top, ['log', '-1', '--format=%s', head], { allowFail: true }) || headRev).trim()} (${head.slice(0, 12)} vs ${baseRef})`
    : mode === 'branch' ? `${branch} (local branch vs ${baseRef})` : `${branch} (${mode} changes)`;
  return {
    repo,
    pr,
    prepared: {
      info: { title, body: log.trim().slice(0, 8000), headRefName: branch, baseRefName: baseRef, url: null },
      checkout: wt,
      source: top,
      head,
      base: baseSha,
      local: { mode, branch, base: baseRef, dir: top },
    },
  };
}

// The run id a local review will use, without creating anything.
function localRunId({ dir, mode = 'branch' }) {
  const top = git.git(path.resolve(dir), ['rev-parse', '--show-toplevel']).trim();
  const branch = (git.git(top, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || 'HEAD').trim();
  const name = path.basename(top).replace(/[^A-Za-z0-9._-]/g, '_');
  return `local__${name}__${runNumber(`${top}\0${branch}\0${mode}`)}`;
}

module.exports = { prepareLocal, localRunId, runNumber, MODES };
