'use strict';
// Read models for the dashboard: everything comes from run directories on
// disk, so the UI shows exactly what the CLI produced.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists } = require('../lib/util');
const { RUNS, ticketDir, prDir, gateState, GATES } = require('../lib/runs');
const { revisionDir } = require('../lib/freeze');
const { packetRel } = require('../lib/driver');
const git = require('../lib/git');
const memory = require('../lib/memory');
const { isAsked } = require('../lib/impact-checks');
const { TEST } = require('../lib/viewpoint-checks');

const PR_ID = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+__\d+$/;
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

function prDirFromId(id) {
  if (!PR_ID.test(id)) throw httpError(400, 'bad run id');
  const [owner, repo, pr] = id.split('__');
  return { dir: prDir(`${owner}/${repo}`, Number(pr)), repo: `${owner}/${repo}`, pr: Number(pr) };
}

function ticketDirFromKey(key) {
  if (!TICKET_KEY.test(key)) throw httpError(400, 'bad ticket key');
  return ticketDir(key);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function currentValidation(dir) {
  const pointer = readJsonIfExists(path.join(dir, 'review', 'context.json'));
  if (!pointer) return null;
  return readJsonIfExists(path.join(revisionDir(dir, pointer.context_id), 'validation.json'));
}

function countBySeverity(findings, aliased = new Set()) {
  const out = { P1: 0, P2: 0, P3: 0, P4: 0, withdrawn: 0 };
  for (const f of findings || []) {
    if (f.state === 'withdrawn') out.withdrawn += 1;
    else if (!aliased.has(f.id) && f.canonical !== false) out[f.severity] += 1;
  }
  return out;
}

function listRuns() {
  const tickets = [];
  const prs = [];
  const tdir = path.join(RUNS, 'tickets');
  if (fs.existsSync(tdir)) {
    for (const key of fs.readdirSync(tdir).filter((k) => TICKET_KEY.test(k))) {
      const run = readJsonIfExists(path.join(tdir, key, 'run.json'));
      if (!run) continue;
      const stages = run.stages || {};
      const spec = readJsonIfExists(path.join(tdir, key, 'spec.json'));
      tickets.push({
        key,
        state: ticketState(path.join(tdir, key), stages),
        items: spec ? spec.review_items.length : 0,
        clean: spec ? spec.clean : null,
        updated_at: latest(Object.values(stages).map((s) => s.at)) || run.created_at,
      });
    }
  }
  const pdir = path.join(RUNS, 'prs');
  if (fs.existsSync(pdir)) {
    for (const id of fs.readdirSync(pdir).filter((n) => PR_ID.test(n))) {
      const run = readJsonIfExists(path.join(pdir, id, 'run.json'));
      if (!run || !run.identity) continue;
      const v = currentValidation(path.join(pdir, id));
      prs.push({
        id,
        repo: run.identity.repo,
        pr: run.identity.pr,
        title: run.identity.title,
        ticket: run.identity.ticket || null,
        status: v ? v.status : (run.phases && run.phases.batch && run.phases.batch.status) || 'NOT_RUN',
        recommendation: v ? v.recommendation : null,
        complete: v ? v.complete : null,
        counts: v ? countBySeverity(v.findings) : null,
        confirmed: v ? v.findings.filter((f) => f.label === 'CONFIRMED').length : 0,
        usage: v && v.usage ? { calls: v.usage.calls + ((v.usage.plan && v.usage.plan.calls) || 0), tokens_in: v.usage.input_tokens + ((v.usage.plan && v.usage.plan.input_tokens) || 0), tokens_out: v.usage.output_tokens + ((v.usage.plan && v.usage.plan.output_tokens) || 0), elapsed_ms: v.usage.elapsed_ms } : null,
        updated_at: latest(Object.values(run.phases || {}).map((p) => p.at)) || run.created_at,
      });
    }
  }
  const byDate = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at));
  return { tickets: tickets.sort(byDate), prs: prs.sort(byDate) };
}

function latest(dates) {
  return dates.filter(Boolean).sort().pop() || null;
}

function ticketState(dir, stages) {
  if (stages.ready) return 'READY';
  const failed = Object.entries(stages).find(([, s]) => /FAIL|BLOCKED/.test(s.status));
  if (failed) return `${failed[0]}: ${failed[1].status}`;
  if (stages.spec && stages.spec.status === 'EXECUTED_PASS' && !stages.analysis) {
    // A PR review stops at the approved spec (no analysis): approved, not waiting.
    const g = safeGate(dir, 'SPEC');
    return g && g.decision === 'approved' && g.valid ? 'SPEC_APPROVED' : 'AWAIT_GATE_SPEC';
  }
  return 'IN_PROGRESS';
}

function safeGate(dir, gate) {
  try {
    return gateState(dir, gate);
  } catch {
    return null;
  }
}

// The intent a ticketless PR review derived from the PR (pr-intent.js):
// which ticket, where it stands, its gate and spec numbers, or why it failed.
function prIntent(identity) {
  const key = identity.ticket_source === 'pr' ? identity.ticket : identity.intent_ticket;
  if (!key && !identity.intent_error) return null;
  const out = { key: key || null, state: null, gate: null, stats: null, questions: 0, error: identity.intent_error || null };
  const dir = key ? ticketDir(key) : null;
  const run = dir ? readJsonIfExists(path.join(dir, 'run.json')) : null;
  if (!run) return out;
  const spec = readJsonIfExists(path.join(dir, 'spec.json'));
  const g = safeGate(dir, 'SPEC');
  return { ...out, state: ticketState(dir, run.stages || {}), gate: g ? { decision: g.decision, valid: g.valid } : null, stats: spec ? spec.stats : null, questions: spec ? spec.questions.length : 0 };
}

function ticketDetail(key) {
  const dir = ticketDirFromKey(key);
  const run = readJsonIfExists(path.join(dir, 'run.json'));
  if (!run) throw httpError(404, 'no such ticket run');
  const gates = {};
  for (const g of Object.keys(GATES).filter((n) => GATES[n].kind === 'ticket')) {
    try {
      const s = gateState(dir, g);
      gates[g] = { decision: s.decision, valid: s.valid, by: s.record && s.record.by, at: s.record && s.record.at, note: s.record && s.record.note };
    } catch (err) {
      gates[g] = { decision: 'UNAVAILABLE', valid: false, error: err.message };
    }
  }
  const evidence = fs.existsSync(path.join(dir, 'ticket-evidence.md')) ? fs.readFileSync(path.join(dir, 'ticket-evidence.md'), 'utf8') : null;
  return {
    key,
    state: ticketState(dir, run.stages || {}),
    stages: run.stages || {},
    gates,
    evidence,
    requirements: readJsonIfExists(path.join(dir, 'requirements.json')),
    spec: readJsonIfExists(path.join(dir, 'spec.json')),
    analysis: readJsonIfExists(path.join(dir, 'analysis.json')),
    usage: sumReceipts(readJsonIfExists(path.join(dir, 'work', 'receipts.json'), {})),
  };
}

function sumReceipts(receipts) {
  const u = { calls: 0, repair_calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, elapsed_ms: 0 };
  for (const list of Object.values(receipts)) {
    for (const r of list) {
      u.calls += 1;
      if (r.mode === 'repair') u.repair_calls += 1;
      u.elapsed_ms += r.elapsed_ms || 0;
      for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens']) u[k] += (r.usage && r.usage[k]) || 0;
    }
  }
  return u;
}

// The tail of a run's driver log: what happened, also for runs started from
// a terminal (no dashboard job log).
const DRIVER_LOG_TAIL = 200 * 1024;
function prDriverLog(id) {
  const { dir } = prDirFromId(id);
  const file = path.join(dir, 'review', 'driver.log');
  if (!fs.existsSync(file)) return { text: '', truncated: false };
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - DRIVER_LOG_TAIL);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Start at a whole line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

// The viewpoint matrix for the dashboard: rows in checklist order with
// their text, columns in unit order, and each cell's evidence from the
// packet that answered it. null for a run from before the matrix.
function viewpointView(checks, packets, checklistText) {
  if (!checks || !checks.length) return null;
  const text = new Map();
  for (const m of String(checklistText || '').matchAll(/^\s*-\s*(CK-[A-Z]+-[0-9]+):\s*(.*)$/gm)) if (!text.has(m[1])) text.set(m[1], m[2].trim());
  const order = [...text.keys()];
  const ids = [...new Set(checks.map((c) => c.viewpoint))].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9) || a.localeCompare(b));
  const tally = {};
  for (const c of checks) tally[c.verdict] = (tally[c.verdict] || 0) + 1;
  const cells = checks.map((c) => {
    const p = packets.find((x) => x.unit_id === c.unit_id && x.role === c.role);
    const answer = p && (p.packet.viewpoint_verdicts || []).find((v) => v.viewpoint === c.viewpoint);
    return { ...c, evidence: answer ? answer.evidence : [] };
  });
  return { viewpoints: ids.map((id) => ({ id, text: text.get(id) || '' })), units: [...new Set(checks.map((c) => c.unit_id))], tally, cells };
}

// The impact view: each changed declaration with its direct call sites, the
// caller checks the reviewers answered (with evidence), and the deeper
// levels that show how far a change reaches. Name-only and other-repository
// edges are listed too, unasked.
function impactView(impact, cells, packets) {
  if (!impact) return null;
  const base = { engine: impact.engine || 'structural', scanned: impact.scanned || 0, truncated: Boolean(impact.truncated), related: impact.related || [], ast_error: impact.ast_error || null, ast_notes: impact.ast_notes || [] };
  if (impact.error) return { ...base, error: impact.error, declarations: [], deeper: [], tally: {} };
  const tally = {};
  for (const c of cells || []) tally[c.verdict] = (tally[c.verdict] || 0) + 1;
  const checkFor = (e) => {
    const c = (cells || []).find((x) => x.from.path === e.from.path && x.from.line === e.from.line && x.to.path === e.to.path && x.to.symbol === e.to.symbol);
    if (!c) return null;
    const p = packets.find((x) => x.unit_id === c.unit_id && x.role === c.role);
    const answer = p && (p.packet.impact_verdicts || []).find((v) => v.caller === c.caller);
    return { ...c, evidence: answer ? answer.evidence : [] };
  };
  const edges = impact.edges || [];
  const declarations = (impact.changed || []).map((d) => ({
    ...d,
    callers: edges.filter((e) => e.level === 1 && e.to.path === d.path && e.to.symbol === d.symbol).map((e) => ({ ...e, check: checkFor(e) })),
  }));
  return { ...base, checked: Array.isArray(cells), tally, declarations: declarations.map((d) => ({ ...d, test: TEST.test(d.path), callers: d.callers.map((e) => ({ ...e, asked: isAsked(e) })) })), deeper: edges.filter((e) => e.level > 1) };
}

function prDetail(id) {
  const { dir } = prDirFromId(id);
  const run = readJsonIfExists(path.join(dir, 'run.json'));
  if (!run) throw httpError(404, 'no such PR run');
  const validation = currentValidation(dir);
  const out = {
    id,
    identity: run.identity,
    phases: run.phases || {},
    intent: run.identity ? prIntent(run.identity) : null,
    units: (run.review && run.review.units) || [],
    plan: fs.existsSync(path.join(dir, 'pr-review-plan.md')) ? fs.readFileSync(path.join(dir, 'pr-review-plan.md'), 'utf8') : null,
    published: readJsonIfExists(path.join(dir, 'published.json')),
    static: readJsonIfExists(path.join(dir, 'static.json')),
    validation: null,
    findings: [],
    overview: null,
    gate: null,
  };
  // The impact index exists from planning on; caller verdicts join it once validated.
  out.impact = impactView(out.static && out.static.impact, null, []);
  if (!validation) return out;
  const rdir = revisionDir(dir, validation.context_id);
  const full = new Map();
  const packets = [];
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJsonIfExists(path.join(rdir, packetRel(job.unit_id, job.role)));
    if (packet) packets.push({ unit_id: job.unit_id, role: job.role, packet });
    if (packet) for (const f of packet.findings) full.set(f.id, f);
  }
  const checklistFile = path.join(rdir, 'inputs', 'policy-policies-checklist.txt');
  out.impact = impactView(out.static && out.static.impact, validation.impacts, packets);
  out.viewpoints = viewpointView(validation.checks, packets, fs.existsSync(checklistFile) ? fs.readFileSync(checklistFile, 'utf8') : '');
  const synthesis = validation.synthesis && validation.synthesis.valid ? readJsonIfExists(path.join(rdir, 'synthesis.json')) : null;
  const aliasOf = new Map((synthesis ? synthesis.aliases : []).map((a) => [a.id, a.duplicate_of]));
  const scope = memory.memoryScope(run.identity);
  const ctxSource = (readJsonIfExists(path.join(rdir, 'context.json')) || {}).source || null;
  const entries = memory.loadMemory().entries;
  out.findings = validation.findings.map((meta) => {
    const rebuttalId = meta.rebuttal_from || meta.id;
    const rebuttal = readJsonIfExists(path.join(rdir, 'rebuttals', `${rebuttalId}.json`));
    const detail = full.get(meta.id) || null;
    const rejected = detail ? memory.matchRejected(detail, { scope, run: id, source: ctxSource }, entries) : null;
    return { ...meta, duplicate_of: aliasOf.get(meta.id) || null, detail, rebuttal, rejected, publish_action: detail ? memory.publishAction(detail, rejected) : null };
  });
  out.feedback = readJsonIfExists(path.join(dir, 'feedback.json'));
  const { findings, clusters, checks, impacts, ...rest } = validation;
  out.validation = { ...rest, counts: countBySeverity(validation.findings, new Set(aliasOf.keys())) };
  out.overview = synthesis ? { flows: synthesis.overview, unverified: synthesis.unverified } : null;
  const frozenItems = readJsonIfExists(path.join(rdir, 'inputs', 'review-items.txt'), []);
  const itemText = new Map(frozenItems.map((i) => [i.id, i]));
  out.items = (validation.items || []).map((r) => ({ ...r, text: (itemText.get(r.id) || {}).text || '', expected: (itemText.get(r.id) || {}).expected || '', label: (itemText.get(r.id) || {}).label || '' }));
  const g = gateState(dir, 'REVIEW');
  out.gate = { decision: g.decision, valid: g.valid, by: g.record && g.record.by, at: g.record && g.record.at, note: g.record && g.record.note };
  return out;
}

// Source lines around a citation, read from the frozen commit (not the
// working tree), so what the UI shows is what was reviewed.
function sourceSnippet(id, file, { revision = 'reviewed', start = 1, end = start, context = 8 } = {}) {
  const { dir } = prDirFromId(id);
  const pointer = readJsonIfExists(path.join(dir, 'review', 'context.json'));
  if (!pointer) throw httpError(404, 'no frozen context');
  const ctx = readJsonIfExists(path.join(revisionDir(dir, pointer.context_id), 'context.json'));
  if (!ctx) throw httpError(404, 'no frozen context');
  if (path.isAbsolute(file) || file.split('/').includes('..')) throw httpError(400, 'bad path');
  const rev = revision === 'base' ? ctx.source.base_sha : ctx.source.head_sha;
  const text = git.showFile(ctx.source.checkout, rev, file);
  if (text == null) throw httpError(404, `${file} does not exist at ${rev.slice(0, 12)}`);
  const lines = text.split('\n');
  const from = Math.max(1, Number(start) - context);
  const to = Math.min(lines.length, Number(end) + context);
  return { path: file, revision, sha: rev, from, to, highlight: [Number(start), Number(end)], lines: lines.slice(from - 1, to) };
}

module.exports = { listRuns, ticketDetail, prDetail, viewpointView, impactView, prDriverLog, sourceSnippet, prDirFromId, ticketDirFromKey, httpError, PR_ID, TICKET_KEY };
