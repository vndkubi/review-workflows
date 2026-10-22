'use strict';
// What a configuration costs, how long it takes and how often its evidence
// is invented, measured from what a run left on disk (no model calls).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_EVAL_DIR = tmpDir('arw-measure-eval-');
const m = require('../src/lib/eval-measure');

function repo() {
  const dir = tmpDir('arw-measure-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'a.py', 'def f(x):\n    return x\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'a.py', 'def f(x):\n    return x + 1\n');
  sh(dir, ['commit', '-q', '-am', 'head']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

test('fabricated quotes: a code quote that is not at its cited lines, at head or (for base evidence) at base', () => {
  const r = repo();
  const ev = (quote, extra = {}) => ({ kind: 'code', path: 'a.py', start_line: 2, end_line: 2, quote, ...extra });
  const findings = [
    { evidence: [ev('return x + 1'), ev('return x', { revision: 'base' })] },
    { evidence: [ev('return x * 2'), { kind: 'input', path: 'spec', start_line: 1, end_line: 1, quote: 'anything' }] },
    { evidence: [{ ...ev('return x + 1'), path: 'missing.py' }] },
  ];
  assert.deepEqual(m.quoteStats(r, findings), { quotes: 4, fabricated: 2, rate: 0.5 });
  assert.deepEqual(m.quoteStats(r, []), { quotes: 0, fabricated: 0, rate: null });
});

test('attempt quotes: every candidate a model wrote, before any rejection', () => {
  const dir = tmpDir('arw-measure-attempts-');
  write(dir, 'attempts/T1-technical-1/raw-candidate.txt', JSON.stringify({ findings: [{ evidence: [{ kind: 'code', path: 'a.py', start_line: 2, end_line: 2, quote: 'nope' }] }] }));
  write(dir, 'attempts/T1-technical-2/raw-candidate.txt', 'not json at all');
  write(dir, 'attempts/plan-1/raw-candidate.txt', JSON.stringify({ units: [] }));
  const found = m.attemptFindings([dir]);
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence[0].quote, 'nope');
});

test('cost: each call priced by the model that served it; an unknown price is null and flagged, never 0', () => {
  const prices = { date: '2026-10-23', models: { luna: { input: 1, cached_input: 0.1, output: 4 }, sol: { input: 5, cached_input: 0.5, output: 20 } } };
  const receipts = [
    { model: 'luna', usage: { input_tokens: 1000000, cached_input_tokens: 400000, output_tokens: 100000 } },
    { model: 'sol', usage: { input_tokens: 200000, cached_input_tokens: 0, output_tokens: 10000 } },
  ];
  const c = m.costOf(receipts, prices);
  // luna: 0.6M * 1 + 0.4M * 0.1 + 0.1M * 4 = 1.04; sol: 0.2M * 5 + 0.01M * 20 = 1.2
  assert.equal(c.usd, 2.24);
  assert.deepEqual(c.by_model, { luna: 1.04, sol: 1.2 });
  assert.deepEqual(c.unpriced, []);
  const u = m.costOf([...receipts, { model: 'mystery', usage: { input_tokens: 10, output_tokens: 1 } }], prices);
  assert.equal(u.usd, null);
  assert.deepEqual(u.unpriced, ['mystery']);
  assert.equal(m.costOf(receipts, null).usd, null);
});

test('receipts and time of a harness run: model time, execution time and rate-limit waits', () => {
  const runDir = tmpDir('arw-measure-run-');
  write(runDir, 'review/context.json', JSON.stringify({ context_id: 'c1' }));
  write(runDir, 'plan-work/receipts.json', JSON.stringify({ plan: [{ model: 'luna', elapsed_ms: 1000, usage: { input_tokens: 10, output_tokens: 1 } }] }));
  write(runDir, 'review/revisions/c1/receipts.json', JSON.stringify({
    'packets/technical/T1.json': [
      { model: 'luna', mode: 'rate_limited', elapsed_ms: 50, wait_ms: 60000, usage: { input_tokens: 0, output_tokens: 0 } },
      { model: 'luna', mode: 'full', elapsed_ms: 2000, usage: { input_tokens: 20, output_tokens: 2 } },
    ],
  }));
  write(runDir, 'review/revisions/c1/repro/T1-technical-F1.json', JSON.stringify({ runs: [{ elapsed_ms: 300 }, { elapsed_ms: 200 }] }));
  write(runDir, 'static.json', JSON.stringify({ impacted_tests: { ran: [{ elapsed_ms: 1000 }] } }));
  const rs = m.receiptsOf(runDir);
  assert.equal(rs.length, 3);
  assert.deepEqual(m.timeOf(runDir, rs), { model_ms: 3050, exec_ms: 1500, wait_ms: 60000 });
  // A raw-prompt run keeps its receipts in raw-review.json.
  const rawDir = tmpDir('arw-measure-raw-');
  write(rawDir, 'raw-review.json', JSON.stringify({ receipts: [{ model: 'sol', elapsed_ms: 900, usage: { input_tokens: 5, output_tokens: 1 } }], findings: [] }));
  assert.equal(m.receiptsOf(rawDir).length, 1);
  assert.deepEqual(m.timeOf(rawDir, m.receiptsOf(rawDir)), { model_ms: 900, exec_ms: 0, wait_ms: 0 });
});

test('prices come from evals/prices.json; none is fine', () => {
  assert.equal(m.loadPrices(), null);
  fs.writeFileSync(path.join(process.env.ARW_EVAL_DIR, 'prices.json'), JSON.stringify({ date: '2026-10-23', models: { luna: { input: 1, cached_input: 0.1, output: 4 } } }));
  assert.equal(m.loadPrices().date, '2026-10-23');
});
