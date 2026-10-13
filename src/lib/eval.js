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
const git = require('./git');

const LINE_SLACK = 3;
const FLAGS = ['singleRole', 'singleAgent', 'skipSeams', 'skipRebuttals', 'skipSynthesis', 'noRepro'];
// Named configurations, to compare on the same cases (same model and inputs):
// what the multi-agent waves add over one reviewer, and what execution adds.
const CONFIGS = {
  'single-agent': { singleAgent: true, noRepro: true },
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
  if (!l.path || typeof l.path !== 'string') errors.push(`${at}.path: the file the defect is in`);
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
  const aliased = new Set((synthesis ? synthesis.aliases : []).map((a) => a.id));
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
  const ev = (f.evidence || []).filter((e) => e.kind === 'code' && e.path === label.path);
  if (!ev.length) return false;
  if (label.lines && !ev.some((e) => e.start_line <= label.lines[1] + LINE_SLACK && label.lines[0] <= e.end_line + LINE_SLACK)) return false;
  if (label.keywords && label.keywords.length) {
    const text = `${f.title} ${f.asis} ${f.tobe} ${f.impact || ''}`.toLowerCase();
    if (!label.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  }
  return true;
}

function ratio(a, b) {
  return b ? Math.round((a / b) * 1000) / 1000 : null;
}

function scoreCase(c, runDir) {
  const res = runDir && reviewFindings(runDir);
  if (!res) return { id: c.id, status: 'NO_RESULT', expected: (c.expected || []).length, found: 0, recall: (c.expected || []).length ? 0 : null, tp: 0, fp: 0, unlabelled: 0, precision: null, details: { expected: [], findings: [] } };
  const { validation, shown, withdrawn } = res;
  const expected = (c.expected || []).map((e) => {
    const hits = shown.filter((f) => matches(f, e));
    const best = hits.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
    return {
      id: e.id,
      found: Boolean(best),
      by: hits.map((f) => f.id),
      severity: best ? best.severity : null,
      severity_ok: best ? !e.severity_at_least || SEVERITY_RANK[best.severity] <= SEVERITY_RANK[e.severity_at_least] : null,
      // The red team withdrew a real defect: a cost of the rebuttal stage.
      withdrawn_by: withdrawn.filter((f) => matches(f, e)).map((f) => f.id),
    };
  });
  const findings = shown.map((f) => {
    const exp = (c.expected || []).filter((e) => matches(f, e)).map((e) => e.id);
    const fps = (c.not_expected || []).filter((e) => matches(f, e)).map((e) => e.id);
    return { id: f.id, severity: f.severity, label: f.label, title: f.title, path: ((f.evidence || []).find((e) => e.kind === 'code') || {}).path || null, verdict: exp.length ? 'tp' : fps.length ? 'fp' : 'unlabelled', labels: exp.length ? exp : fps };
  });
  const tp = findings.filter((f) => f.verdict === 'tp').length;
  const fp = findings.filter((f) => f.verdict === 'fp').length;
  const found = expected.filter((e) => e.found).length;
  const u = validation.usage || {};
  const plan = u.plan || {};
  return {
    id: c.id,
    status: validation.status,
    complete: validation.complete,
    recommendation: validation.recommendation,
    recommendation_ok: c.expected_recommendation ? c.expected_recommendation === validation.recommendation : null,
    expected: expected.length,
    found,
    recall: ratio(found, expected.length),
    severity_ok: expected.filter((e) => e.severity_ok).length,
    tp,
    fp,
    unlabelled: findings.length - tp - fp,
    precision: ratio(tp, tp + fp),
    redteam_withdrew_real: expected.filter((e) => !e.found && e.withdrawn_by.length).map((e) => e.id),
    cost: { calls: (u.calls || 0) + (plan.calls || 0), input_tokens: (u.input_tokens || 0) + (plan.input_tokens || 0), output_tokens: (u.output_tokens || 0) + (plan.output_tokens || 0), elapsed_ms: u.elapsed_ms || 0 },
    details: { expected, findings },
  };
}

function aggregate(scores) {
  const sum = (k) => scores.reduce((n, s) => n + (s[k] || 0), 0);
  const cost = (k) => scores.reduce((n, s) => n + ((s.cost && s.cost[k]) || 0), 0);
  const expected = sum('expected');
  const tp = sum('tp');
  const fp = sum('fp');
  return {
    cases: scores.length,
    completed: scores.filter((s) => s.status === 'EXECUTED_PASS').length,
    expected,
    found: sum('found'),
    recall: ratio(sum('found'), expected),
    severity_ok: sum('severity_ok'),
    tp,
    fp,
    unlabelled: sum('unlabelled'),
    precision: ratio(tp, tp + fp),
    calls: cost('calls'),
    input_tokens: cost('input_tokens'),
    output_tokens: cost('output_tokens'),
  };
}

function pct(x) {
  return x == null ? '–' : `${Math.round(x * 1000) / 10}%`;
}

function renderScorecard(card) {
  const t = card.totals;
  const lines = [
    `# Eval ${card.id}`,
    '',
    `- started ${card.started_at}, finished ${card.finished_at || '(running)'} · tool \`${card.tool_sha256.slice(0, 12)}\` · arw commit \`${(card.arw_commit || '?').slice(0, 12)}\` · model ${card.model || 'default'} · config ${card.config || 'per-case flags'}`,
    `- **recall ${pct(t.recall)}** (${t.found}/${t.expected} expected defects found, ${t.severity_ok} at the expected severity) · **precision ${pct(t.precision)}** on labelled findings (${t.tp} true, ${t.fp} known false) · ${t.unlabelled} unlabelled`,
    `- ${t.completed}/${t.cases} case(s) complete · ${t.calls} model calls · tokens in ${t.input_tokens} / out ${t.output_tokens}`,
    '',
    '| Case | Status | Recall | Precision | TP | FP | Unlabelled | Calls | Missed |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of card.cases) {
    const missed = (s.details.expected || []).filter((e) => !e.found).map((e) => e.id + (e.withdrawn_by && e.withdrawn_by.length ? ' (withdrawn by red team)' : ''));
    lines.push(`| ${s.id} | ${s.status} | ${pct(s.recall)} | ${pct(s.precision)} | ${s.tp} | ${s.fp} | ${s.unlabelled} | ${s.cost ? s.cost.calls : 0} | ${missed.join(', ') || '–'} |`);
  }
  const failed = card.cases.filter((s) => s.error);
  if (failed.length) lines.push('', '## Cases without a clean result', '', ...failed.map((s) => `- ${s.id} (exit ${s.exit_code}): ${s.error}`));
  const unl = card.cases.flatMap((s) => (s.details.findings || []).filter((f) => f.verdict === 'unlabelled').map((f) => `- ${s.id} · \`${f.id}\` [${f.severity}] ${f.title}${f.path ? ` (${f.path})` : ''}`));
  if (unl.length) lines.push('', '## Unlabelled findings', '', 'Label them (`arw eval label ...`) so the next run measures them:', '', ...unl);
  return `${lines.join('\n')}\n`;
}

// ---------- running ----------
function runOne(c, { outDir, arw = path.join(ROOT, 'src', 'cli', 'arw.js'), timeoutMs, log, configFlags = null }) {
  const caseDir = ensureDir(path.join(outDir, 'cases', c.id));
  const args = [arw, 'review', '--local', c.repo, '--base', c.base, '--head', c.head];
  const flags = { noRepro: true, ...(c.flags || {}), ...(configFlags || {}) };
  for (const k of FLAGS) if (flags[k]) args.push(`--${k.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)}`);
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
      const runDir = fs.existsSync(prs) ? fs.readdirSync(prs).map((d) => path.join(prs, d)).find((d) => fs.existsSync(path.join(d, 'run.json'))) : null;
      // The review worktree belongs to the case repository; do not leave it registered there.
      if (fs.existsSync(wtDir)) {
        for (const d of fs.readdirSync(wtDir)) git.git(c.repo, ['worktree', 'remove', '--force', path.join(wtDir, d)], { allowFail: true });
        fs.rmSync(wtDir, { recursive: true, force: true });
      }
      git.git(c.repo, ['worktree', 'prune'], { allowFail: true });
      const tail = fs.readFileSync(path.join(caseDir, 'review.log'), 'utf8').trim().split('\n').slice(-3).join(' | ').slice(0, 500);
      resolve({ exit_code: code, elapsed_ms: Date.now() - started, runDir, tail });
    });
  });
}

function evalRunId(label) {
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  return `${stamp}${label ? `-${String(label).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}` : ''}`;
}

async function runEval({ only, label, config = null, log = () => {}, arw, timeoutMs = envInt('ARW_EVAL_TIMEOUT_MS', 3600000) } = {}) {
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
    cases: [],
    totals: null,
  };
  const save = () => {
    card.totals = aggregate(card.cases);
    writeJsonAtomic(path.join(outDir, 'scorecard.json'), card);
    writeFileAtomic(path.join(outDir, 'scorecard.md'), renderScorecard(card));
  };
  save();
  for (const c of cases) {
    const res = await runOne(c, { outDir, arw, timeoutMs, log, configFlags: config ? CONFIGS[config] : null });
    const score = { ...scoreCase(c, res.runDir), exit_code: res.exit_code, wall_ms: res.elapsed_ms, run_dir: res.runDir ? path.relative(outDir, res.runDir).split(path.sep).join('/') : null };
    if (score.status === 'NO_RESULT' || res.exit_code !== 0) score.error = res.tail;
    card.cases.push(score);
    log(`case ${c.id}: ${score.status} · recall ${pct(score.recall)} · precision ${pct(score.precision)} · ${score.unlabelled} unlabelled · ${score.cost ? score.cost.calls : 0} calls`);
    save();
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
  card.totals = aggregate(card.cases);
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
  return { ...card, cases: scored, totals: aggregate(scored) };
}

// What changed between two eval runs, case by case, on the current labels.
function compare(aId, bId) {
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
  return { a: { id: a.id, totals: a.totals, model: a.model, tool: a.tool_sha256 }, b: { id: b.id, totals: b.totals, model: b.model, tool: b.tool_sha256 }, rows };
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
function labelFinding({ runId, caseId, findingId, as, severity }) {
  if (!['tp', 'fp'].includes(as)) throw new Error('--as tp|fp');
  const card = loadRun(runId);
  const s = card.cases.find((x) => x.id === caseId);
  if (!s || !s.run_dir) throw new Error(`case ${caseId} has no run in ${runId}`);
  const res = reviewFindings(path.join(runsDir(), runId, s.run_dir));
  const f = res && [...res.shown, ...res.withdrawn].find((x) => x.id === findingId);
  if (!f) throw new Error(`no finding ${findingId} in ${runId}/${caseId}`);
  const c = loadCases({ only: [caseId] })[0];
  if (!c) throw new Error(`no case ${caseId}`);
  const list = as === 'tp' ? (c.expected = c.expected || []) : (c.not_expected = c.not_expected || []);
  const label = labelFrom(f, `${as === 'tp' ? 'E' : 'N'}${list.length + 1}`, as === 'tp' ? { severity_at_least: severity || f.severity } : { why: 'labelled false positive' });
  if (!label) throw new Error(`${findingId} cites no code to anchor a label on`);
  list.push(label);
  writeCase(c, { force: true });
  return label;
}

module.exports = { CONFIGS, evalDir, loadCases, validateCase, scoreCase, aggregate, renderScorecard, runEval, rescore, listRuns, loadRun, compare, caseFromRun, labelFinding, matches, keywordsOf };
