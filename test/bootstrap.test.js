'use strict';
// Bootstrap without docker: a scripted runner stands in for Maven in the
// container (it reads the mounts it is given, installs into the task's local
// repository, writes surefire reports). Covers the four acceptance runs
// (build both; reuse the library; library changed; library broken), the
// evidence kept, reuse only of intact records, and source snapshots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-boot-runs-');
process.env.ARW_SANDBOX_HOME = tmpDir('arw-boot-home-');

const { discoverRepo } = require('../src/lib/discovery');
const { bootstrapGraph, renderBootstrap, home } = require('../src/lib/bootstrap');
const { snapshot, extractTar } = require('../src/lib/snapshot');

function pom({ a, v, java, deps = [] }) {
  const d = deps.map(([da, dv]) => `    <dependency>\n      <groupId>com.company</groupId>\n      <artifactId>${da}</artifactId>\n      <version>${dv}</version>\n    </dependency>\n`).join('');
  return `<project>\n  <groupId>com.company</groupId>\n  <artifactId>${a}</artifactId>\n  <version>${v}</version>\n  <properties>\n    <maven.compiler.release>${java}</maven.compiler.release>\n  </properties>\n  <dependencies>\n${d}  </dependencies>\n</project>\n`;
}

function repo(name, files) {
  const dir = path.join(tmpDir('arw-boot-'), name);
  sh(path.dirname(dir), ['init', '-q', '-b', 'main', name]);
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function commit(dir, rel, text) {
  write(dir, rel, text);
  sh(dir, ['commit', '-q', '-am', `edit ${rel}`]);
}

// Stands in for `mvn` in a container. The source decides: BROKEN fails the
// build, FAILTEST fails a test. Consumed com.company artifacts must be in
// /staged, as Maven offline would need them.
function fakeMaven(calls) {
  return async ({ argv, cwd, logFile, image, network, mounts }) => {
    const mount = (c) => (mounts.find((m) => m.container === c) || {}).host;
    const step = argv.includes('-o') ? 'build' : 'resolve';
    const project = fs.readFileSync(path.join(cwd, 'pom.xml'), 'utf8');
    const [, a] = /<artifactId>([^<]+)<\/artifactId>/.exec(project);
    const [, v] = /<version>([^<]+)<\/version>/.exec(project);
    calls.push({ repo: a, step, image, network, mounts: mounts.map((m) => `${m.container}${m.readonly ? ':ro' : ''}`) });
    const say = (t) => fs.writeFileSync(logFile, t);
    if (step === 'resolve') {
      fs.writeFileSync(path.join(mount('/m2'), `resolved-${a}`), 'x');
      say('[INFO] resolved\n');
      return { exit_code: 0, elapsed_ms: 1 };
    }
    for (const [, da, dv] of project.matchAll(/<artifactId>([^<]+)<\/artifactId>\s*<version>([^<]+)<\/version>\s*<\/dependency>/g)) {
      const staged = mount('/staged');
      if (!staged || !fs.existsSync(path.join(staged, 'com', 'company', da, dv, `${da}-${dv}.pom`))) {
        say(`[ERROR] Cannot access central in offline mode and the artifact com.company:${da}:jar:${dv} has not been downloaded from it before.\n`);
        return { exit_code: 1, elapsed_ms: 1 };
      }
    }
    const src = fs.readFileSync(path.join(cwd, 'src', 'Main.java'), 'utf8');
    if (src.includes('BROKEN')) {
      say('[ERROR] COMPILATION ERROR\n');
      return { exit_code: 1, elapsed_ms: 1 };
    }
    const failing = src.includes('FAILTEST');
    write(cwd, `target/surefire-reports/TEST-com.company.${a}Test.xml`, `<testsuite><testcase classname="com.company.${a}Test" name="works">${failing ? '<failure message="expected 0 but was 2"/>' : ''}</testcase></testsuite>`);
    const out = path.join(mount('/m2'), 'com', 'company', a, v);
    write(out, `${a}-${v}.jar`, `jar of ${src}`);
    write(out, `${a}-${v}.pom`, project);
    say('[INFO] BUILD SUCCESS\n');
    return { exit_code: 0, elapsed_ms: 1 };
  };
}

const imageId = (image) => `sha256:${Buffer.from(image).toString('hex').slice(0, 20)}`;
const discover = (dir) => discoverRepo({ checkout: dir, repo: path.basename(dir) });

function payments() {
  return {
    lib: repo('payment-lib', { 'pom.xml': pom({ a: 'payment-lib', v: '1.2.0-SNAPSHOT', java: 8 }), 'src/Main.java': 'class Fees {}\n', 'src/test/java/com/company/FeesTest.java': 'class FeesTest {}\n' }),
    server: repo('payment-server', { 'pom.xml': pom({ a: 'payment-server', v: '3.0.0', java: 11, deps: [['payment-lib', '1.2.0-SNAPSHOT']] }), 'src/Main.java': 'class Billing {}\n', 'src/test/java/com/company/BillingTest.java': 'class BillingTest {}\n' }),
  };
}

const run = (r, calls, opts = {}) => bootstrapGraph({ discoveries: [r.server, r.lib].map(discover), runner: fakeMaven(calls), imageId, ...opts });

test('the four acceptance runs: build both, reuse the library, library changed, library broken', async () => {
  const r = payments();
  // Run 1: both build; the library first, on JDK 8; the server on JDK 11 reads it read-only.
  let calls = [];
  let out = await run(r, calls);
  assert.equal(out.status, 'READY', renderBootstrap(out));
  assert.deepEqual(calls.map((c) => [c.repo, c.step]), [['payment-lib', 'resolve'], ['payment-lib', 'build'], ['payment-server', 'resolve'], ['payment-server', 'build']]);
  assert.deepEqual(calls.map((c) => c.image), ['maven:3.9-eclipse-temurin-8', 'maven:3.9-eclipse-temurin-8', 'maven:3.9-eclipse-temurin-11', 'maven:3.9-eclipse-temurin-11']);
  assert.deepEqual(calls.map((c) => c.network), ['bridge', 'none', 'bridge', 'none'], 'only the resolve step has a network');
  assert.deepEqual(calls[3].mounts, ['/staged:ro', '/m2cache:ro', '/m2'], 'the cache and the library are read-only in the build');
  const [lib1, server1] = out.results;
  assert.deepEqual([lib1.status, lib1.cache, server1.status, server1.inputs[0].repo], ['TESTS_PASSED', 'miss', 'TESTS_PASSED', 'payment-lib']);
  assert.ok(lib1.artifacts.some((a) => a.path === 'artifacts/com/company/payment-lib/1.2.0-SNAPSHOT/payment-lib-1.2.0-SNAPSHOT.jar'));
  assert.ok(lib1.evidence.some((e) => e.path === 'logs/build.log') && lib1.evidence.some((e) => /surefire-reports\/TEST-/.test(e.path)));
  assert.deepEqual(lib1.tests, { total: 1, failed: 0, errors: 0, skipped: 0, failing: [] });
  assert.equal(sh(r.lib, ['status', '--porcelain']), '', 'the checkout is untouched');
  assert.ok(!fs.existsSync(path.join(r.lib, 'target')));
  assert.deepEqual(fs.readdirSync(path.join(home(), 'tasks')), [], 'task directories are removed');

  // Run 2: only the server changes. The library is reused; nothing of it runs.
  commit(r.server, 'src/Main.java', 'class Billing { int v = 2; }\n');
  calls = [];
  out = await run(r, calls);
  assert.equal(out.status, 'READY');
  assert.deepEqual(out.results.map((x) => [x.repo, x.cache]), [['payment-lib', 'hit'], ['payment-server', 'miss']]);
  assert.deepEqual(calls.map((c) => [c.repo, c.step]), [['payment-server', 'build']], 'same build files: the resolve step is skipped too');

  // Run 3: the library changes. It rebuilds, and so does the server (its input changed).
  commit(r.lib, 'src/Main.java', 'class Fees { int late = 2; }\n');
  calls = [];
  out = await run(r, calls);
  assert.deepEqual(out.results.map((x) => [x.repo, x.cache, x.status]), [['payment-lib', 'miss', 'TESTS_PASSED'], ['payment-server', 'miss', 'TESTS_PASSED']]);
  assert.notEqual(out.results[0].fingerprint, lib1.fingerprint);

  // Run 4: the library is broken. The server is blocked and does not run.
  commit(r.lib, 'src/Main.java', 'class Fees { BROKEN }\n');
  calls = [];
  out = await run(r, calls);
  assert.equal(out.status, 'BLOCKED');
  assert.deepEqual(out.results.map((x) => [x.repo, x.status]), [['payment-lib', 'BUILD_FAILED'], ['payment-server', 'BLOCKED']]);
  assert.match(out.results[1].reason, /payment-lib: BUILD_FAILED/);
  assert.ok(!calls.some((c) => c.repo === 'payment-server'));
  assert.match(renderBootstrap(out), /payment-server @ [0-9a-f]{12}: BLOCKED\n {2}payment-lib: BUILD_FAILED/);
});

test('failing library tests: the artifact is built but not used, unless allowed', async () => {
  const r = payments();
  commit(r.lib, 'src/Main.java', 'class Fees { FAILTEST }\n');
  let out = await run(r, []);
  assert.deepEqual(out.results.map((x) => x.status), ['TESTS_FAILED', 'BLOCKED']);
  assert.match(out.results[0].tests.failing[0], /expected 0 but was 2/);
  out = await run(r, [], { allowTestFailures: true });
  assert.deepEqual(out.results.map((x) => [x.status, x.cache]), [['TESTS_FAILED', 'hit'], ['TESTS_PASSED', 'miss']]);
});

test('a stored artifact that changed is not reused; an environment failure is never cached', async () => {
  const r = payments();
  const out = await run(r, []);
  const lib = out.results[0];
  const jar = lib.artifacts.find((a) => a.path.endsWith('.jar'));
  fs.appendFileSync(path.join(home(), 'records', lib.fingerprint, ...jar.path.split('/')), 'tampered');
  const calls = [];
  const again = await run(r, calls);
  assert.equal(again.results[0].cache, 'miss', 'rebuilt instead of reusing a changed artifact');
  assert.ok(calls.some((c) => c.repo === 'payment-lib' && c.step === 'build'));
  // No docker: blocked, and the next run tries again.
  const r2 = payments();
  commit(r2.lib, 'src/Main.java', 'class Fees { int x; }\n');
  const down = async ({ logFile }) => {
    fs.writeFileSync(logFile, 'docker is not available\n');
    return { exit_code: null, spawn_error: 'docker is not available: daemon down', elapsed_ms: 0 };
  };
  const blocked = await bootstrapGraph({ discoveries: [discover(r2.lib)], runner: down, imageId });
  assert.deepEqual([blocked.results[0].status, blocked.status], ['ENVIRONMENT_BLOCKED', 'BLOCKED']);
  const retry = await bootstrapGraph({ discoveries: [discover(r2.lib)], runner: fakeMaven([]), imageId });
  assert.deepEqual([retry.results[0].status, retry.results[0].cache], ['TESTS_PASSED', 'miss']);
});

test('graph problems and missing images stop before anything runs', async () => {
  const r = payments();
  const calls = [];
  const noImage = await bootstrapGraph({ discoveries: [discover(r.lib)], runner: fakeMaven(calls), imageId: () => null });
  assert.match(noImage.results[0].reason, /not available locally/);
  const fork = repo('payment-lib-fork', { 'pom.xml': pom({ a: 'payment-lib', v: '1.2.0-SNAPSHOT', java: 8 }), 'src/Main.java': 'x\n' });
  const dup = await bootstrapGraph({ discoveries: [r.lib, fork, r.server].map(discover), runner: fakeMaven(calls), imageId });
  assert.equal(dup.status, 'BLOCKED');
  assert.match(dup.reason, /produced by payment-lib and payment-lib-fork/);
  assert.deepEqual(calls, []);
});

test('source snapshot: no .git, no links, executable bits kept, unsafe archive entries refused', () => {
  const dir = repo('snap', { 'mvnw': '#!/bin/sh\necho hi\n', 'src/A.java': 'class A {}\n' });
  sh(dir, ['update-index', '--chmod=+x', 'mvnw']);
  const blob = sh(dir, ['hash-object', '-w', 'src/A.java']); // a link whose target is that text
  sh(dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},escape`]);
  sh(dir, ['commit', '-q', '-m', 'link and exec']);
  const dest = path.join(tmpDir('arw-snap-'), 'src');
  const s = snapshot(dir, 'HEAD', dest);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['mvnw', 'src']);
  assert.deepEqual(s.skipped.map((x) => [x.path, x.why]), [['escape', 'symlink']]);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dest, 'mvnw')).mode & 0o100, 'mvnw stays executable');

  // A crafted archive: entries escaping the directory are refused.
  const header = (name, body = '', type = '0') => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
    data.write(body);
    return Buffer.concat([h, data]);
  };
  const tar = Buffer.concat([header('../evil.txt', 'x'), header('/abs.txt', 'x'), header('.git/config', 'x'), header('a/b/../../c.txt', 'x'), header('ok/fine.txt', 'fine'), Buffer.alloc(1024)]);
  const tarFile = path.join(tmpDir('arw-tar-'), 't.tar');
  fs.writeFileSync(tarFile, tar);
  const out = path.join(tmpDir('arw-tarout-'), 'x');
  const res = extractTar(tarFile, out);
  assert.equal(res.files, 1);
  assert.deepEqual(res.skipped.map((x) => x.path), ['../evil.txt', '/abs.txt', '.git/config', 'a/b/../../c.txt']);
  assert.ok(!fs.existsSync(path.join(path.dirname(out), 'evil.txt')));
  assert.equal(fs.readFileSync(path.join(out, 'ok', 'fine.txt'), 'utf8'), 'fine');
});
