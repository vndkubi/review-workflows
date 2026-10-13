'use strict';
// Machine evidence: CI results, linter hits on changed files (no shell, file
// names cannot become options) and test impact by name or reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, makeRepo } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-static-runs-');

const git = require('../src/lib/git');
const { parsePatch } = require('../src/lib/patch');
const { collectStatic, parseLines, isTest } = require('../src/lib/static-evidence');

const ORDER = 'src/main/java/com/acme/OrderService.java';
const FEES = 'billing/fees.py';

function fixture() {
  const repo = makeRepo();
  // A test for OrderService exists on base and is untouched by the PR.
  sh(repo.dir, ['checkout', '-q', repo.base]);
  write(repo.dir, 'src/test/java/com/acme/OrderServiceTest.java', 'class OrderServiceTest { OrderService s; }\n');
  write(repo.dir, 'tests/test_checkout.py', 'from billing.fees import late_fee\n');
  sh(repo.dir, ['add', '-A']);
  sh(repo.dir, ['commit', '-q', '-m', 'tests']);
  const base = sh(repo.dir, ['rev-parse', 'HEAD']);
  sh(repo.dir, ['cherry-pick', repo.head]);
  const head = sh(repo.dir, ['rev-parse', 'HEAD']);
  return { dir: repo.dir, base, head };
}

test('test detection covers Java and Python conventions', () => {
  assert.ok(isTest('src/test/java/a/FooTest.java'));
  assert.ok(isTest('pkg/tests/helpers.py'));
  assert.ok(isTest('test_fees.py'));
  assert.ok(!isTest('src/main/java/a/Foo.java'));
  assert.ok(!isTest('billing/fees.py'));
});

test('generic path:line output is parsed', () => {
  assert.deepEqual(parseLines('billing/fees.py:3:5: W1 money as float\nnoise\n./src/A.java:10: unused', '/x'), [
    { path: 'billing/fees.py', line: 3, rule: '', message: 'W1 money as float' },
    { path: 'src/A.java', line: 10, rule: '', message: 'unused' },
  ]);
});

test('collectStatic: CI, an opt-in linter on changed files, and test impact', () => {
  const r = fixture();
  const changed = git.changedFiles(r.dir, r.base, r.head);
  const parsed = parsePatch(git.diffPatch(r.dir, r.base, r.head));
  // A fake linter that prints one hit per file on line 1, plus one on a file outside the PR.
  const lint = path.join(tmpDir('arw-lint-'), 'lint.js');
  fs.writeFileSync(lint, "for (const f of process.argv.slice(2)) console.log(`${f}:1: X1 looked at ${f}`);\nconsole.log('elsewhere.py:4: X2 not in the PR');\nprocess.exit(1);\n");
  const calls = [];
  const api = (p) => {
    calls.push(p);
    if (p.includes('/check-runs?')) return { check_runs: [{ id: 5, name: 'build', status: 'completed', conclusion: 'failure', output: { title: '1 test failed', summary: 'OrderServiceTest' }, app: { name: 'GitHub Actions' } }] };
    if (p.includes('/check-runs/5/annotations')) return [{ path: ORDER, start_line: 9, annotation_level: 'failure', message: 'expected 100000' }, { path: 'other/File.java', start_line: 1, annotation_level: 'failure', message: 'unrelated' }];
    if (p.endsWith('/status')) return { statuses: [{ context: 'sonar', state: 'success', description: 'Quality gate passed' }] };
    throw new Error(p);
  };
  const s = collectStatic({
    repo: 'acme/shop', checkout: r.dir, base: r.base, head: r.head, changed, reviewable: [ORDER, FEES], parsed, local: null,
    repoCfg: { static_commands: [{ name: 'fake-lint', command: [process.execPath, lint, '{files}'], extensions: ['.py', '.java'] }] }, api,
  });
  assert.deepEqual(s.ci.checks.map((c) => [c.name, c.conclusion]), [['build', 'failure']]);
  assert.deepEqual(s.ci.annotations.map((a) => `${a.path}:${a.line}`), [`${ORDER}:9`], 'annotations outside the PR are dropped');
  const fake = s.linters.find((l) => l.tool === 'fake-lint');
  assert.deepEqual(fake.hits.map((h) => [h.path, h.line, h.on_added_line]).sort(), [[FEES, 1, true], [ORDER, 1, false]], 'only PR files; added lines marked');
  assert.match(fake.hits[0].message, /looked at \.\//, 'files are passed as ./path, never as bare names');
  const impact = Object.fromEntries(s.tests.sources.map((t) => [t.source, t.tests]));
  assert.deepEqual(impact[ORDER].map((t) => [t.path, t.how, t.changed_in_pr]), [['src/test/java/com/acme/OrderServiceTest.java', 'name', false]]);
  assert.deepEqual(impact[FEES].map((t) => [t.path, t.how]), [['tests/test_checkout.py', 'reference']]);
  assert.match(s.markdown, /## Machine evidence/);
  assert.match(s.markdown, /check "build" \(GitHub Actions\): completed \/ failure — 1 test failed/);
  assert.match(s.markdown, /OrderService\.java: src\/test\/java\/com\/acme\/OrderServiceTest\.java \(name, not changed in this PR\)/);

  // A local review has no CI; a broken API is recorded, not fatal.
  assert.equal(collectStatic({ repo: 'local/x', checkout: r.dir, base: r.base, head: r.head, changed, reviewable: [], parsed, local: { mode: 'staged' }, api }).ci, null);
  const broken = collectStatic({ repo: 'acme/shop', checkout: r.dir, base: r.base, head: r.head, changed, reviewable: [], parsed, local: null, api: () => { throw new Error('gh: HTTP 404'); } });
  assert.match(broken.ci.error, /HTTP 404/);
  assert.match(broken.markdown, /unavailable: gh: HTTP 404/);
});

// Real ruff when this machine has it (ARW_RUFF_BIN or on PATH); skipped otherwise.
const ruffBin = process.env.ARW_RUFF_BIN || 'ruff';
let hasRuff = false;
try {
  require('node:child_process').execFileSync(ruffBin, ['--version'], { stdio: 'ignore' });
  hasRuff = true;
} catch {
  hasRuff = false;
}

test('real ruff: hits on changed files, added lines marked, paths relative', { skip: !hasRuff && 'ruff not installed' }, () => {
  const dir = tmpDir('arw-ruff-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/fees.py', 'import os\n\n\ndef late_fee(days):\n    return days * 2\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/fees.py', 'import os\nimport sys\n\n\ndef late_fee(days):\n    try:\n        rate = RATES[days]\n    except:\n        rate = 2\n    return days * rate\n');
  sh(dir, ['commit', '-q', '-am', 'fees']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  const s = collectStatic({ repo: 'local/x', checkout: dir, base, head, changed: git.changedFiles(dir, base, head), reviewable: [FEES], parsed: parsePatch(git.diffPatch(dir, base, head)), local: { mode: 'range' } });
  const ruff = s.linters.find((l) => l.tool === 'ruff');
  const byRule = Object.fromEntries(ruff.hits.map((h) => [`${h.rule}@${h.line}`, h.on_added_line]));
  assert.equal(byRule['F821@7'], true, 'undefined name on an added line');
  assert.equal(byRule['F401@2'], true);
  assert.equal(byRule['F401@1'], false, 'the old unused import is not on an added line');
  assert.ok(ruff.hits.every((h) => h.path === FEES));
});
