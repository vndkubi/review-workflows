'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeRepo } = require('./helpers');
const { parseJunit, classify, statusFromRuns, applyFix, validateReproTest, scrubbedEnv, detectToolchain, commandFor } = require('../src/lib/repro');

const SUREFIRE_FAIL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.OrderServiceReproTest" tests="1" errors="0" skipped="0" failures="1">
  <testcase name="memberAtExactlyOneMillion" classname="com.acme.OrderServiceReproTest">
    <failure message="expected: &lt;0&gt; but was: &lt;1&gt;" type="org.opentest4j.AssertionFailedError">trace</failure>
  </testcase>
</testsuite>`;

test('JUnit XML: failures vs errors vs passes', () => {
  const r = parseJunit(SUREFIRE_FAIL);
  assert.deepEqual([r.tests, r.failures, r.errors], [1, 1, 0]);
  assert.equal(r.message, 'failure: expected: <0> but was: <1>');
  const many = parseJunit('<testsuites tests="9"><testsuite tests="2" failures="0" errors="1" skipped="0"/><testsuite tests="1" failures="0" errors="0" skipped="1"/></testsuites>');
  assert.deepEqual([many.tests, many.errors, many.skipped], [3, 1, 1], 'suite totals, not the wrapper');
  assert.equal(parseJunit('not xml'), null);
});

test('run classification and the overall verdict', () => {
  const run = (junit, extra = {}) => ({ exit_code: 1, junit, ...extra });
  assert.equal(classify(run({ tests: 1, failures: 1, errors: 0, skipped: 0 })), 'red');
  assert.equal(classify(run({ tests: 1, failures: 0, errors: 1, skipped: 0 })), 'error', 'an exception is not an assertion failure');
  assert.equal(classify(run(null)), 'build_error', 'no report and a failed build = did not compile');
  assert.equal(classify(run(null, { spawn_error: 'command not found' })), 'environment');
  assert.equal(classify(run({ tests: 0, failures: 0, errors: 0, skipped: 0 })), 'no_tests');
  const s = (...xs) => statusFromRuns(xs.map((status, i) => ({ phase: `head-${i + 1}`, status })));
  assert.equal(s('red', 'red'), 'RED_PROVEN');
  assert.equal(s('red'), 'INCONCLUSIVE', 'one red run proves little');
  assert.equal(s('red', 'green'), 'FLAKY');
  assert.equal(s('green'), 'GREEN_NOT_PROVEN');
  assert.equal(s('build_error'), 'INCONCLUSIVE');
  assert.equal(s('environment'), 'ENVIRONMENT_BLOCKED');
  assert.equal(statusFromRuns([{ phase: 'head-1', status: 'red' }, { phase: 'head-2', status: 'red' }, { phase: 'fix', status: 'red' }]), 'RED_PROVEN', 'the fix run does not change the head verdict');
});

test('applying a finding fix: exact, indentation-tolerant, refused when ambiguous', () => {
  const dir = tmpDir();
  const file = 'src/A.java';
  fs.mkdirSync(path.join(dir, 'src'));
  const write = (s) => fs.writeFileSync(path.join(dir, file), s);
  const read = () => fs.readFileSync(path.join(dir, file), 'utf8');
  const finding = (asis, tobe) => ({ fix: { kind: 'code_change', asis, tobe, reason: 'r' }, evidence: [{ kind: 'code', path: file }] });

  write('class A {\n    int f(int x) {\n        if (x > 0) {\n            return 1;\n        }\n        return 0;\n    }\n}\n');
  assert.equal(applyFix(dir, finding('if (x > 0) {', 'if (x >= 0) {')).how, 'exact');
  assert.match(read(), /if \(x >= 0\) \{/);

  write('class A {\n    int f(int x) {\n        if (x > 0) {\n            return 1;\n        }\n    }\n}\n');
  const res = applyFix(dir, finding('if (x > 0) {\n    return 1;\n}', 'if (x >= 0) {\n    return 2;\n}'));
  assert.equal(res.how, 'lines');
  assert.match(read(), /\n {8}if \(x >= 0\) \{\n {12}return 2;\n {8}\}/, 're-indented to the matched block');

  write('if (x > 0) {}\nif (x > 0) {}\n');
  assert.equal(applyFix(dir, finding('if (x > 0) {}', 'if (x >= 0) {}')).applied, false);
  assert.equal(applyFix(dir, { fix: { kind: 'not_code' }, evidence: [] }).applied, false);
});

test('model-written tests: new file, matching package/class/selector', () => {
  const repo = makeRepo();
  const context = { source: { checkout: repo.dir, head_sha: repo.head } };
  const base = { language: 'java', path: 'src/test/java/com/acme/OrderServiceReproTest.java', selector: 'com.acme.OrderServiceReproTest', content: 'package com.acme;\nclass OrderServiceReproTest { void t() { assertEquals(1, 1); } }', fails_because: 'x' };
  assert.deepEqual(validateReproTest(base, { context }), []);
  assert.ok(validateReproTest({ ...base, path: 'src/main/java/com/acme/OrderService.java' }, { context }).some((e) => /already exists/.test(e)));
  assert.ok(validateReproTest({ ...base, selector: 'acme.OrderServiceReproTest' }, { context }).some((e) => /must be "com\.acme\.OrderServiceReproTest"/.test(e)));
  assert.ok(validateReproTest({ ...base, content: 'package other;\nclass OrderServiceReproTest { assert }' }, { context }).some((e) => /package com\.acme;/.test(e)));
  assert.ok(validateReproTest({ ...base, path: '../evil/X.java' }, { context }).length);
  assert.ok(validateReproTest({ ...base, selector: 'x; rm -rf /' }, { context }).length, 'selectors cannot carry shell syntax');
  const py = { language: 'python', path: 'tests/test_fee_repro.py', selector: 'tests/test_fee_repro.py::test_31_days', content: 'def test_31_days():\n    assert late_fee(31) > 0\n', fails_because: 'x' };
  assert.deepEqual(validateReproTest(py, { context }), []);
  assert.ok(validateReproTest({ ...py, path: 'tests/fee.py', selector: 'tests/fee.py::t' }, { context }).some((e) => /test_<name>\.py/.test(e)));
});

test('test commands run without secrets; toolchains are detected from build files', () => {
  process.env.ARW_FAKE_TOKEN = 'secret';
  process.env.JIRA_PAT = 'secret';
  const env = scrubbedEnv();
  assert.equal(env.ARW_FAKE_TOKEN, undefined);
  assert.equal(env.JIRA_PAT, undefined);
  assert.ok(env.PATH || env.Path);
  const dir = tmpDir();
  assert.equal(detectToolchain(dir, 'java'), null);
  fs.writeFileSync(path.join(dir, 'pom.xml'), '<project/>');
  assert.equal(detectToolchain(dir, 'java'), 'maven');
  const { command, junit } = commandFor('maven', { language: 'java', selector: 'com.acme.FooReproTest', path: 'x' }, dir);
  assert.match(command, /^mvn -B -q test -Dtest=com\.acme\.FooReproTest /);
  assert.ok(junit.endsWith(path.join('target', 'surefire-reports', 'TEST-com.acme.FooReproTest.xml')));
});
