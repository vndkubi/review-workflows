'use strict';
// README claims must match routes the server actually has, and the Quickstart
// must stay short and use real CLI commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
const CLI = path.join(ROOT, 'src', 'cli', 'arw.js');

test('README does not claim dashboard requirement editing, which has no route', () => {
  assert.doesNotMatch(README, /edit requirement items/i);
  assert.match(README, /approve or reject the spec/i);
  // The server's only ticket write routes are create, advance and gate.
  assert.doesNotMatch(SERVER, /'PUT',\s*\/\^\\\/api\\\/tickets\\\/[^/]+\\\/requirements/);
});

test('Quickstart is near the top, has at most five commands, and each command exists in --help', () => {
  const start = README.indexOf('## Quickstart');
  const spec = README.indexOf('## From spec text');
  assert.ok(start > 0 && start < spec, 'Quickstart is before the design section');
  const block = README.slice(start, spec).match(/```bash\n([\s\S]*?)```/);
  assert.ok(block, 'Quickstart has a bash block');
  const commands = block[1].split('\n').map((line) => line.trim()).filter((line) => line.startsWith('node src/cli/arw.js '));
  assert.ok(commands.length >= 4 && commands.length <= 5, `expected at most 5 commands, got ${commands.length}`);

  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const command of commands) {
    const sub = command.match(/^node src\/cli\/arw\.js (\w+)/)[1];
    assert.match(help, new RegExp(`\\b${sub}\\b`), `${sub} is missing from arw --help`);
  }
});
