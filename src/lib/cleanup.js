'use strict';
// Disk usage and cleanup of old runs. Always reports what it would remove;
// removes only when apply is true. Kinds:
//   worktrees: PR review and repro worktrees (the run becomes read-only:
//              re-validation and the source view need its checkout)
//   attempts:  per-call prompt/output files (receipts, packets, reports stay)
//   runs:      whole run directories
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJsonIfExists } = require('./util');
const { RUNS } = require('./runs');
const git = require('./git');

const DAY = 24 * 3600 * 1000;

function sizeOf(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      // A worktree's .git is a file; the object store lives in the source repo.
      for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
    } else total += st.size;
  }
  return total;
}

function lastTouched(dir) {
  const run = readJsonIfExists(path.join(dir, 'run.json'), {});
  const stamps = Object.values(run.phases || run.stages || {}).map((p) => Date.parse(p.at)).filter(Number.isFinite);
  if (stamps.length) return Math.max(...stamps);
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function attemptDirs(runDir) {
  const out = [];
  for (const base of ['plan-work', 'work']) if (fs.existsSync(path.join(runDir, base, 'attempts'))) out.push(path.join(runDir, base, 'attempts'));
  const revs = path.join(runDir, 'review', 'revisions');
  if (fs.existsSync(revs)) for (const r of fs.readdirSync(revs)) if (fs.existsSync(path.join(revs, r, 'attempts'))) out.push(path.join(revs, r, 'attempts'));
  return out;
}

// [{ kind, id, dir, size, last, worktrees:[{path,size,source}], attempts }]
function diskUsage() {
  const rows = [];
  for (const kind of ['prs', 'tickets']) {
    const base = path.join(RUNS, kind);
    if (!fs.existsSync(base)) continue;
    for (const id of fs.readdirSync(base)) {
      const dir = path.join(base, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      const run = readJsonIfExists(path.join(dir, 'run.json'), {});
      const worktrees = [];
      if (kind === 'prs') {
        const source = run.identity && run.identity.source_checkout;
        const review = run.identity && run.identity.checkout;
        // Only worktrees this tool created: under ROOT/wt or the run's repro-wt.
        if (review && path.resolve(review).startsWith(path.join(ROOT, 'wt') + path.sep) && fs.existsSync(review)) worktrees.push({ path: review, size: sizeOf(review), source });
        const repro = path.join(dir, 'repro-wt');
        if (fs.existsSync(repro)) worktrees.push({ path: repro, size: sizeOf(repro), source: review || source });
      }
      const attempts = attemptDirs(dir).reduce((n, d) => n + sizeOf(d), 0);
      const wtSize = worktrees.reduce((n, w) => n + w.size, 0);
      rows.push({ kind: kind === 'prs' ? 'pr' : 'ticket', id, dir, size: sizeOf(dir) - (fs.existsSync(path.join(dir, 'repro-wt')) ? sizeOf(path.join(dir, 'repro-wt')) : 0) + wtSize, last: new Date(lastTouched(dir)).toISOString(), worktrees, attempts });
    }
  }
  return rows.sort((a, b) => b.size - a.size);
}

function removeWorktree(wt) {
  if (wt.source && fs.existsSync(wt.source)) git.git(wt.source, ['worktree', 'remove', '--force', wt.path], { allowFail: true });
  fs.rmSync(wt.path, { recursive: true, force: true });
  if (wt.source && fs.existsSync(wt.source)) git.git(wt.source, ['worktree', 'prune'], { allowFail: true });
}

// opts: { olderThanDays, worktrees, attempts, runs, apply }
function clean({ olderThanDays = 14, worktrees = true, attempts = true, runs = false, apply = false } = {}) {
  const cutoff = Date.now() - olderThanDays * DAY;
  const actions = [];
  for (const row of diskUsage()) {
    if (Date.parse(row.last) > cutoff) continue;
    if (runs) {
      actions.push({ action: 'remove run', target: row.dir, bytes: row.size });
      if (apply) {
        row.worktrees.forEach(removeWorktree);
        fs.rmSync(row.dir, { recursive: true, force: true });
      }
      continue;
    }
    if (worktrees) {
      for (const wt of row.worktrees) {
        actions.push({ action: 'remove worktree', target: wt.path, bytes: wt.size });
        if (apply) removeWorktree(wt);
      }
    }
    if (attempts && row.attempts) {
      for (const d of attemptDirs(row.dir)) {
        actions.push({ action: 'remove attempt files', target: d, bytes: sizeOf(d) });
        if (apply) fs.rmSync(d, { recursive: true, force: true });
      }
    }
  }
  return { applied: Boolean(apply), cutoff: new Date(cutoff).toISOString(), actions, bytes: actions.reduce((n, a) => n + a.bytes, 0) };
}

module.exports = { diskUsage, clean, sizeOf };
