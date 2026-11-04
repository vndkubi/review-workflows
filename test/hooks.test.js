'use strict';
// The hooks that keep a run's frozen hashes stable and the public repository
// free of private run data. They are scripts; this test invokes them exactly
// as the git/Claude hook wrappers do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'guard-frozen-edit.js');
const PRE_COMMIT = path.join(ROOT, 'scripts', 'hooks', 'pre-commit.js');

function guard(script, cwd, filePath, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ cwd, tool_input: { file_path: filePath } }),
    timeout: 30000,
    env: { ...process.env, ...env },
  });
}

test('guard-frozen-edit blocks a frozen edit only while this checkout runs a review', async () => {
  // Run the same script from a temporary root. The allow case reads a stand-in
  // process list: a real review on this machine (`node src/cli/arw.js review`,
  // a relative path that counts for every checkout) would otherwise block it.
  const root = tmpDir('arw-hook-root-');
  fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true });
  const script = path.join(root, 'scripts', 'hooks', 'guard-frozen-edit.js');
  fs.copyFileSync(GUARD, script);
  const arw = path.join(root, 'src', 'cli', 'arw.js');
  const list = path.join(root, 'processes.txt');

  fs.writeFileSync(list, `"${process.execPath}" ${path.join(tmpDir('arw-other-'), 'src', 'cli', 'arw.js')} review --repo o/n --pr 1\n`);
  const allowed = guard(script, root, 'src/lib/x.js', { ARW_GUARD_PROCESSES: list });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stderr, '');

  fs.writeFileSync(list, `"${process.execPath}" src/cli/arw.js review --repo o/n --pr 1\n`);
  const relative = guard(script, root, 'src/lib/x.js', { ARW_GUARD_PROCESSES: list });
  assert.equal(relative.status, 2, 'a relative arw.js path cannot be placed, so it counts');

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', arw, 'review'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const blocked = guard(script, root, 'src/lib/x.js');
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /src\/lib\/x\.js/);
    assert.match(blocked.stderr, /run of this checkout is in progress/);
  } finally {
    child.kill();
  }
});

test('pre-commit refuses a staged private path', () => {
  const repo = tmpDir('arw-hooks-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'runs'));
  fs.writeFileSync(path.join(repo, 'runs', 'a.json'), '{}\n');
  execFileSync('git', ['add', '-f', 'runs/a.json'], { cwd: repo });
  const refused = spawnSync(process.execPath, [PRE_COMMIT], { cwd: repo, encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /runs\/a\.json: run data/);

  execFileSync('git', ['rm', '--cached', 'runs/a.json'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=secret\n');
  execFileSync('git', ['add', '-f', '.env'], { cwd: repo });
  const env = spawnSync(process.execPath, [PRE_COMMIT], { cwd: repo, encoding: 'utf8' });
  assert.equal(env.status, 1, env.stderr);
  assert.match(env.stderr, /\.env: secrets/);
});
