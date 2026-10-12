'use strict';
// Incremental review after a new push. A packet from the previous context is
// reused for the new one when nothing it looked at changed:
//   - the tool, the grading inputs and the policies are byte-identical;
//   - the unit is the same (id, kind, files, items, roles);
//   - none of the unit's files changed on either side of the diff (so its
//     hunks are identical), and no file a finding cites changed.
// The carried packet then goes through the same validator as model output,
// against the new frozen sources; anything that fails is simply re-run.
// Rebuttals of carried findings are carried the same way. Synthesis and
// reproductions always run again.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, readJsonIfExists, writeJsonAtomic, sha256, sha256Value, nowIso } = require('./util');
const { revisionDir, planDigest } = require('./freeze');
const { makeSources, validatePacket, validateRebuttal } = require('./validate');
const git = require('./git');

// Inputs that change with every push and are re-checked through quotes.
const VOLATILE = new Set(['evidence-pack', 'plan', 'pr-body', 'ticket-evidence']);

function stableInputs(context) {
  return Object.fromEntries(context.inputs.filter((i) => !VOLATILE.has(i.id)).map((i) => [i.id, i.sha256]));
}

function unitKey(unit) {
  const { status, desc, ...rest } = unit;
  return JSON.stringify(rest);
}

function changedBetween(cwd, a, b) {
  if (a === b) return new Set();
  const out = git.git(cwd, ['diff', '--name-only', '--no-renames', a, b], { allowFail: true });
  if (out == null || out === false) return null;
  return new Set(String(out).split('\n').map((l) => l.trim()).filter(Boolean));
}

function unitFiles(unit) {
  return unit.covers.filter((c) => c.startsWith('file:')).map((c) => c.slice(5));
}

// Every evidence entry anywhere in an artifact (findings, coverage, item
// verdicts, verification steps).
function allEvidence(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allEvidence(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'evidence' && Array.isArray(v)) out.push(...v);
      else allEvidence(v, out);
    }
  }
  return out;
}

function citedFilesUnchanged(artifact, changed) {
  return allEvidence(artifact).every((e) => !e || e.kind !== 'code' || !(e.revision === 'base' ? changed.base : changed.head).has(e.path));
}

// Returns { packets: [keys], rebuttals: [ids], skipped: reason|null }.
function carryOver({ runDir, from, to, units, grading, log = () => {} }) {
  const result = { from_context_id: from.context_id, at: nowIso(), packets: [], rebuttals: [], skipped: null };
  const done = (reason) => {
    if (reason) result.skipped = reason;
    writeJsonAtomic(path.join(revisionDir(runDir, to.context_id), 'carried.json'), result);
    log(reason ? `no carry-over from ${from.context_id}: ${reason}` : `carried over from ${from.context_id}: ${result.packets.length} packet(s), ${result.rebuttals.length} rebuttal(s)`);
    return result;
  };
  if (from.context_id === to.context_id) return done('same context');
  if (from.tool_sha256 !== to.tool_sha256) return done('the review tool changed');
  if (JSON.stringify(stableInputs(from)) !== JSON.stringify(stableInputs(to))) return done('review items, spec or policies changed');
  const oldDir = revisionDir(runDir, from.context_id);
  const oldReview = readJsonIfExists(path.join(oldDir, 'units.json'));
  if (!oldReview || planDigest(oldReview) !== from.plan_sha256) return done('the previous plan is not available');
  const oldValidation = readJsonIfExists(path.join(oldDir, 'validation.json'));
  if (!oldValidation) return done('the previous context was never validated');
  const cwd = to.source.checkout;
  const changed = { head: changedBetween(cwd, from.source.head_sha, to.source.head_sha), base: changedBetween(cwd, from.source.base_sha, to.source.base_sha) };
  if (!changed.head || !changed.base) return done('the previous commits are not in the repository');

  const oldUnits = new Map(oldReview.units.map((u) => [u.id, u]));
  const passed = new Set(oldValidation.jobs.filter((j) => j.status === 'EXECUTED_PASS').map((j) => `${j.unit_id}/${j.role}`));
  const newDir = revisionDir(runDir, to.context_id);
  const sources = makeSources(runDir, to);
  const findings = new Map();
  // First passes before seams: a seam's dependency refs are hashes of the
  // (new) dependency packets.
  const ordered = [...units.filter((u) => u.kind !== 'seam'), ...units.filter((u) => u.kind === 'seam')];
  for (const unit of ordered) {
    const old = oldUnits.get(unit.id);
    if (!old || unitKey(old) !== unitKey(unit)) continue;
    if (unitFiles(unit).some((f) => changed.head.has(f) || changed.base.has(f))) continue;
    for (const role of unit.roles) {
      const rel = `packets/${role}/${unit.id}.json`;
      if (!passed.has(`${unit.id}/${role}`) || !fs.existsSync(path.join(oldDir, rel))) continue;
      const packet = readJson(path.join(oldDir, rel));
      if (!citedFilesUnchanged(packet, changed)) continue;
      packet.context_digest = to.context_digest;
      let refs = [];
      if (unit.kind === 'seam') {
        refs = unit.depends_on.flatMap((dep) => units.find((u) => u.id === dep).roles.map((r) => {
          const file = path.join(newDir, `packets/${r}/${dep}.json`);
          return fs.existsSync(file) ? { unit_id: dep, role: r, path: `packets/${r}/${dep}.json`, sha256: sha256(fs.readFileSync(file)) } : null;
        }));
        if (refs.includes(null)) continue;
        packet.dependency_refs = refs;
      }
      const errors = validatePacket(packet, { sources, unit, role, requirements: grading.requirements, items: grading.items, expectedDependencyRefs: refs });
      if (errors.length) {
        log(`not carried ${unit.id}/${role}: ${errors[0]}`);
        continue;
      }
      writeJsonAtomic(path.join(newDir, rel), packet);
      result.packets.push(`${unit.id}/${role}`);
      for (const f of packet.findings) findings.set(f.id, f);
    }
  }
  for (const [id, finding] of findings) {
    const file = path.join(oldDir, 'rebuttals', `${id}.json`);
    if (!fs.existsSync(file)) continue;
    const rebuttal = readJson(file);
    if (rebuttal.finding_sha256 !== sha256Value(finding) || !citedFilesUnchanged(rebuttal, changed)) continue;
    rebuttal.context_digest = to.context_digest;
    if (validateRebuttal(rebuttal, { sources, finding }).length) continue;
    writeJsonAtomic(path.join(newDir, 'rebuttals', `${id}.json`), rebuttal);
    result.rebuttals.push(id);
  }
  return done(null);
}

module.exports = { carryOver, changedBetween, VOLATILE };
