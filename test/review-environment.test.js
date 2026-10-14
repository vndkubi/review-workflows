'use strict';
// The sandbox environment of a review (ARW_SANDBOX=bootstrap): the
// repositories it needs are bootstrapped and staged, dependencies resolved
// at the base revision, every Maven run offline in it, never on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-renv-runs-');
process.env.ARW_SANDBOX_HOME = tmpDir('arw-renv-home-');

const { prepareReviewEnvironment, loadReviewEnvironment, environmentRunner } = require('../src/lib/bootstrap');
const { runImpactedTests, renderImpacted } = require('../src/lib/impacted-tests');

function pom(a, v, java, deps = []) {
  const d = deps.map(([da, dv]) => `    <dependency>\n      <groupId>com.company</groupId>\n      <artifactId>${da}</artifactId>\n      <version>${dv}</version>\n    </dependency>\n`).join('');
  return `<project>\n  <groupId>com.company</groupId>\n  <artifactId>${a}</artifactId>\n  <version>${v}</version>\n  <properties>\n    <maven.compiler.release>${java}</maven.compiler.release>\n  </properties>\n  <dependencies>\n${d}  </dependencies>\n</project>\n`;
}

function repo(name, files) {
  const dir = path.join(tmpDir('arw-renv-'), name);
  sh(path.dirname(dir), ['init', '-q', '-b', 'main', name]);
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

// Maven in a container, scripted: resolve records which source it saw;
// build installs; nothing else.
function fakeMaven(calls) {
  return async ({ argv, cwd, logFile, image, network, mounts }) => {
    const mount = (c) => (mounts.find((m) => m.container === c) || {}).host;
    const project = fs.readFileSync(path.join(cwd, 'pom.xml'), 'utf8');
    const [, a] = /<artifactId>([^<]+)<\/artifactId>/.exec(project);
    const [, v] = /<version>([^<]+)<\/version>/.exec(project);
    const step = argv.includes('-o') ? 'build' : 'resolve';
    calls.push({ repo: a, step, image, network, src: fs.existsSync(path.join(cwd, 'src', 'Main.java')) ? fs.readFileSync(path.join(cwd, 'src', 'Main.java'), 'utf8').trim() : null });
    fs.writeFileSync(logFile, 'ok\n');
    if (step === 'build') {
      write(cwd, `target/surefire-reports/TEST-com.company.${a}Test.xml`, `<testsuite><testcase classname="com.company.${a}Test" name="t"/></testsuite>`);
      write(path.join(mount('/m2'), 'com', 'company', a, v), `${a}-${v}.jar`, 'jar');
      write(path.join(mount('/m2'), 'com', 'company', a, v), `${a}-${v}.pom`, project);
    }
    return { exit_code: 0, elapsed_ms: 1 };
  };
}

const imageId = (image) => `sha256:${Buffer.from(image).toString('hex').slice(0, 16)}`;

function scenario() {
  const lib = repo('payment-lib', { 'pom.xml': pom('payment-lib', '1.2.0-SNAPSHOT', 8), 'src/Main.java': 'lib\n' });
  const server = repo('payment-server', { 'pom.xml': pom('payment-server', '3.0.0', 11, [['payment-lib', '1.2.0-SNAPSHOT']]), 'src/Main.java': 'server base\n', 'src/test/java/com/company/BillingTest.java': 'class BillingTest {}\n' });
  const base = sh(server, ['rev-parse', 'HEAD']);
  write(server, 'src/Main.java', 'server head\n');
  sh(server, ['commit', '-q', '-am', 'PR']);
  return { lib, server, base, head: sh(server, ['rev-parse', 'HEAD']) };
}

test('prepared once: the library it needs is bootstrapped and staged, dependencies resolved at BASE', async () => {
  const s = scenario();
  const runDir = tmpDir('arw-renv-run-');
  const calls = [];
  const env = await prepareReviewEnvironment({ runDir, repo: 'payment-server', checkout: s.server, base: s.base, head: s.head, others: [{ repo: 'payment-lib', checkout: s.lib }], runner: fakeMaven(calls), imageId });
  assert.equal(env.status, 'READY', env.reason);
  assert.deepEqual(calls.map((c) => [c.repo, c.step, c.network]), [['payment-lib', 'resolve', 'bridge'], ['payment-lib', 'build', 'none'], ['payment-server', 'resolve', 'bridge']]);
  assert.equal(calls[2].src, 'server base', 'the only step with network runs the base revision, not the PR');
  assert.equal(env.image, 'maven:3.9-eclipse-temurin-11');
  assert.deepEqual(env.producers.map((p) => [p.repo, p.status]), [['payment-lib', 'TESTS_PASSED']]);
  assert.ok(env.staged.some((a) => a.path.endsWith('payment-lib-1.2.0-SNAPSHOT.jar')));
  assert.ok(fs.existsSync(path.join(env.staged_dir, 'com', 'company', 'payment-lib', '1.2.0-SNAPSHOT', 'payment-lib-1.2.0-SNAPSHOT.jar')));
  assert.ok(!fs.existsSync(path.join(runDir, 'sandbox', 'base-src')), 'the base snapshot is removed after resolving');
  assert.deepEqual(loadReviewEnvironment(runDir, { imageId }).digest, env.digest);

  // Another review of the same repository: nothing to build or resolve again.
  const calls2 = [];
  const env2 = await prepareReviewEnvironment({ runDir: tmpDir('arw-renv-run-'), repo: 'payment-server', checkout: s.server, base: s.base, head: s.head, others: [{ repo: 'payment-lib', checkout: s.lib }], runner: fakeMaven(calls2), imageId });
  assert.deepEqual(calls2, []);
  assert.deepEqual([env2.producers[0].cache, env2.resolve.step, env2.digest], ['hit', 'skipped (resolved before)', env.digest]);

  // Drift before the reproduction: a staged artifact edited, another image.
  fs.appendFileSync(path.join(env.staged_dir, 'com', 'company', 'payment-lib', '1.2.0-SNAPSHOT', 'payment-lib-1.2.0-SNAPSHOT.jar'), 'x');
  assert.match(loadReviewEnvironment(runDir, { imageId }).reason, /changed since it was prepared: staged/);
  assert.match(loadReviewEnvironment(runDir2(env2), { imageId: () => 'sha256:other' }).reason, /image/);
});

function runDir2(env) {
  return path.dirname(path.dirname(env.m2));
}

test('Maven runs go offline into the environment; a dependency the PR adds is ENVIRONMENT_BLOCKED; never the host', async () => {
  const env = { status: 'READY', image: 'maven:img', digest: 'd1', staged_dir: '/s', cache: path.resolve('/c'), m2: path.resolve('/m') };
  env.staged_dir = path.resolve('/s');
  const seen = [];
  const docker = async (opts) => {
    seen.push(opts);
    fs.writeFileSync(opts.logFile, opts.argv.includes('needs-new-dep') ? '[ERROR] Cannot access central in offline mode and the artifact x:y:jar:1 has not been downloaded from it before.\n' : 'ok\n');
    return { exit_code: opts.argv.includes('needs-new-dep') ? 1 : 0, elapsed_ms: 1 };
  };
  const other = async () => ({ exit_code: 0, elapsed_ms: 1, other: true });
  const run = environmentRunner(env, { docker, other });
  const logFile = path.join(tmpDir('arw-renv-log-'), 'x.log');
  const ok = await run({ argv: ['mvn', 'test'], command: 'mvn test', cwd: '/w', logFile, timeoutMs: 1000, toolchain: 'maven' });
  assert.deepEqual([ok.exit_code, ok.environment], [0, 'd1']);
  assert.deepEqual([seen[0].image, seen[0].network, seen[0].env.MAVEN_ARGS], ['maven:img', 'none', '-o']);
  assert.match(seen[0].env.MAVEN_OPTS, /-Dmaven\.repo\.local=\/m2 -Dmaven\.repo\.local\.tail=\/staged,\/m2cache/);
  assert.deepEqual(seen[0].mounts.map((m) => `${m.container}${m.readonly ? ':ro' : ''}`), ['/staged:ro', '/m2cache:ro', '/m2']);
  const missing = await run({ argv: ['mvn', 'needs-new-dep'], command: 'x', cwd: '/w', logFile, timeoutMs: 1000, toolchain: 'maven' });
  assert.match(missing.spawn_error, /not in the environment/);
  assert.equal((await run({ argv: ['python'], command: 'x', cwd: '/w', logFile, timeoutMs: 1000, toolchain: 'pytest' })).other, true);
  const blocked = environmentRunner({ status: 'BLOCKED', reason: 'no docker' }, { docker: async () => assert.fail('must not run') });
  assert.match((await blocked({ argv: ['mvn'], command: 'mvn', cwd: '/w', logFile, timeoutMs: 1, toolchain: 'maven' })).spawn_error, /blocked: no docker/);
});

test('ARW_SANDBOX=bootstrap with a blocked environment: impacted tests do not run, and say why', async () => {
  const saved = process.env.ARW_SANDBOX;
  process.env.ARW_SANDBOX = 'bootstrap';
  try {
    const s = scenario();
    write(s.server, 'src/test/java/com/company/BillingTest.java', 'class BillingTest { int x; }\n');
    sh(s.server, ['commit', '-q', '-am', 'test too']);
    const head = sh(s.server, ['rev-parse', 'HEAD']);
    const runDir = tmpDir('arw-renv-blocked-');
    fs.writeFileSync(path.join(runDir, 'sandbox-env.json'), JSON.stringify({ status: 'BLOCKED', reason: 'image maven:3.9-eclipse-temurin-11 is not available locally', repo: 'payment-server' }));
    const r = await runImpactedTests({ runDir, checkout: s.server, base: s.base, head, impact: { sources: [], tests_changed: ['src/test/java/com/company/BillingTest.java'] }, repoCfg: { run_impacted_tests: true } });
    assert.deepEqual(r.results.map((x) => x.verdict), ['not_run']);
    assert.match(r.ran[0].spawn_error, /environment blocked: image/);
    assert.equal(r.environment.status, 'BLOCKED');
    assert.match(renderImpacted(r), /sandbox environment BLOCKED: image .* \(no test ran on the host\)/);
  } finally {
    if (saved === undefined) delete process.env.ARW_SANDBOX;
    else process.env.ARW_SANDBOX = saved;
  }
});
