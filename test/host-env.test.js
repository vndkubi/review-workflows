'use strict';
// Incident (runs/effort, runs/v2-high): 14 of 14 reproductions stopped at
// "build_error" on the first head run. Maven ran offline (-o) on the host,
// but nothing had resolved the project's dependencies, so no test the model
// wrote ever executed and no finding was ever proven. With no sandbox, the
// host now prepares itself like the bootstrap does: a JDK the project needs,
// dependencies resolved once at the trusted base, then the PR's test offline;
// and when it cannot, the record says exactly why.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, write, sh } = require('./helpers');
const hostEnv = require('../src/lib/host-env');
const { commandFor } = require('../src/lib/repro');

function jdk(root, name, version) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'release'), `JAVA_VERSION="${version}"\nIMPLEMENTOR="Eclipse Adoptium"\n`);
  fs.writeFileSync(path.join(dir, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'), '');
  return dir;
}

test('host JDKs: found under the usual roots, the smallest one the project needs is picked', () => {
  const root = tmpDir('arw-jdks-');
  const j11 = jdk(root, 'jdk-11.0.31.11-hotspot', '11.0.31');
  const j17 = jdk(root, 'jdk-17.0.14+7', '17.0.14');
  const j21 = jdk(root, 'jdk-21.0.6+7', '21.0.6');
  fs.mkdirSync(path.join(root, 'not-a-jdk'));
  const found = hostEnv.findJdks({ roots: [root], env: {} });
  assert.deepEqual(found.map((j) => j.version), [11, 17, 21]);
  assert.equal(hostEnv.pickJdk(17, found).home, j17);
  assert.equal(hostEnv.pickJdk(11, found).home, j11);
  assert.equal(hostEnv.pickJdk(null, found).home, j21, 'no level declared: the newest');
  assert.equal(hostEnv.pickJdk(25, found), null);
  // ARW_JAVA_HOME counts too.
  assert.equal(hostEnv.findJdks({ roots: [], env: { ARW_JAVA_HOME: j21 } })[0].home, j21);
});

function mavenProject(level) {
  const dir = tmpDir('arw-host-mvn-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'pom.xml', `<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>b</artifactId><version>1</version><properties><java.version>${level}</java.version></properties></project>\n`);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  return { dir, base: sh(dir, ['rev-parse', 'HEAD']) };
}

test('host plan: the build tool and a JDK the project needs, or the reason there is none', () => {
  const root = tmpDir('arw-jdks-');
  const jdks = hostEnv.findJdks({ roots: [root], env: { ARW_JAVA_HOME: jdk(root, 'jdk-11', '11.0.2') } });
  const p17 = mavenProject(17);
  const blocked = hostEnv.hostPlan({ wt: p17.dir, toolchain: 'maven', jdks, which: () => '/usr/bin/mvn' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /needs Java 17; this host has Java 11 \(install a JDK 17\+ or set ARW_JAVA_HOME\)/);
  const p11 = mavenProject(11);
  const ok = hostEnv.hostPlan({ wt: p11.dir, toolchain: 'maven', jdks, which: () => '/usr/bin/mvn' });
  assert.equal(ok.ok, true);
  assert.equal(ok.java, 11);
  assert.match(ok.env.PATH, /jdk-11[\\/]bin/);
  write(p11.dir, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw', '');
  const wrapped = hostEnv.hostPlan({ wt: p11.dir, toolchain: 'maven', jdks, which: () => null });
  assert.equal(wrapped.tool, process.platform === 'win32' ? '.\\mvnw.cmd' : './mvnw', 'the wrapper by an explicit path');
  fs.rmSync(path.join(p11.dir, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'));
  const noMvn = hostEnv.hostPlan({ wt: p11.dir, toolchain: 'maven', jdks, which: () => null });
  assert.match(noMvn.reason, /Maven is not installed on this host and the repository has no mvnw/);
});

test('dependencies: resolved once at the trusted base with network, then reused', async () => {
  const p = mavenProject(11);
  const calls = [];
  const runner = async ({ command, cwd }) => { calls.push({ command, cwd }); return { exit_code: 0, elapsed_ms: 1 }; };
  const cache = tmpDir('arw-host-cache-');
  const plan = { ok: true, env: { PATH: process.env.PATH }, java: 11 };
  const first = await hostEnv.prepareDependencies({ checkout: p.dir, base: p.base, toolchain: 'maven', plan, runner, cacheDir: cache, logDir: cache });
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);
  // Surefire runs (with no test) so its JUnit provider is resolved too.
  assert.match(calls[0].command, /^mvn -B -q test -Dtest=ArwNoSuchTest -DfailIfNoTests=false/);
  assert.doesNotMatch(calls[0].command, /skipTests/);
  assert.doesNotMatch(calls[0].command, / -o( |$)/, 'base resolution goes online');
  assert.notEqual(path.resolve(calls[0].cwd), path.resolve(p.dir), 'built in its own base worktree');
  const again = await hostEnv.prepareDependencies({ checkout: p.dir, base: p.base, toolchain: 'maven', plan, runner, cacheDir: cache, logDir: cache });
  assert.equal(again.ok, true);
  assert.equal(calls.length, 1, 'prepared once per repository and base');
  const failing = async () => ({ exit_code: 1, elapsed_ms: 1 });
  const bad = await hostEnv.prepareDependencies({ checkout: p.dir, base: p.base, toolchain: 'maven', plan, runner: failing, cacheDir: tmpDir('arw-host-cache-'), logDir: cache });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /dependencies could not be resolved at base/);
});

test('head runs on a prepared host are offline', () => {
  const wt = tmpDir('arw-host-wt-');
  write(wt, 'pom.xml', '<project/>\n');
  const t = { language: 'java', path: 'src/test/java/a/BTest.java', selector: 'a.BTest' };
  assert.match(commandFor('maven', t, wt, null, { offline: true }).command, /^mvn -B -q -o test /);
  write(wt, 'build.gradle', '\n');
  assert.match(commandFor('gradle', t, wt, null, { offline: true }).command, / --offline/);
});

// Incident (Shopizer #1125, third v3 run): the base had only JUnit 4 tests,
// the PR added JUnit 5 ones, so the offline head run needed a surefire
// provider the base build never resolved. The missing test runtime is
// fetched on its own (no project, no PR code), then the head run once more.
const MISSING_LOG = `[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:2.22.2:test (default-test) on project sm-shop: Unable to generate classpath: org.apache.maven.artifact.resolver.MultipleArtifactsNotFoundException: Missing:
[ERROR] ----------
[ERROR] 1) org.apache.maven.surefire:surefire-junit-platform:jar:2.22.2
[ERROR]       mvn install:install-file -DgroupId=org.apache.maven.surefire -DartifactId=surefire-junit-platform -Dversion=2.22.2 -Dpackaging=jar -Dfile=/path/to/file
[ERROR] 2) com.evil:payload:jar:6.6.6
`;

test('missing test runtime: only test-runner artifacts are fetched, outside the project', async () => {
  assert.deepEqual(hostEnv.missingArtifacts(MISSING_LOG), ['org.apache.maven.surefire:surefire-junit-platform:2.22.2', 'com.evil:payload:6.6.6']);
  assert.deepEqual(hostEnv.testRuntimeArtifacts(MISSING_LOG), ['org.apache.maven.surefire:surefire-junit-platform:2.22.2']);
  const calls = [];
  const runner = async (o) => { calls.push(o); return { exit_code: 0, elapsed_ms: 1 }; };
  const res = await hostEnv.fetchArtifacts({ artifacts: ['org.apache.maven.surefire:surefire-junit-platform:2.22.2'], plan: { env: {}, tool: '.\\mvnw.cmd' }, runner, dir: tmpDir('arw-fetch-') });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /^mvn -B -q org\.apache\.maven\.plugins:maven-dependency-plugin:3\.6\.1:get -Dartifact=org\.apache\.maven\.surefire:surefire-junit-platform:2\.22\.2$/);
  assert.ok(!fs.existsSync(path.join(calls[0].cwd, 'pom.xml')), 'run in an empty directory: no project, no PR code');
  assert.deepEqual(hostEnv.testRuntimeArtifacts('BUILD FAILURE\n'), []);
});

test('arw repro --retry: a reproduction that never ran is tried again; a proven one is kept', () => {
  const { reproDone } = require('../src/lib/repro');
  assert.equal(reproDone({ status: 'RED_PROVEN' }, { retry: true }), true);
  assert.equal(reproDone({ status: 'GREEN_NOT_PROVEN' }, { retry: true }), true);
  assert.equal(reproDone({ status: 'INCONCLUSIVE' }, { retry: true }), false);
  assert.equal(reproDone({ status: 'ENVIRONMENT_BLOCKED' }, { retry: true }), false);
  assert.equal(reproDone({ status: 'INCONCLUSIVE' }, { retry: false }), true);
  assert.equal(reproDone(null, { retry: true }), false);
});

test('sandbox fallback: an unreachable docker daemon falls back to the host unless told not to', () => {
  assert.equal(hostEnv.runnerChoice({ mode: 'docker', daemonError: 'cannot connect', env: {} }), 'host');
  assert.equal(hostEnv.runnerChoice({ mode: 'bootstrap', daemonError: 'cannot connect', env: {} }), 'host');
  assert.equal(hostEnv.runnerChoice({ mode: 'docker', daemonError: null, env: {} }), 'sandbox');
  assert.equal(hostEnv.runnerChoice({ mode: 'docker', daemonError: 'cannot connect', env: { ARW_SANDBOX_FALLBACK: 'off' } }), 'blocked');
  assert.equal(hostEnv.runnerChoice({ mode: 'host', daemonError: null, env: {} }), 'host');
});

// Incident (suite run with Docker Desktop stopped): impacted tests, which run
// online and without host prep, fell back to the host although the sandbox
// environment was recorded BLOCKED. Only repro may fall back.
test('sandbox fallback: only repro moves to the host, impacted tests never do', () => {
  const saved = { s: process.env.ARW_SANDBOX, d: process.env.ARW_DOCKER };
  process.env.ARW_SANDBOX = 'docker';
  process.env.ARW_DOCKER = path.join(tmpDir('arw-nodocker-'), 'no-such-docker');
  try {
    const { defaultRunner, shellRunner } = require('../src/lib/repro');
    assert.equal(defaultRunner(null), shellRunner, 'repro falls back to the prepared host');
    assert.notEqual(defaultRunner(null, () => {}, { fallback: false }), shellRunner, 'impacted tests stay in the sandbox (and are blocked)');
  } finally {
    for (const [k, v] of [['ARW_SANDBOX', saved.s], ['ARW_DOCKER', saved.d]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// Incident (v3 runs on spring-boot, camel, quarkus): resolving a framework
// repository whole at base took longer than the 45 min budget, so no finding
// there was ever run. Only the test's module and what it depends on is
// prepared (and run), and the budget is ARW_HOST_PREP_TIMEOUT_MS.
test('dependencies: scoped to the test module, with a configurable budget', async () => {
  const p = mavenProject(11);
  write(p.dir, 'core/pom.xml', '<project/>\n');
  sh(p.dir, ['add', '-A']);
  sh(p.dir, ['commit', '-q', '-m', 'module']);
  const base = sh(p.dir, ['rev-parse', 'HEAD']);
  const calls = [];
  const runner = async (o) => { calls.push(o); return { exit_code: 0, elapsed_ms: 1 }; };
  const plan = { ok: true, env: {}, java: 11 };
  const cache = tmpDir('arw-host-cache-');
  await hostEnv.prepareDependencies({ checkout: p.dir, base, toolchain: 'maven', plan, runner, cacheDir: cache, logDir: cache, module: 'core', env: { ARW_HOST_PREP_TIMEOUT_MS: '1234' } });
  assert.match(calls[0].command, / -pl core -am /);
  assert.equal(calls[0].timeoutMs, 1234);
  // Another module of the same base is prepared on its own.
  await hostEnv.prepareDependencies({ checkout: p.dir, base, toolchain: 'maven', plan, runner, cacheDir: cache, logDir: cache, module: null, env: {} });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].command, / -pl /);
  assert.equal(calls[1].timeoutMs, 45 * 60 * 1000);
  // A module the base does not have yet (the PR adds it): the whole build.
  await hostEnv.prepareDependencies({ checkout: p.dir, base, toolchain: 'maven', plan, runner, cacheDir: tmpDir('arw-host-cache-'), logDir: cache, module: 'brand-new', env: {} });
  assert.doesNotMatch(calls[2].command, / -pl /);
  // Gradle runs the module's own task.
  await hostEnv.prepareDependencies({ checkout: p.dir, base, toolchain: 'gradle', plan: { ...plan, tool: 'gradle' }, runner, cacheDir: tmpDir('arw-host-cache-'), logDir: cache, module: 'core', env: {} });
  assert.equal(calls[3].command, 'gradle :core:testClasses');
});

test('head runs are scoped to the test module too', () => {
  const wt = tmpDir('arw-host-wt-');
  write(wt, 'pom.xml', '<project/>\n');
  write(wt, 'core/pom.xml', '<project/>\n');
  const t = { language: 'java', path: 'core/src/test/java/a/BTest.java', selector: 'a.BTest' };
  const mvn = commandFor('maven', t, wt, null, { offline: true });
  assert.match(mvn.command, /^mvn -B -q -o -pl core -am test -Dtest=a\.BTest /);
  assert.equal(path.relative(wt, mvn.junit).replace(/\\/g, '/'), 'core/target/surefire-reports/TEST-a.BTest.xml');
  const root = commandFor('maven', { ...t, path: 'src/test/java/a/BTest.java' }, wt, null, { offline: true });
  assert.doesNotMatch(root.command, / -pl /);
  write(wt, 'build.gradle', '\n');
  write(wt, 'core/build.gradle', '\n');
  assert.match(commandFor('gradle', t, wt, null, {}).command, / :core:test --tests a\.BTest$/);
  const { moduleOf } = require('../src/lib/repro');
  assert.equal(moduleOf('maven', wt, t.path), 'core');
  assert.equal(moduleOf('maven', wt, 'src/test/java/a/BTest.java'), null);
});

// P3 defects can be proven too when asked (ARW_REPRO_SEVERITY=P3);
// suggestions (P4) never are.
test('repro targets: P1/P2 by default, P3 defects with ARW_REPRO_SEVERITY=P3', () => {
  const { reproTargets } = require('../src/lib/repro');
  const v = { findings: [{ id: 'A', severity: 'P2', canonical: true }, { id: 'B', severity: 'P3', canonical: true }, { id: 'C', severity: 'P4', canonical: true, suggestion: true }] };
  const byId = new Map(['A', 'B', 'C'].map((id) => [id, { id }]));
  assert.deepEqual(reproTargets(v, byId, {}).map((t) => t.finding.id), ['A']);
  assert.deepEqual(reproTargets(v, byId, { ARW_REPRO_SEVERITY: 'P3' }).map((t) => t.finding.id), ['A', 'B']);
  assert.deepEqual(reproTargets(v, byId, { ARW_REPRO_SEVERITY: 'P1' }).map((t) => t.finding.id), []);
});
