'use strict';
// Incident (probe, 2026-10-29, codex 0.163): with project_doc_max_bytes=0 and
// --ignore-user-config a worker still received the user's global
// ~/.codex/AGENTS.md (a persona prompt) and a skill list that included the
// reviewed checkout's .agents/skills and .codex/skills — author-controlled
// text in the developer message. Workers now run with a private CODEX_HOME
// that holds only the credentials (and, with CODEX_USE_USER_CONFIG=1, the
// config files), and with the skill list turned off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { codexArgs, prepareCodexHome, runCodex } = require('../src/lib/codex');

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(restore);
    restore();
    return r;
  } catch (err) {
    restore();
    throw err;
  }
}

function userHome() {
  const src = tmpDir('arw-codex-user-');
  fs.writeFileSync(path.join(src, 'auth.json'), '{"tokens":"user"}');
  fs.writeFileSync(path.join(src, 'AGENTS.md'), '# SYSTEM IDENTITY\n');
  fs.writeFileSync(path.join(src, 'AGENTS.override.md'), 'override\n');
  fs.writeFileSync(path.join(src, 'config.toml'), 'model = "x"\n');
  fs.writeFileSync(path.join(src, 'deepseek.config.toml'), 'model = "d"\n');
  fs.mkdirSync(path.join(src, 'skills', 'deep-research-agents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'skills', 'deep-research-agents', 'SKILL.md'), '---\nname: x\n---\n');
  return src;
}

test('every worker call turns the skill list off, with or without the user config', () => {
  for (const user of [null, '1']) {
    withEnv({ CODEX_USE_USER_CONFIG: user }, () => {
      const args = codexArgs({ cwd: '.', outFile: 'o', sandbox: 'read-only' });
      const i = args.indexOf('skills.include_instructions=false');
      assert.ok(i > 0 && args[i - 1] === '-c', args.join(' '));
    });
  }
});

test('the private home gets the credentials only: no global instructions, no skills, no config', () => {
  const source = userHome();
  const home = path.join(tmpDir('arw-codex-home-'), 'h');
  prepareCodexHome({ source, home, userConfig: false });
  assert.deepEqual(fs.readdirSync(home).sort(), ['auth.json']);
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), '{"tokens":"user"}');
});

test('with CODEX_USE_USER_CONFIG=1 the config files come along, the instructions and skills still do not', () => {
  const source = userHome();
  const home = path.join(tmpDir('arw-codex-home-'), 'h');
  prepareCodexHome({ source, home, userConfig: true });
  assert.deepEqual(fs.readdirSync(home).sort(), ['auth.json', 'config.toml', 'deepseek.config.toml']);
});

test('no auth.json (API key or BYOK provider): the home is made and nothing asks for a login', () => {
  const source = tmpDir('arw-codex-user-');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'x\n');
  const home = path.join(tmpDir('arw-codex-home-'), 'h');
  assert.doesNotThrow(() => prepareCodexHome({ source, home, userConfig: false }));
  assert.deepEqual(fs.readdirSync(home), []);
  // A missing source home is the same case.
  assert.doesNotThrow(() => prepareCodexHome({ source: path.join(source, 'missing'), home, userConfig: false }));
});

test('a copy codex refreshed in the private home is not overwritten by an older user file', () => {
  const source = userHome();
  const home = path.join(tmpDir('arw-codex-home-'), 'h');
  prepareCodexHome({ source, home, userConfig: false });
  const priv = path.join(home, 'auth.json');
  fs.writeFileSync(priv, '{"tokens":"refreshed"}');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(priv, later, later);
  prepareCodexHome({ source, home, userConfig: false });
  assert.equal(fs.readFileSync(priv, 'utf8'), '{"tokens":"refreshed"}');
  // A newer login on the user side wins.
  const newer = new Date(Date.now() + 120000);
  fs.writeFileSync(path.join(source, 'auth.json'), '{"tokens":"relogin"}');
  fs.utimesSync(path.join(source, 'auth.json'), newer, newer);
  prepareCodexHome({ source, home, userConfig: false });
  assert.equal(fs.readFileSync(priv, 'utf8'), '{"tokens":"relogin"}');
});

test('runCodex spawns codex with the private home, never the user one', async () => {
  const dir = tmpDir('arw-codex-spawn-');
  const source = userHome();
  const home = path.join(dir, 'private');
  // A stand-in codex: writes the CODEX_HOME it was given to the -o file.
  const fake = path.join(dir, 'fake-codex.js');
  fs.writeFileSync(fake, [
    "const a = process.argv.slice(2);",
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "  require('fs').writeFileSync(a[a.indexOf('-o') + 1], String(process.env.CODEX_HOME));",
    "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n');",
    "});",
  ].join('\n'));
  const res = await withEnv({ CODEX_BIN: fake, CODEX_HOME: source, CODEX_ARW_HOME: home, CODEX_USE_USER_CONFIG: null }, () =>
    runCodex({ prompt: 'p', cwd: dir, attemptDir: path.join(dir, 'attempt'), timeoutMs: 30000 }));
  assert.ok(res.ok, res.error_message);
  assert.equal(path.resolve(res.output), path.resolve(home));
  assert.ok(fs.existsSync(path.join(home, 'auth.json')));
  assert.ok(!fs.existsSync(path.join(home, 'AGENTS.md')));
});
