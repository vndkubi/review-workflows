'use strict';
// Rejected-finding memory matches by meaning: concepts and the code anchor,
// while two different defects in one method stay apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, makeRepo, sh } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-semantic-runs-');

const { concepts, similarityOf, stem } = require('../src/lib/semantic');
const memory = require('../src/lib/memory');

test('concepts fold review vocabulary and word forms', () => {
  assert.equal(stem('rounding'), 'round');
  assert.deepEqual([...concepts('Threshold excludes the exact limit')].sort(), ['#boundary', 'exclud'].sort());
  assert.ok(concepts('float arithmetic on cents').has('#precision'));
  assert.ok(concepts('returns None for a missing key').has('#missing'));
  assert.ok(concepts('an off by one in the loop').has('#boundary'), 'phrases count');
});

const A = (title, asis, symbol, fix, authority = null) => ({ title, asis, anchor: { path: 'billing/fees.py', symbol, authority, fix } });

test('similarity: rephrased concerns match; other defects in the same method do not', () => {
  // Seen on a real review: two wordings of one concern about late_fee's signature.
  const miss = similarityOf(
    A('The changed function signature can break existing callers that relied on the previous default argument', 'Callers that omitted rate now get a different result.', 'late_fee', ['def', 'late_fee', 'days', 'rate']),
    A('Late-fee calculation silently changes for existing two-argument callers', 'Two-argument calls compute a different fee now.', 'late_fee', ['def', 'late_fee', 'days', 'rate']),
  );
  assert.ok(miss.score >= memory.MATCH_THRESHOLD && miss.structural > miss.text, JSON.stringify(miss));
  const paraphrase = similarityOf(
    A('Discount threshold is exclusive at 1,000,000', 'Orders of exactly 1,000,000 get no discount.', 'OrderService.discount', ['if', 'member', 'total', 'compareTo', 'THRESHOLD']),
    A('Boundary check excludes the exact limit amount', 'An order equal to the limit is not discounted.', 'OrderService.discount', ['if', 'member', 'total', 'compareTo', 'THRESHOLD']),
  );
  assert.ok(paraphrase.score >= memory.MATCH_THRESHOLD, JSON.stringify(paraphrase));
  // Both from one real review of late_fee: a crash and a money-type problem.
  const different = similarityOf(
    A('Late fee crashes at the grace period boundary', 'fee is used before assignment when days <= 30.', 'late_fee', ['fee', 'min', 'amount']),
    A('Money mixes Decimal with binary floats', 'Decimal amount multiplied by 0.01 float.', 'late_fee', ['fee', 'amount', 'days', 'GRACE_DAYS']),
  );
  assert.ok(different.score < memory.MATCH_THRESHOLD && different.structural === 0, JSON.stringify(different));
});

test('memory: rejections carry an anchor; a reworded finding on the same code is matched', () => {
  const repo = makeRepo();
  const src = { checkout: repo.dir, head_sha: repo.head, base_sha: repo.base };
  const line = sh(repo.dir, ['show', `${repo.head}:billing/fees.py`]).split('\n').findIndex((l) => l.startsWith('def late_fee')) + 1;
  const ev = { kind: 'code', path: 'billing/fees.py', start_line: line, end_line: line, quote: 'def late_fee' };
  const fix = { kind: 'code_change', asis: 'def late_fee(days, rate=0.5):', tobe: 'def late_fee(days, rate=0.1):', reason: 'r' };
  const rejected = { id: 'T1-technical-F1', title: 'Default rate changed for existing callers', asis: 'Callers relying on the default now pay more.', severity: 'P3', evidence: [ev], fix, authority: { kind: 'inferred', id: 'engineering-judgement' } };
  const entry = memory.addRejection(rejected, { scope: 'acme/shop', reason: 'agreed with product', source: 'dashboard', run: 'acme__shop__1', anchorSource: src });
  assert.deepEqual([entry.anchor.path, entry.anchor.symbol], ['billing/fees.py', 'late_fee']);
  const reworded = { id: 'B1-business-F2', title: 'Two-argument calls to late_fee compute a different amount', asis: 'The previous default is gone.', severity: 'P3', evidence: [ev], fix, authority: { kind: 'inferred', id: 'engineering-judgement' } };
  const m = memory.matchRejected(reworded, { scope: 'acme/shop', run: 'acme__shop__2', source: src });
  assert.ok(m && m.how === 'same code', JSON.stringify(m));
  assert.equal(memory.matchRejected(reworded, { scope: 'acme/shop', run: 'acme__shop__2' }), null, 'without the code anchor the wording alone does not match');
  const other = { ...reworded, id: 'X', title: 'Late fee is not capped', asis: 'Fees can exceed the amount.', fix: { ...fix, asis: 'return days * rate' } };
  assert.equal(memory.matchRejected(other, { scope: 'acme/shop', run: 'acme__shop__2', source: src }), null, 'same method, different code to change: a different defect');
});
