'use strict';
// Eval harness end to end: a labelled case runs through the real CLI in its
// own process (fake executor), is scored, re-labelled and re-scored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-eval-runs-');
process.env.ARW_EVAL_DIR = tmpDir('arw-eval-');
process.env.ARW_WT_DIR = tmpDir('arw-eval-wt-');
process.env.ARW_ENV_FILE = path.join(tmpDir('arw-eval-env-'), '.env');
process.env.ARW_EXECUTOR_MODULE = path.join(__dirname, 'fixtures', 'fake-review-executor.js');

const evals = require('../src/lib/eval');

function repoWithBugs() {
  const dir = tmpDir('arw-eval-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/total.py', 'def total(items):\n    return sum(items)\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/total.py', [
    'def total(items):',
    '    n = len(items) - 1  # BUG: off by one drops the last item',
    '    x = 1  # BUG: style nit about naming',
    '    y = 2  # BUG: unclear rounding of totals',
    '    return sum(items[:n]) + x + y',
    '',
  ].join('\n'));
  sh(dir, ['commit', '-q', '-am', 'change totals']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

test('configurations: the single-agent baseline runs one reviewer, no planner, on the same case', async () => {
  const r = repoWithBugs();
  const dir = tmpDir('arw-eval-config-');
  const saved = process.env.ARW_EVAL_DIR;
  process.env.ARW_EVAL_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, 'cases'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cases', 'totals.json'), JSON.stringify({ id: 'totals', repo: r.dir, base: r.base, head: r.head, expected: [{ id: 'E1', path: 'billing/total.py', keywords: ['off by one'] }] }));
    await assert.rejects(evals.runEval({ config: 'everything' }), /--config: one of single-agent, multi-agent, multi-agent\+repro/);
    const { card, outDir } = await evals.runEval({ config: 'single-agent', label: 'single-agent' });
    assert.equal(card.config, 'single-agent');
    const s = card.cases[0];
    assert.equal(s.status, 'EXECUTED_PASS', s.error);
    assert.equal(s.found, 1);
    const run = JSON.parse(fs.readFileSync(path.join(outDir, s.run_dir, 'run.json'), 'utf8'));
    assert.equal(run.review.mode, 'single-agent');
    assert.deepEqual(run.review.units.map((u) => [u.id, u.roles]), [['T1', ['technical']]], 'one unit, one reviewer');
    assert.ok(!fs.existsSync(path.join(outDir, s.run_dir, 'plan-work')), 'no planner call');
    assert.equal(s.cost.calls, 1, 'one model call for the whole review');
  } finally {
    process.env.ARW_EVAL_DIR = saved;
  }
});

test('cases are validated before anything runs', () => {
  assert.match(evals.validateCase({ id: 'x', repo: 'relative', base: 'a', head: 'b', expected: [] }).join(';'), /absolute path/);
  const r = repoWithBugs();
  const errs = evals.validateCase({ id: 'bad id!', repo: r.dir, base: r.base, head: r.head, expected: [{ id: 'E1', path: 'a.py', lines: [5, 2] }] });
  assert.ok(errs.some((e) => /^id:/.test(e)) && errs.some((e) => /lines/.test(e)), errs.join('; '));
  assert.deepEqual(evals.validateCase({ id: 'ok', repo: r.dir, base: r.base, head: 'nope', expected: [{ id: 'E1', path: 'a.py' }] }), ['head: nope is not a commit in ' + r.dir]);
  assert.match(evals.validateCase({ id: 'ok', repo: r.dir, base: r.base, head: r.head }).join(), /label at least one/);
  assert.deepEqual(evals.keywordsOf('Discount excludes orders of exactly 1000000'), ['1000000', 'discount', 'excludes']);
});

test('run, score, label, rescore, and build a case from a reviewed run', async () => {
  const r = repoWithBugs();
  fs.mkdirSync(path.join(process.env.ARW_EVAL_DIR, 'cases'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ARW_EVAL_DIR, 'cases', 'totals.json'), JSON.stringify({
    id: 'totals',
    repo: r.dir,
    base: r.base,
    head: r.head,
    flags: { skipSynthesis: true },
    expected: [
      { id: 'E1', path: 'billing/total.py', lines: [2, 2], keywords: ['off by one'], severity_at_least: 'P3' },
      { id: 'E2', path: 'billing/total.py', keywords: ['timezone'] },
    ],
    not_expected: [{ id: 'N1', path: 'billing/total.py', keywords: ['style'], why: 'naming is not a defect' }],
  }));
  const lines = [];
  const { card, outDir } = await evals.runEval({ label: 'baseline', log: (l) => lines.push(l) });
  const s = card.cases[0];
  assert.equal(s.status, 'EXECUTED_PASS', fs.readFileSync(path.join(outDir, 'cases', 'totals', 'review.log'), 'utf8').slice(-2000));
  assert.deepEqual([s.expected, s.found, s.recall, s.tp, s.fp, s.unlabelled, s.precision], [2, 1, 0.5, 1, 1, 1, 0.5]);
  assert.deepEqual(s.details.expected.map((e) => [e.id, e.found, e.severity_ok]), [['E1', true, true], ['E2', false, null]]);
  assert.equal(card.executor, 'custom');
  assert.ok(s.cost.calls >= 2);
  const md = fs.readFileSync(path.join(outDir, 'scorecard.md'), 'utf8');
  assert.match(md, /recall 50%/);
  assert.match(md, /## Unlabelled findings[\s\S]*unclear rounding of totals/);
  assert.equal(sh(r.dir, ['worktree', 'list']).split('\n').length, 1, 'the case repository is left with no extra worktree');
  assert.ok(lines.some((l) => /case totals: EXECUTED_PASS/.test(l)));

  // Label the unlabelled finding as a false positive and re-score without a model.
  const unl = s.details.findings.find((f) => f.verdict === 'unlabelled');
  const label = evals.labelFinding({ runId: card.id, caseId: 'totals', findingId: unl.id, as: 'fp' });
  assert.equal(label.path, 'billing/total.py');
  const again = evals.rescore(card.id);
  assert.deepEqual([again.cases[0].fp, again.cases[0].unlabelled, again.totals.precision], [2, 0, 0.333]);
  const cmp = evals.compare(card.id, card.id);
  assert.deepEqual(cmp.rows[0].newly_missed, []);
  assert.equal(cmp.a.totals.precision, 0.333, 'runs are compared on the current labels');
  assert.equal(evals.listRuns()[0].id, card.id);

  // A person kept F1 and deleted the rest on GitHub: that run becomes a case.
  const runDir = path.join(outDir, s.run_dir);
  const kept = s.details.findings.find((f) => f.verdict === 'tp').id;
  fs.writeFileSync(path.join(runDir, 'feedback.json'), JSON.stringify({ findings: s.details.findings.map((f) => ({ id: f.id, verdict: f.id === kept ? 'kept' : 'dropped' })) }));
  const built = evals.caseFromRun(runDir, { id: 'from-review' });
  // realpath: Windows temp dirs may be 8.3 short names (RUNNER~1) while git reports long ones.
  assert.equal(fs.realpathSync.native(built.case.repo).toLowerCase(), fs.realpathSync.native(r.dir).toLowerCase());
  assert.deepEqual([built.case.expected.length, built.case.not_expected.length], [1, 2]);
  assert.deepEqual(built.case.expected[0].lines, [2, 2]);
  assert.deepEqual(evals.validateCase(built.case), []);
  assert.throws(() => evals.caseFromRun(runDir, { id: 'from-review' }), /exists/);
});
