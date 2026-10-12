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

function prProgress(id) {
  const { dir } = prDirFromId(id);
  const run = readJsonIfExists(path.join(dir, 'run.json'), {});
  const rev = currentRevision(dir);
  const out = { phases: run.phases || {}, context_id: rev ? rev.id : null, units: [], waves: [], calls: 0, tokens_in: 0, tokens_out: 0, repro: [] };
  const logFile = path.join(dir, 'review', 'driver.log');
  const parsed = fs.existsSync(logFile) ? parseDriverLog(fs.readFileSync(logFile, 'utf8')) : { jobs: [], waves: [] };
  out.waves = parsed.waves.slice(-12);
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

module.exports = { safeRead, prFile, ticketFile, prProgress, prCalls, ticketCalls, prRepro, ticketIntake, parseDriverLog };
