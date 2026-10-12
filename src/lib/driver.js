'use strict';
// Trusted review runtime: wave scheduler, repair loop, receipts, validation.
// Waves: W1 first-pass packets (parallel) -> W2 seam packets (after their
// dependencies) -> W3 blind red-team rebuttals, one per duplicate cluster ->
// W4 synthesis. Every subprocess is bracketed by a context verification; a
// drift aborts the batch without adopting anything.
const fs = require('node:fs');
const path = require('node:path');
const { sha256, sha256Value, writeJsonAtomic, readJson, readJsonIfExists, parseModelJson, envInt, nowIso, runPool, ensureDir } = require('./util');
const { loadContext, verifyContext, revisionDir, reviewDir, readInput } = require('./freeze');
const { makeSources, canonicalizeCandidate, validatePacket, validateRebuttal, validateSynthesis } = require('./validate');
const { findingClusters } = require('./cluster');
const { computeOutcome, BLOCKING } = require('./outcome');
const prompts = require('./prompts');
const { outputSchema, stripNulls } = require('./schema');

const STATUS = {
  NOT_RUN: 'NOT_RUN',
  PASS: 'EXECUTED_PASS',
  FAIL: 'EXECUTED_FAIL',
  BLOCKED: 'ENVIRONMENT_BLOCKED',
  SKIPPED: 'SKIPPED',
};

class ContextDrift extends Error {}

function acquireLock(runDir) {
  const lock = path.join(ensureDir(reviewDir(runDir)), 'driver.lock');
  if (fs.existsSync(lock)) {
    const held = readJsonIfExists(lock, {});
    let alive = false;
    try {
      process.kill(held.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && held.pid !== process.pid) throw new Error(`another driver (pid ${held.pid}) holds ${lock}`);
  }
  writeJsonAtomic(lock, { pid: process.pid, at: nowIso() });
  return () => {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already removed */
    }
  };
}

function makeLogger(runDir) {
  const file = path.join(ensureDir(reviewDir(runDir)), 'driver.log');
  return (msg) => {
    const line = `${nowIso()} pid=${process.pid} ${msg}`;
    fs.appendFileSync(file, `${line}\n`);
    process.stderr.write(`${line.slice(11, 19)} ${msg}\n`);
  };
}

function packetRel(unitId, role) {
  return `packets/${role}/${unitId}.json`;
}

function jobsFor(review) {
  const jobs = [];
  for (const unit of review.units) for (const role of unit.roles) jobs.push({ unit, role, required: unit.required });
  return jobs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Identity fields the runtime already knows. Overwriting them is not trust in
// the model; it removes busywork (copying 64-hex strings) that models garble.
function fillKnown(known) {
  return (candidate) => {
    const changes = [];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return changes;
    for (const [key, value] of Object.entries(known)) {
      if (JSON.stringify(candidate[key]) !== JSON.stringify(value)) changes.push(`$.${key}: filled by runtime`);
      candidate[key] = value;
    }
    return changes;
  };
}

// One model job with the repair loop: full -> repair x N -> one fresh full.
async function runModelJob(env, spec) {
  const { runDir, context, executor, log, receipts, flushReceipts } = env;
  const verify = env.verify || verifyContext;
  const dir = revisionDir(runDir, context.context_id);
  const repairs = envInt('ARW_REPAIR_ATTEMPTS', 2);
  const max429 = envInt('ARW_MAX_429_RETRIES', 3);
  const backoffBase = envInt('ARW_429_BACKOFF_MS', 60000);
  const modes = ['full', ...Array(repairs).fill('repair'), 'fresh'];
  let repair = null;
  let lastErrors = [];
  for (let attempt = 0; attempt < modes.length; attempt += 1) {
    const mode = modes[attempt] === 'repair' && !repair ? 'fresh' : modes[attempt];
    if (mode !== 'repair') repair = null;
    const prompt = spec.buildPrompt(repair);
    const attemptDir = ensureDir(path.join(dir, 'attempts', `${spec.label.replace(/[^A-Za-z0-9_-]/g, '_')}-${attempt + 1}`));
    let res;
    for (let tries = 0; ; tries += 1) {
      const before = verify(runDir, context);
      if (before.length) throw new ContextDrift(`before ${spec.label}: ${before.join('; ')}`);
      log(`start ${spec.label} attempt=${attempt + 1} mode=${mode}`);
      res = await executor({ prompt, cwd: context.source.checkout, attemptDir, model: spec.model, effort: spec.effort, sandbox: 'read-only', outputSchema: spec.outputSchema });
      const after = verify(runDir, context);
      if (after.length) {
        writeJsonAtomic(path.join(dir, 'invalidated.json'), { at: nowIso(), job: spec.label, errors: after });
        throw new ContextDrift(`after ${spec.label}: ${after.join('; ')}`);
      }
      if (res.error_class === 'rate_limit' && tries < max429) {
        const wait = backoffBase * (tries + 1);
        log(`rate limited on ${spec.label}; sleeping ${wait} ms`);
        await sleep(wait);
        continue;
      }
      break;
    }
    const receipt = {
      label: spec.label,
      attempt: attempt + 1,
      mode,
      model: res.model,
      exit_code: res.exit_code,
      elapsed_ms: res.elapsed_ms,
      prompt_bytes: res.prompt_bytes,
      usage: res.usage,
      turns: res.turns,
      commands: res.commands,
      error_class: res.error_class,
      error_message: res.error_message,
      attempt_dir: path.relative(dir, attemptDir).split(path.sep).join('/'),
      at: nowIso(),
    };
    (receipts[spec.outRel] = receipts[spec.outRel] || []).push(receipt);
    flushReceipts();
    if (['auth', 'billing', 'rate_limit', 'config'].includes(res.error_class)) {
      log(`blocked ${spec.label}: ${res.error_class} ${res.error_message}`);
      return { status: STATUS.BLOCKED, errors: [`${res.error_class}: ${res.error_message}`] };
    }
    if (!res.ok || res.output == null) {
      lastErrors = [`process failed (${res.error_class || 'no output'}): ${res.error_message || ''}`];
      log(`process failure ${spec.label}: ${lastErrors[0]}`);
      repair = null;
      continue;
    }
    fs.writeFileSync(path.join(attemptDir, 'raw-candidate.txt'), res.output);
    let candidate;
    try {
      candidate = stripNulls(parseModelJson(res.output));
    } catch (err) {
      lastErrors = [`output is not one JSON object: ${err.message}`];
      repair = { errors: lastErrors, previous: res.output };
      log(`invalid JSON ${spec.label}`);
      continue;
    }
    // Values the runtime already knows (refs, hashes) are filled, not copied:
    // models reliably garble 64-hex strings.
    const changes = [...(spec.fill ? spec.fill(candidate) : []), ...canonicalizeCandidate(candidate, env.sources)];
    if (changes.length) fs.writeFileSync(path.join(attemptDir, 'canonicalized.txt'), `${changes.join('\n')}\n`);
    const errors = spec.validate(candidate);
    receipt.validation_errors = errors.length;
    flushReceipts();
    if (errors.length) {
      lastErrors = errors;
      repair = { errors: errors.slice(0, 40), previous: JSON.stringify(candidate, null, 1) };
      log(`rejected ${spec.label}: ${errors.length} error(s); first: ${errors[0]}`);
      continue;
    }
    const out = path.join(dir, spec.outRel);
    writeJsonAtomic(out, candidate);
    receipt.output_sha256 = sha256(fs.readFileSync(out));
    flushReceipts();
    log(`accepted ${spec.label}`);
    return { status: STATUS.PASS, value: candidate };
  }
  return { status: STATUS.FAIL, errors: lastErrors };
}

// Re-validate everything on disk for this context, without any model.
function collectState(runDir, context, review, requirements) {
  const sources = makeSources(runDir, context);
  const dir = revisionDir(runDir, context.context_id);
  const jobsState = readJsonIfExists(path.join(dir, 'jobs.json'), {});
  const packets = [];
  const jobs = [];
  const errorsByJob = {};
  const refFor = (unitId, role) => {
    const rel = packetRel(unitId, role);
    return { unit_id: unitId, role, path: rel, sha256: sha256(fs.readFileSync(path.join(dir, rel))) };
  };
  const depRefs = (unit) => unit.depends_on.flatMap((dep) => {
    const depUnit = review.units.find((u) => u.id === dep);
    return depUnit.roles.map((role) => (fs.existsSync(path.join(dir, packetRel(dep, role))) ? refFor(dep, role) : null));
  });
  for (const { unit, role, required } of jobsFor(review)) {
    const key = `${unit.id}/${role}`;
    const file = path.join(dir, packetRel(unit.id, role));
    let status = (jobsState[key] && jobsState[key].status) || STATUS.NOT_RUN;
    if (fs.existsSync(file)) {
      const packet = readJson(file);
      const refs = unit.kind === 'seam' ? depRefs(unit) : [];
      const errors = refs.includes(null) ? ['a dependency packet is missing'] : validatePacket(packet, { sources, unit, role, requirements, expectedDependencyRefs: refs });
      if (errors.length) {
        status = STATUS.FAIL;
        errorsByJob[key] = errors;
      } else {
        status = STATUS.PASS;
        packets.push({ unit_id: unit.id, role, packet, ref: refFor(unit.id, role) });
      }
    } else if (status === STATUS.PASS) {
      status = STATUS.NOT_RUN;
    }
    jobs.push({ unit_id: unit.id, role, required, status, errors: errorsByJob[key] || (jobsState[key] && jobsState[key].errors) || [] });
  }

  const entries = packets.flatMap(({ unit_id, role, packet }) => packet.findings.map((finding) => ({ finding, voter: `${unit_id}/${role}` })));
  const clusters = findingClusters(entries);
  const findingById = new Map(entries.map((e) => [e.finding.id, e.finding]));
  const rebuttals = new Map();
  for (const [id, finding] of findingById) {
    const file = path.join(dir, 'rebuttals', `${id}.json`);
    if (!fs.existsSync(file)) continue;
    const reb = readJson(file);
    if (!validateRebuttal(reb, { sources, finding }).length) rebuttals.set(id, reb);
  }
  return { sources, packets, jobs, clusters, rebuttals, findingById };
}

function synthesisCheck(runDir, context, state, outcome) {
  const file = path.join(revisionDir(runDir, context.context_id), 'synthesis.json');
  if (!fs.existsSync(file)) return { present: false, valid: false, errors: [] };
  const errors = validateSynthesis(readJson(file), {
    sources: state.sources,
    expectedPacketRefs: state.packets.map((p) => p.ref),
    findingIds: new Set(state.findingById.keys()),
    recommendation: outcome.recommendation,
  });
  return { present: true, valid: errors.length === 0, errors };
}

async function runBatch({ runDir, executor, workers = envInt('ARW_WORKERS', 4), skipSeams = false, skipRebuttals = false, skipSynthesis = false, maxRebuttalRounds = 3, models = {} }) {
  const release = acquireLock(runDir);
  const log = makeLogger(runDir);
  try {
    const context = loadContext(runDir);
    const run = readJson(path.join(runDir, 'run.json'));
    const review = run.review;
    const requirementsText = readInput(runDir, context, 'requirements');
    const requirements = requirementsText ? JSON.parse(requirementsText) : null;
    const dir = revisionDir(runDir, context.context_id);
    const drift = verifyContext(runDir, context);
    if (drift.length) throw new ContextDrift(`context no longer holds: ${drift.join('; ')} — run the freeze phase with --refresh`);
    const receiptsFile = path.join(dir, 'receipts.json');
    const receipts = readJsonIfExists(receiptsFile, {});
    const jobsFile = path.join(dir, 'jobs.json');
    const jobsState = readJsonIfExists(jobsFile, {});
    const env = {
      runDir,
      context,
      executor,
      log,
      receipts,
      flushReceipts: () => writeJsonAtomic(receiptsFile, receipts),
      sources: makeSources(runDir, context),
    };
    const setJob = (key, result) => {
      jobsState[key] = { status: result.status, errors: (result.errors || []).slice(0, 20), at: nowIso() };
      writeJsonAtomic(jobsFile, jobsState);
    };
    log(`batch start context=${context.context_id} workers=${workers}`);

    let state = collectState(runDir, context, review, requirements);
    const passed = new Set(state.jobs.filter((j) => j.status === STATUS.PASS).map((j) => `${j.unit_id}/${j.role}`));
    const packetJob = (unit, role, depRefs = [], depPaths = []) => ({
      key: `${unit.id}/${role}`,
      label: `${unit.id}-${role}`,
      outRel: packetRel(unit.id, role),
      model: models.review,
      effort: models.effort,
      outputSchema: outputSchema('review', 'packet'),
      fill: fillKnown({ schema_version: '1.0', context_digest: context.context_digest, unit_id: unit.id, role, dependency_refs: depRefs }),
      buildPrompt: (repair) => prompts.packetPrompt(runDir, context, { unit, role, dependencyRefs: depRefs, packetPaths: depPaths, repair }),
      validate: (candidate) => validatePacket(candidate, { sources: env.sources, unit, role, requirements, expectedDependencyRefs: depRefs }),
    });

    // W1: independent first passes; viewpoints first (they cover everything).
    const order = { viewpoint: 0, business: 1, technical: 1, orphan: 2 };
    const w1 = jobsFor(review)
      .filter(({ unit, role }) => unit.kind !== 'seam' && !passed.has(`${unit.id}/${role}`))
      .sort((a, b) => order[a.unit.kind] - order[b.unit.kind]);
    log(`W1 ${w1.length} job(s) (${passed.size} already valid)`);
    await runPool(w1, workers, async ({ unit, role }) => {
      const spec = packetJob(unit, role);
      setJob(spec.key, await runModelJob(env, spec));
    });

    // W2: seams once every dependency packet is valid.
    state = collectState(runDir, context, review, requirements);
    const valid = new Map(state.packets.map((p) => [`${p.unit_id}/${p.role}`, p]));
    const seams = review.units.filter((u) => u.kind === 'seam');
    const seamJobs = [];
    for (const unit of seams) {
      for (const role of unit.roles) {
        const key = `${unit.id}/${role}`;
        if (valid.has(key)) continue;
        if (skipSeams) {
          setJob(key, { status: STATUS.SKIPPED, errors: ['skipped by --skip-seams (recorded opt-out)'] });
          continue;
        }
        const deps = unit.depends_on.flatMap((d) => review.units.find((u) => u.id === d).roles.map((r) => valid.get(`${d}/${r}`)));
        if (deps.includes(undefined)) {
          setJob(key, { status: STATUS.NOT_RUN, errors: ['dependency packets are not all valid'] });
          continue;
        }
        seamJobs.push(packetJob(unit, role, deps.map((d) => d.ref), deps.map((d) => path.join(dir, d.ref.path))));
      }
    }
    log(`W2 ${seamJobs.length} seam job(s)`);
    await runPool(seamJobs, workers, async (spec) => setJob(spec.key, await runModelJob(env, spec)));

    // W3: one blind rebuttal per cluster with blocking members; a withdrawal
    // or an unresolved verdict hands the cluster to its next blocking member.
    state = collectState(runDir, context, review, requirements);
    if (!skipRebuttals) {
      const targets = state.clusters.filter(
        (c) =>
          c.members.some((id) => BLOCKING.has(state.findingById.get(id).severity)) &&
          !c.members.some((id) => state.rebuttals.get(id) && state.rebuttals.get(id).verdict === 'FINDING_STANDS'),
      );
      log(`W3 ${targets.length} cluster(s) need a rebuttal`);
      await runPool(targets, workers, async (cluster) => {
        const blocking = cluster.members.filter((id) => BLOCKING.has(state.findingById.get(id).severity));
        for (const id of blocking.slice(0, maxRebuttalRounds)) {
          const existing = state.rebuttals.get(id);
          if (existing && existing.verdict === 'FINDING_STANDS') return;
          if (existing) continue;
          const finding = state.findingById.get(id);
          const findingSha256 = sha256Value(finding);
          const res = await runModelJob(env, {
            label: `rebuttal-${id}`,
            outRel: `rebuttals/${id}.json`,
            model: models.judge,
            effort: models.effort,
            outputSchema: outputSchema('review', 'rebuttal'),
            fill: fillKnown({ schema_version: '1.0', context_digest: context.context_digest, finding_id: id, finding_sha256: findingSha256, role: 'red-team' }),
            buildPrompt: (repair) => prompts.rebuttalPrompt(runDir, context, { finding, findingSha256, repair }),
            validate: (candidate) => validateRebuttal(candidate, { sources: env.sources, finding }),
          });
          if (res.status === STATUS.PASS && res.value.verdict === 'FINDING_STANDS') return;
          if (res.status === STATUS.BLOCKED) return;
        }
      });
    }

    // W4: synthesis over the final packet set.
    state = collectState(runDir, context, review, requirements);
    let outcome = computeOutcome({ packets: state.packets, jobs: state.jobs, clusters: state.clusters, rebuttals: state.rebuttals, requirements });
    const synth = synthesisCheck(runDir, context, state, outcome);
    if (!skipSynthesis && state.packets.length && !synth.valid) {
      const packetRefs = state.packets.map((p) => p.ref);
      const rebuttalOutcomes = outcome.findings.filter((f) => BLOCKING.has(f.severity)).map((f) => ({ id: f.id, state: f.state, rebuttal_from: f.rebuttal_from }));
      const multi = state.clusters.filter((c) => c.members.length > 1);
      const res = await runModelJob(env, {
        label: 'synthesis',
        outRel: 'synthesis.json',
        model: models.judge,
        effort: models.effort,
        outputSchema: outputSchema('review', 'synthesis'),
        fill: fillKnown({ schema_version: '1.0', context_digest: context.context_digest, role: 'coordinator', packet_refs: packetRefs }),
        buildPrompt: (repair) =>
          prompts.synthesisPrompt(runDir, context, { packetRefs, clusters: multi, rebuttalOutcomes, gaps: outcome.gaps, recommendation: outcome.recommendation, repair }),
        validate: (candidate) =>
          validateSynthesis(candidate, { sources: env.sources, expectedPacketRefs: packetRefs, findingIds: new Set(state.findingById.keys()), recommendation: outcome.recommendation }),
      });
      setJob('synthesis', res);
    }
    log('batch done');
    return finish(runDir, { skipSeams, skipRebuttals, skipSynthesis });
  } finally {
    release();
  }
}

function sumUsage(receipts) {
  const usage = { calls: 0, repair_calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, elapsed_ms: 0 };
  for (const list of Object.values(receipts)) {
    for (const r of list) {
      usage.calls += 1;
      if (r.mode === 'repair') usage.repair_calls += 1;
      usage.elapsed_ms += r.elapsed_ms || 0;
      for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) usage[k] += (r.usage && r.usage[k]) || 0;
    }
  }
  return usage;
}

// Model-free: re-validate all artifacts, compute the outcome, write
// validation.json and update unit statuses in run.json.
function finish(runDir, optOuts = {}) {
  const context = loadContext(runDir);
  const runFile = path.join(runDir, 'run.json');
  const run = readJson(runFile);
  const requirementsText = readInput(runDir, context, 'requirements');
  const requirements = requirementsText ? JSON.parse(requirementsText) : null;
  const dir = revisionDir(runDir, context.context_id);
  const drift = verifyContext(runDir, context);
  const state = collectState(runDir, context, run.review, requirements);
  const outcome = computeOutcome({ packets: state.packets, jobs: state.jobs, clusters: state.clusters, rebuttals: state.rebuttals, requirements });
  const synth = synthesisCheck(runDir, context, state, outcome);
  const usage = sumUsage(readJsonIfExists(path.join(dir, 'receipts.json'), {}));
  // Planning happens before the freeze; its cost is reported, not hidden.
  usage.plan = sumUsage(readJsonIfExists(path.join(runDir, 'plan-work', 'receipts.json'), {}));
  const gate = readJsonIfExists(path.join(runDir, 'gates', 'REVIEW.json'));
  const status = drift.length ? 'INVALIDATED' : outcome.complete && (!synth.present || synth.valid) ? 'EXECUTED_PASS' : 'EXECUTED_FAIL';
  const validation = {
    schema_version: '1.0',
    context_id: context.context_id,
    context_digest: context.context_digest,
    validated_at: nowIso(),
    status,
    drift,
    complete: outcome.complete,
    recommendation: outcome.recommendation,
    gaps: outcome.gaps,
    jobs: state.jobs,
    clusters: state.clusters,
    findings: outcome.findings,
    synthesis: synth,
    opt_outs: Object.entries(optOuts).filter(([, v]) => v).map(([k]) => k),
    usage,
    human_gate: {
      gate: 'REVIEW',
      required: true,
      recorded: gate ? gate.decision : 'NOT_RECORDED',
      bound_to_current_context: Boolean(gate && gate.bound && gate.bound.context_digest === context.context_digest),
      note: 'The runtime never approves. Only `arw gate` run by a person records this decision.',
    },
  };
  writeJsonAtomic(path.join(dir, 'validation.json'), validation);
  const byUnit = new Map();
  for (const j of state.jobs) {
    if (!byUnit.has(j.unit_id)) byUnit.set(j.unit_id, []);
    byUnit.get(j.unit_id).push(j.status);
  }
  for (const unit of run.review.units) {
    const statuses = byUnit.get(unit.id) || [];
    unit.status = statuses.every((s) => s === STATUS.PASS) ? STATUS.PASS : statuses.find((s) => s !== STATUS.PASS) || STATUS.NOT_RUN;
  }
  run.review.context_id = context.context_id;
  writeJsonAtomic(runFile, run);
  return validation;
}

module.exports = { runBatch, finish, collectState, runModelJob, acquireLock, ContextDrift, STATUS, packetRel };
