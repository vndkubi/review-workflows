'use strict';
// Setting up a new machine: the setup scripts parse, `arw doctor` says how to
// fix what is missing on this OS, and a standalone codex binary can be used.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fixHint } = require('../src/lib/setup-hints');
const { resolveCodex } = require('../src/lib/codex');

const ROOT = path.join(__dirname, '..');

test('doctor hints name the install command for the platform', () => {
  assert.match(fixHint('node >= 20', 'win32'), /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(fixHint('node >= 20', 'darwin'), /brew install node/);
  assert.match(fixHint('git', 'linux'), /apt install git|your package manager/);
  assert.match(fixHint('gh auth', 'win32'), /winget install GitHub\.cli[\s\S]*gh auth login/);
  assert.match(fixHint('codex', 'darwin'), /npm i -g @openai\/codex[\s\S]*codex login/);
  const jdk = fixHint('JDK for Java impact (javac)', 'linux');
  assert.match(jdk, /openjdk-17-jdk/);
  assert.match(jdk, /ARW_JAVA_AST=off/, 'Java is optional and the hint says how to do without');
  assert.match(fixHint('config/repos.json', 'win32'), /sandbox setup .* --register/);
  assert.match(fixHint('codex preflight (model gpt-x)', 'win32'), /CODEX_MODEL/);
  assert.equal(fixHint('something new', 'win32'), null);
  // Every hint points a Windows user at the one-step setup.
  assert.match(fixHint('git', 'win32'), /scripts[\\/]setup\.ps1/);
  assert.match(fixHint('git', 'darwin'), /scripts\/setup\.sh/);
  assert.doesNotMatch(fixHint('Jira (REST)', 'win32'), /setup/, 'the setup scripts install tools; they do not configure Jira');
});

test('CODEX_BIN can be a standalone codex binary, not only the npm JS entry', () => {
  const saved = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = path.join('C:', 'tools', 'codex.exe');
    assert.deepEqual(resolveCodex(), { cmd: process.env.CODEX_BIN, pre: [] });
    process.env.CODEX_BIN = path.join('npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    assert.deepEqual(resolveCodex(), { cmd: process.execPath, pre: [process.env.CODEX_BIN] });
  } finally {
    if (saved === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = saved;
  }
});

test('the setup scripts parse', { skip: false }, (t) => {
  const sh = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'setup.sh')], { encoding: 'utf8' });
  if (sh.error) t.diagnostic('bash not available: setup.sh not checked');
  else assert.equal(sh.status, 0, sh.stderr);
  if (process.platform === 'win32') {
    const file = path.join(ROOT, 'scripts', 'setup.ps1').replace(/'/g, "''");
    const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`], { encoding: 'utf8' });
    assert.equal(ps.status, 0, ps.stdout + ps.stderr);
  }
});
