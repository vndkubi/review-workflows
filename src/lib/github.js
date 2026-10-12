'use strict';
// GitHub via the authenticated gh CLI, and per-PR git worktrees.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJsonIfExists } = require('./util');
const { git, revParse, mergeBase } = require('./git');

function gh(args, input) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${err.stderr ? String(err.stderr).trim() : err.message}`);
  }
}

function prView(repo, pr) {
  const fields = 'number,title,body,url,headRefName,baseRefName,headRefOid,baseRefOid,author,isDraft,state';
  return JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', fields]));
}

function reposConfig() {
  const file = process.env.ARW_REPOS_FILE ? path.resolve(process.env.ARW_REPOS_FILE) : path.join(ROOT, 'config', 'repos.json');
  return readJsonIfExists(file, { repos: {} });
}

// Local clone used to create worktrees for `repo` ("owner/name").
function sourceCheckoutFor(repo) {
  const entry = reposConfig().repos[repo];
  if (!entry || !entry.checkout) throw new Error(`no local checkout for ${repo}: add it to config/repos.json`);
  if (!fs.existsSync(entry.checkout)) throw new Error(`checkout ${entry.checkout} for ${repo} does not exist`);
  return { checkout: entry.checkout, remote: entry.remote || 'origin', test_command: entry.test_command || null };
}

// Detached worktree at the PR head; the base is the merge-base with the
// target branch, so the diff is exactly what the PR adds.
function preparePrWorktree({ repo, pr, info, worktree }) {
  const { checkout, remote } = sourceCheckoutFor(repo);
  git(checkout, ['fetch', '--no-tags', remote, `+refs/pull/${pr}/head:refs/arw/pr-${pr}`, `+refs/heads/${info.baseRefName}:refs/arw/base-${pr}`]);
  const head = revParse(checkout, `refs/arw/pr-${pr}`);
  if (head !== info.headRefOid) throw new Error(`fetched head ${head} != PR head ${info.headRefOid}; the PR moved, retry`);
  const base = mergeBase(checkout, `refs/arw/base-${pr}`, head);
  if (fs.existsSync(worktree)) {
    const current = git(worktree, ['rev-parse', 'HEAD'], { allowFail: true });
    if (current && current.trim() === head && git(worktree, ['status', '--porcelain']).trim() === '') return { checkout: worktree, head, base, source: checkout };
    git(checkout, ['worktree', 'remove', '--force', worktree], { allowFail: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  git(checkout, ['worktree', 'prune']);
  git(checkout, ['worktree', 'add', '--detach', worktree, head]);
  return { checkout: worktree, head, base, source: checkout };
}

function removeWorktree(source, worktree) {
  git(source, ['worktree', 'remove', '--force', worktree], { allowFail: true });
  git(source, ['worktree', 'prune'], { allowFail: true });
}

function apiGet(apiPath) {
  return JSON.parse(gh(['api', apiPath]));
}

function currentLogin() {
  return JSON.parse(gh(['api', 'user'])).login;
}

// Pending review = visible only to its author until they submit it on GitHub
// with their own verdict. Any older pending review by the same user is
// deleted first (GitHub allows one per user per PR).
function createPendingReview({ repo, pr, commitId, body, comments }) {
  const me = currentLogin();
  const reviews = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=100`]));
  for (const r of reviews) {
    if (r.state === 'PENDING' && r.user && r.user.login === me) gh(['api', '--method', 'DELETE', `repos/${repo}/pulls/${pr}/reviews/${r.id}`]);
  }
  const payload = { commit_id: commitId, body, comments };
  return JSON.parse(gh(['api', '--method', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'], JSON.stringify(payload)));
}

module.exports = { gh, prView, reposConfig, sourceCheckoutFor, preparePrWorktree, removeWorktree, createPendingReview, currentLogin, apiGet };
