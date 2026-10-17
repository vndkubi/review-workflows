'use strict';
// Dashboard sandbox endpoints: discovery and graph of configured
// repositories, records and the files they list, bootstrap as a queued job.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-wsb-runs-');
process.env.ARW_SANDBOX_HOME = tmpDir('arw-wsb-home-');
process.env.ARW_ENV_FILE = path.join(tmpDir('arw-wsb-env-'), '.env');
process.env.ARW_REPOS_FILE = path.join(tmpDir('arw-wsb-repos-'), 'repos.json');

const { createServer } = require('../src/web/server');
const { bootstrapGraph } = require('../src/lib/bootstrap');
const { discoverRepo } = require('../src/lib/discovery');

const TOKEN = 's'.repeat(48);

function repo(name, pomText) {
  const dir = path.join(tmpDir('arw-wsb-'), name);
  sh(path.dirname(dir), ['init', '-q', '-b', 'main', name]);
  write(dir, 'pom.xml', pomText);
  write(dir, 'src/test/java/com/company/XTest.java', 'class XTest {}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

const pom = (a, java, dep) => `<project>\n  <groupId>com.company</groupId>\n  <artifactId>${a}</artifactId>\n  <version>1.0</version>\n  <properties>\n    <maven.compiler.release>${java}</maven.compiler.release>\n  </properties>\n  <dependencies>\n${dep ? `    <dependency>\n      <groupId>com.company</groupId>\n      <artifactId>${dep}</artifactId>\n      <version>1.0</version>\n    </dependency>\n` : ''}  </dependencies>\n</project>\n`;

function call(port, method, url, { body, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (res) => ({ status: res.status, json: await res.json() }));
}

test('sandbox endpoints', async (t) => {
  const lib = repo('payment-lib', pom('payment-lib', 8));
  const server = repo('payment-server', pom('payment-server', 11, 'payment-lib'));
  fs.writeFileSync(process.env.ARW_REPOS_FILE, JSON.stringify({ repos: { 'acme/payment-lib': { checkout: lib }, 'acme/payment-server': { checkout: server } } }));
  // One record, made by bootstrap with a scripted Maven.
  const runner = async ({ argv, cwd, logFile, mounts }) => {
    fs.writeFileSync(logFile, `[INFO] ${argv.includes('-o') ? 'BUILD SUCCESS' : 'resolved'}\n`);
    if (argv.includes('-o')) {
      write(cwd, 'target/surefire-reports/TEST-com.company.XTest.xml', '<testsuite><testcase classname="com.company.XTest" name="t"/></testsuite>');
      const m2 = mounts.find((m) => m.container === '/m2').host;
      write(path.join(m2, 'com', 'company', 'payment-lib', '1.0'), 'payment-lib-1.0.jar', 'jar');
      write(path.join(m2, 'com', 'company', 'payment-lib', '1.0'), 'payment-lib-1.0.pom', '<project/>');
    }
    return { exit_code: 0, elapsed_ms: 1 };
  };
  const out = await bootstrapGraph({ discoveries: [discoverRepo({ checkout: lib, repo: 'acme/payment-lib' })], runner, imageId: () => 'sha256:test' });
  const fp = out.results[0].fingerprint;
  assert.equal(out.results[0].status, 'TESTS_PASSED');

  const queued = [];
  const queue = { list: () => [], get: () => null, readLog: () => ({ text: '', next: 0 }), cancel: () => null, enqueue: (j) => { queued.push(j); return { id: 'job1', ...j }; } };
  const probe = createServer({ port: 0, token: TOKEN, queue });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  probe.close();
  const real = createServer({ port, token: TOKEN, queue });
  await new Promise((r) => real.listen(port, '127.0.0.1', r));
  t.after(() => real.close());
  const auth = { 'X-ARW-Token': TOKEN };

  await t.test('overview: mode, configured repositories with their latest record', async () => {
    const r = await call(port, 'GET', '/api/sandbox');
    assert.equal(r.status, 200);
    assert.ok(['host', 'docker', 'bootstrap'].includes(r.json.mode));
    assert.deepEqual(r.json.repos.map((x) => [x.name, x.latest && x.latest.status]), [['acme/payment-lib', 'TESTS_PASSED'], ['acme/payment-server', null]]);
    const saved = process.env.ARW_SANDBOX;
    process.env.ARW_SANDBOX = 'dockre';
    try {
      const bad = await call(port, 'GET', '/api/sandbox');
      assert.equal(bad.status, 200);
      assert.equal(bad.json.mode, 'invalid');
      assert.match(bad.json.mode_error, /ARW_SANDBOX="dockre"/);
    } finally {
      if (saved === undefined) delete process.env.ARW_SANDBOX;
      else process.env.ARW_SANDBOX = saved;
    }
  });

  await t.test('discovery and graph of configured repositories only', async () => {
    const d = await call(port, 'GET', '/api/sandbox/discover?repo=acme/payment-server');
    assert.deepEqual([d.json.java.jdk, d.json.dependencies[0].artifactId], [11, 'payment-lib']);
    assert.equal((await call(port, 'GET', '/api/sandbox/discover?repo=C:/Windows')).status, 404);
    assert.equal((await call(port, 'GET', '/api/sandbox/discover?repo=acme/payment-lib&rev=HEAD;rm')).status, 400);
    const g = await call(port, 'GET', '/api/sandbox/graph');
    assert.deepEqual(g.json.levels, [['acme/payment-lib'], ['acme/payment-server']]);
  });

  await t.test('records and the files a record lists, nothing else', async () => {
    const list = await call(port, 'GET', '/api/sandbox/records');
    assert.deepEqual(list.json.map((r) => r.fingerprint), [fp]);
    const rec = await call(port, 'GET', `/api/sandbox/records/${fp}`);
    assert.equal(rec.json.intact, true);
    const log = await call(port, 'GET', `/api/sandbox/records/${fp}/file?path=logs/build.log`);
    assert.match(log.json.text, /BUILD SUCCESS[\s\S]*\[arw\] exit_code=0/);
    assert.equal((await call(port, 'GET', `/api/sandbox/records/${fp}/file?path=../../../repos.json`)).status, 404);
    assert.equal((await call(port, 'GET', `/api/sandbox/records/${fp}/file?path=artifacts/com/company/payment-lib/1.0/payment-lib-1.0.jar`)).status, 404, 'binary artifacts are not served as text');
  });

  await t.test('detect from any source folder (token required), then set up in one job', async () => {
    const folder = repo('billing-svc', pom('billing-svc', 17));
    assert.equal((await call(port, 'POST', '/api/sandbox/detect', { body: { dir: folder } })).status, 403);
    assert.equal((await call(port, 'POST', '/api/sandbox/detect', { body: { dir: 'relative/x' }, headers: auth })).status, 400);
    assert.equal((await call(port, 'POST', '/api/sandbox/detect', { body: { dir: tmpDir('arw-wsb-nogit-') }, headers: auth })).status, 400);
    const d = await call(port, 'POST', '/api/sandbox/detect', { body: { dir: folder }, headers: auth });
    assert.deepEqual([d.json.configured_as, d.json.suggested_name, d.json.discovery.java.jdk, d.json.discovery.proposal.image], [null, 'local/billing-svc', 17, 'maven:3.9-eclipse-temurin-17']);
    const known = await call(port, 'POST', '/api/sandbox/detect', { body: { dir: server }, headers: auth });
    assert.equal(known.json.configured_as, 'acme/payment-server');

    queued.length = 0;
    await call(port, 'POST', '/api/sandbox/setup', { body: { dir: folder, register: true, name: 'acme/billing-svc' }, headers: auth });
    assert.deepEqual(queued[0].args, ['sandbox', 'setup', path.resolve(folder), '--register', '--name', 'acme/billing-svc']);
    await call(port, 'POST', '/api/sandbox/setup', { body: { dir: server }, headers: auth });
    assert.deepEqual(queued[1].args, ['sandbox', 'setup', 'acme/payment-server'], 'a configured folder is set up by its name');
    await call(port, 'POST', '/api/sandbox/setup', { body: { repo: 'acme/payment-lib' }, headers: auth });
    assert.deepEqual(queued[2].args, ['sandbox', 'setup', 'acme/payment-lib']);
    assert.equal((await call(port, 'POST', '/api/sandbox/setup', { body: { dir: folder, register: true, name: 'no slash' }, headers: auth })).status, 400);
    assert.equal((await call(port, 'POST', '/api/sandbox/setup', { body: { dir: folder, register: true, name: 'acme/payment-lib' }, headers: auth })).status, 409);
  });

  await t.test('detect lists the libraries; an in-house one without source gets added from its folder', async () => {
    const rates = repo('rates-lib', pom('rates-lib', 8));
    const app = repo('invoice-app', pom('invoice-app', 11, 'rates-lib'));
    let d = await call(port, 'POST', '/api/sandbox/detect', { body: { dir: app }, headers: auth });
    assert.deepEqual(d.json.libraries.map((l) => [l.artifact, l.kind]), [['com.company:rates-lib', 'missing']], 'same group, no configured repository builds it');
    const wrong = await call(port, 'POST', '/api/sandbox/libraries', { body: { dir: lib, artifact: 'com.company:rates-lib' }, headers: auth });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /produces com.company:payment-lib, not com.company:rates-lib/);
    assert.equal((await call(port, 'POST', '/api/sandbox/libraries', { body: { dir: rates, artifact: 'com.company:rates-lib' } })).status, 403);
    const added = await call(port, 'POST', '/api/sandbox/libraries', { body: { dir: rates, artifact: 'com.company:rates-lib' }, headers: auth });
    assert.deepEqual([added.json.name, added.json.added], ['local/rates-lib', true]);
    d = await call(port, 'POST', '/api/sandbox/detect', { body: { dir: app }, headers: auth });
    assert.deepEqual(d.json.libraries.map((l) => [l.artifact, l.kind, l.repo]), [['com.company:rates-lib', 'configured', 'local/rates-lib']]);
  });

  await t.test('addRepo registers one folder and keeps the others', () => {
    const settings = require('../src/lib/settings');
    const folder = repo('ledger', pom('ledger', 11));
    assert.equal(settings.addRepo('acme/ledger', folder).added, true);
    assert.equal(settings.addRepo('acme/ledger', folder).added, false, 'the same folder again is a no-op');
    assert.throws(() => settings.addRepo('acme/ledger', lib), /already configured/);
    const repos = JSON.parse(fs.readFileSync(process.env.ARW_REPOS_FILE, 'utf8')).repos;
    assert.deepEqual(Object.keys(repos).sort(), ['acme/ledger', 'acme/payment-lib', 'acme/payment-server', 'local/rates-lib']);
  });

  await t.test('bootstrap is a queued CLI job, for configured repositories, with the token', async () => {
    queued.length = 0;
    assert.equal((await call(port, 'POST', '/api/sandbox/bootstrap', { body: { repos: ['acme/payment-server'] } })).status, 403);
    assert.equal((await call(port, 'POST', '/api/sandbox/bootstrap', { body: { repos: ['evil/repo'] }, headers: auth })).status, 404);
    assert.equal((await call(port, 'POST', '/api/sandbox/bootstrap', { body: { repos: ['acme/payment-lib@x y'] }, headers: auth })).status, 400);
    const r = await call(port, 'POST', '/api/sandbox/bootstrap', { body: { repos: ['acme/payment-lib', 'acme/payment-server'], force: true }, headers: auth });
    assert.equal(r.status, 200);
    assert.deepEqual(queued[0].args, ['sandbox', 'bootstrap', 'acme/payment-lib', 'acme/payment-server', '--force']);
    assert.deepEqual(queued[0].target, { type: 'sandbox', id: 'sandbox' });
  });
});
