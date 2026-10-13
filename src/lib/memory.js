'use strict';
// Memory of rejected findings. A person rejects a finding (in the dashboard,
// with `arw reject`, or by deleting its comment before submitting the GitHub
// review); later findings in the same repository that look like it are
// marked, and the minor ones are left out of the published draft. The
// validation verdict itself never reads this file: it stays a function of
// the frozen context.
const path = require('node:path');
const { readJsonIfExists, writeJsonAtomic, sha256, nowIso, samePath } = require('./util');
const { RUNS } = require('./runs');
const { words, jaccard } = require('./cluster');

const MATCH_THRESHOLD = 0.5;

function memoryFile() {
  return path.join(RUNS, 'memory', 'rejected.json');
}

function loadMemory() {
  return readJsonIfExists(memoryFile(), { entries: [] });
}

// Local runs share memory with the configured repository whose checkout is
// the reviewed directory, so a rejection before the PR still counts after.
function memoryScope(identity) {
  if (identity && identity.local) {
    const { reposConfig } = require('./github');
    const dir = path.resolve(identity.local.dir);
    const hit = Object.entries(reposConfig().repos).find(([, r]) => r && r.checkout && samePath(r.checkout, dir));
    if (hit) return hit[0];
  }
  return identity.repo;
}

function codePath(f) {
  const e = (f.evidence || []).find((x) => x.kind === 'code');
  return e ? e.path : null;
}

function entryFor(f, { scope, reason, source, run, contextId }) {
  return {
    id: `RJ-${sha256(`${scope}\0${run}\0${f.id}`).slice(0, 10)}`,
    scope,
    path: codePath(f),
    title: f.title,
    asis: f.asis,
    severity: f.severity,
    authority: f.authority ? `${f.authority.kind}:${f.authority.id}` : null,
    reason: String(reason || '').trim() || 'rejected',
    source,
    run,
    finding_id: f.id,
    context_id: contextId || null,
    at: nowIso(),
  };
}

function addRejection(f, opts) {
  const mem = loadMemory();
  const entry = entryFor(f, opts);
  mem.entries = mem.entries.filter((e) => e.id !== entry.id).concat(entry);
  writeJsonAtomic(memoryFile(), mem);
  return entry;
}

function forget(id) {
  const mem = loadMemory();
  const before = mem.entries.length;
  mem.entries = mem.entries.filter((e) => e.id !== id);
  if (mem.entries.length === before) return false;
  writeJsonAtomic(memoryFile(), mem);
  return true;
}

function similarity(f, e) {
  const t = jaccard(words(f.title), words(e.title));
  const full = jaccard(words(`${f.title} ${f.asis}`), words(`${e.title} ${e.asis}`));
  return Math.max(t, full);
}

// Best earlier rejection that looks like finding `f`, or null. The finding
// itself (same run and id) always matches.
function matchRejected(f, { scope, run }, entries = loadMemory().entries) {
  let best = null;
  for (const e of entries) {
    if (e.scope !== scope) continue;
    const same = e.run === run && e.finding_id === f.id;
    const p = codePath(f);
    if (!same && e.path && p && e.path !== p) continue;
    const score = same ? 1 : similarity(f, e);
    if (score < MATCH_THRESHOLD) continue;
    if (!best || score > best.score) best = { entry_id: e.id, reason: e.reason, at: e.at, source: e.source, same, score: Math.round(score * 100) / 100 };
  }
  return best;
}

// Publish policy for a matched finding: the exact finding a person rejected
// is never published; a look-alike is left out when minor (P3/P4) and kept
// with a note when it could be serious (P1/P2).
function publishAction(f, match) {
  if (!match) return 'publish';
  if (match.same) return 'omit';
  return ['P1', 'P2'].includes(f.severity) ? 'publish_with_note' : 'omit';
}

module.exports = { memoryFile, loadMemory, memoryScope, addRejection, forget, matchRejected, publishAction, MATCH_THRESHOLD };
