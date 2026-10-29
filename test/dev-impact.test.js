'use strict';
// scripts/dev-impact.js answers, for a file of this repository: is it under
// the frozen hashes, what requires it, and which tests reach it. The
// impact-analyst agent and the hooks rely on these answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir, write } = require('./helpers');
const { analyze } = require('../scripts/dev-impact');

const ROOT = path.resolve(__dirname, '..');

test('a runtime module is in the tool digest and its own test is found', () => {
  const [a] = analyze(['src/lib/anchors.js']);
  assert.equal(a.hashed, 'tool');
  assert.ok(a.tests.direct.includes('test/anchors.test.js'));
  assert.ok(a.dependents.includes('src/lib/validate.js'), a.dependents.join(', '));
});

test('frozen policy and the dashboard are told apart', () => {
  const [schema, charter, web, freeze] = analyze(['config/schemas/review.schema.json', 'agents/coordinator.md', 'src/web/server.js', 'src/lib/freeze.js']);
  assert.equal(schema.hashed, 'policy');
  assert.match(schema.notes.join('\n'), /packet-contract-change/);
  // Read by src/lib/schema.js, not required, and still traced to tests.
  assert.ok(schema.dependents.includes('src/lib/schema.js'), schema.dependents.join(', '));
  assert.ok(schema.tests.direct.length + schema.tests.transitive.length > 0);
  assert.equal(charter.hashed, 'policy');
  assert.equal(web.hashed, null);
  assert.match(web.notes.join('\n'), /dashboard-change-verify/);
  assert.equal(freeze.hashed, 'tool');
  // The same files freeze.js hashes as policy.
  const { policyFiles } = require('../src/lib/freeze');
  const policy = policyFiles().map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.ok(policy.length > 5);
  for (const p of analyze(policy)) assert.equal(p.hashed, 'policy', p.file);
});

test('tests that reach a file only through another module are found too', () => {
  const root = tmpDir('arw-impact-');
  write(root, 'src/lib/b.js', 'module.exports = 1;\n');
  write(root, 'src/lib/a.js', "function f() {\n  return require('./b');\n}\nmodule.exports = { f };\n");
  write(root, 'test/a.test.js', "require('../src/lib/a.js');\n");
  write(root, 'test/b.test.js', "require('../src/lib/b');\n");
  write(root, 'test/other.test.js', "require('node:fs');\n");
  const [b] = analyze(['src/lib/b.js'], { root });
  assert.deepEqual(b.dependents, ['src/lib/a.js']);
  assert.deepEqual(b.tests.direct, ['test/b.test.js']);
  assert.deepEqual(b.tests.transitive, ['test/a.test.js']);
  assert.equal(b.hashed, 'tool');
});

test('the CLI prints the answer and exits 0', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dev-impact.js'), 'src/lib/anchors.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /src\/lib\/anchors\.js/);
  assert.match(res.stdout, /test\/anchors\.test\.js/);
  assert.match(res.stdout, /tool digest/);
});
