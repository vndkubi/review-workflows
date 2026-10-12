'use strict';
// Read-only git helpers. Prompts are disabled so a missing credential fails
// fast instead of hanging an unattended run.
const { execFileSync } = require('node:child_process');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
const MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd, args, { allowFail = false, input } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    if (allowFail) return null;
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

function revParse(cwd, rev) {
  return git(cwd, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
}

function mergeBase(cwd, a, b) {
  return git(cwd, ['merge-base', a, b]).trim();
}

// Uncommitted tracked changes or untracked files make a checkout unreviewable:
// the review must read exactly the frozen commit.
function isClean(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=normal']).trim() === '';
}

// [{ status: 'M'|'A'|'D'|'R', path, old_path? }]
function changedFiles(cwd, base, head) {
  const out = git(cwd, ['diff', '--name-status', '-M', '-z', base, head]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++];
      files.push({ status: status[0], path: parts[i++], old_path: oldPath });
    } else {
      files.push({ status: status[0], path: parts[i++] });
    }
  }
  return files;
}

function diffPatch(cwd, base, head) {
  return git(cwd, ['diff', '-M', '--no-color', '--no-ext-diff', base, head]);
}

const blobCache = new Map();
// Content of <rev>:<path>, or null when the path does not exist at rev.
function showFile(cwd, rev, file) {
  const key = `${cwd}\0${rev}\0${file}`;
  if (!blobCache.has(key)) {
    blobCache.set(key, git(cwd, ['show', `${rev}:${file}`], { allowFail: true }));
  }
  return blobCache.get(key);
}

// Files at `rev` containing `word` as a whole word, capped. Returns
// { files, truncated }.
function grepFiles(cwd, rev, word, pathspecs, cap) {
  const out = git(cwd, ['grep', '-l', '-w', '-F', '-e', word, rev, '--', ...pathspecs], { allowFail: true });
  if (!out) return { files: [], truncated: false };
  const files = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(rev.length + 1));
  return { files: files.slice(0, cap), truncated: files.length > cap };
}

module.exports = { git, revParse, mergeBase, isClean, changedFiles, diffPatch, showFile, grepFiles };
