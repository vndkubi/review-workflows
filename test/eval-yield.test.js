'use strict';
// Seen on the pilot2 evals (23 Oct 2026): the multi-agent run found 52% of
// the labels at 26x the tokens of one raw prompt, and nothing said which
// stage earned them. Stage yield splits calls, tokens, reads and true
// findings per stage, from what the runs left on disk (no model call).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, write } = require('./helpers');
const { stageYield, renderYield, jobStage, findingStage } = require('../src/lib/eval-yield');
const { readsOf, readsTotal } = require('../src/lib/eval-measure');

const units = new Map([
  ['P0', { id: 'P0', kind: 'viewpoint', hunt: true, plain: true }],
  ['V0', { id: 'V0', kind: 'viewpoint', hunt: true }],
  ['B1', { id: 'B1', kind: 'business' }],
  ['T1', { id: 'T1', kind: 'technical' }],
  ['S1', { id: 'S1', kind: 'seam' }],
]);

test('stages: a job by its receipt key, a finding by its id', () => {
  assert.equal(jobStage('packets/business/B1.json', units), 'business');
  assert.equal(jobStage('packets/technical/B1.json', units), 'business', 'both roles of a business unit');
  assert.equal(jobStage('plain/P0.json', units), 'plain');
  assert.equal(jobStage('packets/technical/P0.json', units), 'plain', 'the conversion belongs to the plain review');
  assert.equal(jobStage('packets/technical/V0.json', units), 'free');
  assert.equal(jobStage('packets/technical/S1.json', units), 'seam');
  assert.equal(jobStage('rebuttals/B1-business-F1.json', units), 'red team');
  assert.equal(jobStage('synthesis.json', units), 'synthesis');
  assert.equal(jobStage('packets/technical/X9.json', units), 'other');
  assert.equal(findingStage('V0-technical-F2', units, false), 'free');
  assert.equal(findingStage('B1-technical-F1', units, false), 'business');
  assert.equal(findingStage('F1', units, true), 'raw');
});

test('reads: shell commands per counted call; old receipts and rate-limited attempts are not counted', () => {
  const r = readsOf([{ commands: 4 }, { commands: 2 }, { usage: {} }, { commands: 9, mode: 'rate_limited' }]);
  assert.deepEqual(r, { calls: 2, commands: 6, per_call: 3 });
  assert.deepEqual(readsOf([]), { calls: 0, commands: 0, per_call: null });
  assert.deepEqual(readsTotal([r, { calls: 1, commands: 3 }, null]), { calls: 3, commands: 9, per_call: 3 });
});

test('stage yield: cost, true findings and the labels only one stage found', () => {
  const dir = tmpDir('arw-yield-');
  const rel = 'cases/c1/runs/prs/local__x__1';
  const runDir = path.join(dir, rel);
  write(runDir, 'run.json', JSON.stringify({ review: { units: [...units.values()] } }));
  write(runDir, 'plan-work/receipts.json', JSON.stringify({ plan: [{ mode: 'full', usage: { input_tokens: 100 }, commands: 0 }] }));
  write(runDir, 'review/context.json', JSON.stringify({ context_id: 'ctx1' }));
  const r = (mode, tokens, commands) => ({ mode, usage: { input_tokens: tokens }, commands });
  write(runDir, 'review/revisions/ctx1/receipts.json', JSON.stringify({
    'packets/business/B1.json': [r('full', 1000, 2), r('repair', 1000, 2)],
    'packets/technical/V0.json': [r('full', 5000, 17)],
    'plain/P0.json': [r('full', 3000, 9)],
    'packets/technical/P0.json': [r('full', 500, 1)],
    'rebuttals/B1-business-F1.json': [r('rate_limited', 0, 0), r('full', 200, 1)],
  }));
  const card = {
    id: 'run1',
    cases: [
      {
        id: 'c1', status: 'EXECUTED_PASS', run_dir: rel,
        details: {
          findings: [
            { id: 'B1-business-F1', verdict: 'tp' },
            { id: 'P0-technical-F1', verdict: 'tp' },
            { id: 'V0-technical-F1', verdict: 'unlabelled' },
            { id: 'V0-technical-F2', verdict: 'fp' },
          ],
          expected: [
            { id: 'E1', by: ['B1-business-F1'] },
            { id: 'E2', by: ['B1-business-F1', 'P0-technical-F1'] },
            { id: 'E3', by: [] },
          ],
        },
      },
      { id: 'c2', status: 'NO_RESULT', run_dir: null, details: { findings: [], expected: [] } },
    ],
  };
  const res = stageYield([{ card, dir }]);
  assert.equal(res.cases, 1, 'a case without a result is not counted');
  const row = (s) => res.stages.find((x) => x.stage === s);
  assert.deepEqual(res.stages.map((x) => x.stage), ['plan', 'plain', 'free', 'business', 'red team']);
  assert.deepEqual(
    [row('business').jobs, row('business').calls, row('business').repairs, row('business').input_tokens, row('business').reads_p50],
    [1, 2, 1, 2000, 2],
  );
  assert.deepEqual([row('plain').jobs, row('plain').calls, row('plain').input_tokens], [2, 2, 3500], 'prose and conversion');
  assert.deepEqual([row('red team').calls, row('red team').input_tokens], [1, 200], 'a rate-limited attempt is not a call');
  assert.deepEqual([row('free').findings, row('free').tp, row('free').fp, row('free').unlabelled, row('free').labels_found], [2, 0, 1, 1, 0]);
  assert.deepEqual([row('business').tp, row('business').labels_found, row('business').labels_only], [1, 2, 1]);
  assert.deepEqual([row('plain').labels_found, row('plain').labels_only], [1, 0], 'E2 was also found by business');
  const md = renderYield(res, ['run1']);
  assert.match(md, /\| business \| 1 \| 2 \(\d+%\) \| 1 \| 0\.0M \(\d+%\) \| 2 \| 1 \| 1 \| 0 \| 0 \| 2 \| 1 \|/);
});

test('stage yield: a raw-prompt run is one stage', () => {
  const dir = tmpDir('arw-yield-raw-');
  write(dir, 'cases/c1/raw/raw-review.json', JSON.stringify({ receipts: [{ usage: { input_tokens: 50 }, commands: 6 }], findings: [] }));
  const card = { id: 'raw1', cases: [{ id: 'c1', status: 'EXECUTED_PASS', run_dir: 'cases/c1/raw', details: { findings: [{ id: 'F1', verdict: 'tp' }], expected: [{ id: 'E1', by: ['F1'] }] } }] };
  const { stages } = stageYield([{ card, dir }]);
  assert.deepEqual(stages.map((s) => [s.stage, s.calls, s.reads_p50, s.tp, s.labels_only]), [['raw', 1, 6, 1, 1]]);
});

test('stages: a checklist sweep of older runs (viewpoint unit without hunt) is its own stage', () => {
  const old = new Map([['V1', { id: 'V1', kind: 'viewpoint' }]]);
  assert.equal(jobStage('packets/business/V1.json', old), 'sweep');
  assert.equal(findingStage('V1-business-F1', old, false), 'sweep');
});
