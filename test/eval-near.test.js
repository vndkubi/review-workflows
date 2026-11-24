'use strict';
// Incident: on 20261124-072023Z-implicit-luna-multi, martian-sentry-5 M5
// ("a timestamp of 0 is treated as absent ... age=0") was found in both
// repeats as "Zero-valued age or timestamp bypasses mutual-exclusion
// validation" at the label's file, yet scored as missed: the label's keywords
// (age=0, initial_data) are words of the original comment, not of the defect.
// A finding at a missed label's code is now shown as a near miss with the
// command that links it, and recall says how far those near misses reach.
// Low and style labels are counted apart, so a docstring nit does not weigh
// like a wrong permission check.
const test = require('node:test');
const assert = require('node:assert/strict');
const evals = require('../src/lib/eval');

const P = 'src/sentry/issues/endpoints/browser_reporting_collector.py';
const finding = (id, path, start, title) => ({ id, severity: 'P2', title, asis: '', tobe: '', evidence: [{ kind: 'code', path, start_line: start, end_line: start + 2, quote: 'x' }] });
const M5 = { id: 'M5', prose: 'uses .get(timestamp), so a timestamp of 0 is absent', paths: [P], keywords: ['age=0', 'initial_data'], min_keywords: 1, approx: true, category: 'bug', source_severity: 'High' };
const DOC = { id: 'M2', prose: 'docstring says list', paths: ['src/other.py'], keywords: ['docstring'], approx: true, category: 'doc_defect', source_severity: 'Low' };
const LINE = { id: 'E1', path: 'src/Mongo.java', lines: [64, 64] };

test('a finding at a missed label\'s code is a near miss, not a hit', () => {
  const zero = finding('B6-business-F1', P, 50, 'Zero-valued age or timestamp bypasses mutual-exclusion validation');
  const far = finding('B1-technical-F1', 'src/Mongo.java', 140, 'Positive offsets lose their timezone');
  const close = finding('B1-technical-F3', 'src/Mongo.java', 80, 'Replacement rescans the query');
  const near = evals.nearMisses([zero, far, close], [M5, DOC, LINE], new Set());
  assert.deepEqual(near, { M5: ['B6-business-F1'], E1: ['B1-technical-F3'] });
  assert.deepEqual(evals.nearMisses([zero], [M5], new Set(['B6-business-F1'])), {}, 'a finding that already hit a label is not offered again');
});

test('recall shows the confirmed value, how far near misses reach, and the core labels apart', () => {
  const card = { id: 'x', tool_sha256: 'a'.repeat(64), started_at: 't', repeat: 1, cases: [
    { id: 'c', status: 'EXECUTED_PASS', expected: 3, scored_expected: 3, found: 1, near_found: 1, core_expected: 2, core_found: 1, tp: 1, fp: 0, unlabelled: 1, cost: { calls: 1 },
      details: { expected: [
        { id: 'M5', found: false, by: [], near: ['B6-business-F1'], core: true },
        { id: 'M2', found: false, by: [], near: [], core: false },
        { id: 'E1', found: true, by: ['F1'], near: [], core: true },
      ], findings: [] }, run_dir: 'cases/c' },
  ] };
  evals.finalize(card);
  assert.equal(card.totals.recall, 0.333);
  assert.equal(card.totals.recall_upper, 0.667);
  assert.equal(card.totals.recall_core, 0.5);
  const md = evals.renderScorecard(card);
  assert.match(md, /recall 33\.3%\*\* .*up to 66\.7% if the 1 near miss\(es\) are confirmed/);
  assert.match(md, /core labels \(no Low, style, doc or speculative\): 50% \(1\/2\)/);
  assert.match(md, /## Near misses/);
  assert.match(md, /arw eval label --run x --case c --finding B6-business-F1 --as tp --to M5/);
});

test('a link makes a near miss a hit on the next score, for line labels too', () => {
  const close = finding('F3', 'src/Mongo.java', 80, 'Replacement rescans the query');
  assert.equal(evals.matches(close, LINE), false);
  const linked = { ...LINE, anchors: [{ path: 'src/Mongo.java', lines: [80, 82] }] };
  assert.equal(evals.hitsLabel(close, linked), true);
  assert.equal(evals.hitsLabel(finding('F4', 'src/Mongo.java', 200, 'other'), linked), false);
});
