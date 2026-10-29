'use strict';
// scripts/hooks/readonly-bash.js is the PreToolUse hook of the read-only
// Claude agents (.claude/agents/*.md): a Bash command runs only when every
// part of it is on a read-only list. The model's word is not the guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verdict } = require('../scripts/hooks/readonly-bash');

const HOOK = path.resolve(__dirname, '..', 'scripts', 'hooks', 'readonly-bash.js');

const ALLOWED = [
  'git log --oneline -5 -- src/lib/freeze.js',
  'git show HEAD:src/lib/anchors.js | head -40',
  'git -C /d/x diff --stat HEAD~1',
  'git status --short && git ls-files src/web',
  'git grep -n recordGate -- src',
  'node scripts/dev-impact.js src/lib/anchors.js',
  'node scripts/dev-impact.js --json',
  'node scripts/test.js test/anchors.test.js',
  'node scripts/ai-sync.js --check',
  'node src/cli/arw.js status',
  'node src/cli/arw.js gate status --repo o/n --pr 3 --gate REVIEW',
  'node src/cli/arw.js retro --since 7',
  'node src/cli/arw.js --help',
  'ARW_RUNS_DIR=/tmp/x node src/cli/arw.js status',
  'npm test',
  'cat runs/prs/o__n__3/run.json',
  "grep -rn 'drift' runs/prs/o__n__3/review/driver.log 2>/dev/null",
  'ls -la runs/prs; wc -l src/lib/*.js',
  'find runs -name "*.json" -newer package.json',
  "sed -n '10,40p' src/lib/freeze.js",
  'cd src/lib && rg -n toolDigest',
  'sort -u x.txt | uniq -c | head',
  'git diff HEAD~1 2>&1 | tail -20',
];

const REFUSED = [
  'rm -rf runs',
  'git checkout -- src/lib/freeze.js',
  'git commit -m x',
  'git stash',
  'git diff --output=patch.txt',
  'echo x > src/lib/a.js',
  'cat a >> b',
  'git log | tee log.txt',
  "sed -i 's/a/b/' src/lib/freeze.js",
  'find runs -name "*.tmp" -delete',
  'find . -exec rm {} \\;',
  'sort -o out.txt in.txt',
  'node -e "require(\'fs\').writeFileSync(\'x\', \'y\')"',
  'node src/cli/arw.js review --local',
  'node src/cli/arw.js retro --save',
  'node src/cli/arw.js gate approve --repo o/n --pr 3 --gate REVIEW',
  'node scripts/ai-sync.js',
  'cat $(echo src/lib/a.js)',
  'cat `ls`',
  'npm install',
  'python -c "open(\'x\',\'w\')"',
  'git log; touch x',
  '',
];

test('read-only commands pass', () => {
  for (const cmd of ALLOWED) assert.equal(verdict(cmd), null, cmd);
});

test('commands that can write are refused, with a reason', () => {
  for (const cmd of REFUSED) assert.match(verdict(cmd) || '', /./, `not refused: ${cmd}`);
});

test('as a hook it exits 2 with the reason on stderr, and 0 for a read', () => {
  const run = (command) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  const bad = run('git commit -am x');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /read-only/);
  assert.equal(run('git log -1').status, 0);
  // Not a Bash call: nothing to decide here.
  const other = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }), encoding: 'utf8' });
  assert.equal(other.status, 0);
});
