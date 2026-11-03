'use strict';
// `arw --help` is the first command a new user runs; it is not an error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

const CLI = path.join(__dirname, '..', 'src', 'cli', 'arw.js');
const ENV = {
  ...process.env,
  ARW_RUNS_DIR: tmpDir('arw-cli-runs-'),
  ARW_ENV_FILE: path.join(tmpDir('arw-cli-env-'), '.env'),
  ARW_REPOS_FILE: path.join(tmpDir('arw-cli-repos-'), 'repos.json'),
};

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, env: ENV });
}

test('arw --help, -h and help print the usage and exit 0', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const res = run(args);
    assert.equal(res.status, 0, `${args[0]} exited ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /^arw .*evidence-first/m);
  }
});

test('an unknown command exits 1 and puts the usage on stderr', () => {
  const res = run(['definitely-not-a-command']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^arw .*evidence-first/m);
  assert.doesNotMatch(res.stdout, /^arw .*evidence-first/m);
});

test('a review that stops at AWAITING_INTENT exits 3', () => {
  const preload = path.join(tmpDir('arw-cli-preload-'), 'fake-review.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const Module = require('node:module');",
    'const load = Module._load;',
    "Module._load = function (request, parent, isMain) {",
    "  if (request === '../lib/pr-review' && parent && /arw\\.js$/.test(parent.filename)) return {",
    "    reviewPr: async () => ({ awaiting: 'intent', ticket: 'ACME-1', validation: null }),",
    "    revalidate: () => { throw new Error('not used'); },",
    '  };',
    '  return load.apply(this, arguments);',
    '};',
  ].join('\n'));
  const res = spawnSync(process.execPath, ['--require', preload, CLI, 'review', '--repo', 'acme/shop', '--pr', '1'], { encoding: 'utf8', timeout: 30000, env: ENV });
  assert.equal(res.status, 3, res.stdout + res.stderr);
  assert.match(res.stdout, /AWAITING_INTENT/);
});
