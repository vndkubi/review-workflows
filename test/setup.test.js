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

// ---------- essentials, presets and the shared setup core ----------
const fs = require('node:fs');
const { tmpDir } = require('./helpers');

function withFiles(fn) {
  const dir = tmpDir('arw-setup-');
  const saved = { env: process.env.ARW_ENV_FILE, repos: process.env.ARW_REPOS_FILE };
  process.env.ARW_ENV_FILE = path.join(dir, '.env');
  process.env.ARW_REPOS_FILE = path.join(dir, 'repos.json');
  const restore = () => {
    for (const [k, v] of [['ARW_ENV_FILE', saved.env], ['ARW_REPOS_FILE', saved.repos]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of ['ARW_PRESET', 'CODEX_EFFORT', 'ARW_MAX_CALLS', 'ARW_REVIEW_MODE', 'ARW_REPRO', 'ARW_SANDBOX', 'ARW_RUN_IMPACTED_TESTS', 'ARW_JAVA_AST', 'ARW_WORKERS']) delete process.env[k];
  };
  return Promise.resolve().then(() => fn(dir)).finally(restore);
}

const allOk = { node: true, git: true, codex: true, 'codex login': true, gh: true, 'gh auth': true, docker: true, jdk: true };
const probeWith = (ok) => (id) => ({ ok: Boolean(ok[id]), detail: ok[id] ? `${id} fine` : `${id} missing` });

test('seven essential settings (plus repositories) are flagged; everything else is advanced', () => {
  const settings = require('../src/lib/settings');
  assert.deepEqual(settings.ESSENTIAL_KEYS, ['CODEX_MODEL', 'CODEX_EFFORT', 'ARW_OUTPUT_LANGUAGE', 'ARW_WORKERS', 'ARW_MAX_CALLS', 'ARW_PR_INTENT', 'ARW_SANDBOX']);
  const rows = settings.readEnvSettings();
  for (const key of settings.ESSENTIAL_KEYS) assert.equal(rows.find((r) => r.key === key).essential, true, key);
  assert.equal(rows.filter((r) => r.essential).length, 7);
});

test('presets: fast, thorough, java-docker, with valid values, what they leave out and what they need', async () => {
  const { PRESETS } = require('../src/lib/setup');
  const settings = require('../src/lib/settings');
  assert.deepEqual(PRESETS.map((p) => p.id), ['fast', 'thorough', 'java-docker']);
  for (const p of PRESETS) {
    assert.ok(p.name && p.summary && Array.isArray(p.leavesOut) && Array.isArray(p.needs), p.id);
    await withFiles(() => assert.doesNotThrow(() => settings.writeEnvSettings(p.values), p.id));
  }
  const fast = PRESETS.find((p) => p.id === 'fast');
  assert.deepEqual([fast.values.ARW_REVIEW_MODE, fast.values.ARW_REPRO], ['single-agent', 'off']);
  assert.deepEqual(PRESETS.find((p) => p.id === 'java-docker').needs, ['docker', 'jdk']);
});

test('applying a preset writes its settings and its name; one whose tools are missing is refused unless forced', async () => {
  const { applyPreset } = require('../src/lib/setup');
  const settings = require('../src/lib/settings');
  await withFiles(() => {
    const r = applyPreset('fast', { probe: probeWith(allOk) });
    assert.deepEqual(r.preset, 'fast');
    const env = Object.fromEntries(settings.readEnvSettings().map((e) => [e.key, e.value]));
    assert.deepEqual([env.ARW_PRESET, env.ARW_REVIEW_MODE, env.ARW_REPRO, env.CODEX_EFFORT], ['fast', 'single-agent', 'off', 'low']);
    const noDocker = probeWith({ ...allOk, docker: false });
    assert.throws(() => applyPreset('java-docker', { probe: noDocker }), /needs docker/);
    assert.equal(applyPreset('java-docker', { probe: noDocker, force: true }).preset, 'java-docker');
    assert.throws(() => applyPreset('nope', { probe: probeWith(allOk) }), /unknown preset/);
  });
});

test('the environment check lists each tool, says which are required and how to fix what is missing', () => {
  const { checkEnvironment } = require('../src/lib/setup');
  const r = checkEnvironment({ probe: probeWith({ ...allOk, codex: false, 'codex login': false, jdk: false }), platform: 'win32' });
  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(byId), ['node', 'git', 'codex', 'codex login', 'gh', 'gh auth', 'docker', 'jdk']);
  assert.equal(r.ready, false, 'codex is required');
  assert.equal(byId.codex.required, true);
  assert.match(byId.codex.fix, /npm i -g @openai\/codex/);
  assert.equal(byId.jdk.required, false);
  assert.match(byId.jdk.fix, /Temurin/);
  assert.equal(byId.git.fix, null, 'nothing to fix');
  assert.equal(checkEnvironment({ probe: probeWith(allOk) }).ready, true);
  // A probe can say what fixes it (Docker installed but not running: start it).
  const stopped = checkEnvironment({ probe: (id) => (id === 'docker' ? { ok: false, detail: 'installed, daemon not running', fix: 'start Docker Desktop' } : { ok: true }) });
  assert.equal(stopped.items.find((i) => i.id === 'docker').fix, 'start Docker Desktop');
});

test('init creates .env and an empty repos.json once, never overwriting them', async () => {
  const { init, projectState } = require('../src/lib/setup');
  await withFiles((dir) => {
    assert.deepEqual(projectState(), { env: false, repos: 0, preset: null });
    assert.deepEqual(init().created, ['.env', 'repos.json']);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /arw setup/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'repos.json'), 'utf8')), { repos: {} });
    fs.writeFileSync(path.join(dir, '.env'), 'ARW_WORKERS=2\n');
    assert.deepEqual(init().created, []);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ARW_WORKERS=2\n');
  });
});

test('review defaults come from settings; flags given on the command line still apply', () => {
  const { reviewDefaults } = require('../src/lib/setup');
  assert.deepEqual(reviewDefaults({}, {}), { singleAgent: false, noRepro: false });
  assert.deepEqual(reviewDefaults({}, { ARW_REVIEW_MODE: 'single-agent', ARW_REPRO: 'off' }), { singleAgent: true, noRepro: true });
  assert.deepEqual(reviewDefaults({ singleAgent: true, noRepro: true }, {}), { singleAgent: true, noRepro: true });
});

test('arw setup: --check reports and changes nothing; --preset applies one', async () => {
  await withFiles((dir) => {
    const env = { ...process.env, ARW_ENV_FILE: path.join(dir, '.env'), ARW_REPOS_FILE: path.join(dir, 'repos.json') };
    const check = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli', 'arw.js'), 'setup', '--check'], { encoding: 'utf8', env, timeout: 120000 });
    assert.match(check.stdout, /Presets/);
    assert.match(check.stdout, /fast .*Fast/);
    assert.ok(!fs.existsSync(path.join(dir, '.env')), '--check writes nothing');
    const apply = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli', 'arw.js'), 'setup', '--preset', 'fast'], { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /ARW_PRESET=fast/);
    assert.ok(fs.existsSync(path.join(dir, 'repos.json')));
  });
});
