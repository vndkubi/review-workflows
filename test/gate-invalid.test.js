'use strict';
// D5: a person may reject an invalid or incomplete review, but cannot approve
// it. The gate must remain unrecorded after the refused approval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { recordGate, gateState } = require('../src/lib/runs');

const CONTEXT = '0123456789abcdef';
const DIGEST = 'd'.repeat(64);

function runWith(validation) {
  const dir = tmpDir('arw-gate-');
  fs.mkdirSync(path.join(dir, 'review', 'revisions', CONTEXT), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review', 'context.json'), JSON.stringify({ context_id: CONTEXT, context_digest: DIGEST }));
  fs.writeFileSync(path.join(dir, 'review', 'revisions', CONTEXT, 'validation.json'), JSON.stringify({
    context_id: CONTEXT,
    context_digest: DIGEST,
    recommendation: 'no_blocking_findings',
    findings: [],
    jobs: [],
    ...validation,
  }));
  return dir;
}

test('approving an INVALIDATED, incomplete or drifted review is refused', () => {
  const cases = [
    { status: 'INVALIDATED', complete: true, drift: ['tool changed'] },
    { status: 'EXECUTED_PASS', complete: false, drift: [] },
    { status: 'EXECUTED_PASS', complete: true, drift: ['input changed'] },
  ];
  for (const validation of cases) {
    const dir = runWith(validation);
    assert.throws(() => recordGate(dir, 'REVIEW', 'approved'), /cannot approve REVIEW/);
    assert.equal(gateState(dir, 'REVIEW').decision, 'NOT_RECORDED');
  }
});

test('rejecting an invalid review is allowed', () => {
  const dir = runWith({ status: 'INVALIDATED', complete: false, drift: ['tool changed'] });
  const record = recordGate(dir, 'REVIEW', 'rejected', { note: 'the context is stale' });
  assert.equal(record.decision, 'rejected');
  assert.equal(gateState(dir, 'REVIEW').decision, 'rejected');
  assert.equal(gateState(dir, 'REVIEW').valid, true);
});

test('a valid EXECUTED_PASS review can be approved', () => {
  const dir = runWith({ status: 'EXECUTED_PASS', complete: true, drift: [] });
  const record = recordGate(dir, 'REVIEW', 'approved', { note: 'read it' });
  assert.equal(record.decision, 'approved');
  assert.equal(gateState(dir, 'REVIEW').decision, 'approved');
  assert.equal(gateState(dir, 'REVIEW').valid, true);
});
