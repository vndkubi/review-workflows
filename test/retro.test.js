'use strict';
// Retrospective: measurements over run directories and the rules that turn
// them into suggestions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-retro-runs-');

const { retrospective, renderRetro, errorPattern, jobKind } = require('../src/lib/retro');

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const NOT_INPUT = (n) => `$.findings[${n}].evidence[2].path: "evidence" is not a frozen input id (one of: evidence-pack, plan)`;

function makeRun(n, { at = new Date().toISOString() } = {}) {
  const dir = path.join(process.env.ARW_RUNS_DIR, 'prs', `acme__shop__${n}`);
  put(path.join(dir, 'run.json'), { identity: { repo: 'acme/shop', pr: n }, phases: { batch: { status: 'EXECUTED_PASS', at } }, created_at: at });
  put(path.join(dir, 'review', 'context.json'), { context_id: 'c1' });
  const rev = path.join(dir, 'review', 'revisions', 'c1');
  const ok = (label) => ({ label, mode: 'full', usage: { input_tokens: 1000, output_tokens: 10 }, elapsed_ms: 5 });
  put(path.join(rev, 'receipts.json'), {
    'packets/business/B1.json': [{ ...ok('B1-business'), validation_errors: 1, errors: [NOT_INPUT(0)] }, { ...ok('B1-business'), mode: 'repair' }],
    'packets/technical/T1.json': [ok('T1-technical')],
    'packets/technical/V0.json': [{ ...ok('V0-technical'), validation_errors: 1, errors: [NOT_INPUT(3)] }, { ...ok('V0-technical'), mode: 'repair' }],
    'synthesis.json': [ok('synthesis')],
  });
  put(path.join(rev, 'validation.json'), {
    status: 'EXECUTED_PASS',
    jobs: [{ unit_id: 'B1', role: 'business', status: 'EXECUTED_PASS' }, { unit_id: 'T1', role: 'technical', status: 'EXECUTED_PASS' }, { unit_id: 'V0', role: 'technical', status: 'EXECUTED_PASS' }],
    findings: [
      { id: 'B1-business-F1', state: 'stands', label: 'SUSPECTED', canonical: true },
      { id: 'T1-technical-F1', state: 'withdrawn', label: 'SUSPECTED', canonical: true },
      { id: 'T1-technical-F2', state: 'not_challenged', label: 'SUSPECTED', canonical: true },
    ],
  });
  put(path.join(dir, 'feedback.json'), { findings: [{ id: 'B1-business-F1', verdict: 'kept' }, { id: 'T1-technical-F2', verdict: 'dropped' }] });
  return dir;
}

test('error patterns drop specifics; job kinds come from labels', () => {
  assert.equal(errorPattern(NOT_INPUT(0)), errorPattern(NOT_INPUT(7)));
  assert.equal(errorPattern(NOT_INPUT(0)), '$.findings[].evidence[].path: "…" is not a frozen input id');
  assert.equal(jobKind('B1-business'), 'packet:business/business');
  assert.equal(jobKind('V0_2-technical'), 'packet:viewpoint/technical');
  assert.equal(jobKind('rebuttal-B1-business-F1'), 'rebuttal');
});

test('retrospective: totals, repairs, rejected patterns, producers, suggestions', () => {
  for (let i = 1; i <= 5; i += 1) makeRun(i);
  makeRun(9, { at: '2020-01-01T00:00:00Z' });
  const r = retrospective({ sinceDays: 30 });
  assert.equal(r.totals.runs, 5, 'the old run is outside the window');
  assert.deepEqual([r.totals.calls, r.totals.repairs], [30, 10]);
  assert.equal(r.patterns[0].count, 10);
  assert.deepEqual(r.patterns[0].kinds, { 'packet:business/business': 5, 'packet:viewpoint/technical': 5 });
  assert.equal(r.kinds['packet:business/business'].first_try_rate, 0);
  assert.equal(r.kinds['packet:technical/technical'].first_try_rate, 1);
  assert.deepEqual(r.producers['technical/technical'], { findings: 10, withdrawn: 5, canonical: 10, kept: 0, dropped: 5 });
  const text = r.suggestions.map((s) => `${s.area}: ${s.text}`).join('\n');
  assert.match(text, /prompts: 33% of model calls were repairs\. Most common rejection \(10×\)/);
  assert.match(text, /validator: "\$\.findings\[\]\.evidence\[\]\.path: "…" is not a frozen input id" was rejected 10×/);
  assert.match(text, /first pass: The red team withdrew 33% of 15 findings/);
  assert.match(text, /noise: technical\/technical: people kept 0 of 5/);
  assert.match(renderRetro(r), /\| packet:business\/business \| 5 \| 10 \| 5 \| 0% \|/);
  assert.equal(retrospective().totals.runs, 6, 'no window: every run');
});
