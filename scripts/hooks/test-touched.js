'use strict';
// Claude Code PostToolUse hook for Edit|Write|MultiEdit: runs the tests of
// the file just changed, so a break shows up at the edit, not at the push.
// A test file runs itself; a source file runs test/<name>.test.js, else the
// tests that require it (at most MAX). Exit 2 shows the failure to the model.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX = 3;

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}
const target = (input.tool_input && input.tool_input.file_path) || '';
if (!target.endsWith('.js')) process.exit(0);
const rel = path.relative(ROOT, path.resolve(input.cwd || ROOT, target)).replace(/\\/g, '/');
if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);

let tests = [];
if (/^test\/[^/]+\.test\.js$/.test(rel)) tests = [rel];
else if (/^src\//.test(rel)) {
  const name = path.basename(rel, '.js');
  const own = `test/${name}.test.js`;
  if (fs.existsSync(path.join(ROOT, own))) tests = [own];
  else {
    const needle = new RegExp(`require\\(['"][./]+${rel.replace(/\.js$/, '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\.js)?['"]\\)`);
    tests = fs.readdirSync(path.join(ROOT, 'test'))
      .filter((f) => f.endsWith('.test.js') && needle.test(fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')))
      .sort().slice(0, MAX).map((f) => `test/${f}`);
  }
}
if (!tests.length) process.exit(0);

const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test.js'), ...tests.map((t) => path.join(ROOT, t))], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true });
if (res.status === 0) process.exit(0);
const out = `${res.stdout || ''}${res.stderr || ''}`.split(/\r?\n/);
const failing = out.filter((l) => /^\s*not ok /.test(l));
process.stderr.write(`tests for ${rel} failed (${tests.join(', ')}):\n${failing.join('\n')}\n--- last lines ---\n${out.slice(-40).join('\n')}\n`);
process.exit(2);
