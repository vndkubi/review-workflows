'use strict';
// Hash binding for the model artifacts a person decides on: the validation
// outcome and the accepted packets behind the report and the published
// review. A gate or a publish is only as good as the bytes it was made on;
// re-validating rewrites validation.json but keeps this digest stable while
// the decision itself is unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { sha256File, sha256Value, readJsonIfExists } = require('./util');

// Fields that change without changing the decision (a new timestamp, cost,
// the gate that was just recorded) or that are derived from the files.
function stableValidation(validation) {
  const { validated_at, usage, human_gate, opt_outs, carried_over, ...stable } = validation;
  return stable;
}

function validationDigest(validation) {
  return sha256Value(stableValidation(validation));
}

function reviewDir(runDir, contextId) {
  return path.join(runDir, 'review', 'revisions', contextId);
}

// The packet files of the jobs validation.json accepted, with their hashes as
// they are on disk now. A missing packet has a null hash, so deleting one
// invalidates the decision just like editing it.
function packetHashes(runDir, contextId, jobs = []) {
  const dir = reviewDir(runDir, contextId);
  return (jobs || [])
    .filter((job) => job.status === 'EXECUTED_PASS')
    .map((job) => {
      const rel = `packets/${job.role}/${job.unit_id}.json`;
      const abs = path.join(dir, rel);
      return { unit_id: job.unit_id, role: job.role, path: rel, sha256: fs.existsSync(abs) ? sha256File(abs) : null };
    })
    .sort((a, b) => `${a.unit_id}/${a.role}`.localeCompare(`${b.unit_id}/${b.role}`));
}

// Throws when validation.json, run.json's binding or an accepted packet no
// longer match what validation.json recorded. Callers that read packets to
// show or publish them use this first; `arw validate` rebinds after a change.
function verifyArtifacts(runDir, validation, run = null) {
  const runDoc = run || readJsonIfExists(path.join(runDir, 'run.json'));
  if (!runDoc || !runDoc.validation_sha256) throw new Error('this validation is not bound to its artifacts: run `arw validate`');
  if (validationDigest(validation) !== runDoc.validation_sha256) throw new Error('validation.json changed after it was written: run `arw validate`');
  const packets = validation.artifacts && validation.artifacts.packets;
  if (!Array.isArray(packets)) throw new Error('validation.json has no packet hashes: run `arw validate`');
  if (!/^[0-9a-f]{16}$/.test(String(validation.context_id || ''))) throw new Error('validation.json has an invalid context id');
  const dir = reviewDir(runDir, validation.context_id);
  const listed = new Set();
  for (const p of packets) {
    if (!/^packets\/[^/]+\/[^/]+\.json$/.test(String(p.path || ''))) throw new Error('validation.json has an invalid packet path');
    listed.add(`${p.unit_id}/${p.role}`);
    const abs = path.join(dir, p.path);
    const actual = fs.existsSync(abs) ? sha256File(abs) : null;
    if (actual !== p.sha256) throw new Error(`packet ${p.path} changed after validation: run \`arw validate\``);
  }
  for (const job of validation.jobs || []) {
    if (job.status === 'EXECUTED_PASS' && !listed.has(`${job.unit_id}/${job.role}`)) throw new Error(`packet ${job.unit_id}/${job.role} is not bound to this validation: run \`arw validate\``);
  }
  return true;
}

module.exports = { stableValidation, validationDigest, packetHashes, verifyArtifacts, reviewDir };
