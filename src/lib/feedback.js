'use strict';
// What people did with the findings: rejections recorded here or in the
// dashboard, and the submitted GitHub review read back through the
// `<!-- arw:finding=... -->` markers. Kept/edited/dropped per finding feeds
// the acceptance rate; dropped findings go to the rejection memory.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, readJsonIfExists, writeJsonAtomic, sha256, nowIso } = require('./util');
const { RUNS } = require('./runs');
const { revisionDir } = require('./freeze');
const { packetRel } = require('./driver');
const memory = require('./memory');

const MARKER = /<!--\s*arw:finding=([A-Za-z0-9._-]+)\s+context=([A-Za-z0-9]+)\s*-->/g;

// Comment text without the marker, whitespace-normalised, for edit detection.
function normalizedBody(text) {
  return String(text || '').replace(MARKER, '').replace(/\s+/g, ' ').trim();
}

function bodyHash(text) {
  return sha256(normalizedBody(text));
}

function markersIn(text) {
  return [...String(text || '').matchAll(MARKER)].map((m) => m[1]);
}

// Findings of the run's current context, by id.
function currentFindings(runDir) {
  const run = readJson(path.join(runDir, 'run.json'));
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  if (!pointer) throw new Error('this run has no frozen context yet');
  const dir = revisionDir(runDir, pointer.context_id);
  const validation = readJsonIfExists(path.join(dir, 'validation.json'));
  if (!validation) throw new Error('this run has no validation yet');
  const byId = new Map();
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJsonIfExists(path.join(dir, packetRel(job.unit_id, job.role)));
    if (packet) for (const f of packet.findings) byId.set(f.id, f);
  }
  return { run, validation, byId, contextId: pointer.context_id };
}

function runId(runDir) {
  return path.basename(runDir);
}

function rejectFinding(runDir, findingId, { reason, source = 'dashboard' } = {}) {
  const { run, validation, byId, contextId } = currentFindings(runDir);
  const f = byId.get(findingId);
  if (!f) throw new Error(`no finding ${findingId} in the current context`);
  const entry = memory.addRejection(f, { scope: memory.memoryScope(run.identity), reason, source, run: runId(runDir), contextId });
  require('./report').writeReport(runDir, validation, run.identity);
  return entry;
}

// Rejections recorded for this run (by the dashboard, CLI or read-back).
function runRejections(runDir) {
  const id = runId(runDir);
  return memory.loadMemory().entries.filter((e) => e.run === id);
}

// Reads the submitted review back from GitHub. `api(path)` returns parsed
// JSON for a GitHub REST path (gh api in production, a stub in tests).
function readBack(runDir, { api }) {
  const published = readJsonIfExists(path.join(runDir, 'published.json'));
  if (!published || published.dry_run || !published.review_id) throw new Error('nothing was published for this run (only dry runs)');
  const { run, byId } = currentFindings(runDir);
  const { repo, pr } = run.identity;
  const review = api(`repos/${repo}/pulls/${pr}/reviews/${published.review_id}`);
  const comments = review.state === 'PENDING' ? [] : api(`repos/${repo}/pulls/${pr}/reviews/${published.review_id}/comments?per_page=100`);
  const hashes = published.bodies || {};
  const byMarker = new Map();
  for (const c of comments) for (const id of markersIn(c.body)) byMarker.set(id, c);
  const used = new Set();
  const findings = [];
  const verdictOf = (id, placed) => {
    if (review.state === 'PENDING') return 'pending';
    if (review.state === 'DISMISSED') return 'dismissed';
    if (placed.inline) {
      const c = byMarker.get(id);
      if (c) {
        used.add(c.id);
        return hashes[id] && bodyHash(c.body) !== hashes[id] ? 'edited' : 'kept';
      }
      // The reviewer may have rewritten the comment and removed the marker.
      const moved = comments.find((x) => !used.has(x.id) && !markersIn(x.body).length && x.path === placed.path && (x.line === placed.line || x.original_line === placed.line));
      if (moved) {
        used.add(moved.id);
        return 'edited';
      }
      return 'dropped';
    }
    return markersIn(review.body).includes(id) ? 'kept' : 'dropped';
  };
  const placed = [...published.inline.map((c) => ({ id: c.finding_id, inline: true, path: c.path, line: c.line })), ...published.summary_only.map((id) => ({ id, inline: false }))];
  for (const p of placed) {
    const f = byId.get(p.id);
    findings.push({ id: p.id, verdict: verdictOf(p.id, p), severity: f ? f.severity : null, title: f ? f.title : null, inline: p.inline });
  }
  const counts = { kept: 0, edited: 0, dropped: 0, pending: 0, dismissed: 0 };
  for (const f of findings) counts[f.verdict] += 1;
  const record = { at: nowIso(), review_id: published.review_id, context_id: published.context_id, state: review.state, submitted_at: review.submitted_at || null, findings, counts };
  writeJsonAtomic(path.join(runDir, 'feedback.json'), record);
  const remembered = [];
  for (const f of findings.filter((x) => x.verdict === 'dropped')) {
    const full = byId.get(f.id);
    if (full) remembered.push(memory.addRejection(full, { scope: memory.memoryScope(run.identity), reason: 'removed from the GitHub review before submitting', source: 'github', run: runId(runDir), contextId: published.context_id }));
  }
  return { record, remembered };
}

// Acceptance across runs: of the findings a person decided on, how many
// they kept. Grouped by severity, evidence label and reviewer role.
function acceptanceStats() {
  const base = path.join(RUNS, 'prs');
  const total = { kept: 0, edited: 0, dropped: 0 };
  const groups = { severity: {}, label: {}, role: {} };
  const runs = [];
  if (!fs.existsSync(base)) return { total: { ...total, rate: null }, groups, runs };
  const add = (bucket, key, verdict) => {
    bucket[key] = bucket[key] || { kept: 0, edited: 0, dropped: 0 };
    bucket[key][verdict] += 1;
  };
  for (const id of fs.readdirSync(base)) {
    const fb = readJsonIfExists(path.join(base, id, 'feedback.json'));
    if (!fb) continue;
    const pointer = readJsonIfExists(path.join(base, id, 'review', 'context.json'));
    const validation = pointer && readJsonIfExists(path.join(revisionDir(path.join(base, id), fb.context_id || pointer.context_id), 'validation.json'));
    const metas = new Map(((validation && validation.findings) || []).map((m) => [m.id, m]));
    const decided = fb.findings.filter((f) => ['kept', 'edited', 'dropped'].includes(f.verdict));
    for (const f of decided) {
      total[f.verdict] += 1;
      const meta = metas.get(f.id) || {};
      add(groups.severity, f.severity || '?', f.verdict);
      add(groups.label, meta.label || '?', f.verdict);
      add(groups.role, (/-(business|technical)-/.exec(f.id) || [null, '?'])[1], f.verdict);
    }
    runs.push({ id, at: fb.at, state: fb.state, counts: fb.counts });
  }
  const rate = (c) => (c.kept + c.edited + c.dropped ? Math.round(((c.kept + c.edited) / (c.kept + c.edited + c.dropped)) * 1000) / 10 : null);
  for (const g of Object.values(groups)) for (const c of Object.values(g)) c.rate = rate(c);
  return { total: { ...total, rate: rate(total) }, groups, runs: runs.sort((a, b) => String(b.at).localeCompare(String(a.at))) };
}

module.exports = { rejectFinding, runRejections, readBack, acceptanceStats, bodyHash, normalizedBody, markersIn, currentFindings };
