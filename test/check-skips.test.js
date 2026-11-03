'use strict';
// The CI isolation job must fail when a Docker or ruff test was skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

test('Docker and ruff skips are reported; an unrelated skip is allowed', () => {
  const { skippedIsolation } = require('../scripts/check-skips');
  const text = [
    'ok 1 - real containers: JDK 8 library # SKIP set ARW_DOCKER_TESTS=1 to run real containers',
    'ok 2 - real ruff: hits on changed files # SKIP ruff not installed',
    'ok 3 - docker: no network # SKIP set ARW_DOCKER_TESTS=1 to run real containers',
    'ok 4 - javac: overloads # SKIP no JDK 11+ on PATH',
    'not ok 5 - a real failure',
  ].join('\n');
  assert.deepEqual(skippedIsolation(text).map((line) => line.split(' - ')[1].split(' #')[0]), [
    'real containers: JDK 8 library',
    'real ruff: hits on changed files',
    'docker: no network',
  ]);
  assert.deepEqual(skippedIsolation('ok 1 - javac # SKIP no JDK 11+ on PATH'), []);
});

test('the CLI exits 1 with the skipped isolation test names', () => {
  const file = path.join(tmpDir('arw-skips-'), 'test.log');
  fs.writeFileSync(file, 'ok 1 - docker: no network # SKIP set ARW_DOCKER_TESTS=1 to run real containers\n');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-skips.js'), file], { encoding: 'utf8' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /docker: no network/);
  assert.match(res.stderr, /Docker and ruff tests must run/);
});

test('the CLI exits 0 when only an unrelated test was skipped', () => {
  const file = path.join(tmpDir('arw-skips-'), 'test.log');
  fs.writeFileSync(file, 'ok 1 - javac: overloads # SKIP no JDK 11+ on PATH\n');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-skips.js'), file], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no Docker or ruff test was skipped/);
});
