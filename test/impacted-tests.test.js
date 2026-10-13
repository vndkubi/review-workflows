'use strict';
// Impacted tests: grouped per toolchain and module, run at base and head in
// their own worktree, compared per test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-impacted-runs-');

const git = require('../src/lib/git');
const { testImpact } = require('../src/lib/static-evidence');
const { runImpactedTests, renderImpacted, planRuns, parseCases, verdict } = require('../src/lib/impacted-tests');

test('junit cases, verdicts, and grouping by module', () => {
  const cases = parseCases('<testsuite><testcase classname="com.acme.ATest" name="ok"/><testcase classname="com.acme.ATest" name="bad"><failure message="expected &lt;1&gt;">x</failure></testcase><testcase classname="t.test_x" name="s"><skipped/></testcase></testsuite>');
  assert.deepEqual(cases.map((c) => [c.name, c.status, c.message]), [['ok', 'pass', null], ['bad', 'fail', 'expected <1>'], ['s', 'skipped', null]]);
  assert.equal(verdict({ status: 'pass' }, { status: 'fail' }), 'newly_failing');
  assert.equal(verdict({ status: 'fail' }, { status: 'fail' }), 'still_failing');
  assert.equal(verdict(null, { status: 'fail' }), 'new_test_failing');
  assert.equal(verdict({ status: 'fail' }, { status: 'pass' }), 'fixed');
  const root = tmpDir('arw-mod-');
  write(root, 'pom.xml', '<project/>');
  write(root, 'billing/pom.xml', '<project/>');
  const groups = planRuns(root, ['src/test/java/com/acme/ATest.java', 'billing/src/test/java/com/acme/BTest.java', 'tests/test_fees.py']);
  assert.deepEqual(groups.map((g) => [g.toolchain, g.module, g.tests.map((t) => t.selector)]), [['maven', '', ['com.acme.ATest']], ['maven', 'billing', ['com.acme.BTest']], ['pytest', '', ['tests/test_fees.py']]]);
});

test('runs at base and head, finds the test this change broke, cleans up', async () => {
  const dir = tmpDir('arw-impacted-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'pom.xml', '<project/>');
  write(dir, 'src/main/java/com/acme/OrderService.java', 'class OrderService { int discount() { return 10; } }\n');
  write(dir, 'src/test/java/com/acme/OrderServiceTest.java', 'class OrderServiceTest { }\n');
  write(dir, 'billing/fees.py', 'def fee():\n    return 1\n');
  write(dir, 'tests/test_fees.py', 'from billing.fees import fee\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'src/main/java/com/acme/OrderService.java', 'class OrderService { int discount() { return 0; } }\n');
  write(dir, 'billing/fees.py', 'def fee():\n    return 1  # same\n');
  sh(dir, ['commit', '-q', '-am', 'change']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  const changed = git.changedFiles(dir, base, head).map((f) => f.path);
  const impact = testImpact({ checkout: dir, head, changed });
  const runDir = tmpDir('arw-impacted-run-');
  const commands = [];
  // Stands in for mvn/pytest: OrderServiceTest fails once discount() returns 0.
  const runner = async ({ command, cwd, logFile }) => {
    commands.push(command);
    fs.writeFileSync(logFile, command);
    const broken = fs.readFileSync(path.join(cwd, 'src/main/java/com/acme/OrderService.java'), 'utf8').includes('return 0');
    if (command.startsWith('mvn')) {
      fs.mkdirSync(path.join(cwd, 'target', 'surefire-reports'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'target', 'surefire-reports', 'TEST-com.acme.OrderServiceTest.xml'), `<testsuite><testcase classname="com.acme.OrderServiceTest" name="memberDiscount">${broken ? '<failure message="expected: &lt;10&gt; but was: &lt;0&gt;"/>' : ''}</testcase></testsuite>`);
    } else {
      const junit = command.match(/--junitxml=(\S+)/)[1];
      fs.writeFileSync(junit, '<testsuite><testcase classname="tests.test_fees" name="test_fee"/></testsuite>');
    }
    return { exit_code: broken && command.startsWith('mvn') ? 1 : 0, elapsed_ms: 1 };
  };
  assert.equal(await runImpactedTests({ runDir, checkout: dir, base, head, impact, repoCfg: {}, runner }), null, 'off unless enabled');
  const r = await runImpactedTests({ runDir, checkout: dir, base, head, impact, repoCfg: { run_impacted_tests: true }, runner });
  assert.deepEqual(r.results.map((x) => [x.test, x.verdict]).sort(), [['src/test/java/com/acme/OrderServiceTest.java', 'newly_failing'], ['tests/test_fees.py', 'passing']]);
  assert.match(r.results.find((x) => x.verdict === 'newly_failing').head.failing[0].message, /expected: <10> but was: <0>/);
  assert.equal(commands.length, 4, 'two groups, at base and at head');
  assert.ok(commands.some((c) => /-Dtest=com\.acme\.OrderServiceTest\b/.test(c)));
  assert.ok(!fs.existsSync(path.join(runDir, 'tests-wt')), 'the test worktree is removed');
  assert.equal(sh(dir, ['status', '--porcelain']), '', 'the checkout is untouched');
  assert.match(renderImpacted(r), /OrderServiceTest\.java: FAILS ON HEAD, passed on base \(broken by this change\)\n {2}- memberDiscount: expected: <10> but was: <0>/);
});
