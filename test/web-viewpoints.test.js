'use strict';
// The dashboard's Viewpoints tab: one row per assigned checklist viewpoint,
// one column per unit, each cell the verdict with its note and evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-web-vp-');
const { viewpointView } = require('../src/web/data');

const CHECKLIST = [
  '## Transactions',
  '- CK-TX-1: A read-modify-write of shared state runs in one transaction.',
  '- CK-BZ-1: Boundary conditions match the requirement wording.',
  '',
].join('\n');
const ev = { kind: 'code', path: 'A.java', start_line: 9, end_line: 9, quote: 'if (x > 0) {' };

test('viewpointView: rows in checklist order, cells carry the packet\'s evidence', () => {
  const checks = [
    { unit_id: 'T1', viewpoint: 'CK-BZ-1', verdict: 'fail', note: 'strict >', role: 'technical' },
    { unit_id: 'T1', viewpoint: 'CK-TX-1', verdict: 'pass', note: 'one transaction', role: 'technical' },
    { unit_id: 'B1', viewpoint: 'CK-BZ-1', verdict: 'not_answered', note: '', role: null },
  ];
  const packets = [{ unit_id: 'T1', role: 'technical', packet: { viewpoint_verdicts: [{ viewpoint: 'CK-BZ-1', verdict: 'fail', evidence: [ev], note: 'strict >' }, { viewpoint: 'CK-TX-1', verdict: 'pass', evidence: [], note: 'one transaction' }] } }];
  const v = viewpointView(checks, packets, CHECKLIST);
  assert.deepEqual(v.viewpoints, [
    { id: 'CK-TX-1', text: 'A read-modify-write of shared state runs in one transaction.' },
    { id: 'CK-BZ-1', text: 'Boundary conditions match the requirement wording.' },
  ]);
  assert.deepEqual(v.units, ['T1', 'B1']);
  assert.deepEqual(v.tally, { fail: 1, pass: 1, not_answered: 1 });
  const cell = v.cells.find((c) => c.unit_id === 'T1' && c.viewpoint === 'CK-BZ-1');
  assert.deepEqual(cell.evidence, [ev]);
  assert.deepEqual(v.cells.find((c) => c.unit_id === 'B1').evidence, []);
});

test('viewpointView: a run from before the matrix has none', () => {
  assert.equal(viewpointView(undefined, [], CHECKLIST), null);
  assert.equal(viewpointView([], [], CHECKLIST), null);
});
