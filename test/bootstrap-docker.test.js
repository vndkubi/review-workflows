'use strict';
// The four acceptance runs with real Maven in real containers: payment-lib
// on JDK 8, payment-server on JDK 11 using it. Needs docker, the images
// maven:3.9-eclipse-temurin-8 and -11, and network for the resolve step
// (Maven Central). Runs only with ARW_DOCKER_TESTS=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-bootd-runs-');
process.env.ARW_SANDBOX_HOME = tmpDir('arw-bootd-home-');

const { discoverRepo } = require('../src/lib/discovery');
const { bootstrapGraph, renderBootstrap } = require('../src/lib/bootstrap');

function ready() {
  if (process.env.ARW_DOCKER_TESTS !== '1') return 'set ARW_DOCKER_TESTS=1 to run real containers';
  try {
    for (const i of ['maven:3.9-eclipse-temurin-8', 'maven:3.9-eclipse-temurin-11']) execFileSync('docker', ['image', 'inspect', i], { stdio: 'ignore' });
    return false;
  } catch {
    return 'docker or the JDK 8/11 Maven images are not available';
  }
}

const LIB_POM = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.company</groupId>
  <artifactId>payment-lib</artifactId>
  <version>1.2.0-SNAPSHOT</version>
  <properties>
    <maven.compiler.source>1.8</maven.compiler.source>
    <maven.compiler.target>1.8</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

const SERVER_POM = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.company</groupId>
  <artifactId>payment-server</artifactId>
  <version>3.0.0</version>
  <properties>
    <maven.compiler.release>11</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.company</groupId>
      <artifactId>payment-lib</artifactId>
      <version>1.2.0-SNAPSHOT</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

const FEES = (body) => `package com.company.pay;\n\npublic class Fees {\n    public static int late(int days) {\n        ${body}\n    }\n}\n`;
const FEES_TEST = 'package com.company.pay;\n\nimport org.junit.Test;\nimport static org.junit.Assert.assertEquals;\n\npublic class FeesTest {\n    @Test\n    public void dayThirtyIsFree() {\n        assertEquals(0, Fees.late(30));\n    }\n}\n';
// `var` needs Java 10+: the server really compiles on 11.
const BILLING = (extra) => `package com.company.server;\n\nimport com.company.pay.Fees;\n\npublic class Billing {\n    public static int charge(int days) {\n        var fee = Fees.late(days);\n        return 100 + fee${extra};\n    }\n}\n`;
const BILLING_TEST = 'package com.company.server;\n\nimport org.junit.Test;\nimport static org.junit.Assert.assertEquals;\n\npublic class BillingTest {\n    @Test\n    public void onTimeCostsTheBase() {\n        assertEquals(100, Billing.charge(30));\n    }\n}\n';

function repo(name, files) {
  const dir = path.join(tmpDir('arw-bootd-'), name);
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

test('real containers: JDK 8 library, JDK 11 server, four runs', { skip: ready(), timeout: 30 * 60 * 1000 }, async () => {
  const lib = repo('payment-lib', { 'pom.xml': LIB_POM, 'src/main/java/com/company/pay/Fees.java': FEES('return days <= 30 ? 0 : (days - 30) * 2;'), 'src/test/java/com/company/pay/FeesTest.java': FEES_TEST });
  const server = repo('payment-server', { 'pom.xml': SERVER_POM, 'src/main/java/com/company/server/Billing.java': BILLING(''), 'src/test/java/com/company/server/BillingTest.java': BILLING_TEST });
  const lines = [];
  const go = async (label) => {
    const t0 = Date.now();
    const out = await bootstrapGraph({ discoveries: [server, lib].map((d) => discoverRepo({ checkout: d, repo: path.basename(d) })), log: (m) => lines.push(m) });
    process.stderr.write(`\n--- ${label} (${Math.round((Date.now() - t0) / 1000)} s)\n${renderBootstrap(out)}\n`);
    return out;
  };

  let out = await go('run 1: build both');
  assert.equal(out.status, 'READY', lines.join('\n'));
  assert.deepEqual(out.results.map((r) => [r.repo, r.status, r.image]), [['payment-lib', 'TESTS_PASSED', 'maven:3.9-eclipse-temurin-8'], ['payment-server', 'TESTS_PASSED', 'maven:3.9-eclipse-temurin-11']]);
  assert.deepEqual(out.results.map((r) => r.tests.total), [1, 1]);

  commit(server, 'src/main/java/com/company/server/Billing.java', BILLING(' + 0'));
  out = await go('run 2: server changed');
  assert.deepEqual(out.results.map((r) => [r.repo, r.cache, r.status]), [['payment-lib', 'hit', 'TESTS_PASSED'], ['payment-server', 'miss', 'TESTS_PASSED']]);
  assert.equal(out.results[1].resolve, 'skipped (resolved before)');

  commit(lib, 'src/main/java/com/company/pay/Fees.java', FEES('return days <= 30 ? 0 : (days - 30) * 3;'));
  out = await go('run 3: library changed');
  assert.deepEqual(out.results.map((r) => [r.repo, r.cache, r.status]), [['payment-lib', 'miss', 'TESTS_PASSED'], ['payment-server', 'miss', 'TESTS_PASSED']]);
  assert.equal(out.results[1].resolve, 'skipped (resolved before)', 'the library jar changed, its POM did not: no new resolution');

  commit(lib, 'src/main/java/com/company/pay/Fees.java', FEES('return days <= 30 ? 0 : (days - 30) * "2";'));
  out = await go('run 4: library broken');
  assert.deepEqual(out.results.map((r) => [r.repo, r.status]), [['payment-lib', 'BUILD_FAILED'], ['payment-server', 'BLOCKED']]);
});

test('real containers: a review of payment-server runs its impacted tests offline in the prepared environment', { skip: ready(), timeout: 30 * 60 * 1000 }, async () => {
  const { prepareReviewEnvironment } = require('../src/lib/bootstrap');
  const { runImpactedTests, renderImpacted } = require('../src/lib/impacted-tests');
  const saved = process.env.ARW_SANDBOX;
  process.env.ARW_SANDBOX = 'bootstrap';
  try {
    const lib = repo('payment-lib', { 'pom.xml': LIB_POM, 'src/main/java/com/company/pay/Fees.java': FEES('return days <= 30 ? 0 : (days - 30) * 2;'), 'src/test/java/com/company/pay/FeesTest.java': FEES_TEST });
    const server = repo('payment-server', { 'pom.xml': SERVER_POM, 'src/main/java/com/company/server/Billing.java': BILLING(''), 'src/test/java/com/company/server/BillingTest.java': BILLING_TEST });
    const base = sh(server, ['rev-parse', 'HEAD']);
    commit(server, 'src/main/java/com/company/server/Billing.java', BILLING(' + 1')); // the PR breaks the on-time price
    const head = sh(server, ['rev-parse', 'HEAD']);
    const impact = { sources: [{ path: 'src/main/java/com/company/server/Billing.java', tests: [{ path: 'src/test/java/com/company/server/BillingTest.java' }] }], tests_changed: [] };
    const review = async (h) => {
      const runDir = tmpDir('arw-bootd-review-');
      const t0 = Date.now();
      const env = await prepareReviewEnvironment({ runDir, repo: 'payment-server', checkout: server, base, head: h, others: [{ repo: 'payment-lib', checkout: lib }], log: (m) => process.stderr.write(`  ${m}\n`) });
      const r = await runImpactedTests({ runDir, checkout: server, base, head: h, impact, repoCfg: { run_impacted_tests: true } });
      process.stderr.write(`--- review (${Math.round((Date.now() - t0) / 1000)} s)${renderImpacted(r)}`);
      return { env, r };
    };
    const { env, r } = await review(head);
    assert.equal(env.status, 'READY', env.reason);
    assert.deepEqual(env.producers.map((p) => p.repo), ['payment-lib']);
    assert.equal(r.results[0].verdict, 'newly_failing', JSON.stringify(r, null, 2));
    assert.match(r.results[0].head.failing[0].message, /expected:<100> but was:<101>/);
    assert.ok(r.ran.every((g) => g.environment === env.digest), 'every run is bound to the environment');

    // A PR that adds a dependency the base never resolved: blocked, not failed.
    commit(server, 'pom.xml', SERVER_POM.replace('  </dependencies>', '    <dependency>\n      <groupId>org.apache.commons</groupId>\n      <artifactId>commons-text</artifactId>\n      <version>1.12.0</version>\n    </dependency>\n  </dependencies>'));
    const newDep = await review(sh(server, ['rev-parse', 'HEAD']));
    const headRun = newDep.r.ran.find((g) => g.rev === 'head');
    assert.match(headRun.spawn_error, /not in the environment/);
    assert.notEqual(newDep.r.results[0].verdict, 'newly_failing');
  } finally {
    if (saved === undefined) delete process.env.ARW_SANDBOX;
    else process.env.ARW_SANDBOX = saved;
  }
});
