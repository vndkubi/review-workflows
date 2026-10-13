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
const { similarityOf, codeTokens } = require('./semantic');

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

// Where a finding points in code: the file, the enclosing method/function at
// the reviewed (or base) revision, the authority it cites, and the
// identifiers of the code its fix would change. `src` = context.source.
const symbolCache = new Map();
function anchorOf(f, src) {
  const ev = (f.evidence || []).find((e) => e.kind === 'code' && e.revision !== 'base') || (f.evidence || []).find((e) => e.kind === 'code');
  const anchor = { path: ev ? ev.path : null, symbol: null, authority: f.authority && f.authority.kind !== 'inferred' ? `${f.authority.kind}:${f.authority.id}` : null, fix: f.fix && f.fix.kind === 'code_change' ? [...codeTokens(f.fix.asis)].sort() : [] };
  if (!ev || !src || !src.checkout) return anchor;
  const rev = ev.revision === 'base' ? src.base_sha : src.head_sha;
  const key = `${src.checkout}\0${rev}\0${ev.path}`;
  if (!symbolCache.has(key)) {
    if (symbolCache.size > 500) symbolCache.clear();
    const { indexFile } = require('./impact');
    const text = require('./git').showFile(src.checkout, rev, ev.path);
    symbolCache.set(key, text == null ? null : indexFile(ev.path, text));
  }
  const idx = symbolCache.get(key);
  if (idx) {
    const { enclosing } = require('./impact');
    const m = enclosing(idx, ev.start_line);
    if (m) anchor.symbol = `${m.owner ? `${m.owner}.` : ''}${m.name}`;
  }
  return anchor;
}

function entryFor(f, { scope, reason, source, run, contextId, anchorSource }) {
  return {
    anchor: anchorOf(f, anchorSource),
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

// Meaning, not wording: the best of the old title word overlap, the concept
// overlap (stems and review vocabulary), and the structural anchor (same
// method, same cited item, same code to change).
function similarity(f, e, fAnchor) {
  const words_ = Math.max(jaccard(words(f.title), words(e.title)), jaccard(words(`${f.title} ${f.asis}`), words(`${e.title} ${e.asis}`)));
  const sem = similarityOf({ title: f.title, asis: f.asis, anchor: fAnchor }, { title: e.title, asis: e.asis, anchor: e.anchor });
  return { score: Math.max(words_, sem.score), how: sem.structural >= Math.max(words_, sem.text) && sem.structural >= MATCH_THRESHOLD ? 'same code' : sem.text > words_ ? 'same concern' : 'same words' };
}

// Best earlier rejection that looks like finding `f`, or null. The finding
// itself (same run and id) always matches. `source` (context.source) lets
// the finding be anchored to its method.
function matchRejected(f, { scope, run, source = null }, entries = loadMemory().entries) {
  let best = null;
  let fAnchor;
  for (const e of entries) {
    if (e.scope !== scope) continue;
    const same = e.run === run && e.finding_id === f.id;
    const p = codePath(f);
    if (!same && e.path && p && e.path !== p) continue;
    if (fAnchor === undefined && !same) fAnchor = source ? anchorOf(f, source) : null;
    const sim = same ? { score: 1, how: 'same finding' } : similarity(f, e, fAnchor);
    if (sim.score < MATCH_THRESHOLD) continue;
    if (!best || sim.score > best.score) best = { entry_id: e.id, reason: e.reason, at: e.at, source: e.source, same, score: Math.round(sim.score * 100) / 100, how: sim.how };
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

module.exports = { memoryFile, loadMemory, memoryScope, addRejection, forget, matchRejected, publishAction, anchorOf, MATCH_THRESHOLD };
