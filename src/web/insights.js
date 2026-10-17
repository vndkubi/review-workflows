'use strict';
// Detail read models for the dashboard: live progress, model calls, repro
// records, intake details, and safe reads of run files. All from disk.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists } = require('../lib/util');
const { revisionDir } = require('../lib/freeze');
const { prDirFromId, ticketDirFromKey, httpError } = require('./data');

const MAX_FILE = 512 * 1024;

// Read a text file that must live inside `base`; never follows "..".
function safeRead(base, rel) {
  if (!rel || typeof rel !== 'string') throw httpError(400, 'path required');
  const abs = path.resolve(base, rel);
  if (abs !== path.resolve(base) && !abs.startsWith(path.resolve(base) + path.sep)) throw httpError(400, 'path outside the run');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `${rel} not found`);
  const size = fs.statSync(abs).size;
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(Math.min(size, MAX_FILE));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  return { path: rel, size, truncated: size > MAX_FILE, text: buf.toString('utf8') };
}

function currentRevision(dir) {
  const pointer = readJsonIfExists(path.join(dir, 'review', 'context.json'));
  return pointer ? { id: pointer.context_id, dir: revisionDir(dir, pointer.context_id) } : null;
}

function prFile(id, rel) {
  return safeRead(prDirFromId(id).dir, rel);
}

function ticketFile(key, rel) {
  return safeRead(ticketDirFromKey(key), rel);
}

// driver.log lines: "<iso> pid=<n> <message>"
function parseDriverLog(text) {
  const jobs = new Map();
  const waves = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\S+) pid=\d+ (.*)$/);
    if (!m) continue;
    const [, at, msg] = m;
    let x;
    if ((x = msg.match(/^start (\S+) attempt=(\d+) mode=(\w+)/))) jobs.set(x[1], { label: x[1], state: 'running', attempt: Number(x[2]), mode: x[3], at });
    else if ((x = msg.match(/^accepted (\S+)/))) jobs.set(x[1], { ...(jobs.get(x[1]) || { label: x[1] }), state: 'accepted', at });
    else if ((x = msg.match(/^rejected (\S+): (.*)$/))) jobs.set(x[1], { ...(jobs.get(x[1]) || { label: x[1] }), state: 'rejected', error: x[2], at });
    else if ((x = msg.match(/^(?:process failure|blocked|invalid JSON) (\S+?):? ?(.*)$/))) jobs.set(x[1], { ...(jobs.get(x[1]) || { label: x[1] }), state: 'failed', error: x[2], at });
    else if ((x = msg.match(/^(W\d) (.*)$/))) waves.push({ wave: x[1], text: x[2], at });
    else if (/^batch (start|done)/.test(msg)) waves.push({ wave: msg.split(' ')[1] === 'start' ? 'start' : 'done', text: msg, at });
  }
  return { jobs: [...jobs.values()], waves };
}

// The review pipeline as steps, each pending | running | done | failed |
// skipped | waiting | warn, with a short detail. Read from run.json phases and
// the driver log of the latest batch (the log keeps older batches too).
// active: a job for this run is queued or running; jobStatus: how the last
// job ended (a failed job marks the step it was in as failed).
const STEPS = [
  ['prepare', 'Prepare'], ['intent', 'Ticket / intent'], ['plan', 'Plan'], ['freeze', 'Freeze'],
  ['W1', 'W1 first pass'], ['W2', 'W2 seams'], ['W3', 'W3 red team'], ['W4', 'W4 synthesis'],
  ['validate', 'Validate'], ['repro', 'Repro'], ['report', 'Report'],
];
const PASS = /PASS|READY/;
const FAIL = /FAIL|BLOCK|INVALID/;

function reviewSteps({ run, driverLog = '', active = false, jobStatus = null, hasReport = false }) {
  const phases = (run && run.phases) || {};
  const text = String(driverLog);
  const lastBatch = text.lastIndexOf(' batch start ');
  const segment = lastBatch < 0 ? '' : text.slice(text.lastIndexOf('\n', lastBatch) + 1);
  const { jobs, waves } = parseDriverLog(segment);
  const wave = (w) => waves.find((x) => x.wave === w);
  const batchDone = waves.some((x) => x.wave === 'done');
  const out = new Map(STEPS.map(([id, label]) => [id, { id, label, state: 'pending', detail: '' }]));
  const set = (id, st, detail = '') => Object.assign(out.get(id), { state: st, detail });
  const fromPhase = (id, p, detail = '') => {
    if (!p) return;
    if (PASS.test(p.status)) set(id, 'done', detail);
    else if (FAIL.test(p.status)) set(id, 'failed', detail || p.status);
    else if (p.status === 'SKIPPED') set(id, 'skipped', detail || p.reason || '');
    else set(id, 'running', detail);
  };

  fromPhase('prepare', phases.prepare);
  const t = phases.ticket;
  if (t) {
    if (t.status === 'RUNNING') set('intent', 'running', t.step || '');
    else if (t.status === 'AWAITING_INTENT') set('intent', 'waiting', `${t.ticket}: confirm the intent at its SPEC gate`);
    else if (t.status === 'SKIPPED') set('intent', 'skipped', t.intent_error || 'no ticket');
    else {
      const how = t.intent === 'unconfirmed' ? 'not confirmed' : t.intent === 'confirmed' || t.spec_approved ? 'approved spec' : 'unapproved';
      set('intent', t.intent === 'unconfirmed' ? 'warn' : 'done', [t.ticket, how, t.items != null ? `${t.items} items` : null].filter(Boolean).join(' · '));
    }
  }
  fromPhase('plan', phases.plan, phases.plan && phases.plan.units ? `${phases.plan.units} units` : '');
  fromPhase('freeze', phases.freeze, phases.freeze && phases.freeze.context_id ? `context ${String(phases.freeze.context_id).slice(0, 8)}` : '');

  // Waves: a wave is done once the next one (or the end of the batch) shows.
  const unitJobs = jobs.filter((j) => !/^(rebuttal-|synthesis|repro-)/.test(j.label));
  const counts = (list) => {
    const n = (s) => list.filter((j) => j.state === s).length;
    return [n('accepted') && `${n('accepted')} accepted`, n('running') && `${n('running')} running`, n('rejected') && `${n('rejected')} being repaired`, n('failed') && `${n('failed')} failed`].filter(Boolean).join(' · ');
  };
  const order = ['W1', 'W2', 'W3'];
  order.forEach((w, i) => {
    const seen = wave(w);
    const later = order.slice(i + 1).some((x) => wave(x)) || batchDone || jobs.some((j) => j.label === 'synthesis');
    if (!seen) {
      if (batchDone || (w !== 'W1' && later)) set(w, 'skipped', w === 'W3' ? 'no blocking finding to challenge' : '');
      return;
    }
    const empty = /^0 /.test(seen.text);
    const detail = [seen.text, w === 'W1' ? counts(unitJobs) : w === 'W3' ? counts(jobs.filter((j) => j.label.startsWith('rebuttal-'))) : ''].filter(Boolean).join(' · ');
    set(w, later ? (empty ? 'skipped' : 'done') : 'running', detail);
  });
  const synth = jobs.find((j) => j.label === 'synthesis');
  if (synth) set('W4', synth.state === 'accepted' ? 'done' : synth.state === 'running' ? 'running' : 'failed', synth.error || '');
  else if (batchDone) set('W4', 'skipped');

  if (phases.batch && phases.batch.status !== 'RUNNING') fromPhase('validate', phases.batch, phases.batch.status);
  else if (batchDone) set('validate', 'running');
  fromPhase('repro', phases.repro, phases.repro && phases.repro.results ? `${phases.repro.results.length} finding(s) reproduced` : '');
  if (!phases.repro && phases.batch && PASS.test(phases.batch.status) && active) set('repro', 'running');
  if (hasReport) set('report', 'done');

  const steps = [...out.values()];
  // A job that ended without finishing: the step it was in failed.
  if (!active && jobStatus === 'failed') {
    const current = steps.find((s) => s.state === 'running');
    if (current) current.state = 'failed';
  }
  return steps;
}

function prProgress(id, { active = false, jobStatus = null } = {}) {
  const { dir } = prDirFromId(id);
  const run = readJsonIfExists(path.join(dir, 'run.json'), {});
  const rev = currentRevision(dir);
  const out = { phases: run.phases || {}, context_id: rev ? rev.id : null, units: [], waves: [], calls: 0, tokens_in: 0, tokens_out: 0, repro: [] };
  const logFile = path.join(dir, 'review', 'driver.log');
  const parsed = fs.existsSync(logFile) ? parseDriverLog(fs.readFileSync(logFile, 'utf8')) : { jobs: [], waves: [] };
  out.waves = parsed.waves.slice(-12);
  out.steps = reviewSteps({ run, driverLog: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '', active, jobStatus, hasReport: Boolean(rev && fs.existsSync(path.join(rev.dir, 'report.md'))) });
  const live = new Map(parsed.jobs.map((j) => [j.label, j]));
  const state = rev ? readJsonIfExists(path.join(rev.dir, 'jobs.json'), {}) : {};
  for (const unit of (run.review && run.review.units) || []) {
    for (const role of unit.roles) {
      const label = `${unit.id}-${role}`;
      const st = state[`${unit.id}/${role}`];
      const l = live.get(label);
      out.units.push({ unit: unit.id, kind: unit.kind, role, status: st ? st.status : 'NOT_RUN', live: l ? l.state : null, attempt: l ? l.attempt : null, mode: l ? l.mode : null, error: (l && l.error) || (st && st.errors && st.errors[0]) || null });
    }
  }
  out.other = parsed.jobs.filter((j) => /^(rebuttal-|synthesis|repro-)/.test(j.label));
  if (rev) {
    const receipts = readJsonIfExists(path.join(rev.dir, 'receipts.json'), {});
    for (const list of Object.values(receipts)) {
      for (const r of list) {
        out.calls += 1;
        out.tokens_in += (r.usage && r.usage.input_tokens) || 0;
        out.tokens_out += (r.usage && r.usage.output_tokens) || 0;
      }
    }
    const rdir = path.join(rev.dir, 'repro');
    if (fs.existsSync(rdir)) {
      for (const name of fs.readdirSync(rdir).filter((n) => /^[^.]+\.json$/.test(n) && !n.endsWith('.test.json'))) {
        const rec = readJsonIfExists(path.join(rdir, name));
        if (rec && rec.finding_id) out.repro.push({ finding: rec.finding_id, status: rec.status, runs: (rec.runs || []).map((r) => `${r.phase}:${r.status}`), fix: rec.fix ? rec.fix.verified : null });
      }
    }
  }
  return out;
}

function flattenReceipts(receipts, prefix) {
  const rows = [];
  for (const [output, list] of Object.entries(receipts || {})) {
    for (const r of list) {
      rows.push({
        output,
        label: r.label || output,
        attempt: r.attempt,
        mode: r.mode,
        model: r.model,
        elapsed_ms: r.elapsed_ms,
        tokens_in: (r.usage && r.usage.input_tokens) || 0,
        tokens_cached: (r.usage && r.usage.cached_input_tokens) || 0,
        tokens_out: (r.usage && r.usage.output_tokens) || 0,
        turns: r.turns,
        commands: r.commands,
        error_class: r.error_class || null,
        error_message: r.error_message || null,
        validation_errors: r.validation_errors == null ? null : r.validation_errors,
        dir: r.attempt_dir ? `${prefix}${r.attempt_dir}` : `${prefix}attempts/${(r.label || output).replace(/[^A-Za-z0-9_-]/g, '_')}-${r.attempt}`,
        at: r.at,
      });
    }
  }
  return rows;
}

function filesIn(base, relDir) {
  const abs = path.join(base, relDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter((n) => fs.statSync(path.join(abs, n)).isFile()).map((n) => `${relDir}/${n}`);
}

// Every model call of a PR run (planning + review), with its attempt files.
function prCalls(id) {
  const { dir } = prDirFromId(id);
  const rev = currentRevision(dir);
  const rows = [
    ...flattenReceipts(readJsonIfExists(path.join(dir, 'plan-work', 'receipts.json'), {}), 'plan-work/'),
    ...(rev ? flattenReceipts(readJsonIfExists(path.join(rev.dir, 'receipts.json'), {}), `review/revisions/${rev.id}/`) : []),
  ];
  for (const r of rows) r.files = filesIn(dir, r.dir);
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function ticketCalls(key) {
  const dir = ticketDirFromKey(key);
  const rows = flattenReceipts(readJsonIfExists(path.join(dir, 'work', 'receipts.json'), {}), 'work/');
  for (const r of rows) {
    if (!fs.existsSync(path.join(dir, r.dir))) r.dir = `work/attempts/${r.output}-${r.attempt}`;
    r.files = filesIn(dir, r.dir);
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Full repro records for the current revision, with the test source.
function prRepro(id) {
  const { dir } = prDirFromId(id);
  const rev = currentRevision(dir);
  if (!rev) return [];
  const rdir = path.join(rev.dir, 'repro');
  if (!fs.existsSync(rdir)) return [];
  const prefix = `review/revisions/${rev.id}/`;
  return fs
    .readdirSync(rdir)
    .filter((n) => /^[^.]+\.json$/.test(n))
    .map((n) => readJsonIfExists(path.join(rdir, n)))
    .filter((r) => r && r.finding_id)
    .map((r) => ({
      ...r,
      test: r.test ? { ...r.test, source: r.test.artifact ? safeRead(rev.dir, r.test.artifact.path).text : null } : null,
      runs: (r.runs || []).map((x) => ({ ...x, log_path: x.log ? `${prefix}${x.log.path}` : null })),
    }));
}

function ticketIntake(key) {
  const dir = ticketDirFromKey(key);
  const run = readJsonIfExists(path.join(dir, 'run.json'), {});
  const intake = (run.stages && run.stages.intake) || {};
  const evidence = ['ticket-evidence.md', ...filesIn(dir, 'evidence')].filter((f) => fs.existsSync(path.join(dir, f)));
  const history = filesIn(dir, 'history');
  const docs = ['requirements.md', 'spec.md', 'analysis.md'].filter((f) => fs.existsSync(path.join(dir, f)));
  return { source: intake.source || null, confluence_pages: intake.confluence_pages || [], extras: intake.extras || [], evidence, spec_history: history, docs };
}

module.exports = { safeRead, prFile, ticketFile, prProgress, prCalls, ticketCalls, prRepro, ticketIntake, parseDriverLog, reviewSteps };
