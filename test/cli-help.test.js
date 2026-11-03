'use strict';
// `arw --help` is the first command a new user runs; it is not an error.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli', 'arw.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });
}

test('arw --help, -h and help print the usage and exit 0', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const res = run(args);
    assert.equal(res.status, 0, `${args[0]} exited ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /^arw .*evidence-first/m);
  }
});
