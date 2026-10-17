'use strict';
// What the dashboard shows while a review runs: one state per pipeline step,
// read from run.json and the driver log of the latest batch; and logs that
// stay readable (with stack traces) after a job ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-progress-runs-');

const { reviewSteps } = require('../src/web/insights');

const line = (msg, t = '10:00:00') => `2026-10-17T${t}.000Z pid=1 ${msg}`;
const state = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.state]));

test('steps of a review that is in W1, with an older batch in the same log', () => {
  const run = { phases: { prepare: { status: 'EXECUTED_PASS' }, ticket: { status: 'EXECUTED_PASS', ticket: 'PRSHOP-7', intent: 'unconfirmed', items: 9 }, plan: { status: 'EXECUTED_PASS', units: 4 }, freeze: { status: 'EXECUTED_PASS' }, batch: { status: 'RUNNING' } } };
  const log = [
    line('batch start context=old workers=4', '09:00:00'), line('W1 2 job(s)'), line('W2 0 seam job(s)'), line('W3 1 cluster(s) need a rebuttal'), line('start synthesis attempt=1 mode=full'), line('accepted synthesis'), line('batch done'),
    line('batch start context=new workers=4'), line('W1 6 job(s) (0 already valid)'),
    line('start B1-business attempt=1 mode=full'), line('accepted B1-business'), line('start B1-technical attempt=1 mode=full'), line('rejected B1-technical: $.findings[0]: bad quote'),
  ].join('\n');
  const steps = reviewSteps({ run, driverLog: log, active: true });
  assert.deepEqual(steps.map((s) => s.id), ['prepare', 'intent', 'plan', 'freeze', 'W1', 'W2', 'W3', 'W4', 'validate', 'repro', 'report']);
  assert.deepEqual(state(steps), { prepare: 'done', intent: 'warn', plan: 'done', freeze: 'done', W1: 'running', W2: 'pending', W3: 'pending', W4: 'pending', validate: 'pending', repro: 'pending', report: 'pending' }, 'only the latest batch counts');
  const w1 = steps.find((s) => s.id === 'W1');
  assert.match(w1.detail, /6 job\(s\)/);
  assert.match(w1.detail, /1 accepted · 1 being repaired/);
  assert.match(steps.find((s) => s.id === 'intent').detail, /PRSHOP-7 · not confirmed · 9 items/);
});

test('steps of a finished review: skipped waves and repro, a report', () => {
  const run = { phases: { prepare: { status: 'EXECUTED_PASS' }, ticket: { status: 'SKIPPED' }, plan: { status: 'EXECUTED_PASS' }, freeze: { status: 'EXECUTED_PASS' }, batch: { status: 'EXECUTED_PASS' }, repro: { status: 'SKIPPED', reason: 'disabled (--no-repro)' } } };
  const log = [line('batch start context=c workers=4'), line('W1 4 job(s) (0 already valid)'), line('W2 0 seam job(s)'), line('batch done')].join('\n');
  const steps = reviewSteps({ run, driverLog: log, active: false, hasReport: true });
  assert.deepEqual(state(steps), { prepare: 'done', intent: 'skipped', plan: 'done', freeze: 'done', W1: 'done', W2: 'skipped', W3: 'skipped', W4: 'skipped', validate: 'done', repro: 'skipped', report: 'done' });
  assert.match(steps.find((s) => s.id === 'repro').detail, /--no-repro/);
});

test('a job that died marks the step it was in as failed; a review waiting for its intent says so', () => {
  const run = { phases: { prepare: { status: 'EXECUTED_PASS' }, ticket: { status: 'EXECUTED_PASS' }, plan: { status: 'EXECUTED_PASS' }, freeze: { status: 'EXECUTED_PASS' }, batch: { status: 'RUNNING' } } };
  const log = [line('batch start context=c workers=4'), line('W1 4 job(s) (0 already valid)'), line('W2 1 seam job(s)')].join('\n');
  const died = reviewSteps({ run, driverLog: log, active: false, jobStatus: 'failed' });
  assert.deepEqual([state(died).W1, state(died).W2, state(died).W3], ['done', 'failed', 'pending']);
  const waiting = reviewSteps({ run: { phases: { prepare: { status: 'EXECUTED_PASS' }, ticket: { status: 'AWAITING_INTENT', ticket: 'PRSHOP-8' } } }, driverLog: '', active: false });
  assert.equal(state(waiting).intent, 'waiting');
  assert.equal(state(waiting).plan, 'pending');
  const deriving = reviewSteps({ run: { phases: { prepare: { status: 'EXECUTED_PASS' }, ticket: { status: 'RUNNING', step: 'deriving the intent from the PR' } } }, driverLog: '', active: true });
  assert.deepEqual([state(deriving).intent, deriving.find((s) => s.id === 'intent').detail], ['running', 'deriving the intent from the PR']);
});

test('the driver log of a run can be read from the dashboard, the tail of it', () => {
  const data = require('../src/web/data');
  const { prDir } = require('../src/lib/runs');
  const dir = prDir('acme/shop', 3);
  fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ identity: { repo: 'acme/shop', pr: 3 }, phases: {} }));
  fs.writeFileSync(path.join(dir, 'review', 'driver.log'), `${'x'.repeat(300000)}\n${line('batch start context=c workers=4')}\n`);
  const log = data.prDriverLog('acme__shop__3');
  assert.ok(log.text.endsWith('batch start context=c workers=4\n'));
  assert.ok(log.text.length <= 200 * 1024 + 200, 'only the tail');
  assert.equal(log.truncated, true);
});

test('a dashboard job that fails leaves its stack trace in the job log', async () => {
  const { JobQueue } = require('../src/web/jobs');
  const queue = new JobQueue();
  const job = queue.enqueue({ kind: 'validate', title: 'missing run', args: ['validate', '--repo', 'nobody/nothing', '--pr', '1'], target: null });
  const deadline = Date.now() + 60000;
  while (['queued', 'running'].includes(queue.get(job.id).status) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.equal(queue.get(job.id).status, 'failed');
  const text = queue.readLog(job.id, 0).text;
  assert.match(text, /^error: /m);
  assert.match(text, /^\s+at /m, 'ARW_DEBUG is on for dashboard jobs');
});
