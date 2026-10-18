'use strict';
// Large PRs: viewpoints split into parts, units scored by risk, a split
// proposal along the planned units.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUnits } = require('../src/lib/plan');
const { prSize, fileRisks, scoreUnits, suggestSplit } = require('../src/lib/pr-size');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-size-runs-');

const files = [
  ...Array.from({ length: 30 }, (_, i) => `web/ui/Component${String(i).padStart(2, '0')}.java`),
  ...Array.from({ length: 20 }, (_, i) => `billing/refund/Refund${String(i).padStart(2, '0')}.java`),
  'docs/guide.md',
];
const parsed = files.map((f) => ({ path: f, added: f.startsWith('billing') ? 40 : 30, removed: 5, hunks: [] }));

test('viewpoints over many files are split into parts of neighbouring files', () => {
  const plan = { units: [
    { id: 'B1', kind: 'business', desc: 'refunds', files: files.filter((f) => f.startsWith('billing')), items: [] },
    { id: 'T1', kind: 'technical', desc: 'ui', files: files.filter((f) => f.startsWith('web')), items: [] },
  ] };
  const res = buildUnits(plan, files, null);
  assert.deepEqual(res.errors, []);
  const v0 = res.units.filter((u) => u.kind === 'viewpoint' && u.id.startsWith('V0'));
  assert.deepEqual(v0.map((u) => u.id), ['V0_1', 'V0_2', 'V0_3']);
  assert.ok(v0.every((u) => u.covers.length - 1 <= 25), 'at most 25 files per part');
  const covered = v0.flatMap((u) => u.covers.filter((c) => c.startsWith('file:')));
  assert.deepEqual(covered.sort(), files.map((f) => `file:${f}`).sort(), 'every file is swept once per viewpoint');
  assert.ok(v0[0].covers.includes(`viewpoint:V0_1`));
  assert.match(v0[0].desc, /Part 1\/3: billing\/refund/);
  // Small PRs keep the single free review V0.
  assert.deepEqual(buildUnits({ units: [plan.units[0]] }, plan.units[0].files, null).units.filter((u) => u.kind === 'viewpoint').map((u) => u.id), ['V0']);
});

test('size, risk order and split proposal', () => {
  process.env.ARW_LARGE_PR_FILES = '40';
  const size = prSize(parsed, files);
  delete process.env.ARW_LARGE_PR_FILES;
  assert.equal(prSize(parsed, files).large, false, 'defaults: 60 files / 2000 lines');
  // 20 billing files of 45 lines, 30 ui files and the doc of 35 lines each.
  assert.deepEqual([size.files, size.lines, size.large], [51, 20 * 45 + 31 * 35, true]);
  assert.equal(prSize(parsed.slice(0, 5), files.slice(0, 5)).large, false);
  const risks = fileRisks(parsed, files, [{ path: 'web/ui/Component00.java', line: 3 }]);
  assert.ok(risks.get('billing/refund/Refund00.java') > risks.get('web/ui/Component01.java'), 'money paths weigh more');
  assert.ok(risks.get('web/ui/Component00.java') > risks.get('web/ui/Component01.java'), 'boundary signals weigh more');
  assert.ok(risks.get('docs/guide.md') < risks.get('web/ui/Component01.java'), 'docs weigh less');
  const units = buildUnits({ units: [
    { id: 'B1', kind: 'business', desc: 'refunds', files: files.filter((f) => f.startsWith('billing')), items: [] },
    { id: 'T1', kind: 'technical', desc: 'ui', files: files.filter((f) => f.startsWith('web')), items: [] },
  ] }, files, null).units;
  scoreUnits(units, risks);
  const b1 = units.find((u) => u.id === 'B1');
  const t1 = units.find((u) => u.id === 'T1');
  assert.ok(b1.risk > t1.risk, `${b1.risk} > ${t1.risk}: 20 refund files outweigh 30 ui files`);
  const split = suggestSplit(units, parsed);
  assert.deepEqual(split.map((p) => p.units.join('+')), ['B1', 'T1', 'O1']);
  assert.equal(split[0].lines, 20 * 45);
  // Units sharing a file belong to the same proposed PR.
  const shared = buildUnits({ units: [
    { id: 'B1', kind: 'business', desc: 'refunds', files: ['billing/refund/Refund00.java', 'web/ui/Component00.java'], items: [] },
    { id: 'T1', kind: 'technical', desc: 'ui', files: ['web/ui/Component00.java'], items: [] },
  ] }, ['billing/refund/Refund00.java', 'web/ui/Component00.java'], null).units;
  scoreUnits(shared, risks);
  assert.deepEqual(suggestSplit(shared, parsed).map((p) => p.units.sort().join('+')), ['B1+T1']);
});

test('a large PR is reviewed with split viewpoints, riskiest first, and a split proposal', async () => {
  process.env.ARW_VIEWPOINT_FILES = '6';
  process.env.ARW_LARGE_PR_FILES = '10';
  const dir = tmpDir('arw-large-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'README.md', 'x\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  for (let i = 0; i < 8; i += 1) write(dir, `ui/view${i}.py`, `def view${i}():\n    return ${i}\n`);
  for (let i = 0; i < 6; i += 1) write(dir, `billing/refund${i}.py`, `def refund${i}(amount):\n    return amount  # BUG: refund ignores fees\n`);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'big change']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  const { reviewPr } = require('../src/lib/pr-review');
  const fake = require('./fixtures/fake-review-executor');
  const started = [];
  const executor = (opts) => {
    if (opts.prompt.startsWith('You are a read-only planner')) {
      fs.mkdirSync(opts.attemptDir, { recursive: true });
      const all = [...Array(8).keys()].map((i) => `ui/view${i}.py`);
      const money = [...Array(6).keys()].map((i) => `billing/refund${i}.py`);
      const units = [{ id: 'T1', kind: 'technical', desc: 'ui', files: all, items: [] }, { id: 'T2', kind: 'technical', desc: 'refunds', files: money, items: [] }];
      return { ok: true, output: JSON.stringify({ schema_version: '1.0', hypotheses: [], units, gaps: [], notes: '' }), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, turns: 1, commands: 0, error_class: null, error_message: null, model: 'fake', prompt_bytes: 1 };
    }
    const m = opts.prompt.match(/^UNIT: (.*)$/m);
    if (m) started.push(JSON.parse(m[1]).id);
    return fake(opts);
  };
  const prepared = { info: { title: 'big change', body: '', headRefName: 'big', baseRefName: 'main', url: null }, checkout: dir, head, base };
  const { validation, report } = await reviewPr({ repo: 'acme/big', pr: 1, executor, prepared, workers: 1, noRepro: true, skipSynthesis: true });
  delete process.env.ARW_VIEWPOINT_FILES;
  delete process.env.ARW_LARGE_PR_FILES;
  assert.equal(validation.status, 'EXECUTED_PASS', JSON.stringify(validation.jobs.filter((j) => j.errors.length), null, 1));
  assert.deepEqual(validation.jobs.filter((j) => j.unit_id.startsWith('V0')).map((j) => j.unit_id), ['V0_1', 'V0_2', 'V0_3']);
  assert.equal(validation.size.large, true);
  // With one worker, the order is visible: after the viewpoints, refund (money) units before ui ones.
  const units = JSON.parse(fs.readFileSync(path.join(require('../src/lib/runs').prDir('acme/big', 1), 'run.json'), 'utf8')).review.units;
  const riskOf = (id) => units.find((u) => u.id === id).risk;
  assert.ok(riskOf('T2') > riskOf('T1'), `6 refund files (${riskOf('T2')}) outweigh 8 ui files (${riskOf('T1')})`);
  assert.deepEqual(started.filter((id) => /^T/.test(id)), ['T2', 'T1'], 'the riskier unit runs first');
  assert.ok(validation.findings.some((f) => f.id.startsWith('T2-technical')), 'the planted refund defect is found');
  const text = fs.readFileSync(report, 'utf8');
  assert.match(text, /## Large PR: 14 files/);
  assert.match(text, /Consider splitting along the planned units/);
});
