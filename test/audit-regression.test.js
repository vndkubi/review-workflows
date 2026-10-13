'use strict';
// Findings of an external deep review (2026-10-13), each reproduced here
// before it was fixed: F1 CONFIRMED without a control, F2 repro status not
// re-derived from raw evidence, F3 budget admission race, F4 custom JUnit
// path, F5 nonzero exit counted as green, F6 non-atomic driver lock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeRepo } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-audit-runs-');

const { classify, commandFor, validateReproTest, loadReproRecords, trailer } = require('../src/lib/repro');
const { reproFields } = require('../src/lib/outcome');
const { runModelJob, acquireLock } = require('../src/lib/driver');
const { sha256 } = require('../src/lib/util');

test('F1: a test that fails twice is not enough for CONFIRMED; it needs a control (fix or base)', () => {
  const rec = (extra) => new Map([['B1-business-F1', { status: 'RED_PROVEN', runs: [{ phase: 'head-1', status: 'red' }, { phase: 'head-2', status: 'red' }], ...extra }]]);
  const noControl = reproFields('B1-business-F1', null, rec({ fix: { applied: false, verified: null } }), 'stands');
  assert.notEqual(noControl.label, 'CONFIRMED', 'fails twice, but nothing shows it fails because of the defect');
  assert.equal(noControl.label, 'REPRODUCED');
  const fixed = reproFields('B1-business-F1', null, rec({ fix: { applied: true, verified: true } }), 'stands');
  assert.deepEqual([fixed.label, fixed.evidence_level], ['CONFIRMED', 'L3'], 'red on head, green with the fix: broken/fixed control');
  const regression = reproFields('B1-business-F1', null, rec({ fix: { applied: false, verified: null }, runs: [{ phase: 'head-1', status: 'red' }, { phase: 'head-2', status: 'red' }, { phase: 'base', status: 'green' }] }), 'stands');
  assert.equal(regression.label, 'CONFIRMED', 'red on head, green on base: regression control');
});

test('F1: a reproduction test must exercise the finding’s code, not assert a constant', () => {
  const repo = makeRepo();
  const context = { source: { checkout: repo.dir, head_sha: repo.head, base_sha: repo.base } };
  const finding = { id: 'B2-technical-F1', evidence: [{ kind: 'code', path: 'billing/fees.py', start_line: 1, end_line: 1, quote: 'def late_fee(days, rate=0.5):' }], fix: { kind: 'code_change', asis: 'def late_fee(days, rate=0.5):', tobe: 'x', reason: 'r' } };
  const t = (content) => ({ language: 'python', path: 'tests/test_repro_fee.py', selector: 'tests/test_repro_fee.py::test_fee', content, fails_because: 'x' });
  assert.match(validateReproTest(t('def test_fee():\n    assert False\n'), { context, finding }).join('\n'), /always fails|does not call/);
  assert.match(validateReproTest(t('def test_fee():\n    assert 1 == 2\n'), { context, finding }).join('\n'), /does not call/);
  assert.deepEqual(validateReproTest(t('from billing.fees import late_fee\n\ndef test_fee():\n    assert late_fee(3) == 1.5\n'), { context, finding }), []);
});

test('F2: repro status is re-derived from the stored JUnit XML and exit code, not from the record', () => {
  const runDir = tmpDir('arw-audit-f2-');
  const context = { context_id: 'c1', context_digest: 'd'.repeat(64) };
  const dir = path.join(runDir, 'review', 'revisions', 'c1', 'repro');
  fs.mkdirSync(path.join(dir, 'F'), { recursive: true });
  const put = (rel, text) => {
    fs.writeFileSync(path.join(dir, rel), text);
    return { path: `repro/${rel}`, sha256: sha256(text) };
  };
  const passing = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="T" name="t"/></testsuite>';
  const runs = ['head-1', 'head-2'].map((phase) => ({
    phase,
    status: 'red', // forged: the raw evidence below says the test passed
    exit_code: 1,
    junit: { tests: 1, failures: 1, errors: 0, skipped: 0 },
    log: put(`F/${phase}.log`, `ok\n${trailer({ exit_code: 0, timed_out: false })}\n`),
    junit_xml: put(`F/${phase}.junit.xml`, passing),
  }));
  fs.writeFileSync(path.join(dir, 'F.json'), JSON.stringify({ finding_id: 'F', context_digest: context.context_digest, status: 'RED_PROVEN', test: { artifact: put('F/test_x.py', 'def test_x(): pass') }, runs }));
  const { records, errors } = loadReproRecords(runDir, context);
  assert.equal(records.size, 0, 'a record whose raw evidence contradicts it is not evidence');
  assert.match(errors.join('\n'), /run head-1 does not follow from its raw evidence \(red recorded, green in the artifacts\)/);
  // A record from before raw evidence was kept is not trusted either.
  for (const r of runs) fs.writeFileSync(path.join(dir, r.log.path.slice('repro/'.length)), 'ok\n');
  for (const r of runs) r.log.sha256 = sha256('ok\n');
  fs.writeFileSync(path.join(dir, 'F.json'), JSON.stringify({ finding_id: 'F', context_digest: context.context_digest, status: 'RED_PROVEN', test: { artifact: { path: 'repro/F/test_x.py', sha256: sha256('def test_x(): pass') } }, runs }));
  assert.match(loadReproRecords(runDir, context).errors.join('\n'), /no raw evidence/);
});

test('F3: the call budget is reserved before a model call, so parallel workers cannot overshoot it', async () => {
  process.env.ARW_MAX_CALLS = '1';
  try {
    const runDir = tmpDir('arw-audit-f3-');
    let calls = 0;
    const executor = async (opts) => {
      calls += 1;
      fs.mkdirSync(opts.attemptDir, { recursive: true });
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, output: '{}', exit_code: 0, elapsed_ms: 30, usage: { input_tokens: 1, output_tokens: 1 }, error_class: null, model: 'fake', prompt_bytes: 1 };
    };
    const env = { runDir, context: { context_id: 'c1', context_digest: 'd', source: { checkout: runDir } }, executor, log: () => {}, receipts: {}, flushReceipts: () => {}, sources: {}, verify: () => [] };
    const job = (i) => runModelJob(env, { label: `j${i}`, outRel: `j${i}.json`, buildPrompt: () => 'p', validate: () => [] });
    const results = await Promise.all([0, 1, 2, 3].map(job));
    assert.equal(calls, 1, `ARW_MAX_CALLS=1 but ${calls} calls started`);
    assert.equal(results.filter((r) => r.status === 'BUDGET_EXCEEDED').length, 3);
  } finally {
    delete process.env.ARW_MAX_CALLS;
  }
});

test('F4: a custom test command reads its report from the path it was given as {junit}', () => {
  const dir = tmpDir('arw-audit-f4-');
  fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>');
  const { command, junit } = commandFor('maven', { language: 'java', selector: 'com.acme.FooReproTest', path: 'x' }, dir, './run-tests.sh {class} --xml {junit}');
  assert.ok(command.includes(junit), `the command writes ${command.split('--xml ')[1]} but the harness reads ${junit}`);
});

test('F5: a passing report with a failing command is not GREEN', () => {
  const junit = { tests: 1, failures: 0, errors: 0, skipped: 0 };
  assert.notEqual(classify({ exit_code: 1, junit }), 'green');
  assert.equal(classify({ exit_code: 0, junit }), 'green');
});

test('B: the frozen context covers the execution, not only the source: a model change is drift', () => {
  const { freezeContext, verifyContext } = require('../src/lib/freeze');
  const repo = makeRepo();
  const runDir = tmpDir('arw-audit-b-');
  const review = { units: [] };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ review }));
  const saved = process.env.CODEX_MODEL;
  process.env.CODEX_MODEL = 'model-a';
  try {
    const context = freezeContext({ runDir, checkout: repo.dir, base: repo.base, head: repo.head, changed: [], reviewable: [], patch: '', review, inputs: [] });
    assert.deepEqual(verifyContext(runDir, context), []);
    assert.equal(context.execution.model, 'model-a');
    process.env.CODEX_MODEL = 'model-b';
    assert.match(verifyContext(runDir, context).join('\n'), /execution settings changed since freeze: model "model-a" -> "model-b", judge_model "model-a" -> "model-b"/);
  } finally {
    if (saved === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = saved;
  }
});

test('A: PR code can run in a container: only the worktree, no network, limits, container paths', () => {
  const { dockerArgs, toContainer, enabled } = require('../src/lib/sandbox');
  const saved = { ...process.env };
  try {
    delete process.env.ARW_SANDBOX_IMAGE;
    delete process.env.ARW_SANDBOX_NETWORK;
    process.env.ARW_SANDBOX = 'docker';
    process.env.ARW_SANDBOX_M2 = '/home/me/.m2/repository';
    assert.equal(enabled(), true);
    const wt = process.platform === 'win32' ? 'C:\\runs\\x\\repro-wt' : '/runs/x/repro-wt';
    const args = dockerArgs({ command: `python -m pytest -q t.py --junitxml=${wt}${path.sep}.arw-junit.xml`, cwd: wt, toolchain: 'maven', name: 'arw-test' });
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('--network'), 'none');
    assert.equal(at('-w'), '/work');
    assert.ok(args.includes(`${wt}:/work`), 'the worktree is the only checkout mounted');
    assert.ok(args.includes('/home/me/.m2/repository:/m2:ro'), 'the Maven repository is read-only');
    assert.ok(args.includes('--memory') && args.includes('--pids-limit') && args.includes('no-new-privileges'));
    assert.equal(args[args.length - 1], 'python -m pytest -q t.py --junitxml=/work/.arw-junit.xml', 'host paths become container paths');
    assert.equal(toContainer('x D:/a/wt/r.xml', 'D:\\a\\wt'), 'x /work/r.xml');
    assert.throws(() => dockerArgs({ command: 'x', cwd: wt, toolchain: 'pytest', name: 'n' }), /ARW_SANDBOX_IMAGE_PYTEST/, 'no default image with pytest');
    const { sandboxPython, gradleWrapper } = require('../src/lib/repro');
    assert.deepEqual([sandboxPython(), gradleWrapper()], [process.env.ARW_PYTHON || 'python', './gradlew'], 'Linux commands inside the image');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('F6: the driver lock is taken atomically; a live holder blocks, a dead one is reclaimed', () => {
  const runDir = tmpDir('arw-audit-f6-');
  const lock = path.join(runDir, 'review', 'driver.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: 'x' }));
  assert.throws(() => acquireLock(runDir), /another driver/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: 'x' }));
  const release = acquireLock(runDir);
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.throws(() => acquireLock(runDir), /another driver|already holds/, 'a second acquisition while held fails');
  release();
  assert.ok(!fs.existsSync(lock));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'driver.js'), 'utf8');
  assert.match(src, /openSync\([^)]*'wx'/, 'exclusive create, not check-then-write');
});
