'use strict';
// Freeze-then-verify: every input a worker may cite is snapshotted and hashed
// once; any drift (source, plan, inputs, the tool itself) invalidates the run.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, sha256, sha256Value, writeFileAtomic, writeJsonAtomic, readJson, readJsonIfExists, nowIso } = require('./util');
const git = require('./git');

const POLICY_GLOBS = [
  ['agents', /\.md$/],
  ['config/policies', /\.md$/],
  ['config/schemas', /\.json$/],
];

function policyFiles() {
  const out = [];
  for (const [dir, re] of POLICY_GLOBS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) if (re.test(name)) out.push(path.join(abs, name));
  }
  return out;
}

// Hash of the trusted runtime. Upgrading the tool changes what "valid" means,
// so a context frozen by an older tool must be refreshed.
function toolDigest() {
  const dir = path.join(ROOT, 'src', 'lib');
  const parts = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .sort()
    .map((n) => `${n}\0${sha256(fs.readFileSync(path.join(dir, n)))}`);
  return sha256(parts.join('\n'));
}

function planDigest(review) {
  return sha256Value(review.units.map(({ status, ...rest }) => rest));
}

function reviewDir(runDir) {
  return path.join(runDir, 'review');
}

function revisionDir(runDir, contextId) {
  return path.join(reviewDir(runDir), 'revisions', contextId);
}

// inputs: [{ id, kind, content }] — content is written to inputs/<id>.txt.
function freezeContext({ runDir, checkout, base, head, changed, reviewable, patch, review, inputs }) {
  if (!git.isClean(checkout)) throw new Error(`checkout ${checkout} has uncommitted or untracked changes`);
  const actualHead = git.revParse(checkout, 'HEAD');
  if (actualHead !== head) throw new Error(`checkout HEAD ${actualHead} != frozen head ${head}`);

  const allInputs = [
    ...inputs,
    ...policyFiles().map((file) => ({
      id: `policy-${path.basename(path.dirname(file))}-${path.basename(file).replace(/\.(md|json)$/, '').replace(/\./g, '-')}`,
      kind: 'policy',
      content: fs.readFileSync(file, 'utf8'),
    })),
  ];
  const ids = new Set();
  for (const input of allInputs) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.id)) throw new Error(`bad input id ${input.id}`);
    if (ids.has(input.id)) throw new Error(`duplicate input id ${input.id}`);
    ids.add(input.id);
  }

  const body = {
    schema_version: '1.0',
    source: {
      checkout: path.resolve(checkout),
      base_sha: base,
      head_sha: head,
      patch_sha256: sha256(patch),
      changed_files: changed,
      reviewable,
    },
    plan_sha256: planDigest(review),
    tool_sha256: toolDigest(),
    inputs: allInputs.map((input) => ({
      id: input.id,
      kind: input.kind,
      snapshot: `inputs/${input.id}.txt`,
      sha256: sha256(input.content),
    })),
  };
  const digest = sha256Value(body);
  const contextId = digest.slice(0, 16);
  const dir = revisionDir(runDir, contextId);
  for (const input of allInputs) writeFileAtomic(path.join(dir, 'inputs', `${input.id}.txt`), input.content);
  writeFileAtomic(path.join(dir, 'review.patch'), patch);
  const context = { ...body, context_id: contextId, context_digest: digest, frozen_at: nowIso() };
  writeJsonAtomic(path.join(dir, 'context.json'), context);
  writeJsonAtomic(path.join(reviewDir(runDir), 'context.json'), { context_id: contextId, context_digest: digest });
  return context;
}

function loadContext(runDir) {
  const pointer = readJsonIfExists(path.join(reviewDir(runDir), 'context.json'));
  if (!pointer) throw new Error(`no frozen context in ${runDir} (run the freeze phase first)`);
  const context = readJson(path.join(revisionDir(runDir, pointer.context_id), 'context.json'));
  const { context_id, context_digest, frozen_at, ...body } = context;
  if (sha256Value(body) !== context_digest || context_digest !== pointer.context_digest) {
    throw new Error('context.json digest mismatch: the frozen context was edited');
  }
  return context;
}

function readInput(runDir, context, id) {
  const entry = context.inputs.find((i) => i.id === id);
  if (!entry) return null;
  return fs.readFileSync(path.join(revisionDir(runDir, context.context_id), entry.snapshot), 'utf8');
}

// Returns a list of drift errors; empty means the context still holds.
function verifyContext(runDir, context, { checkTool = true } = {}) {
  const errors = [];
  const dir = revisionDir(runDir, context.context_id);
  const { checkout, head_sha, patch_sha256 } = context.source;
  try {
    const actual = git.revParse(checkout, 'HEAD');
    if (actual !== head_sha) errors.push(`checkout HEAD moved: ${actual} != ${head_sha}`);
    if (!git.isClean(checkout)) errors.push('checkout has uncommitted or untracked changes');
  } catch (err) {
    errors.push(`checkout unreadable: ${err.message}`);
  }
  for (const input of context.inputs) {
    const file = path.join(dir, input.snapshot);
    if (!fs.existsSync(file)) errors.push(`input ${input.id} snapshot missing`);
    else if (sha256(fs.readFileSync(file, 'utf8')) !== input.sha256) errors.push(`input ${input.id} snapshot changed`);
  }
  const patchFile = path.join(dir, 'review.patch');
  if (!fs.existsSync(patchFile) || sha256(fs.readFileSync(patchFile, 'utf8')) !== patch_sha256) errors.push('review.patch changed');
  const run = readJsonIfExists(path.join(runDir, 'run.json'));
  if (!run || !run.review || planDigest(run.review) !== context.plan_sha256) errors.push('run.json review plan changed since freeze');
  if (checkTool && toolDigest() !== context.tool_sha256) errors.push('tool source (src/lib) changed since freeze; refresh the context');
  return errors;
}

module.exports = { freezeContext, loadContext, verifyContext, readInput, revisionDir, reviewDir, planDigest, toolDigest, policyFiles };
