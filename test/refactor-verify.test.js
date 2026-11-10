'use strict';
// A kept refactor suggestion is run, not believed: the tests that cover its
// file must pass on the head as it is and again with the suggestion applied.
// VERIFIED needs both; a test that turns red means BROKEN; everything else
// (no covering test, a head that is already red, nowhere to run) is
// UNVERIFIED with the reason, never a pass. PR code never runs on the host
// without the existing consent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, viewpointVerdicts, impactVerdicts, coverageIdsOf } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-refactor-verify-runs-');
process.env.ARW_REFACTOR = 'on';

const { reviewPr } = require('../src/lib/pr-review');
const { loadContext, revisionDir } = require('../src/lib/freeze');
const { readJson } = require('../src/lib/util');
const { loadRefactor, applyAt } = require('../src/lib/refactor');

const CALC = 'billing/calc.py';
const OTHER = 'billing/other.py';
const CALC_BASE = `def clamp(value, low, high):
    return max(low, min(value, high))


def fee(days):
    return 0
`;
const CALC_HEAD = `def clamp(value, low, high):
    return max(low, min(value, high))


def fee(days):
    if days is not None:
        if days > 30:
            return (days - 30) * 2
        else:
            return 0
    else:
        return 0


def bounded(rate):
    if rate < 0:
        rate = 0
    if rate > 1:
        rate = 1
    return rate
`;
const OTHER_HEAD = `def sign(n):
    if n >= 0:
        if n == 0:
            return 0
        else:
            return 1
    else:
        return -1
`;
const HEADS = { [CALC]: CALC_HEAD, [OTHER]: OTHER_HEAD };
const ev = (file, from, to) => ({ kind: 'code', path: file, start_line: from, end_line: to, quote: HEADS[file].split('\n').slice(from - 1, to).join('\n') });
const block = (file, from, to) => HEADS[file].split('\n').slice(from - 1, to).join('\n');

const FEE_TOBE = '    if days is None or days <= 30:\n        return 0\n    return (days - 30) * 2';
const GOOD = { id: 'x', kind: 'control_flow', title: 'Early return instead of nested else', reason: 'One guard says what two levels of nesting say.', evidence: [ev(CALC, 6, 12)], fix: { asis: block(CALC, 6, 12), tobe: FEE_TOBE }, reuse: null };
// Simpler by the numbers, wrong in behaviour: the lower bound is gone.
const BAD = { id: 'x', kind: 'control_flow', title: 'One expression for the bound', reason: 'min() does the same.', evidence: [ev(CALC, 16, 20)], fix: { asis: block(CALC, 16, 20), tobe: '    return min(rate, 1)' }, reuse: null };
const UNTESTED = { id: 'x', kind: 'control_flow', title: 'Flatten sign()', reason: 'Two returns instead of three levels.', evidence: [ev(OTHER, 2, 8)], fix: { asis: block(OTHER, 2, 8), tobe: '    if n == 0:\n        return 0\n    return 1 if n > 0 else -1' }, reuse: null };

function repo() {
  const dir = tmpDir('arw-refactor-verify-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, CALC, CALC_BASE);
  write(dir, 'tests/test_calc.py', 'from billing.calc import fee\n\n\ndef test_fee():\n    assert fee(31) == 2\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, CALC, CALC_HEAD);
  write(dir, OTHER, OTHER_HEAD);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'fee, bounded, sign']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

function executor(suggestions) {
  return async (opts) => {
    fs.mkdirSync(opts.attemptDir, { recursive: true });
    const p = opts.prompt;
    const ok = (o) => ({ ok: true, output: JSON.stringify(o), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 10, output_tokens: 5 }, error_class: null, model: 'fake', prompt_bytes: p.length });
    if (p.startsWith('You are a read-only planner')) return ok({ schema_version: '1.0', hypotheses: [], units: [{ id: 'T1', kind: 'technical', desc: 'billing', files: [CALC, OTHER], items: [] }], gaps: [], notes: '' });
    if (p.includes('JOB: refactor suggestions')) return ok({ schema_version: '1.0', context_digest: 'x', role: 'simplifier', suggestions, notes: '' });
    const unit = JSON.parse(p.match(/^UNIT: (.*)$/m)[1]);
    const role = p.match(/^JOB: .* role (business|technical)\.$/m)[1];
    const coverage = coverageIdsOf(p).map((id) => (id.startsWith('file:') ? { id, disposition: 'reviewed', evidence: [ev(id.slice(5), 1, 1)], note: 'read it' } : { id, disposition: 'unverified', evidence: [], note: 'nothing to cite' }));
    return ok({ schema_version: '1.0', context_digest: p.match(/context_digest: ([a-f0-9]{64})/)[1], unit_id: unit.id, role, summary: 'done', dependency_refs: [], coverage, item_verdicts: [], viewpoint_verdicts: viewpointVerdicts(p, []), impact_verdicts: impactVerdicts(p), findings: [], recommendation: 'no_findings' });
  };
}

// Stands in for pytest: tests/test_calc.py fails once bounded() lost its lower
// bound (or always, with headFails). Each call records what it ran against.
function runner(calls, { headFails = false } = {}) {
  return async ({ command, cwd, logFile }) => {
    const src = fs.readFileSync(path.join(cwd, CALC), 'utf8').replace(/\r\n/g, '\n');
    const pass = !headFails && !src.includes('return min(rate, 1)');
    calls.push({ label: path.basename(logFile, '.log'), pass, flattened: src.includes('if days is None or days <= 30:'), command });
    fs.writeFileSync(command.match(/--junitxml=(\S+)/)[1], `<testsuite><testcase classname="tests.test_calc" name="test_fee">${pass ? '' : '<failure message="assert 0 == 1"/>'}</testcase></testsuite>`);
    fs.writeFileSync(logFile, `pytest: ${pass ? 'passed' : 'failed'}\n`);
    return { exit_code: pass ? 0 : 1, elapsed_ms: 1 };
  };
}

async function review(pr, suggestions, { fake = {}, inject = true } = {}) {
  const r = repo();
  const calls = [];
  const prepared = { info: { title: 'fee, bounded, sign', body: '', headRefName: 'f', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { validation, runDir } = await reviewPr({ repo: 'acme/calc', pr, executor: executor(suggestions), prepared, workers: 1, skipSynthesis: true, noRepro: true, ...(inject ? { refactorRunner: runner(calls, fake) } : {}) });
  const context = loadContext(runDir);
  const dir = revisionDir(runDir, context.context_id);
  return { r, calls, validation, runDir, context, dir, loaded: loadRefactor(runDir, context), report: fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), run: readJson(path.join(runDir, 'run.json')) };
}

const outcome = (x) => x.loaded.suggestions.map((s) => [s.id, s.status]);

test('applyAt replaces whole lines and keeps the indentation of the block', () => {
  const wt = tmpDir('arw-apply-');
  write(wt, 'a.py', 'def f(x):\n        if x:\n            return 1\n        return 0\n');
  assert.deepEqual(applyAt(wt, { path: 'a.py', start: 2, end: 4 }, 'return 1 if x else 0'), { applied: true });
  assert.equal(fs.readFileSync(path.join(wt, 'a.py'), 'utf8'), 'def f(x):\n        return 1 if x else 0\n');
  // Removal (dead code): the lines go, nothing is left in their place.
  write(wt, 'b.py', 'a = 1\nb = 2\nc = 3\n');
  applyAt(wt, { path: 'b.py', start: 2, end: 2 }, '');
  assert.equal(fs.readFileSync(path.join(wt, 'b.py'), 'utf8'), 'a = 1\nc = 3\n');
  assert.equal(applyAt(wt, { path: 'missing.py', start: 1, end: 1 }, 'x = 1').applied, false);
});

test('green before and green with it applied: VERIFIED, with the runs kept as evidence', async () => {
  const x = await review(1, [GOOD]);
  assert.deepEqual(outcome(x), [['RF1', 'VERIFIED']]);
  assert.deepEqual(x.calls.map((c) => [c.label, c.pass, c.flattened]), [['baseline-1', true, false], ['all-1', true, true]], 'the head as it is, then the head with the suggestion');
  assert.match(x.calls[0].command, /pytest .*tests\/test_calc\.py/);
  assert.deepEqual(x.loaded.suggestions[0].verification.tests, [{ path: 'tests/test_calc.py', baseline: 'pass', after: 'pass' }]);
  for (const name of ['baseline-1', 'all-1']) assert.ok(fs.existsSync(path.join(x.dir, 'refactor', 'logs', `${name}.log`)), name);
  assert.equal(readJson(path.join(x.dir, 'refactor', 'verification.json')).logs.length, 2);
  assert.match(x.report, /branches 2 → 2 · \*\*VERIFIED\*\* \(tests\/test_calc\.py passes before and after\)/);
  assert.deepEqual([x.run.phases.refactor.verified, x.run.phases.refactor.broken, x.run.phases.refactor.unverified], [1, 0, 0]);
  assert.ok(!fs.existsSync(path.join(x.runDir, 'refactor-wt')), 'the worktree is removed');
  assert.equal(sh(x.r.dir, ['status', '--porcelain']), '', 'the reviewed checkout is untouched');
  assert.equal(x.validation.status, 'EXECUTED_PASS');
});

test('a suggestion that turns a test red is BROKEN; the one beside it is run alone and still VERIFIED', async () => {
  const x = await review(2, [GOOD, BAD]);
  assert.deepEqual(outcome(x), [['RF1', 'VERIFIED'], ['RF2', 'BROKEN']]);
  assert.deepEqual(x.calls.map((c) => [c.label, c.pass]), [['baseline-1', true], ['all-1', false], ['RF1-1', true], ['RF2-1', false]], 'together first; one by one only because that failed');
  assert.match(x.report, /### `RF1` \[control_flow\] Early return instead of nested else/);
  assert.match(x.report, /- `RF2` \[control_flow\] One expression for the bound — rejected: tests\/test_calc\.py fails with it applied/);
  assert.doesNotMatch(x.report, /### `RF2`/, 'a broken suggestion is named, not offered');
  assert.equal(x.validation.recommendation, 'no_blocking_findings');
});

test('no covering test, or a head that is already red: UNVERIFIED with the reason', async () => {
  const untested = await review(3, [UNTESTED]);
  assert.deepEqual(outcome(untested), [['RF1', 'UNVERIFIED']]);
  assert.equal(untested.loaded.suggestions[0].verification.reason, 'no test covers billing/other.py');
  assert.deepEqual(untested.calls, [], 'nothing to run');
  assert.match(untested.report, /\*\*UNVERIFIED\*\* \(no test covers billing\/other\.py\)/);

  const red = await review(4, [GOOD], { fake: { headFails: true } });
  assert.deepEqual(outcome(red), [['RF1', 'UNVERIFIED']]);
  assert.match(red.loaded.suggestions[0].verification.reason, /its tests do not pass on the head as it is \(tests\/test_calc\.py: fail\)/);
  assert.deepEqual(red.calls.map((c) => c.label), ['baseline-1'], 'nothing is applied on a red head');
});

test('PR code does not run on the host without consent, and verification can be switched off', async () => {
  const saved = { ...process.env };
  delete process.env.ARW_SANDBOX;
  delete process.env.ARW_ALLOW_HOST_CODE;
  try {
    const blocked = await review(5, [GOOD], { inject: false });
    assert.deepEqual(outcome(blocked), [['RF1', 'UNVERIFIED']]);
    assert.match(blocked.loaded.suggestions[0].verification.reason, /the tests could not run: host code execution is disabled/);

    process.env.ARW_REFACTOR_VERIFY = 'off';
    const off = await review(6, [GOOD]);
    assert.deepEqual(outcome(off), [['RF1', 'UNVERIFIED']]);
    assert.match(off.loaded.suggestions[0].verification.reason, /verification is off/);
    assert.deepEqual(off.calls, []);
  } finally {
    for (const k of ['ARW_SANDBOX', 'ARW_ALLOW_HOST_CODE', 'ARW_REFACTOR_VERIFY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('a verification record edited after the run proves nothing', async () => {
  const x = await review(7, [UNTESTED]);
  const file = path.join(x.dir, 'refactor', 'verification.json');
  const rec = readJson(file);
  rec.records[0].status = 'VERIFIED';
  fs.writeFileSync(file, JSON.stringify(rec));
  const loaded = loadRefactor(x.runDir, x.context);
  assert.deepEqual(loaded.suggestions.map((s) => s.status), ['UNVERIFIED']);
  assert.match(loaded.suggestions[0].verification.reason, /changed after the run/);
});
