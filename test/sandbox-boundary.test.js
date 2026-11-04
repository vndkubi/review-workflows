'use strict';
// The execution boundary: built-in test commands reach the sandbox as argv
// (no shell), a missing docker blocks instead of falling back to the host,
// and impacted-test results say where they ran. The tests at the end run
// real containers; they need a local docker and the default Maven image and
// run only with ARW_DOCKER_TESTS=1 (npm test stays hermetic).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, sh, write, makeRepo } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-boundary-runs-');

const sandbox = require('../src/lib/sandbox');
const { commandFor, classify } = require('../src/lib/repro');
const confine = require('../src/lib/confine');
const git = require('../src/lib/git');

function withEnv(vars, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    sandbox._resetDaemon();
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

// Incident: ARW_SANDBOX=dockre ran PR code on the host shell.
test('an unknown ARW_SANDBOX value blocks instead of falling back to the host', () => {
  const { defaultRunner } = require('../src/lib/repro');
  for (const value of ['dockre', 'Docker', 'yes']) {
    withEnv({ ARW_SANDBOX: value }, () => {
      assert.throws(() => sandbox.mode(), /ARW_SANDBOX/);
      assert.throws(() => defaultRunner(), /ARW_SANDBOX/);
      assert.throws(() => sandbox.manifest(), /ARW_SANDBOX/);
    });
  }
  for (const value of ['', 'off', 'host']) withEnv({ ARW_SANDBOX: value }, () => assert.equal(sandbox.mode(), 'host'));
  withEnv({ ARW_SANDBOX: 'docker' }, () => assert.equal(sandbox.mode(), 'docker'));
});

test('built-in test commands reach the container as argv, without a shell', () => {
  const wt = process.platform === 'win32' ? 'C:\\runs\\x\\repro-wt' : '/runs/x/repro-wt';
  const t = { language: 'python', path: 'tests/test_fee.py', selector: 'tests/test_fee.py::test_fee' };
  const { command, argv } = commandFor('pytest', t, wt, null);
  assert.deepEqual(argv.slice(1, 6), ['-m', 'pytest', '-q', '-p', 'no:cacheprovider']);
  assert.equal(command, argv.join(' '), 'the host shell gets the same words');
  const args = withEnv({ ARW_SANDBOX_IMAGE_PYTEST: 'py:img' }, () => sandbox.dockerArgs({ command, argv, cwd: wt, toolchain: 'pytest', name: 'n' }));
  const after = args.slice(args.indexOf('py:img') + 1);
  assert.ok(!after.includes('-c') && after[0] !== 'sh', `no shell: ${after.join(' ')}`);
  assert.equal(after[after.length - 1], '--junitxml=/work/.arw-junit.xml', 'host paths become container paths');
  const custom = commandFor(null, t, wt, './run.sh {path}');
  assert.equal(custom.argv, undefined, 'a configured test_command is a shell string');
});

test('no docker, ARW_SANDBOX_FALLBACK=off: the run is ENVIRONMENT_BLOCKED, nothing runs on the host', async () => {
  const dir = tmpDir('arw-boundary-nodocker-');
  const marker = path.join(dir, 'ran-on-host');
  for (const bin of [path.join(dir, 'no-such-docker'), process.execPath]) {
    // process.execPath stands in for a docker CLI whose daemon does not answer.
    const res = await withEnv({ ARW_SANDBOX: 'docker', ARW_DOCKER: bin, ARW_SANDBOX_FALLBACK: 'off' }, () => {
      sandbox._resetDaemon();
      return require('../src/lib/repro').defaultRunner()({ command: `echo x > ${marker}`, argv: ['sh', '-c', `echo x > ${marker}`], cwd: dir, logFile: path.join(dir, 'run.log'), timeoutMs: 20000, toolchain: 'maven' });
    });
    assert.match(String(res.spawn_error), /docker is not available/);
    assert.equal(classify({ ...res, junit: null }), 'environment');
    assert.ok(!fs.existsSync(marker), 'no fallback to the host');
  }
});

test('no docker, default fallback without host consent: the host is refused', () => {
  const dir = tmpDir('arw-boundary-fallback-');
  const repro = require('../src/lib/repro');
  const runner = withEnv({ ARW_SANDBOX: 'docker', ARW_DOCKER: path.join(dir, 'no-such-docker'), ARW_SANDBOX_FALLBACK: undefined, ARW_ALLOW_HOST_CODE: null }, () => {
    sandbox._resetDaemon();
    return repro.defaultRunner(null, () => {});
  });
  assert.equal(runner, repro.blockedHostRunner);
  withEnv({ ARW_ALLOW_HOST_CODE: '1' }, () => assert.equal(repro.defaultRunner(null, () => {}), repro.shellRunner));
});

test('host repro without consent is ENVIRONMENT_BLOCKED and names ARW_ALLOW_HOST_CODE', async () => {
  const { runRepro, shellRunner } = require('../src/lib/repro');
  const { freezeContext, revisionDir } = require('../src/lib/freeze');
  const repo = makeRepo();
  const dir = tmpDir('arw-boundary-host-consent-');
  const review = { units: [{ id: 'B1', kind: 'business', desc: 'business', covers: ['file:billing/fees.py'], roles: ['business'], items: [] }] };
  const patch = 'diff --git a/billing/fees.py b/billing/fees.py\n--- a/billing/fees.py\n+++ b/billing/fees.py\n@@ -1,1 +1,2 @@\n a\n+b\n';
  const context = freezeContext({
    runDir: dir, checkout: repo.dir, base: repo.base, head: repo.head,
    changed: [{ status: 'M', path: 'billing/fees.py' }], reviewable: ['billing/fees.py'],
    patch, review, inputs: [],
  });
  const rev = revisionDir(dir, context.context_id);
  const finding = {
    id: 'B1-business-F1', severity: 'P2', title: 'a boundary', state: 'not_challenged',
    suggestion: false, canonical: true, cluster_id: null,
  };
  fs.mkdirSync(path.join(rev, 'packets', 'business'), { recursive: true });
  fs.writeFileSync(path.join(rev, 'packets', 'business', 'B1.json'), JSON.stringify({ findings: [{ id: finding.id, severity: 'P2', title: finding.title, evidence: [] }] }));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ identity: { repo: 'acme/shop', pr: 9, head_sha: repo.head, base_sha: repo.base, title: 'fixture' }, review, phases: {} }));
  fs.writeFileSync(path.join(rev, 'validation.json'), JSON.stringify({
    context_id: context.context_id, context_digest: context.context_digest,
    findings: [finding],
    jobs: [{ unit_id: 'B1', role: 'business', status: 'EXECUTED_PASS' }],
  }));
  let started = false;
  const results = await withEnv({ ARW_SANDBOX: 'off', ARW_REPRO: 'on', ARW_ALLOW_HOST_CODE: null }, () => runRepro({
    runDir: dir,
    runner: shellRunner,
    prompts: {},
    runModelJob: () => {
      started = true;
      throw new Error('no model call for a blocked host');
    },
    makeSources: () => ({}),
  }));
  assert.equal(started, false, 'not even the test writer ran');
  assert.equal(results[0].status, 'ENVIRONMENT_BLOCKED');
  assert.match(results[0].reason, /ARW_ALLOW_HOST_CODE/);
  assert.ok(!fs.existsSync(path.join(dir, 'repro-wt')), 'no worktree was made');

  const runFile = path.join(dir, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run.review.units.push({ id: 'B2', kind: 'business', desc: 'changed plan', covers: ['file:billing/fees.py'], roles: ['business'], items: [] });
  fs.writeFileSync(runFile, JSON.stringify(run));
  await assert.rejects(() => runRepro({ runDir: dir, runner: shellRunner, prompts: {}, runModelJob: () => { throw new Error('no model'); }, makeSources: () => ({}) }), /context no longer holds/);
});

test('impacted-test results record where they ran', async () => {
  const { runImpactedTests } = require('../src/lib/impacted-tests');
  const dir = tmpDir('arw-boundary-impacted-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'tests/test_a.py', 'def test_a():\n    assert 1\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'a']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  const runner = async ({ logFile, argv }) => {
    fs.writeFileSync(logFile, 'x');
    fs.writeFileSync(argv[argv.length - 1].slice('--junitxml='.length), '<testsuite><testcase classname="tests.test_a" name="test_a"/></testsuite>');
    return { exit_code: 0, elapsed_ms: 1 };
  };
  const r = await runImpactedTests({ runDir: tmpDir('arw-boundary-ir-'), checkout: dir, base: head, head, impact: { sources: [], tests_changed: ['tests/test_a.py'] }, repoCfg: { run_impacted_tests: true }, runner });
  assert.deepEqual(r.execution, sandbox.manifest());
  assert.equal(r.results[0].verdict, 'passing');
});

// ---------- real containers ----------
const IMAGE = sandbox.DEFAULT_IMAGES.maven;
function dockerReady() {
  if (process.env.ARW_DOCKER_TESTS !== '1') return 'set ARW_DOCKER_TESTS=1 to run real containers';
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    return null;
  } catch {
    return `docker or the image ${IMAGE} is not available`;
  }
}
const skip = dockerReady() || false; // node:test skips on any non-false value, null included

function run(cwd, argv, extra = {}) {
  const logFile = path.join(tmpDir('arw-boundary-log-'), 'run.log');
  return withEnv({ ARW_SANDBOX: 'docker', ...extra.env }, () => sandbox.dockerRunner({ command: argv.join(' '), argv, cwd, logFile, timeoutMs: extra.timeoutMs || 120000, toolchain: 'maven' }))
    .then((res) => ({ ...res, log: fs.readFileSync(logFile, 'utf8') }));
}

test('docker: no network, no host secrets in the container', { skip }, async () => {
  const wt = tmpDir('arw-boundary-net-');
  const res = await run(wt, ['sh', '-c', 'env; getent hosts example.com; echo net=$?'], { env: { ARW_PROBE_SECRET_TOKEN: 's3cr3t-probe-value' } });
  assert.equal(res.exit_code, 0, res.log);
  assert.match(res.log, /net=[1-9]/, 'name resolution fails without a network');
  assert.ok(!res.log.includes('s3cr3t-probe-value'), 'the host environment is not passed in');
});

test('docker: links the container makes are not followed by the host', { skip }, async () => {
  const wt = tmpDir('arw-boundary-links-');
  const res = await run(wt, ['sh', '-c', 'mkdir -p target/surefire-reports && ln -s /etc/passwd target/surefire-reports/TEST-x.xml && ln -s /etc linkdir']);
  assert.equal(res.exit_code, 0, res.log);
  const report = path.join(wt, 'target', 'surefire-reports', 'TEST-x.xml');
  assert.equal(confine.readConfined(wt, report), null, 'the report link is not read');
  assert.equal(confine.isConfinedFile(wt, report), false);
  assert.throws(() => confine.writeNewFile(wt, 'linkdir/test_x.py', 'x'), confine.ConfinementError);
  assert.equal(confine.removeConfined(wt, report), true, 'the link itself can be removed');
  assert.ok(!fs.existsSync(report));
});

test('docker: a .git file the container rewrites does not reach git on the host', { skip }, async () => {
  const repo = makeRepo();
  const wt = path.join(tmpDir('arw-boundary-gitwt-'), 'wt');
  sh(repo.dir, ['worktree', 'add', '--detach', wt, repo.head]);
  const script = [
    'mkdir -p .evil/objects .evil/refs',
    "echo 'ref: refs/heads/main' > .evil/HEAD",
    "printf '[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = echo pwned > fsmonitor-ran\\n' > .evil/config",
    'rm -f .git',
    "echo 'gitdir: .evil' > .git",
  ].join(' && ');
  const res = await run(wt, ['sh', '-c', script]);
  assert.equal(res.exit_code, 0, res.log);
  assert.equal(git.worktreeGit(repo.dir, wt, ['rev-parse', 'HEAD']).trim(), repo.head);
  git.worktreeGit(repo.dir, wt, ['status', '--porcelain'], { allowFail: true });
  assert.ok(!fs.existsSync(path.join(wt, 'fsmonitor-ran')) && !fs.existsSync(path.join(wt, '.evil', 'fsmonitor-ran')), 'the planted fsmonitor did not run');
  // The same git call the old way (git reads the .git file) runs it.
  git.git(wt, ['status', '--porcelain'], { allowFail: true });
  assert.ok(fs.existsSync(path.join(wt, 'fsmonitor-ran')) || fs.existsSync(path.join(wt, '.evil', 'fsmonitor-ran')), 'control: the plant is live');
});

test('docker: a run past its timeout is killed and reported as timed out', { skip }, async () => {
  const res = await run(tmpDir('arw-boundary-timeout-'), ['sleep', '120'], { timeoutMs: 3000 });
  assert.equal(res.timed_out, true);
  assert.ok(res.elapsed_ms < 60000, `took ${res.elapsed_ms} ms`);
  assert.equal(classify({ ...res, junit: null }), 'timeout');
});
