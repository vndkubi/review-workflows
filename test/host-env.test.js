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
