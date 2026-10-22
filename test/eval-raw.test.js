'use strict';
// The traditional baseline for the cost/quality measurement: one prompt per
// case, no validator, repair loop, red team, synthesis or repro. It is scored
// exactly like the harness's own configurations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, scriptedExecutor } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-raw-runs-');
process.env.ARW_EVAL_DIR = tmpDir('arw-raw-eval-');
process.env.ARW_WT_DIR = tmpDir('arw-raw-wt-');
process.env.ARW_ENV_FILE = path.join(tmpDir('arw-raw-env-'), '.env');
process.env.ARW_EXECUTOR_MODULE = path.join(__dirname, 'fixtures', 'fake-review-executor.js');

const evals = require('../src/lib/eval');
const raw = require('../src/lib/raw-review');

function repoWithBugs() {
  const dir = tmpDir('arw-raw-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/total.py', 'def total(items):\n    return sum(items)\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/total.py', 'def total(items):\n    n = len(items) - 1  # BUG: off by one drops the last item\n    return sum(items[:n])\n');
  sh(dir, ['commit', '-q', '-am', 'change totals']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

const FINDING = { id: 'F1', severity: 'P2', title: 'Off by one drops the last item', asis: 'n = len - 1', tobe: 'all items', impact: 'wrong total', evidence: [{ kind: 'code', path: 'billing/total.py', start_line: 2, end_line: 2, quote: 'n = len(items) - 1  # BUG: off by one drops the last item' }] };

test('the baseline prompt is a committed, strong senior-reviewer prompt', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'config', 'baselines', 'raw-prompt.md'), 'utf8');
  assert.match(text, /senior/i);
  for (const word of ['security', 'concurren', 'callers', 'business']) assert.match(text, new RegExp(word, 'i'));
  const p = raw.buildPrompt(text, { base: 'b'.repeat(40), head: 'h'.repeat(40) });
  assert.ok(p.startsWith(text.trim()), 'the baseline comes first, unchanged');
  assert.match(p, new RegExp(`git diff ${'b'.repeat(40)} ${'h'.repeat(40)}`));
  assert.match(p, /RAW-PROMPT OUTPUT/);
  assert.match(p, /"evidence": \[\{"kind": "code", "path"/);
});

test('raw review: one call, at most one retry when the JSON does not parse, usage recorded', async () => {
  const r = repoWithBugs();
  let n = 0;
  const exec = scriptedExecutor(() => (n++ === 0 ? 'Here are my findings: (no JSON)' : JSON.stringify({ findings: [FINDING] })));
  const out = tmpDir('arw-raw-out-');
  const res = await raw.runRawReview({ repo: r.dir, base: r.base, head: r.head, outDir: out, executor: exec, model: 'luna', baseline: 'Review as a senior engineer.' });
  assert.equal(exec.calls.length, 2);
  assert.equal(res.status, 'EXECUTED_PASS');
  assert.deepEqual(res.findings.map((f) => f.id), ['F1']);
  assert.equal(res.receipts.length, 2);
  assert.ok(res.receipts.every((x) => x.usage && typeof x.elapsed_ms === 'number' && x.model === 'luna'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'raw-review.json'), 'utf8')).findings.map((f) => f.id), ['F1']);
  // No validator: a finding with a wrong quote is kept as the model wrote it.
  const bad = { ...FINDING, evidence: [{ ...FINDING.evidence[0], quote: 'not in the file' }] };
  const kept = await raw.runRawReview({ repo: r.dir, base: r.base, head: r.head, outDir: tmpDir('arw-raw-out-'), executor: scriptedExecutor(() => JSON.stringify({ findings: [bad] })), model: 'luna', baseline: 'x' });
  assert.equal(kept.findings[0].evidence[0].quote, 'not in the file');
  // Two unparsable answers: no findings, and the run says so.
  const failed = await raw.runRawReview({ repo: r.dir, base: r.base, head: r.head, outDir: tmpDir('arw-raw-out-'), executor: scriptedExecutor(() => 'nope'), model: 'luna', baseline: 'x' });
  assert.equal(failed.status, 'EXECUTED_FAIL');
  assert.deepEqual(failed.findings, []);
  assert.equal(failed.receipts.length, 2);
});

test('eval: the raw-prompt configuration is scored like the others', async () => {
  const r = repoWithBugs();
  fs.mkdirSync(path.join(process.env.ARW_EVAL_DIR, 'cases'), { recursive: true });
  fs.writeFileSync(path.join(process.env.ARW_EVAL_DIR, 'cases', 'totals.json'), JSON.stringify({ id: 'totals', repo: r.dir, base: r.base, head: r.head, expected: [{ id: 'E1', path: 'billing/total.py', lines: [2, 2], keywords: ['off by one'] }] }));
  const { card } = await evals.runEval({ config: 'raw-prompt', label: 'raw' });
  assert.equal(card.config, 'raw-prompt');
  const s = card.cases[0];
  assert.equal(s.status, 'EXECUTED_PASS', s.error);
  assert.equal(s.found, 1);
  assert.equal(s.cost.calls, 1);
  assert.ok(s.cost.input_tokens > 0);
  // Quotes checked against the PR head, priced calls, and time split.
  assert.deepEqual(s.evidence.final, { quotes: 1, fabricated: 0, rate: 0 });
  assert.deepEqual(s.evidence.attempts, { quotes: 1, fabricated: 0, rate: 0 });
  assert.equal(s.cost.usd, null, 'no prices: USD stays null');
  assert.deepEqual(s.cost.unpriced, ['fake']);
  assert.equal(typeof s.time.model_ms, 'number');
  assert.equal(s.time.exec_ms, 0);
  assert.ok(card.totals.wall_ms.p50 > 0 && card.totals.wall_ms.p95 >= card.totals.wall_ms.p50);
  assert.deepEqual(card.totals.evidence.final, { quotes: 1, fabricated: 0, rate: 0 });

  fs.writeFileSync(path.join(process.env.ARW_EVAL_DIR, 'prices.json'), JSON.stringify({ date: '2026-10-23', models: { fake: { input: 2, cached_input: 1, output: 8 } } }));
  const card2 = evals.rescore(card.id);
  assert.ok(card2.cases[0].cost.usd > 0);
  assert.equal(card2.totals.usd, card2.cases[0].cost.usd);
  assert.equal(card2.totals.usd_per_tp, card2.cases[0].cost.usd, 'one true positive');
  assert.equal(card2.prices.date, '2026-10-23');
});
