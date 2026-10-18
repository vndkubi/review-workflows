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

// ---------- the Impact tab ----------
const { impactView } = require('../src/web/data');

test('impactView: callers grouped under each changed declaration, with their verdicts', () => {
  const impact = {
    engine: 'structural',
    scanned: 3,
    changed: [{ path: 'A.java', symbol: 'A.run', lines: [3, 9] }, { path: 'b.py', symbol: 'fee', lines: [1, 4] }],
    edges: [
      { level: 1, to: { path: 'A.java', symbol: 'A.run' }, from: { path: 'C.java', line: 7, symbol: 'C.go' }, confidence: 'resolved' },
      { level: 2, to: { path: 'C.java', symbol: 'C.go' }, from: { path: 'D.java', line: 2, symbol: 'D.main' }, confidence: 'resolved' },
      { level: 1, to: { path: 'A.java', symbol: 'A.run' }, from: { path: 'E.java', line: 4, symbol: 'E.x' }, confidence: 'name-only' },
    ],
    truncated: false,
  };
  const cells = [{ unit_id: 'T1', caller: 'C1', from: { path: 'C.java', line: 7, symbol: 'C.go' }, to: { path: 'A.java', symbol: 'A.run' }, confidence: 'resolved', verdict: 'broken', note: 'null now', role: 'technical' }];
  const packets = [{ unit_id: 'T1', role: 'technical', packet: { impact_verdicts: [{ caller: 'C1', verdict: 'broken', evidence: [ev], note: 'null now' }] } }];
  const v = impactView(impact, cells, packets);
  assert.deepEqual(v.tally, { broken: 1 });
  assert.deepEqual(v.declarations.map((d) => [d.symbol, d.callers.map((c) => [c.level, c.from.symbol, c.check ? c.check.verdict : null])]), [
    ['A.run', [[1, 'C.go', 'broken'], [1, 'E.x', null]]],
    ['fee', []],
  ]);
  assert.deepEqual(v.declarations[0].callers[0].check.evidence, [ev]);
  // Deeper levels show how far a change reaches, keyed by the caller they reach through.
  assert.deepEqual(v.deeper.map((e) => [e.level, e.from.symbol, e.to.symbol]), [[2, 'D.main', 'C.go']]);
  assert.equal(impactView(null, [], []), null);
  assert.equal(impactView({ error: 'boom', changed: [], edges: [] }, [], []).error, 'boom');
});
