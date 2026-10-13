'use strict';
// Findings of the second external deep review (2026-10-14), each reproduced
// here before it was fixed: N1 model text (test path, selector) or PR file
// names reaching a shell command, N2 host-side writes and reads following
// symlinks out of the worktree, N3 stale-lock reclaim deleting a live lock,
// N4 sandbox settings outside the frozen execution manifest, N5 an
// incomplete impacted-test run counted as a pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tmpDir, sh, write, makeRepo } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-audit2-runs-');

const { validateReproTest, commandFor, applyFix } = require('../src/lib/repro');
const { planRuns, runImpactedTests } = require('../src/lib/impacted-tests');
const { acquireLock } = require('../src/lib/driver');

// A directory link that needs no admin rights on Windows (a junction); a
// symlink elsewhere.
function link(target, at) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
}

function javaTest(p, selector) {
  return { language: 'java', path: p, selector, content: 'package com.acme;\nclass ReproTest { void t() { org.junit.Assert.assertEquals(1, new OrderService().discount(true, null)); } }\n', fails_because: 'x' };
}

test('N1: a test path or selector with shell syntax is rejected before it can reach a command', () => {
  const repo = makeRepo();
  const context = { source: { checkout: repo.dir, head_sha: repo.head, base_sha: repo.base } };
  const injected = 'x;printf${IFS}INJECTED>marker;#/src/test/java/com/acme/ReproTest.java';
  assert.match(validateReproTest(javaTest(injected, 'com.acme.ReproTest'), { context }).join('\n'), /\$\.path/, 'the path passes only if every part of it is plain');
  assert.match(validateReproTest(javaTest('src/test/java/com/acme/ReproTest.java', 'com.acme.ReproTest#t;touch pwned'), { context }).join('\n'), /\$\.selector/, 'the #method part goes into mvn -Dtest=');
  assert.deepEqual(validateReproTest(javaTest('src/test/java/com/acme/ReproTest.java', 'com.acme.ReproTest'), { context }), []);
  const py = (p, selector) => ({ language: 'python', path: p, selector, content: 'from billing.fees import late_fee\n\ndef test_fee():\n    assert late_fee(3) == 1.5\n', fails_because: 'x' });
  assert.match(validateReproTest(py('tests/test_fee.py', 'tests/test_fee.py::test_fee; touch pwned'), { context }).join('\n'), /\$\.selector/);
  // Python paths were already held back by the selector schema (the selector starts with the path).
  assert.match(validateReproTest(py('a$(touch pwned)/test_fee.py', 'a$(touch pwned)/test_fee.py::test_fee'), { context }).join('\n'), /\$\.(path|selector)/);
});

test('N1: the command builder refuses unsafe values itself, also for a custom command with {path}', () => {
  const dir = tmpDir('arw-audit2-n1-');
  const injected = { language: 'java', path: 'x;printf${IFS}INJECTED>marker;#/src/test/java/com/acme/ReproTest.java', selector: 'com.acme.ReproTest' };
  assert.throws(() => commandFor(null, injected, dir, './run.sh {path}'), /unsafe/);
  assert.throws(() => commandFor('maven', { language: 'java', path: 'src/test/java/com/acme/ReproTest.java', selector: 'com.acme.ReproTest#t&calc' }, dir, null), /unsafe/);
  const ok = commandFor(null, { language: 'java', path: 'src/test/java/com/acme/ReproTest.java', selector: 'com.acme.ReproTest' }, dir, './run.sh {path}');
  assert.equal(ok.command, './run.sh src/test/java/com/acme/ReproTest.java');
});

test('N1: impacted tests skip PR file names that are not plain paths', () => {
  const root = tmpDir('arw-audit2-n1b-');
  write(root, 'pom.xml', '<project/>');
  const groups = planRuns(root, ['src/test/java/com/a;touch pwned;b/XTest.java', 'tests/test_$(touch pwned).py', 'src/test/java/com/acme/ATest.java']);
  assert.deepEqual(groups.flatMap((g) => g.tests.map((t) => t.selector)), ['com.acme.ATest']);
});

test('N2: the reproduction test is not written through a directory link out of the worktree', () => {
  const { writeNewFile } = require('../src/lib/confine');
  const root = tmpDir('arw-audit2-n2-');
  const outside = tmpDir('arw-audit2-outside-');
  link(outside, path.join(root, 'tests'));
  assert.throws(() => writeNewFile(root, 'tests/test_new.py', 'x'), /link/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside');
  writeNewFile(root, 'other/deep/test_new.py', 'ok');
  assert.equal(fs.readFileSync(path.join(root, 'other', 'deep', 'test_new.py'), 'utf8'), 'ok');
  assert.throws(() => writeNewFile(root, 'other/deep/test_new.py', 'again'), /exists/, 'a new test never overwrites a file');
});

test('N2: a JUnit report that is a link out of the worktree is not read', () => {
  const { readConfined } = require('../src/lib/confine');
  const root = tmpDir('arw-audit2-n2r-');
  const outside = tmpDir('arw-audit2-secret-');
  fs.writeFileSync(path.join(outside, 'TEST-x.xml'), 'SECRET');
  link(outside, path.join(root, 'target', 'surefire-reports'));
  assert.equal(readConfined(root, path.join(root, 'target', 'surefire-reports', 'TEST-x.xml')), null);
  write(root, 'build/r.xml', '<testsuite/>');
  assert.equal(readConfined(root, path.join(root, 'build', 'r.xml')), '<testsuite/>');
});

test('N2: the finding’s fix is not applied through a link', () => {
  const wt = tmpDir('arw-audit2-n2f-');
  const outside = tmpDir('arw-audit2-victim-');
  fs.writeFileSync(path.join(outside, 'fees.py'), 'if days < 30:\n');
  link(outside, path.join(wt, 'billing'));
  const finding = { evidence: [{ kind: 'code', path: 'billing/fees.py', revision: 'head' }], fix: { kind: 'code_change', asis: 'if days < 30:', tobe: 'if days <= 30:' } };
  assert.equal(applyFix(wt, finding).applied, false);
  assert.equal(fs.readFileSync(path.join(outside, 'fees.py'), 'utf8'), 'if days < 30:\n', 'the file outside is unchanged');
});

test('N3: a reclaimer that judged a lock stale does not delete the lock another driver took since', () => {
  const { reclaimStale } = require('../src/lib/driver');
  const runDir = tmpDir('arw-audit2-n3-');
  const lock = path.join(runDir, 'review', 'driver.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const stale = JSON.stringify({ pid: 999999, at: 'x', token: 'old' });
  fs.writeFileSync(lock, stale);
  // B read the stale lock. Meanwhile A reclaimed it and now holds a live one.
  const live = JSON.stringify({ pid: process.ppid, at: 'y', token: 'a' });
  fs.writeFileSync(lock, live);
  assert.equal(reclaimStale(lock, stale), false, 'B must not reclaim');
  assert.equal(fs.readFileSync(lock, 'utf8'), live, "A's lock is intact");
  // The lock B judged is still there: B may take it.
  fs.writeFileSync(lock, stale);
  assert.equal(reclaimStale(lock, stale), true);
  assert.ok(!fs.existsSync(lock));
});

test('N3: many drivers starting together on a stale lock: never two owners at once', async () => {
  const runDir = tmpDir('arw-audit2-n3s-');
  const lock = path.join(runDir, 'review', 'driver.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: 'x' }));
  const script = `const { acquireLock } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'driver.js'))});
let release; try { release = acquireLock(process.argv[1]); } catch { process.stdout.write('lost'); process.exit(0); }
const start = Date.now(); setTimeout(() => { release(); process.stdout.write('won ' + start + ' ' + Date.now()); }, 400);`;
  const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, runDir], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
  })));
  const held = runs.filter((r) => r.startsWith('won')).map((r) => r.split(' ').slice(1).map(Number));
  assert.ok(held.length >= 1, `someone reclaims the stale lock: ${runs.join(' | ')}`);
  for (let i = 0; i < held.length; i += 1) {
    for (let j = i + 1; j < held.length; j += 1) assert.ok(held[i][1] <= held[j][0] || held[j][1] <= held[i][0], `two drivers held the lock at once: ${JSON.stringify(held)}`);
  }
});

test('N4: the sandbox and the executor module are part of the frozen execution manifest', () => {
  const { freezeContext, verifyContext } = require('../src/lib/freeze');
  const repo = makeRepo();
  const runDir = tmpDir('arw-audit2-n4-');
  const review = { units: [] };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ review }));
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith('ARW_SANDBOX')) delete process.env[k];
    const context = freezeContext({ runDir, checkout: repo.dir, base: repo.base, head: repo.head, changed: [], reviewable: [], patch: '', review, inputs: [] });
    assert.deepEqual(verifyContext(runDir, context), []);
    process.env.ARW_SANDBOX = 'docker';
    assert.match(verifyContext(runDir, context).join('\n'), /execution settings changed since freeze: sandbox/, 'host shell -> docker is drift');
    const docker = freezeContext({ runDir, checkout: repo.dir, base: repo.base, head: repo.head, changed: [], reviewable: [], patch: '', review, inputs: [] });
    process.env.ARW_SANDBOX_NETWORK = 'bridge';
    assert.match(verifyContext(runDir, docker).join('\n'), /sandbox/, 'opening the network is drift');
    delete process.env.ARW_SANDBOX_NETWORK;
    process.env.ARW_SANDBOX_IMAGE_MAVEN = 'maven:other';
    assert.match(verifyContext(runDir, docker).join('\n'), /sandbox/, 'another image is drift');
    delete process.env.ARW_SANDBOX_IMAGE_MAVEN;
    const mod = path.join(tmpDir('arw-audit2-exec-'), 'exec.js');
    fs.writeFileSync(mod, 'module.exports = async () => ({});\n');
    process.env.ARW_EXECUTOR_MODULE = mod;
    const custom = freezeContext({ runDir, checkout: repo.dir, base: repo.base, head: repo.head, changed: [], reviewable: [], patch: '', review, inputs: [] });
    fs.writeFileSync(mod, 'module.exports = async () => ({ changed: true });\n');
    assert.match(verifyContext(runDir, custom).join('\n'), /executor/, 'the executor module was edited');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('N5: a test whose cases passed before its run timed out or failed is not a pass', async () => {
  const dir = tmpDir('arw-audit2-n5-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'pom.xml', '<project/>');
  write(dir, 'src/test/java/com/acme/ATest.java', 'class ATest { }\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'src/test/java/com/acme/ATest.java', 'class ATest { int x; }\n');
  sh(dir, ['commit', '-q', '-am', 'head']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  const impact = { sources: [], tests_changed: ['src/test/java/com/acme/ATest.java'] };
  const xml = (cwd) => {
    fs.mkdirSync(path.join(cwd, 'target', 'surefire-reports'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'target', 'surefire-reports', 'TEST-com.acme.ATest.xml'), '<testsuite><testcase classname="com.acme.ATest" name="a"/></testsuite>');
  };
  // Base: a clean pass. Head: case a passed, then the run timed out.
  let n = 0;
  const timedOut = async ({ cwd, logFile }) => {
    fs.writeFileSync(logFile, 'x');
    xml(cwd);
    n += 1;
    return n === 1 ? { exit_code: 0, elapsed_ms: 1 } : { exit_code: null, timed_out: true, elapsed_ms: 1 };
  };
  let r = await runImpactedTests({ runDir: tmpDir('arw-audit2-n5r-'), checkout: dir, base, head, impact, repoCfg: { run_impacted_tests: true }, runner: timedOut });
  assert.notEqual(r.results[0].head.status, 'pass', 'the head run did not finish');
  assert.notEqual(r.results[0].verdict, 'passing');
  // Head: every case passed but the build failed afterwards.
  n = 0;
  const failedBuild = async ({ cwd, logFile }) => {
    fs.writeFileSync(logFile, 'x');
    xml(cwd);
    n += 1;
    return { exit_code: n === 1 ? 0 : 1, elapsed_ms: 1 };
  };
  r = await runImpactedTests({ runDir: tmpDir('arw-audit2-n5r-'), checkout: dir, base, head, impact, repoCfg: { run_impacted_tests: true }, runner: failedBuild });
  assert.notEqual(r.results[0].head.status, 'pass', 'the command failed with no failing case to explain it');
  assert.equal(r.results[0].base.status, 'pass');
});

test('a worktree whose .git file is gone is not mistaken for the repository around it', () => {
  const git = require('../src/lib/git');
  const outer = tmpDir('arw-audit2-outer-');
  sh(outer, ['init', '-q', '-b', 'main']);
  write(outer, 'tool.txt', 'the tool repository\n');
  sh(outer, ['add', '-A']);
  sh(outer, ['commit', '-q', '-m', 'outer']);
  const repo = makeRepo();
  const wt = path.join(outer, 'runs', 'wt');
  sh(repo.dir, ['worktree', 'add', '--detach', wt, repo.head]);
  assert.equal(git.worktreeGit(repo.dir, wt, ['rev-parse', 'HEAD']).trim(), repo.head);
  fs.rmSync(path.join(wt, '.git'), { force: true });
  fs.writeFileSync(path.join(outer, 'tool.txt'), 'edited\n');
  git.worktreeGit(repo.dir, wt, ['checkout', '--', '.'], { allowFail: true });
  assert.equal(fs.readFileSync(path.join(outer, 'tool.txt'), 'utf8'), 'edited\n', 'git did not act on the outer repository');
  assert.equal(git.worktreeGit(repo.dir, wt, ['rev-parse', 'HEAD']).trim(), repo.head, 'the git dir comes from the main repository');
  assert.equal(git.worktreeGit(repo.dir, tmpDir('arw-audit2-notwt-'), ['status'], { allowFail: true }), null);
});
