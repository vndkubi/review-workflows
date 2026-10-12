'use strict';
// Run directories and human gates. A gate records a person's decision bound
// to the exact artifact hash it was made on; if the artifact changes, the
// gate no longer counts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, sha256File, sha256Value, writeJsonAtomic, readJsonIfExists, nowIso, ensureDir } = require('./util');

const RUNS = process.env.ARW_RUNS_DIR ? path.resolve(process.env.ARW_RUNS_DIR) : path.join(ROOT, 'runs');

function ticketDir(key) {
  return path.join(RUNS, 'tickets', key);
}

function prDir(repo, pr) {
  return path.join(RUNS, 'prs', `${repo.replace('/', '__')}__${pr}`);
}

// Worktrees the tool creates live here (ARW_WT_DIR overrides it, for tests).
function worktreeRoot() {
  return process.env.ARW_WT_DIR || path.join(ROOT, 'wt');
}

function worktreeDir(repo, pr) {
  return path.join(worktreeRoot(), `${repo.replace('/', '__')}__${pr}`);
}

// What each gate is bound to, per run kind.
const GATES = {
  // spec.json embeds the requirement items it was built from, so one gate
  // covers requirements, tables and review items.
  SPEC: { kind: 'ticket', artifact: 'spec.json' },
  REVIEW: { kind: 'pr', artifact: null },
};

function gateBinding(runDir, gate) {
  const spec = GATES[gate];
  if (!spec) throw new Error(`unknown gate ${gate} (one of ${Object.keys(GATES).join(', ')})`);
  if (spec.artifact) {
    const file = path.join(runDir, spec.artifact);
    if (!fs.existsSync(file)) throw new Error(`${spec.artifact} does not exist yet in ${runDir}`);
    return { artifact: spec.artifact, sha256: sha256File(file) };
  }
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  if (!pointer) throw new Error('no frozen review context to bind the gate to');
  const validation = readJsonIfExists(path.join(runDir, 'review', 'revisions', pointer.context_id, 'validation.json'));
  if (!validation) throw new Error('the review has not been validated yet');
  // Bound to what the person saw: the context and the finding outcomes.
  // Re-validating without changes keeps the gate; any changed outcome voids it.
  const outcome = validation.findings.map((f) => [f.id, f.severity, f.state]).sort();
  return { context_digest: pointer.context_digest, recommendation: validation.recommendation, findings_sha256: sha256Value(outcome) };
}

function recordGate(runDir, gate, decision, { by = os.userInfo().username, note = '' } = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const record = { gate, decision, by, at: nowIso(), note, bound: gateBinding(runDir, gate) };
  writeJsonAtomic(path.join(ensureDir(path.join(runDir, 'gates')), `${gate}.json`), record);
  return record;
}

// { decision, valid } — valid only while the bound artifact is unchanged.
function gateState(runDir, gate) {
  const record = readJsonIfExists(path.join(runDir, 'gates', `${gate}.json`));
  if (!record) return { decision: 'NOT_RECORDED', valid: false };
  let current;
  try {
    current = gateBinding(runDir, gate);
  } catch {
    return { decision: record.decision, valid: false, record };
  }
  const valid = JSON.stringify(current) === JSON.stringify(record.bound);
  return { decision: record.decision, valid, record };
}

function isApproved(runDir, gate) {
  const s = gateState(runDir, gate);
  return s.decision === 'approved' && s.valid;
}

module.exports = { RUNS, ticketDir, prDir, worktreeRoot, worktreeDir, GATES, recordGate, gateState, isApproved };
