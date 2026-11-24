'use strict';
// Eval harness: replay labelled changes through the whole review and score
// the result, so a prompt, model or code change is measured, not guessed.
//
//   evals/cases/<id>.json   a commit range in a local clone + labels:
//     expected:     defects a good review must report (path, lines, keywords)
//     not_expected: known false positives (reporting them costs precision)
//   evals/runs/<run id>/    one isolated runs dir per case, logs, scorecard
//
// Each case runs as `arw review --local <repo> --base <base> --head <head>`
// in its own process and runs directory. Scoring is model-free.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, readJson, readJsonIfExists, writeJsonAtomic, writeFileAtomic, ensureDir, nowIso, envInt, sha256 } = require('./util');
const { worktreeRoot } = require('./runs');
const { revisionDir, toolDigest } = require('./freeze');
const { packetRel } = require('./driver');
const { words, SEVERITY_RANK } = require('./cluster');
const { effectiveAliases } = require('./outcome');
const git = require('./git');
const measure = require('./eval-measure');
const stats = require('./eval-stats');
const { lastUsageLimit } = require('./quota');

const LINE_SLACK = 3;
const FLAGS = ['singleRole', 'singleAgent', 'freeReview', 'skipSeams', 'skipRebuttals', 'skipSynthesis', 'noRepro'];
// Named configurations, to compare on the same cases (same model and inputs):
// what the multi-agent waves add over one reviewer, and what execution adds.
const CONFIGS = {
  // The traditional baseline: one prompt, one call (config/baselines).
  'raw-prompt': { raw: true },
  'single-agent': { singleAgent: true, noRepro: true },
  // Only the whole-PR free reviews: set ARW_HUNT_LENSES in the matrix cell.
  'free-review': { freeReview: true, noRepro: true },
  'multi-agent': { singleAgent: false, noRepro: true },
  'multi-agent+repro': { singleAgent: false, noRepro: false },
};

function evalDir() {
  return process.env.ARW_EVAL_DIR ? path.resolve(process.env.ARW_EVAL_DIR) : path.join(ROOT, 'evals');
}
const casesDir = () => path.join(evalDir(), 'cases');
const runsDir = () => path.join(evalDir(), 'runs');

// ---------- cases ----------
function checkLabel(l, at, errors) {
  if (!l || typeof l !== 'object') return errors.push(`${at}: must be an object`);
  if (!/^[A-Za-z0-9._-]+$/.test(String(l.id || ''))) errors.push(`${at}.id: letters, digits, . _ -`);
  // A prose label (a reviewer's comment without coordinates) is scoped to
  // `paths` when known and always matched by keywords: never by prose alone.
  if (l.prose !== undefined) {
    if (typeof l.prose !== 'string' || !l.prose.trim()) errors.push(`${at}.prose: the comment text`);
    if (!Array.isArray(l.keywords) || !l.keywords.length) errors.push(`${at}: a prose label needs keywords`);
    if (l.paths !== undefined && !(Array.isArray(l.paths) && l.paths.every((p) => typeof p === 'string' && p))) errors.push(`${at}.paths: list of files`);
    if (l.min_keywords !== undefined && !(Number.isInteger(l.min_keywords) && l.min_keywords >= 1)) errors.push(`${at}.min_keywords: a positive integer`);
    for (const [i, a] of (l.anchors || []).entries()) if (!a || typeof a.path !== 'string' || !(Array.isArray(a.lines) && a.lines.length === 2)) errors.push(`${at}.anchors[${i}]: { path, lines: [start, end] }`);
  } else if (!l.path || typeof l.path !== 'string') errors.push(`${at}.path: the file the defect is in`);
  if (l.lines !== undefined && !(Array.isArray(l.lines) && l.lines.length === 2 && l.lines.every(Number.isInteger) && l.lines[0] <= l.lines[1])) errors.push(`${at}.lines: [start, end]`);
  if (l.keywords !== undefined && !(Array.isArray(l.keywords) && l.keywords.every((k) => typeof k === 'string' && k.trim()))) errors.push(`${at}.keywords: list of words`);
  if (l.severity_at_least !== undefined && !SEVERITY_RANK[l.severity_at_least]) errors.push(`${at}.severity_at_least: P1..P4`);
  return errors;
}

function validateCase(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['a case is a JSON object'];
  if (!/^[A-Za-z0-9._-]+$/.test(String(c.id || ''))) errors.push('id: letters, digits, . _ -');
  if (!c.repo || !path.isAbsolute(c.repo)) errors.push('repo: absolute path of a local clone');
  else if (!fs.existsSync(c.repo) || !git.git(c.repo, ['rev-parse', '--git-dir'], { allowFail: true })) errors.push(`repo: ${c.repo} is not a git repository`);
  for (const k of ['base', 'head']) if (!c[k] || typeof c[k] !== 'string' || c[k].startsWith('-')) errors.push(`${k}: a commit or ref`);
  if (!errors.length) {
    for (const k of ['base', 'head']) if (!git.git(c.repo, ['rev-parse', '--verify', '--quiet', `${c[k]}^{commit}`], { allowFail: true })) errors.push(`${k}: ${c[k]} is not a commit in ${c.repo}`);
  }
  (c.expected || []).forEach((l, i) => checkLabel(l, `expected[${i}]`, errors));
  (c.not_expected || []).forEach((l, i) => checkLabel(l, `not_expected[${i}]`, errors));
  if (!(c.expected || []).length && !(c.not_expected || []).length) errors.push('label at least one expected or not_expected defect');
  for (const k of Object.keys(c.flags || {})) if (!FLAGS.includes(k)) errors.push(`flags.${k}: one of ${FLAGS.join(', ')}`);
  return errors;
}

function loadCases({ only } = {}) {
  const dir = casesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const c = readJson(path.join(dir, f));
    return { ...c, file: path.join(dir, f), errors: validateCase(c) };
  }).filter((c) => !only || only.includes(c.id));
}

// ---------- scoring ----------
// The findings a reader of the review would see: valid, not withdrawn by
// the red team, not folded into another as a duplicate.
function reviewFindings(runDir) {
  // A raw-prompt run: the model's findings as written, nothing withdrawn.
  const rawFile = path.join(runDir, 'raw-review.json');
  if (fs.existsSync(rawFile)) {
    const r = readJson(rawFile);
    const usage = { calls: r.receipts.length, input_tokens: 0, output_tokens: 0, elapsed_ms: 0 };
    for (const x of r.receipts) {
      usage.input_tokens += (x.usage && x.usage.input_tokens) || 0;
      usage.output_tokens += (x.usage && x.usage.output_tokens) || 0;
      usage.elapsed_ms += x.elapsed_ms || 0;
    }
    return { validation: { status: r.status, complete: r.status === 'EXECUTED_PASS', recommendation: null, usage }, shown: r.findings.map((f) => ({ ...f, label: null, state: null })), withdrawn: [] };
  }
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  if (!pointer) return null;
  const dir = revisionDir(runDir, pointer.context_id);
  const validation = readJsonIfExists(path.join(dir, 'validation.json'));
  if (!validation) return null;
  const byId = new Map();
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJsonIfExists(path.join(dir, packetRel(job.unit_id, job.role)));
    if (packet) for (const f of packet.findings) byId.set(f.id, f);
  }
  const synthesis = validation.synthesis && validation.synthesis.valid ? readJsonIfExists(path.join(dir, 'synthesis.json')) : null;
  const aliased = new Set(effectiveAliases(synthesis, validation.findings).map((a) => a.id));
  const shown = [];
  const withdrawn = [];
  for (const meta of validation.findings) {
    const f = byId.get(meta.id);
    if (!f || aliased.has(meta.id) || meta.canonical === false) continue;
    (meta.state === 'withdrawn' ? withdrawn : shown).push({ ...f, label: meta.label, state: meta.state });
  }
  return { validation, shown, withdrawn };
}

function matches(f, label) {
  const scope = label.path ? [label.path] : label.paths || [];
  const ev = (f.evidence || []).filter((e) => e.kind === 'code' && (!scope.length || scope.includes(e.path)));
  if (!ev.length) return false;
  if (label.lines && !ev.some((e) => e.start_line <= label.lines[1] + LINE_SLACK && label.lines[0] <= e.end_line + LINE_SLACK)) return false;
  if (label.keywords && label.keywords.length) {
    const text = `${f.title} ${f.asis} ${f.tobe} ${f.impact || ''}`.toLowerCase();
    if (label.keywords.filter((k) => text.includes(k.toLowerCase())).length < (label.min_keywords || 1)) return false;
  }
  return true;
}

// A person's link of a finding to a label (`arw eval label --to`) is an
// anchor: a finding at that code meets the label on every later score.
function hitsLabel(f, label) {
  if ((label.anchors || []).some((a) => matches(f, { path: a.path, lines: a.lines }))) return true;
  return matches(f, label);
}

// A finding at a missed label's code, which the label's lines or keywords
// did not admit: a near miss. It is shown with the command that links it, and
// recall says how far near misses reach; only a person's link makes it a hit.
const NEAR_SLACK = 25;
function nearMisses(findings, labels, taken) {
  const out = {};
  for (const l of labels) {
    const scope = l.path ? [l.path] : l.paths || [];
    if (!scope.length) continue;
    for (const f of findings) {
      if (taken.has(f.id)) continue;
      const ev = (f.evidence || []).filter((e) => e.kind === 'code' && scope.includes(e.path));
      if (!ev.length) continue;
      if (l.lines && !ev.some((e) => e.start_line <= l.lines[1] + NEAR_SLACK && l.lines[0] <= e.end_line + NEAR_SLACK)) continue;
      (out[l.id] = out[l.id] || []).push(f.id);
    }
  }
  return out;
}

// Core labels: what a reviewer must catch. Low, style, documentation and
// speculative comments are counted apart.
const MINOR = new Set(['style', 'doc_defect', 'speculative']);
const isCore = (l) => !MINOR.has(l.category) && l.source_severity !== 'Low';

// Prose labels of one case often share identifiers (the PR's main class), so
// a shared keyword alone does not tell them apart. A label with keywords of
// its own needs one of them; each finding then meets only its best label.
// Returns { labelId: [findingId, ...] }.
function assignProse(findings, labels) {
  const prose = labels.filter((l) => l.approx);
  const count = new Map();
  for (const l of prose) for (const k of new Set(l.keywords.map((x) => x.toLowerCase()))) count.set(k, (count.get(k) || 0) + 1);
  const out = {};
  for (const f of findings) {
    const text = `${f.title} ${f.asis} ${f.tobe} ${f.impact || ''}`.toLowerCase();
    let best = null;
    for (const l of prose) {
      // Anchors are a person's links of earlier findings to this comment.
      if ((l.anchors || []).some((a) => matches(f, { path: a.path, lines: a.lines }))) {
        best = { id: l.id, score: Infinity };
        break;
      }
      if (!matches(f, l)) continue;
      const own = l.keywords.filter((k) => count.get(k.toLowerCase()) === 1);
      const ownHits = own.filter((k) => text.includes(k.toLowerCase())).length;
      if (own.length && !ownHits) continue;
      const score = 2 * ownHits + l.keywords.filter((k) => text.includes(k.toLowerCase())).length - ownHits;
      if (!best || score > best.score) best = { id: l.id, score };
    }
    if (best) (out[best.id] = out[best.id] || []).push(f.id);
  }
  return out;
}

function ratio(a, b) {
  return b ? Math.round((a / b) * 1000) / 1000 : null;
}

// What precision can be, whatever the unlabelled findings turn out to be:
// all false (lo) or all true (hi). With many unlabelled findings the point
// value on the labelled few says little, so the range is shown beside it.
function precisionBounds(tp, fp, unlabelled) {
  const n = tp + fp + unlabelled;
  if (!n) return { precision_range: null, labelled_share: null };
  return { precision_range: { lo: ratio(tp, n), hi: ratio(tp + unlabelled, n) }, labelled_share: ratio(tp + fp, n) };
}

function scoreCase(c, runDir, prices = measure.loadPrices()) {
  const res = runDir && reviewFindings(runDir);
  const notExpected = (c.not_expected || []).length;
  if (!res) {
    return {
      id: c.id,
      status: 'NO_RESULT',
      expected: (c.expected || []).length,
      scored_expected: 0,
      not_expected: notExpected,
      found: 0,
      // No result is a gap, not a miss: it is excluded from the recall denominator.
      recall: null,
      tp: 0,
      fp: 0,
      unlabelled: 0,
      precision: null,
      gap: 'no review result: the case was not scored',
      evidence: null,
      time: null,
      details: { expected: [], findings: [] },
    };
  }
  const { validation, shown, withdrawn } = res;
  const proseShown = assignProse(shown, c.expected || []);
  const proseWithdrawn = assignProse(withdrawn, c.expected || []);
  const hitsOf = (list, assigned, e) => (e.approx ? list.filter((f) => (assigned[e.id] || []).includes(f.id)) : list.filter((f) => hitsLabel(f, e)));
  const taken = new Set();
  for (const e of c.expected || []) for (const f of hitsOf(shown, proseShown, e)) taken.add(f.id);
  for (const e of c.not_expected || []) for (const f of shown) if (matches(f, e)) taken.add(f.id);
  const near = nearMisses(shown, c.expected || [], taken);
  const expected = (c.expected || []).map((e) => {
    const hits = hitsOf(shown, proseShown, e);
    const best = hits.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
    return {
      id: e.id,
      found: Boolean(best),
      by: hits.map((f) => f.id),
      near: best ? [] : near[e.id] || [],
      core: isCore(e),
      ...(e.approx ? { approx: true, prose: e.prose } : {}),
      severity: best ? best.severity : null,
      severity_ok: best ? !e.severity_at_least || SEVERITY_RANK[best.severity] <= SEVERITY_RANK[e.severity_at_least] : null,
      // The red team withdrew a real defect: a cost of the rebuttal stage.
      withdrawn_by: hitsOf(withdrawn, proseWithdrawn, e).map((f) => f.id),
    };
  });
  const findings = shown.map((f) => {
    const exp = (c.expected || []).filter((e) => hitsOf([f], proseShown, e).length).map((e) => e.id);
    const fps = (c.not_expected || []).filter((e) => matches(f, e)).map((e) => e.id);
    const at = (f.evidence || []).find((e) => e.kind === 'code') || {};
    return { id: f.id, severity: f.severity, label: f.label, title: f.title, path: at.path || null, lines: at.path ? [at.start_line, at.end_line] : null, verdict: exp.length ? 'tp' : fps.length ? 'fp' : 'unlabelled', labels: exp.length ? exp : fps };
  });
  const tp = findings.filter((f) => f.verdict === 'tp').length;
  const fp = findings.filter((f) => f.verdict === 'fp').length;
  const found = expected.filter((e) => e.found).length;
  const u = validation.usage || {};
  const plan = u.plan || {};
  // Quotes checked against the case's commits; calls priced by the model
  // that served each; time split into model, execution and waiting.
  const src = { dir: c.repo, base: c.base, head: c.head };
  const receipts = measure.receiptsOf(runDir);
  const priced = measure.costOf(receipts, prices);
  return {
    id: c.id,
    status: validation.status,
    complete: validation.complete,
    recommendation: validation.recommendation,
    recommendation_ok: c.expected_recommendation ? c.expected_recommendation === validation.recommendation : null,
    expected: expected.length,
    scored_expected: expected.length,
    not_expected: notExpected,
    found,
    recall: ratio(found, expected.length),
    near_found: expected.filter((e) => !e.found && e.near.length).length,
    core_expected: expected.filter((e) => e.core).length,
    core_found: expected.filter((e) => e.core && e.found).length,
    severity_ok: expected.filter((e) => e.severity_ok).length,
    tp,
    fp,
    unlabelled: findings.length - tp - fp,
    // Precision needs at least one known false positive label to have a
    // denominator that means something. With zero not_expected labels it is
    // not measurable, not 100%.
    precision: notExpected ? ratio(tp, tp + fp) : null,
    precision_denominator: tp + fp,
    ...precisionBounds(tp, fp, findings.length - tp - fp),
    redteam_withdrew_real: expected.filter((e) => !e.found && e.withdrawn_by.length).map((e) => e.id),
    // Shell commands the workers ran (reads, mostly): how deep they looked.
    reads: measure.readsOf(receipts),
    cost: { calls: (u.calls || 0) + (plan.calls || 0), input_tokens: (u.input_tokens || 0) + (plan.input_tokens || 0), cached_input_tokens: receipts.reduce((n, r) => n + ((r.usage && r.usage.cached_input_tokens) || 0), 0), output_tokens: (u.output_tokens || 0) + (plan.output_tokens || 0), elapsed_ms: u.elapsed_ms || 0, usd: priced.usd, by_model: priced.by_model, unpriced: priced.unpriced },
    evidence: { final: measure.quoteStats(src, shown), attempts: measure.quoteStats(src, measure.attemptFindings(measure.attemptDirs(runDir))) },
    time: measure.timeOf(runDir, receipts),
    details: { expected, findings },
  };
}

// Nearest-rank percentiles of the values present.
function quantiles(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return { p50: null, p95: null };
  const at = (q) => v[Math.max(0, Math.ceil(q * v.length) - 1)];
  return { p50: at(0.5), p95: at(0.95) };
}

function quoteTotals(scores, kind) {
  const quotes = scores.reduce((n, s) => n + ((s.evidence && s.evidence[kind] && s.evidence[kind].quotes) || 0), 0);
  const fabricated = scores.reduce((n, s) => n + ((s.evidence && s.evidence[kind] && s.evidence[kind].fabricated) || 0), 0);
  const unchecked = scores.reduce((n, s) => n + ((s.evidence && s.evidence[kind] && s.evidence[kind].unchecked) || 0), 0);
  return { quotes, fabricated, unchecked, rate: ratio(fabricated, quotes - unchecked) };
}

function aggregate(scores) {
  const sum = (k) => scores.reduce((n, s) => n + (s[k] || 0), 0);
  const cost = (k) => scores.reduce((n, s) => n + ((s.cost && s.cost[k]) || 0), 0);
  const scored = scores.filter((s) => s.status !== 'NO_RESULT');
  const expected = sum('expected');
  // A NO_RESULT case is a gap: its labels stay in `expected` for the report
  // but are excluded from the recall denominator.
  const scoredExpected = scored.reduce((n, s) => n + (s.scored_expected == null ? (s.expected || 0) : s.scored_expected), 0);
  const found = scored.reduce((n, s) => n + (s.found || 0), 0);
  const nearFound = scored.reduce((n, s) => n + (s.near_found || 0), 0);
  const coreExpected = scored.reduce((n, s) => n + (s.core_expected || 0), 0);
  const coreFound = scored.reduce((n, s) => n + (s.core_found || 0), 0);
  const tp = sum('tp');
  const fp = sum('fp');
  const notExpected = sum('not_expected');
  // USD only when every case is priced: a missing price is never 0.
  const usd = scores.length && scores.every((s) => s.cost && typeof s.cost.usd === 'number') ? Math.round(scores.reduce((n, s) => n + s.cost.usd, 0) * 10000) / 10000 : null;
  const time = (k) => quantiles(scores.map((s) => s.time && s.time[k]));
  return {
    cases: scores.length,
    completed: scores.filter((s) => s.status === 'EXECUTED_PASS').length,
    expected,
    scored_expected: scoredExpected,
    found,
    recall: ratio(found, scoredExpected),
    near_found: nearFound,
    recall_upper: ratio(found + nearFound, scoredExpected),
    core_expected: coreExpected,
    core_found: coreFound,
    recall_core: ratio(coreFound, coreExpected),
    severity_ok: sum('severity_ok'),
    tp,
    fp,
    unlabelled: sum('unlabelled'),
    not_expected: notExpected,
    // No not_expected labels means precision has no real denominator. Show
    // it as null (N/A), not as a perfect score.
    precision: notExpected ? ratio(tp, tp + fp) : null,
    precision_denominator: tp + fp,
    ...precisionBounds(tp, fp, sum('unlabelled')),
    gaps: scores.filter((s) => s.status === 'NO_RESULT').length,
    calls: cost('calls'),
    input_tokens: cost('input_tokens'),
    cached_input_tokens: cost('cached_input_tokens'),
    output_tokens: cost('output_tokens'),
    usd,
    usd_per_tp: usd != null && tp ? Math.round((usd / tp) * 10000) / 10000 : null,
    unpriced: [...new Set(scores.flatMap((s) => (s.cost && s.cost.unpriced) || []))],
    evidence: { final: quoteTotals(scores, 'final'), attempts: quoteTotals(scores, 'attempts') },
    reads: measure.readsTotal(scores.map((s) => s.reads)),
    wall_ms: quantiles(scores.map((s) => s.wall_ms)),
    model_ms: time('model_ms'),
    exec_ms: time('exec_ms'),
    wait_ms: time('wait_ms'),
  };
}

// Totals pool every repeat; with k > 1, the spread across repeats and how
// much they agree.
function finalize(card) {
  card.repeat = card.repeat || 1;
  card.totals = aggregate(card.cases);
  card.gaps = card.cases
    .filter((s) => s.status === 'NO_RESULT')
    .map((s) => ({ id: s.id, repeat: s.repeat || 1, reason: s.gap || s.error || 'NO_RESULT' }));
  const byCase = new Map();
  for (const s of card.cases) {
    const a = byCase.get(s.id) || { id: s.id, n: 0, recall: [], precision: [], found: [] };
    a.n += 1;
    if (s.recall != null) a.recall.push(s.recall);
    if (s.precision != null) a.precision.push(s.precision);
    a.found.push(s.found || 0);
    byCase.set(s.id, a);
  }
  card.case_spread = [...byCase.values()].map((a) => ({
    id: a.id,
    n: a.n,
    recall: stats.meanSd(a.recall),
    precision: stats.meanSd(a.precision),
    found: stats.meanSd(a.found),
  }));
  const k = card.repeat;
  if (k > 1) {
    const groups = Array.from({ length: k }, (_, i) => card.cases.filter((x) => (x.repeat || 1) === i + 1)).filter((g) => g.length);
    const per = groups.map((g) => aggregate(g));
    const meanWall = (g) => (g.length ? g.reduce((n, x) => n + (x.wall_ms || 0), 0) / g.length : null);
    card.repeats = {
      recall: stats.meanSd(per.map((t) => t.recall)),
      precision: stats.meanSd(per.map((t) => t.precision)),
      usd: stats.meanSd(per.map((t) => t.usd)),
      wall_ms: stats.meanSd(groups.map(meanWall)),
    };
    card.stability = stats.stability(groups);
  }
  return card;
}

function pricesNote(prices) {
  return prices ? { date: prices.date || null, models: prices.models || {} } : null;
}

function pct(x) {
  return x == null ? '–' : `${Math.round(x * 1000) / 10}%`;
}

// One line for any totals or case score: the point value on labelled
// findings, and the range the unlabelled ones leave open.
function precisionText(t) {
  const unlabelled = t.unlabelled || 0;
  // Counted from tp/fp/unlabelled, so scorecards written before the range
  // existed show it too.
  const r = precisionBounds(t.tp || 0, t.fp || 0, unlabelled).precision_range;
  if (!r) return 'no findings';
  const point = t.precision == null ? 'not measurable (no not_expected labels)' : `${pct(t.precision)} of ${(t.tp || 0) + (t.fp || 0)} labelled`;
  if (!unlabelled) return point;
  return `${point} · range ${pct(r.lo).replace('%', '')}–${pct(r.hi)} (${unlabelled} unlabelled)`;
}

const secs = (q) => (q && q.p50 != null ? `${Math.round(q.p50 / 1000)}/${Math.round(q.p95 / 1000)}` : '–');

function renderScorecard(card) {
  const t = card.totals;
  const lines = [
    `# Eval ${card.id}`,
    '',
    `- started ${card.started_at}, finished ${card.finished_at || '(running)'} · tool \`${card.tool_sha256.slice(0, 12)}\` · arw commit \`${(card.arw_commit || '?').slice(0, 12)}\` · model ${card.model || 'default'} · config ${card.config || 'per-case flags'} · repeat ${card.repeat || 1}${(card.repeat || 1) === 1 ? ' (one run per case: spread not measured)' : ''}`,
    `- **recall ${pct(t.recall)}** (${t.found}/${t.scored_expected == null ? t.expected : t.scored_expected} scored expected defects found${t.gaps ? `; ${t.expected - (t.scored_expected == null ? t.expected : t.scored_expected)} label(s) in ${t.gaps} NO_RESULT gap(s)` : ''}, ${t.severity_ok} at the expected severity)${t.near_found ? ` · up to ${pct(t.recall_upper)} if the ${t.near_found} near miss(es) are confirmed` : ''}${t.core_expected ? ` · core labels (no Low, style, doc or speculative): ${pct(t.recall_core)} (${t.core_found}/${t.core_expected})` : ''} · ${t.not_expected ? `**precision ${pct(t.precision)}** on labelled findings (${t.tp} true, ${t.fp} known false; ${t.not_expected} not_expected label(s))` : `**precision not measurable: no not_expected labels** (${t.tp} true, ${t.fp} known false)`} · ${t.unlabelled} unlabelled${t.unlabelled && t.precision_range ? ` · **precision range ${pct(t.precision_range.lo).replace('%', '')}–${pct(t.precision_range.hi)}** until they are labelled` : ''}`,
    `- ${t.completed}/${t.cases} case(s) complete · ${t.calls} model calls · tokens in ${t.input_tokens} (cached ${t.cached_input_tokens || 0}) / out ${t.output_tokens}`,
    `- reads: ${t.reads && t.reads.calls ? `${t.reads.commands} shell commands in ${t.reads.calls} counted call(s), ${t.reads.per_call} per call` : 'not counted (receipts without command counts)'}`,
    `- cost ${t.usd == null ? `USD unknown${t.unpriced && t.unpriced.length ? ` (no price for ${t.unpriced.join(', ')})` : ''}` : `$${t.usd} · $${t.usd_per_tp == null ? '–' : t.usd_per_tp} per true positive`}${card.prices && card.prices.date ? ` · prices of ${card.prices.date}` : ''}`,
    `- fabricated quotes: final ${t.evidence ? `${t.evidence.final.fabricated}/${t.evidence.final.quotes} (${t.evidence.final.unchecked || 0} unchecked)` : '–'} · in all model attempts ${t.evidence ? `${t.evidence.attempts.fabricated}/${t.evidence.attempts.quotes} (${t.evidence.attempts.unchecked || 0} unchecked)` : '–'}`,
    `- time per case p50/p95 (s): wall ${secs(t.wall_ms)} · model ${secs(t.model_ms)} · execution ${secs(t.exec_ms)} · rate-limit waiting ${secs(t.wait_ms)}`,
    ...(card.quota_waits && card.quota_waits.length ? [`- usage limit waited out ${card.quota_waits.length} time(s): ${card.quota_waits.map((w) => `${w.case} until ${w.until}`).join(', ')}`] : []),
    ...(card.stopped ? [`- **stopped**: ${card.stopped}`] : []),
    '',
    '| Case | Status | Recall | Precision | TP | FP | Unlabelled | Calls | Missed |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of card.cases) {
    const missed = s.status === 'NO_RESULT'
      ? 'NO_RESULT (gap, excluded from recall)'
      : (s.details.expected || []).filter((e) => !e.found).map((e) => e.id + (e.withdrawn_by && e.withdrawn_by.length ? ' (withdrawn by red team)' : '')).join(', ') || '–';
    lines.push(`| ${s.id} | ${s.status} | ${pct(s.recall)} | ${pct(s.precision)} | ${s.tp} | ${s.fp} | ${s.unlabelled} | ${s.cost ? s.cost.calls : 0} | ${missed} |`);
  }
  const decision = [
    `- repeat: ${card.repeat || 1}${(card.repeat || 1) === 1 ? ' (one run per case: the per-case spread is not measured; use --repeat k)' : ''}`,
    `- precision denominator: ${t.not_expected ? `${t.not_expected} not_expected label(s)` : 'none (N/A; not a perfect score)'}`,
    `- gaps: ${(card.gaps || []).length} case(s) with NO_RESULT, excluded from recall`,
  ];
  lines.push('', '## Decision', '', ...decision);
  if (card.case_spread && card.case_spread.length) {
    const spread = (x) => (x.mean == null ? '–' : `${pct(x.mean)} ± ${pct(x.sd)}`);
    const countSpread = (x) => (x.mean == null ? '–' : `${x.mean} ± ${x.sd}`);
    lines.push('', '## Per-case spread', '', '| Case | Runs | Recall mean ± sd | Precision mean ± sd | Found mean ± sd |', '|---|---|---|---|---|',
      ...card.case_spread.map((s) => `| ${s.id} | ${s.n} | ${spread(s.recall)} | ${spread(s.precision)} | ${countSpread(s.found)} |`));
  }
  if ((card.gaps || []).length) lines.push('', '## Gaps (NO_RESULT, not counted as misses)', '', ...card.gaps.map((g) => `- ${g.id}${g.repeat > 1 ? ` (repeat ${g.repeat})` : ''}: ${g.reason}`));
  const failed = card.cases.filter((s) => s.error);
  if (failed.length) lines.push('', '## Cases without a clean result', '', ...failed.map((s) => `- ${s.id} (exit ${s.exit_code}): ${s.error}`));
  const nears = card.cases.flatMap((s) => ((s.details && s.details.expected) || []).filter((e) => !e.found && (e.near || []).length).map((e) => {
    const rep = (s.repeat || 1) > 1 ? ` --repeat ${s.repeat}` : '';
    const titles = new Map(((s.details && s.details.findings) || []).map((f) => [f.id, f.title]));
    return [`- ${s.id}${rep ? ` (repeat ${s.repeat})` : ''} · ${e.id}${e.prose ? `: ${String(e.prose).slice(0, 140)}` : ''}`,
      ...e.near.map((id) => `  - \`${id}\` ${titles.get(id) || ''} — if it is the same defect: \`arw eval label --run ${card.id} --case ${s.id} --finding ${id} --as tp --to ${e.id}${rep}\``)];
  }).flat());
  if (nears.length) lines.push('', '## Near misses', '', 'A finding at the code of a missed label that its lines or keywords did not admit. Not counted until a person links it.', '', ...nears);
  const approx = card.cases.flatMap((s) => (s.details.expected || []).filter((e) => e.approx && e.found).map((e) => `- ${s.id} · ${e.id} by \`${e.by.join(', ')}\`: ${String(e.prose || '').slice(0, 160)}`));
  if (approx.length) lines.push('', '## Prose labels matched by keywords', '', 'These came from comments without coordinates: check each finding says the same thing.', '', ...approx);
  const unl = card.cases.flatMap((s) => (s.details.findings || []).filter((f) => f.verdict === 'unlabelled').map((f) => `- ${s.id} · \`${f.id}\` [${f.severity}] ${f.title}${f.path ? ` (${f.path})` : ''}`));
  if (unl.length) lines.push('', '## Unlabelled findings', '', 'Label them (`arw eval label ...`) so the next run measures them:', '', ...unl);
  return `${lines.join('\n')}\n`;
}

// ---------- running ----------
function runOne(c, { outDir, arw = path.join(ROOT, 'src', 'cli', 'arw.js'), timeoutMs, log, configFlags = null, dirName = c.id }) {
  const caseDir = ensureDir(path.join(outDir, 'cases', dirName));
  const rawPrompt = Boolean(configFlags && configFlags.raw);
  const args = rawPrompt
    ? [arw, 'raw-review', '--repo', c.repo, '--base', c.base, '--head', c.head, '--out', path.join(caseDir, 'raw')]
    : [arw, 'review', '--local', c.repo, '--base', c.base, '--head', c.head];
  const flags = { noRepro: true, ...(c.flags || {}), ...(configFlags || {}) };
  if (!rawPrompt) for (const k of FLAGS) if (flags[k]) args.push(`--${k.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}`);
  // Worktrees go to a short path: git on Windows refuses long worktree paths.
  const wtDir = path.join(worktreeRoot(), `ev-${sha256(caseDir).slice(0, 10)}`);
  const env = { ...process.env, ARW_RUNS_DIR: path.join(caseDir, 'runs'), ARW_WT_DIR: wtDir };
  const logFile = fs.openSync(path.join(caseDir, 'review.log'), 'w');
  log(`case ${c.id}: ${c.base.slice(0, 12)}..${c.head.slice(0, 12)} in ${c.repo}`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', logFile, logFile], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.closeSync(logFile);
      const prs = path.join(caseDir, 'runs', 'prs');
      const runDir = rawPrompt ? (fs.existsSync(path.join(caseDir, 'raw', 'raw-review.json')) ? path.join(caseDir, 'raw') : null) : fs.existsSync(prs) ? fs.readdirSync(prs).map((d) => path.join(prs, d)).find((d) => fs.existsSync(path.join(d, 'run.json'))) : null;
      // The review worktree belongs to the case repository; do not leave it registered there.
      if (fs.existsSync(wtDir)) {
        for (const d of fs.readdirSync(wtDir)) git.git(c.repo, ['worktree', 'remove', '--force', path.join(wtDir, d)], { allowFail: true });
        fs.rmSync(wtDir, { recursive: true, force: true });
      }
      git.git(c.repo, ['worktree', 'prune'], { allowFail: true });
      const tail = fs.readFileSync(path.join(caseDir, 'review.log'), 'utf8').trim().split('\n').slice(-3).join(' | ').slice(0, 500);
      resolve({ exit_code: code, elapsed_ms: Date.now() - started, runDir, caseDir, tail });
    });
  });
}

function evalRunId(label) {
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  return `${stamp}${label ? `-${String(label).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}` : ''}`;
}

// repeat: each case k times, each in its own runs dir. shouldStop(card) is
// asked before every case; a reason stops the run cleanly, scorecard kept.
// A case cut by the account's usage limit: the review log (the driver's
// lines and the CLI's error) or a raw-prompt receipt names it.
function usageLimitOf(res, now) {
  const texts = [];
  const log = path.join(res.caseDir, 'review.log');
  if (fs.existsSync(log)) texts.push(fs.readFileSync(log, 'utf8'));
  const raw = readJsonIfExists(path.join(res.caseDir, 'raw', 'raw-review.json'));
  for (const r of (raw && raw.receipts) || []) if (r.error_message) texts.push(r.error_message);
  return lastUsageLimit(texts.join('\n'), now);
}

// After the usage limit: wait for the reset when it comes within
// ARW_EVAL_QUOTA_WAIT_HOURS (default 6) and run the case again (its valid
// packets are reused); otherwise stop. The cut case is never scored: a miss
// it did not have the calls to find is not a miss.
const QUOTA_MARGIN_MS = 2 * 60 * 1000;

async function runEval({ only, label, config = null, log = () => {}, arw, timeoutMs = envInt('ARW_EVAL_TIMEOUT_MS', 3600000), repeat = 1, shouldStop = null, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat: a positive integer');
  if (config && !CONFIGS[config]) throw new Error(`--config: one of ${Object.keys(CONFIGS).join(', ')}`);
  const cases = loadCases({ only });
  if (!cases.length) throw new Error(`no eval cases in ${casesDir()}${only ? ` matching ${only.join(', ')}` : ''}`);
  const bad = cases.filter((c) => c.errors.length);
  if (bad.length) throw new Error(bad.map((c) => `${path.basename(c.file)}: ${c.errors.join('; ')}`).join('\n'));
  let id = evalRunId(label);
  for (let n = 2; fs.existsSync(path.join(runsDir(), id)); n += 1) id = `${evalRunId(label)}-${n}`;
  const outDir = ensureDir(path.join(runsDir(), id));
  const card = {
    id,
    label: label || null,
    started_at: nowIso(),
    finished_at: null,
    tool_sha256: toolDigest(),
    arw_commit: (git.git(ROOT, ['rev-parse', 'HEAD'], { allowFail: true }) || '').trim() || null,
    model: process.env.CODEX_MODEL || null,
    judge_model: process.env.CODEX_JUDGE_MODEL || null,
    effort: process.env.CODEX_EFFORT || null,
    executor: process.env.ARW_EXECUTOR_MODULE ? 'custom' : 'codex',
    config: config || 'per-case flags',
    prices: pricesNote(measure.loadPrices()),
    repeat,
    stopped: null,
    quota_waits: [],
    cases: [],
    totals: null,
  };
  const save = () => {
    finalize(card);
    writeJsonAtomic(path.join(outDir, 'scorecard.json'), card);
    writeFileAtomic(path.join(outDir, 'scorecard.md'), renderScorecard(card));
  };
  save();
  const maxWaitMs = Number(process.env.ARW_EVAL_QUOTA_WAIT_HOURS || 6) * 3600000;
  run: for (let r = 1; r <= repeat; r += 1) {
    for (const [i, c] of cases.entries()) {
      const why = shouldStop ? shouldStop(card) : null;
      if (why) {
        card.stopped = why;
        log(`stopped: ${why}`);
        break run;
      }
      let res;
      for (let waits = 0; ; waits += 1) {
        res = await runOne(c, { outDir, arw, timeoutMs, log, configFlags: config ? CONFIGS[config] : null, dirName: repeat > 1 ? `${c.id}__r${r}` : c.id });
        const limit = usageLimitOf(res, now());
        if (!limit) break;
        const wait = limit.reset ? limit.reset.getTime() - now().getTime() + QUOTA_MARGIN_MS : null;
        if (wait == null || wait > maxWaitMs || waits >= 2) {
          const left = [...cases.slice(i).map((x) => x.id), ...(r < repeat ? [`repeats ${r + 1}-${repeat}`] : [])];
          card.stopped = `usage limit until ${limit.reset ? limit.reset.toISOString() : 'an unknown time'}${waits >= 2 ? ' (still hit after two waits)' : ''}; not run: ${left.join(', ')}`;
          log(`stopped: ${card.stopped}`);
          break run;
        }
        const until = new Date(now().getTime() + wait);
        card.quota_waits.push({ case: c.id, at: now().toISOString(), until: until.toISOString(), message: limit.message });
        save();
        log(`usage limit: waiting until ${until.toISOString()} then running ${c.id} again`);
        await sleep(wait);
      }
      const score = { ...scoreCase(c, res.runDir), repeat: r, exit_code: res.exit_code, wall_ms: res.elapsed_ms, run_dir: res.runDir ? path.relative(outDir, res.runDir).split(path.sep).join('/') : null };
      if (score.status === 'NO_RESULT' || res.exit_code !== 0) score.error = res.tail;
      card.cases.push(score);
      log(`case ${c.id}${repeat > 1 ? ` (repeat ${r})` : ''}: ${score.status} · recall ${pct(score.recall)} · precision ${pct(score.precision)} · ${score.unlabelled} unlabelled · ${score.cost ? score.cost.calls : 0} calls`);
      save();
    }
  }
  card.finished_at = nowIso();
  save();
  return { outDir, card };
}

// Re-score an earlier eval run against the current labels (no model calls):
// after labelling, the same review is measured again.
function rescore(runId) {
  const outDir = path.join(runsDir(), runId);
  const card = readJson(path.join(outDir, 'scorecard.json'));
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  card.cases = card.cases.map((s) => {
    const c = cases.get(s.id);
    if (!c) return s;
    return { ...s, ...scoreCase(c, s.run_dir ? path.join(outDir, s.run_dir) : null) };
  });
  finalize(card);
  card.prices = pricesNote(measure.loadPrices());
  card.rescored_at = nowIso();
  writeJsonAtomic(path.join(outDir, 'scorecard.json'), card);
  writeFileAtomic(path.join(outDir, 'scorecard.md'), renderScorecard(card));
  return card;
}

function listRuns() {
  if (!fs.existsSync(runsDir())) return [];
  return fs.readdirSync(runsDir()).map((id) => readJsonIfExists(path.join(runsDir(), id, 'scorecard.json'))).filter(Boolean)
    .map(({ cases, ...rest }) => ({ ...rest, case_ids: cases.map((c) => c.id) }))
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

function loadRun(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad eval run id');
  const card = readJsonIfExists(path.join(runsDir(), id, 'scorecard.json'));
  if (!card) throw new Error(`no eval run ${id}`);
  return card;
}

// Scores of a stored run against the current labels (nothing is written),
// so two runs are compared on the same labels.
function scoredNow(id) {
  const card = loadRun(id);
  const outDir = path.join(runsDir(), id);
  const cases = new Map(loadCases().map((c) => [c.id, c]));
  const scored = card.cases.map((s) => (cases.get(s.id) ? { ...s, ...scoreCase(cases.get(s.id), s.run_dir ? path.join(outDir, s.run_dir) : null) } : s));
  return finalize({ ...card, cases: scored });
}

// What changed between two eval runs, case by case, on the current labels.
function compare(aId, bId, { allowToolDiff = false } = {}) {
  const a = scoredNow(aId);
  const b = scoredNow(bId);
  const byId = new Map(a.cases.map((s) => [s.id, s]));
  const rows = b.cases.map((s) => {
    const o = byId.get(s.id);
    const foundIds = (x) => new Set(((x && x.details.expected) || []).filter((e) => e.found).map((e) => e.id));
    const before = foundIds(o);
    const after = foundIds(s);
    return {
      id: s.id,
      recall: [o ? o.recall : null, s.recall],
      precision: [o ? o.precision : null, s.precision],
      fp: [o ? o.fp : null, s.fp],
      calls: [o && o.cost ? o.cost.calls : null, s.cost ? s.cost.calls : null],
      newly_missed: [...before].filter((x) => !after.has(x)),
      newly_found: [...after].filter((x) => !before.has(x)),
    };
  });
  return { a: { id: a.id, totals: a.totals, model: a.model, config: a.config, tool: a.tool_sha256 }, b: { id: b.id, totals: b.totals, model: b.model, config: b.config, tool: b.tool_sha256 }, rows, stats: pairedStats(a, b, { allowToolDiff }) };
}

// Per case, averaged over its repeats; per label, found by a majority of them.
function perCase(card) {
  const out = new Map();
  for (const s of card.cases) {
    const o = out.get(s.id) || { n: 0, found: 0, expected: 0, not_expected: 0, tp: 0, fp: 0, usd: 0, priced: true, wall: 0, labels: new Map() };
    o.n += 1;
    o.found += s.found || 0;
    // A NO_RESULT case is a gap, not a miss, so it leaves the denominator.
    o.expected += s.status === 'NO_RESULT' ? 0 : (s.expected || 0);
    o.not_expected += s.not_expected || 0;
    o.tp += s.tp || 0;
    o.fp += s.fp || 0;
    if (s.cost && typeof s.cost.usd === 'number') o.usd += s.cost.usd;
    else o.priced = false;
    o.wall += s.wall_ms || 0;
    for (const e of (s.details && s.details.expected) || []) o.labels.set(e.id, (o.labels.get(e.id) || 0) + (e.found ? 1 : 0));
    out.set(s.id, o);
  }
  for (const o of out.values()) {
    for (const k of ['found', 'expected', 'tp', 'fp', 'usd', 'wall']) o[k] /= o.n;
    if (!o.priced) o.usd = null;
    o.majority = new Map([...o.labels].map(([id, hits]) => [id, hits / o.n >= 0.5]));
  }
  return out;
}

// McNemar on the labels both runs scored, and bootstrap CIs (cases resampled,
// fixed seed) for B - A. Runs on different tool code are not compared.
function pairedStats(a, b, { n = 10000, seed = 42, allowToolDiff = false } = {}) {
  const toolDiff = a.tool_sha256 !== b.tool_sha256
    ? `tool_sha256 differs (${String(a.tool_sha256).slice(0, 12)} vs ${String(b.tool_sha256).slice(0, 12)})`
    : null;
  if (toolDiff && !allowToolDiff) return { tool_mismatch: `${toolDiff}: rerun both on the same code, or pass --allow-tool-diff to compare and see the warning` };
  const pa = perCase(a);
  const pb = perCase(b);
  const ids = [...pa.keys()].filter((id) => pb.has(id)).sort();
  let only_a = 0;
  let only_b = 0;
  for (const id of ids) {
    for (const [label, foundA] of pa.get(id).majority) {
      if (!pb.get(id).majority.has(label)) continue;
      const foundB = pb.get(id).majority.get(label);
      if (foundA && !foundB) only_a += 1;
      if (!foundA && foundB) only_b += 1;
    }
  }
  const ra = ids.map((id) => pa.get(id));
  const rb = ids.map((id) => pb.get(id));
  const sum = (rows, k) => rows.reduce((x, r) => x + r[k], 0);
  const recall = (rows) => (sum(rows, 'expected') ? sum(rows, 'found') / sum(rows, 'expected') : null);
  const precision = (rows) => (sum(rows, 'not_expected') && sum(rows, 'tp') + sum(rows, 'fp') ? sum(rows, 'tp') / (sum(rows, 'tp') + sum(rows, 'fp')) : null);
  const usdPerTp = (rows) => (rows.every((r) => r.usd != null) && sum(rows, 'tp') ? sum(rows, 'usd') / sum(rows, 'tp') : null);
  const wall = (rows) => (rows.length ? sum(rows, 'wall') / rows.length : null);
  const opts = { n, seed };
  return {
    tool_mismatch: null,
    tool_changed: toolDiff,
    cases: ids.length,
    mcnemar: stats.mcnemar(only_a, only_b),
    recall_diff: stats.bootstrapDiff(ra, rb, recall, opts),
    precision_diff: stats.bootstrapDiff(ra, rb, precision, opts),
    usd_per_tp_diff: stats.bootstrapDiff(ra, rb, usdPerTp, opts),
    wall_ms_diff: stats.bootstrapDiff(ra, rb, wall, opts),
  };
}

// ---------- matrix ----------
// Cells run one after another, each with its env (model, effort...) set for
// its review processes. Before every case the accumulated spend is checked
// against the budget; reaching it stops cleanly and keeps every scorecard.
async function runMatrix({ cells, label = 'matrix', budget = {}, repeat = 1, only, log = () => {}, arw } = {}) {
  const started = Date.now();
  const done = [];
  let stopped = null;
  let tool = null;
  for (const cell of cells) {
    if (stopped) break;
    if (!cell.name || !/^[A-Za-z0-9._-]+$/.test(cell.name)) throw new Error('every cell needs a name of letters, digits, . _ -');
    const saved = {};
    for (const [k, v] of Object.entries(cell.env || {})) {
      saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
      process.env[k] = String(v);
    }
    const spentBefore = () => done.reduce((acc, d) => ({ calls: acc.calls + d.card.totals.calls, usd: acc.usd == null || d.card.totals.usd == null ? null : acc.usd + d.card.totals.usd }), { calls: 0, usd: 0 });
    const shouldStop = (card) => {
      const before = spentBefore();
      const calls = before.calls + ((card.totals && card.totals.calls) || 0);
      const usd = before.usd == null || !card.totals || card.totals.usd == null ? null : before.usd + card.totals.usd;
      if (tool && card.tool_sha256 !== tool) return `the tool code changed during the matrix (${tool.slice(0, 12)} -> ${card.tool_sha256.slice(0, 12)})`;
      if (budget.calls && calls >= budget.calls) return `budget: ${budget.calls} model calls reached (${calls})`;
      if (budget.usd && card.cases.length && usd == null) return `budget: ${budget.usd} USD cannot be checked, a price is missing (${(card.totals.unpriced || []).join(', ') || 'unknown'})`;
      if (budget.usd && usd != null && usd >= budget.usd) return `budget: ${budget.usd} USD reached (${Math.round(usd * 100) / 100})`;
      if (budget.hours && (Date.now() - started) / 3600000 >= budget.hours) return `budget: ${budget.hours} hours of wall clock reached`;
      return null;
    };
    try {
      log(`cell ${cell.name}: ${cell.config} ${JSON.stringify(cell.env || {})}`);
      const { card } = await runEval({ only, label: `${label}-${cell.name}`, config: cell.config, repeat, shouldStop, log, arw });
      tool = tool || card.tool_sha256;
      done.push({ name: cell.name, card });
      if (card.stopped) stopped = card.stopped;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const summary = { label, started_at: new Date(started).toISOString(), finished_at: nowIso(), budget, repeat, stopped, tool_sha256: tool, cells: done.map((d) => ({ name: d.name, run: d.card.id, config: d.card.config, model: d.card.model, totals: d.card.totals })) };
  writeJsonAtomic(path.join(ensureDir(path.join(evalDir(), 'matrix')), `${evalRunId(label)}.json`), summary);
  return { cells: done, stopped, summary };
}

// ---------- blind labelling ----------
// Every unlabelled finding of the given runs, shuffled, with nothing naming
// the model or configuration. The key that maps them back is a separate file.
function blindExport(runIds, { out, seed = 1 } = {}) {
  if (!out) throw new Error('--out: a directory outside the repository');
  const dir = path.resolve(out);
  const rel = path.relative(ROOT, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`--out must be outside the repository (${ROOT})`);
  const items = [];
  for (const id of runIds) {
    const card = scoredNow(id);
    for (const s of card.cases) {
      const res = s.run_dir ? reviewFindings(path.join(runsDir(), id, s.run_dir)) : null;
      if (!res) continue;
      for (const f of (s.details && s.details.findings) || []) {
        if (f.verdict !== 'unlabelled') continue;
        const full = res.shown.find((x) => x.id === f.id);
        if (!full) continue;
        items.push({
          item: { case: s.id, severity: full.severity, title: full.title, asis: full.asis, tobe: full.tobe, impact: full.impact || '', evidence: (full.evidence || []).filter((e) => e.kind === 'code').map((e) => ({ path: e.path, start_line: e.start_line, end_line: e.end_line, quote: e.quote })) },
          key: { run: id, case: s.id, repeat: s.repeat || 1, finding: f.id },
        });
      }
    }
  }
  const rand = stats.mulberry32(seed);
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const width = String(items.length).length;
  const blind = items.map((x, i) => ({ blind_id: `B${String(i + 1).padStart(width, '0')}`, ...x }));
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, 'items.json'), blind.map((x) => ({ blind_id: x.blind_id, ...x.item })));
  writeJsonAtomic(path.join(dir, 'key.json'), Object.fromEntries(blind.map((x) => [x.blind_id, x.key])));
  writeJsonAtomic(path.join(dir, 'labels.json'), Object.fromEntries(blind.map((x) => [x.blind_id, ''])));
  return { items: blind.length, dir };
}

// labels.json: { blind_id: "tp" | "fp" | "" } filled in by a person.
function blindImport({ key, labels }) {
  const k = readJson(path.resolve(key));
  const l = readJson(path.resolve(labels));
  const applied = [];
  for (const [bid, as] of Object.entries(l)) {
    if (!as) continue;
    if (!['tp', 'fp'].includes(as)) throw new Error(`${bid}: label "tp", "fp" or leave it empty`);
    const src = k[bid];
    if (!src) throw new Error(`${bid}: not in the key`);
    const label = labelFinding({ runId: src.run, caseId: src.case, repeat: src.repeat, findingId: src.finding, as });
    applied.push({ blind_id: bid, as, label: label.id, case: src.case });
  }
  return applied;
}

// ---------- building the corpus ----------
function keywordsOf(title) {
  return [...words(title)].sort((x, y) => /\d/.test(y) - /\d/.test(x) || y.length - x.length).slice(0, 3);
}

function labelFrom(f, id, extra = {}) {
  const ev = (f.evidence || []).find((e) => e.kind === 'code' && e.revision !== 'base') || (f.evidence || []).find((e) => e.kind === 'code');
  if (!ev) return null;
  return { id, path: ev.path, lines: [ev.start_line, ev.end_line], keywords: keywordsOf(f.title), ...extra, from_finding: f.id, title: f.title };
}

function writeCase(c, { force = false } = {}) {
  const file = path.join(ensureDir(casesDir()), `${c.id}.json`);
  if (fs.existsSync(file) && !force) throw new Error(`case ${c.id} exists (${file}); pass --force to replace it`);
  const { file: _f, errors: _e, ...clean } = c;
  writeJsonAtomic(file, clean);
  return file;
}

// A case from a reviewed PR: what the person kept on GitHub is expected,
// what they deleted or rejected is a known false positive.
function caseFromRun(runDir, { id, force } = {}) {
  const run = readJson(path.join(runDir, 'run.json'));
  const idn = run.identity;
  const res = reviewFindings(runDir);
  if (!res) throw new Error('the run has no validated review');
  const byId = new Map([...res.shown, ...res.withdrawn].map((f) => [f.id, f]));
  const fb = readJsonIfExists(path.join(runDir, 'feedback.json'));
  const { loadMemory } = require('./memory');
  const rejected = new Set(loadMemory().entries.filter((e) => e.run === path.basename(runDir)).map((e) => e.finding_id));
  const expected = [];
  const notExpected = [];
  for (const f of (fb && fb.findings) || []) {
    const full = byId.get(f.id);
    if (!full) continue;
    if (['kept', 'edited'].includes(f.verdict)) expected.push(labelFrom(full, `E${expected.length + 1}`, { severity_at_least: full.severity }));
  }
  for (const fid of new Set([...((fb && fb.findings) || []).filter((f) => f.verdict === 'dropped').map((f) => f.id), ...rejected])) {
    const full = byId.get(fid);
    if (full) notExpected.push(labelFrom(full, `N${notExpected.length + 1}`, { why: 'rejected by a person' }));
  }
  const c = {
    id: id || path.basename(runDir),
    repo: (idn.local && idn.local.dir) || idn.source_checkout,
    base: idn.base_sha,
    head: idn.head_sha,
    source: { repo: idn.repo, pr: idn.pr, url: idn.url || null, created_from: path.basename(runDir), at: nowIso() },
    expected: expected.filter(Boolean),
    not_expected: notExpected.filter(Boolean),
  };
  const errors = validateCase(c);
  if (errors.length) throw new Error(`cannot build a case: ${errors.join('; ')} (label findings first: arw feedback, or reject in the dashboard)`);
  return { file: writeCase(c, { force }), case: c };
}

// Label one finding of an eval run as a true (tp) or false (fp) positive in
// its case file.
function labelFinding({ runId, caseId, findingId, as, severity, linkTo, repeat = null }) {
  if (!['tp', 'fp'].includes(as)) throw new Error('--as tp|fp');
  if (linkTo && as !== 'tp') throw new Error('--label links a true positive to a prose label');
  const card = loadRun(runId);
  const s = card.cases.find((x) => x.id === caseId && (repeat == null || (x.repeat || 1) === repeat));
  if (!s || !s.run_dir) throw new Error(`case ${caseId} has no run in ${runId}`);
  const res = reviewFindings(path.join(runsDir(), runId, s.run_dir));
  const f = res && [...res.shown, ...res.withdrawn].find((x) => x.id === findingId);
  if (!f) throw new Error(`no finding ${findingId} in ${runId}/${caseId}`);
  const c = loadCases({ only: [caseId] })[0];
  if (!c) throw new Error(`no case ${caseId}`);
  if (linkTo) {
    const target = (c.expected || []).find((e) => e.id === linkTo);
    if (!target) throw new Error(`no expected label ${linkTo} in ${caseId}`);
    const anchor = labelFrom(f, linkTo);
    if (!anchor) throw new Error(`${findingId} cites no code to anchor a label on`);
    target.anchors = [...(target.anchors || []), { path: anchor.path, lines: anchor.lines, from_finding: f.id, title: f.title }];
    writeCase(c, { force: true });
    return { ...anchor, linked: linkTo };
  }
  const list = as === 'tp' ? (c.expected = c.expected || []) : (c.not_expected = c.not_expected || []);
  const label = labelFrom(f, `${as === 'tp' ? 'E' : 'N'}${list.length + 1}`, as === 'tp' ? { severity_at_least: severity || f.severity } : { why: 'labelled false positive' });
  if (!label) throw new Error(`${findingId} cites no code to anchor a label on`);
  list.push(label);
  writeCase(c, { force: true });
  return label;
}

module.exports = { runMatrix, blindExport, blindImport, pairedStats, scoredNow, CONFIGS, evalDir, casesDir, writeCase, loadCases, validateCase, scoreCase, aggregate, finalize, renderScorecard, precisionText, runEval, rescore, listRuns, loadRun, compare, caseFromRun, labelFinding, matches, hitsLabel, nearMisses, assignProse, keywordsOf };
