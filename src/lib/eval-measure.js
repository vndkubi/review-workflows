'use strict';
// Measurements of an eval run read from what it left on disk, no model:
//   quoteStats      how many code quotes are not at their cited lines
//   attemptFindings every finding a model wrote, before any rejection
//   receiptsOf      the calls of a run (planning, jobs, repro; or raw-prompt)
//   costOf          USD from evals/prices.json, per serving model
//   timeOf          model, execution and rate-limit waiting time
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists, parseModelJson } = require('./util');
const { quoteMatchesAt, splitLines } = require('./validate');
const { revisionDir } = require('./freeze');
const git = require('./git');

// { repo, base, head }, findings -> { quotes, fabricated, rate }
function quoteStats({ dir, base, head }, findings) {
  const files = new Map();
  const lines = (rev, file) => {
    const key = `${rev}:${file}`;
    if (!files.has(key)) {
      const text = git.git(dir, ['show', `${rev}:${file}`], { allowFail: true });
      files.set(key, text == null || text === '' ? null : splitLines(text));
    }
    return files.get(key);
  };
  let quotes = 0;
  let fabricated = 0;
  for (const f of findings || []) {
    for (const ev of (f && Array.isArray(f.evidence) ? f.evidence : [])) {
      if (!ev || ev.kind !== 'code' || typeof ev.quote !== 'string' || typeof ev.path !== 'string') continue;
      quotes += 1;
      const src = lines(ev.revision === 'base' ? base : head, ev.path);
      if (!src || !quoteMatchesAt(src, Number(ev.start_line), Number(ev.end_line), ev.quote).ok) fabricated += 1;
    }
  }
  return { quotes, fabricated, rate: quotes ? Math.round((fabricated / quotes) * 1000) / 1000 : null };
}

// Findings of every raw candidate under the given directories' attempts.
function attemptFindings(dirs) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'raw-candidate.txt') {
        try {
          const c = parseModelJson(fs.readFileSync(p, 'utf8'));
          if (c && Array.isArray(c.findings)) out.push(...c.findings.filter((f) => f && typeof f === 'object'));
        } catch {
          /* not JSON: no quotes to check */
        }
      }
    }
  };
  for (const d of dirs) walk(path.join(d, 'attempts'));
  return out;
}

// The directories whose attempts belong to a run (harness or raw-prompt).
function attemptDirs(runDir) {
  if (fs.existsSync(path.join(runDir, 'raw-review.json'))) return [runDir];
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  return pointer ? [revisionDir(runDir, pointer.context_id)] : [];
}

function receiptsOf(runDir) {
  const raw = readJsonIfExists(path.join(runDir, 'raw-review.json'));
  if (raw) return raw.receipts || [];
  const flat = (obj) => Object.values(obj || {}).flat().filter(Boolean);
  const out = flat(readJsonIfExists(path.join(runDir, 'plan-work', 'receipts.json')));
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  if (pointer) out.push(...flat(readJsonIfExists(path.join(revisionDir(runDir, pointer.context_id), 'receipts.json'))));
  return out;
}

const round = (x) => Math.round(x * 10000) / 10000;

// prices: { date, models: { id: { input, cached_input, output } } } in USD
// per 1M tokens. input_tokens includes the cached part.
function costOf(receipts, prices) {
  const byModel = {};
  const unpriced = new Set();
  for (const r of receipts) {
    const p = prices && prices.models && prices.models[r.model];
    const u = r.usage || {};
    if (!p) {
      unpriced.add(r.model || 'unknown');
      continue;
    }
    const cached = u.cached_input_tokens || 0;
    const usd = (((u.input_tokens || 0) - cached) * p.input + cached * (p.cached_input != null ? p.cached_input : p.input) + (u.output_tokens || 0) * p.output) / 1e6;
    byModel[r.model] = round((byModel[r.model] || 0) + usd);
  }
  const usd = unpriced.size || !prices ? null : round(Object.values(byModel).reduce((a, b) => a + b, 0));
  return { usd, by_model: byModel, unpriced: [...unpriced], price_date: prices ? prices.date || null : null };
}

function timeOf(runDir, receipts) {
  const model = receipts.reduce((n, r) => n + (r.elapsed_ms || 0), 0);
  const wait = receipts.reduce((n, r) => n + (r.wait_ms || 0), 0);
  let exec = 0;
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  if (pointer) {
    const rdir = path.join(revisionDir(runDir, pointer.context_id), 'repro');
    if (fs.existsSync(rdir)) {
      for (const f of fs.readdirSync(rdir).filter((x) => x.endsWith('.json') && !x.endsWith('.test.json'))) {
        const rec = readJsonIfExists(path.join(rdir, f));
        for (const run of (rec && rec.runs) || []) exec += run.elapsed_ms || 0;
      }
    }
  }
  const st = readJsonIfExists(path.join(runDir, 'static.json'));
  for (const run of (st && st.impacted_tests && st.impacted_tests.ran) || []) exec += run.elapsed_ms || 0;
  return { model_ms: model, exec_ms: exec, wait_ms: wait };
}

// Shell commands per call, over the calls whose receipt counted them (older
// receipts and rate-limited attempts did not).
function readsOf(receipts) {
  const counted = receipts.filter((r) => typeof r.commands === 'number' && r.mode !== 'rate_limited');
  const commands = counted.reduce((n, r) => n + r.commands, 0);
  return { calls: counted.length, commands, per_call: counted.length ? round(commands / counted.length) : null };
}

function readsTotal(list) {
  const calls = list.reduce((n, r) => n + ((r && r.calls) || 0), 0);
  const commands = list.reduce((n, r) => n + ((r && r.commands) || 0), 0);
  return { calls, commands, per_call: calls ? round(commands / calls) : null };
}

function loadPrices() {
  const dir = process.env.ARW_EVAL_DIR ? path.resolve(process.env.ARW_EVAL_DIR) : path.join(require('./util').ROOT, 'evals');
  return readJsonIfExists(path.join(dir, 'prices.json'));
}

module.exports = { quoteStats, attemptFindings, attemptDirs, receiptsOf, costOf, timeOf, readsOf, readsTotal, loadPrices };
