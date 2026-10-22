'use strict';
// Repeats, stability, paired statistics, the matrix runner and the blind
// labelling export: what turns eval runs into a measurement a person can
// trust (fake executor, no model calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-stats-runs-');
process.env.ARW_EVAL_DIR = tmpDir('arw-stats-eval-');
process.env.ARW_WT_DIR = tmpDir('arw-stats-wt-');
process.env.ARW_ENV_FILE = path.join(tmpDir('arw-stats-env-'), '.env');
process.env.ARW_EXECUTOR_MODULE = path.join(__dirname, 'fixtures', 'fake-review-executor.js');

const evals = require('../src/lib/eval');
const stats = require('../src/lib/eval-stats');

function repoWithBugs() {
  const dir = tmpDir('arw-stats-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/total.py', 'def total(items):\n    return sum(items)\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/total.py', 'def total(items):\n    n = len(items) - 1  # BUG: off by one drops the last item\n    y = 2  # BUG: unclear rounding of totals\n    return sum(items[:n]) + y\n');
  sh(dir, ['commit', '-q', '-am', 'change totals']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

function writeCases() {
  const r = repoWithBugs();
  fs.mkdirSync(path.join(process.env.ARW_EVAL_DIR, 'cases'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ARW_EVAL_DIR, 'cases', 'totals.json'), JSON.stringify({ id: 'totals', repo: r.dir, base: r.base, head: r.head, expected: [{ id: 'E1', path: 'billing/total.py', lines: [2, 2], keywords: ['off by one'] }] }));
  return r;
}

test('McNemar exact test on discordant pairs, two-sided', () => {
  assert.deepEqual(stats.mcnemar(0, 0), { b: 0, c: 0, p: 1 });
  // b=6, c=0: p = 2 * 0.5^6 = 0.03125
  assert.equal(stats.mcnemar(6, 0).p, 0.0313);
  assert.equal(stats.mcnemar(3, 3).p, 1);
});

test('bootstrap: deterministic with a fixed seed, CI around the observed difference', () => {
  const a = [{ found: 1, expected: 2 }, { found: 2, expected: 2 }, { found: 0, expected: 1 }];
  const b = [{ found: 2, expected: 2 }, { found: 2, expected: 2 }, { found: 1, expected: 1 }];
  const metric = (rows) => rows.reduce((n, r) => n + r.found, 0) / rows.reduce((n, r) => n + r.expected, 0);
  const one = stats.bootstrapDiff(a, b, metric, { n: 2000, seed: 7 });
  const two = stats.bootstrapDiff(a, b, metric, { n: 2000, seed: 7 });
  assert.deepEqual(one, two);
  assert.equal(one.est, 0.4);
  assert.ok(one.lo <= one.est && one.est <= one.hi);
});

test('stability: mean pairwise Jaccard of found labels and of finding anchors', () => {
  const run = (labels, anchors) => ({ id: 'c', details: { expected: labels.map((id) => ({ id, found: true })), findings: anchors.map(([p, s, e]) => ({ path: p, lines: [s, e] })) } });
  const s = stats.stability([[run(['E1', 'E2'], [['a.py', 10, 12]])], [run(['E1'], [['a.py', 11, 11], ['b.py', 1, 1]])]]);
  assert.equal(s.labels, 0.5); // {E1,E2} vs {E1}
  assert.equal(s.anchors, 0.5); // one shared anchor of two distinct
  assert.deepEqual(stats.stability([[run([], [])], [run([], [])]]), { labels: 1, anchors: 1, pairs: 1 });
});

test('--repeat k: each case k times in its own runs dir; mean, sd and stability on the card', async () => {
  writeCases();
  const { card, outDir } = await evals.runEval({ config: 'raw-prompt', label: 'rep', repeat: 2 });
  assert.equal(card.repeat, 2);
  assert.deepEqual(card.cases.map((s) => [s.id, s.repeat]), [['totals', 1], ['totals', 2]]);
  assert.notEqual(card.cases[0].run_dir, card.cases[1].run_dir);
  assert.ok(fs.existsSync(path.join(outDir, card.cases[1].run_dir, 'raw-review.json')));
  assert.deepEqual(card.repeats.recall, { mean: 1, sd: 0 });
  assert.deepEqual(card.stability, { labels: 1, anchors: 1, pairs: 1 });
  assert.equal(card.totals.found, 2, 'totals pool every repeat');
});

test('compare: McNemar and bootstrap CIs on the same labels; refused across tool versions', async () => {
  writeCases();
  const a = (await evals.runEval({ config: 'raw-prompt', label: 'a' })).card;
  const b = (await evals.runEval({ config: 'single-agent', label: 'b' })).card;
  const c = evals.compare(a.id, b.id);
  assert.equal(c.stats.tool_mismatch, null);
  assert.deepEqual([c.stats.mcnemar.b, c.stats.mcnemar.c], [0, 0]);
  assert.equal(c.stats.recall_diff.est, 0);
  assert.deepEqual(evals.compare(a.id, b.id).stats, c.stats, 'deterministic');
  // A run on other tool code is not compared statistically.
  const file = path.join(process.env.ARW_EVAL_DIR, 'runs', b.id, 'scorecard.json');
  const card = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...card, tool_sha256: 'f'.repeat(64) }));
  const refused = evals.compare(a.id, b.id);
  assert.match(refused.stats.tool_mismatch, /tool_sha256 differs/);
  assert.equal(refused.stats.mcnemar, undefined);
});

test('matrix: cells run one after another with their env; a budget stop keeps the partial scorecards', async () => {
  writeCases();
  fs.writeFileSync(path.join(process.env.ARW_EVAL_DIR, 'cases', 'again.json'), fs.readFileSync(path.join(process.env.ARW_EVAL_DIR, 'cases', 'totals.json'), 'utf8').replace('"totals"', '"again"'));
  const cells = [{ name: 'cheap-raw', config: 'raw-prompt', env: { CODEX_MODEL: 'cheap' } }, { name: 'cheap-single', config: 'single-agent', env: { CODEX_MODEL: 'cheap' } }];
  const res = await evals.runMatrix({ cells, label: 'm', budget: { calls: 3 } });
  assert.equal(res.cells[0].card.model, 'cheap');
  assert.equal(res.cells[0].card.cases.length, 2, 'the first cell completes (2 calls)');
  assert.equal(res.cells[1].card.cases.length, 1, 'stopped before the case that would pass the budget');
  assert.match(res.stopped, /budget: 3 model calls reached/);
  assert.equal(res.cells[1].card.stopped, res.stopped);
  assert.equal(process.env.CODEX_MODEL, undefined, 'the env is restored');
  assert.ok(fs.existsSync(path.join(process.env.ARW_EVAL_DIR, 'runs', res.cells[1].card.id, 'scorecard.json')));
});

test('blind export: every unlabelled finding shuffled with its source hidden; labels come back through labelFinding', async () => {
  writeCases();
  fs.rmSync(path.join(process.env.ARW_EVAL_DIR, 'cases', 'again.json'), { force: true });
  const { card } = await evals.runEval({ config: 'raw-prompt', label: 'blind' });
  const out = tmpDir('arw-blind-');
  const res = evals.blindExport([card.id], { out });
  assert.equal(res.items, 1, 'the rounding finding is unlabelled');
  const items = JSON.parse(fs.readFileSync(path.join(out, 'items.json'), 'utf8'));
  assert.deepEqual(Object.keys(items[0]).sort(), ['blind_id', 'case', 'evidence', 'impact', 'severity', 'title', 'asis', 'tobe'].sort(), 'the case gives the labeller its repository and commits; nothing names a model or config');
  assert.ok(!JSON.stringify(items).includes(card.id), 'no run, model or config in the items');
  const key = JSON.parse(fs.readFileSync(path.join(out, 'key.json'), 'utf8'));
  assert.equal(key[items[0].blind_id].run, card.id);
  assert.throws(() => evals.blindExport([card.id], { out: path.join(__dirname, '..', 'blind-out') }), /outside the repository/);
  fs.writeFileSync(path.join(out, 'labels.json'), JSON.stringify({ [items[0].blind_id]: 'fp' }));
  const applied = evals.blindImport({ key: path.join(out, 'key.json'), labels: path.join(out, 'labels.json') });
  assert.deepEqual(applied.map((a) => a.as), ['fp']);
  const after = evals.rescore(card.id);
  assert.equal(after.cases[0].fp, 1);
});
