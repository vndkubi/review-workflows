'use strict';
// A model worker reads untrusted PR code. It gets an allowlist of the host
// environment, never the dashboard's Jira/GitHub/Confluence credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

const { workerEnv } = require('../src/lib/worker-env');

const SECRETS = {
  JIRA_PAT: 'jira-secret',
  GITHUB_TOKEN: 'github-secret',
  GH_TOKEN: 'gh-secret',
  CONFLUENCE_TOKEN: 'confluence-secret',
  JIRA_API_TOKEN: 'jira-api-secret',
  CONFLUENCE_API_TOKEN: 'confluence-api-secret',
};

function withEnv(vars, fn) {
  const before = {};
  for (const key of Object.keys(vars)) {
    before[key] = process.env[key];
    if (vars[key] == null) delete process.env[key];
    else process.env[key] = vars[key];
  }
  const restore = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out);
}

function fakeCodex(dir, envFile) {
  const file = path.join(dir, 'fake-codex.js');
  fs.writeFileSync(file, [
    "'use strict';",
    `const fs = require('node:fs');`,
    `const out = ${JSON.stringify(envFile)};`,
    "const args = process.argv.slice(2);",
    "let stdin = ''; process.stdin.on('data', (d) => { stdin += d; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(out, JSON.stringify(process.env));",
    "  const o = args[args.indexOf('-o') + 1]; if (o) fs.writeFileSync(o, 'ok');",
    "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }) + '\\n');",
    "});",
  ].join('\n'));
  return file;
}

function fakeCopilot(dir, envFile) {
  const file = path.join(dir, 'fake-copilot.js');
  fs.writeFileSync(file, [
    "'use strict';",
    `const fs = require('node:fs');`,
    `const out = ${JSON.stringify(envFile)};`,
    "let stdin = ''; process.stdin.on('data', (d) => { stdin += d; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(out, JSON.stringify(process.env));",
    "  process.stdout.write(JSON.stringify({ type: 'assistant.message', data: { content: 'ok' } }) + '\\n');",
    "  process.stdout.write(JSON.stringify({ type: 'result', exitCode: 0 }) + '\\n');",
    "});",
  ].join('\n'));
  return file;
}

test('the shared allowlist keeps system, locale, proxy and provider variables only', () => {
  const env = workerEnv({
    home: '/private/codex',
    source: {
      PATH: '/bin', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', PATHEXT: '.EXE',
      HOME: '/home/person', USERPROFILE: 'C:\\Users\\person', APPDATA: 'C:\\Users\\person\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local', TEMP: 'C:\\Temp', TMP: 'C:\\Temp',
      LANG: 'en_US.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy', OPENAI_API_KEY: 'key',
      CODEX_HOME: '/home/person/.codex', JIRA_PAT: 'jira', GITHUB_TOKEN: 'github', GH_TOKEN: 'gh',
      CONFLUENCE_TOKEN: 'confluence', CONFLUENCE_API_TOKEN: 'confluence-api',
    },
  });
  for (const key of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'OPENAI_API_KEY']) assert.ok(key in env, key);
  assert.equal(env.CODEX_HOME, '/private/codex');
  for (const key of ['JIRA_PAT', 'GITHUB_TOKEN', 'GH_TOKEN', 'CONFLUENCE_TOKEN', 'CONFLUENCE_API_TOKEN']) assert.equal(env[key], undefined, key);
});

test('codex gets PATH and its provider key, never Jira/GitHub/Confluence secrets', async () => {
  const { runCodex } = require('../src/lib/codex');
  const dir = tmpDir('arw-worker-env-codex-');
  const envFile = path.join(dir, 'env.json');
  const fake = fakeCodex(dir, envFile);
  const vars = {
    ...SECRETS,
    CODEX_BIN: fake,
    CODEX_ARW_HOME: path.join(dir, 'codex-home'),
    CODEX_HOME: path.join(dir, 'user-codex'),
    OPENAI_API_KEY: 'provider-key',
  };
  const res = await withEnv(vars, () => runCodex({ prompt: 'p', cwd: dir, attemptDir: path.join(dir, 'attempt'), timeoutMs: 30000 }));
  assert.ok(res.ok, res.error_message);
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  for (const key of Object.keys(SECRETS)) assert.equal(env[key], undefined, `${key} reached codex`);
  assert.equal(env.OPENAI_API_KEY, 'provider-key');
  assert.equal(env.CODEX_HOME, path.join(dir, 'codex-home'));
  assert.ok(env.PATH || env.Path);
});

test('copilot gets PATH and its home, never Jira/GitHub/Confluence secrets', async () => {
  const { runCopilot } = require('../src/lib/copilot');
  const dir = tmpDir('arw-worker-env-copilot-');
  const envFile = path.join(dir, 'env.json');
  const fake = fakeCopilot(dir, envFile);
  const vars = {
    ...SECRETS,
    COPILOT_BIN: fake,
    COPILOT_ARW_HOME: path.join(dir, 'copilot-home'),
    OPENAI_API_KEY: 'provider-key',
  };
  const res = await withEnv(vars, () => runCopilot({ prompt: 'p', cwd: dir, attemptDir: path.join(dir, 'attempt'), timeoutMs: 30000 }));
  assert.ok(res.ok, res.error_message);
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  for (const key of Object.keys(SECRETS)) assert.equal(env[key], undefined, `${key} reached copilot`);
  assert.equal(env.OPENAI_API_KEY, 'provider-key');
  assert.equal(env.COPILOT_HOME, path.join(dir, 'copilot-home'));
  assert.ok(env.PATH || env.Path);
});

test('copilot keeps COPILOT_GITHUB_TOKEN, its documented sign-in; codex does not get it', () => {
  const source = { PATH: '/bin', COPILOT_GITHUB_TOKEN: 'copilot-sign-in', GITHUB_TOKEN: 'github', GH_TOKEN: 'gh' };
  const copilot = workerEnv({ home: '/private/copilot', homeKey: 'COPILOT_HOME', source });
  assert.equal(copilot.COPILOT_GITHUB_TOKEN, 'copilot-sign-in');
  assert.equal(copilot.GITHUB_TOKEN, undefined);
  assert.equal(copilot.GH_TOKEN, undefined);
  const codex = workerEnv({ home: '/private/codex', homeKey: 'CODEX_HOME', source });
  assert.equal(codex.COPILOT_GITHUB_TOKEN, undefined);
});

test('toolchain and Windows/Unix session variables reach the worker shell', () => {
  const env = workerEnv({
    source: {
      JAVA_HOME: 'C:\jdk', MAVEN_HOME: 'C:\mvn', M2_HOME: 'C:\mvn', GRADLE_USER_HOME: 'C:\g', VIRTUAL_ENV: '/venv',
      USERNAME: 'person', USERDOMAIN: 'box', ProgramFiles: 'C:\Program Files', ProgramData: 'C:\ProgramData',
      PSModulePath: 'C:\ps', NUMBER_OF_PROCESSORS: '8', USER: 'person', SHELL: '/bin/bash', TERM: 'xterm',
      JIRA_PAT: 'jira',
    },
  });
  for (const key of ['JAVA_HOME', 'MAVEN_HOME', 'M2_HOME', 'GRADLE_USER_HOME', 'VIRTUAL_ENV', 'USERNAME', 'USERDOMAIN', 'ProgramFiles', 'ProgramData', 'PSModulePath', 'NUMBER_OF_PROCESSORS', 'USER', 'SHELL', 'TERM']) assert.ok(key in env, key);
  assert.equal(env.JIRA_PAT, undefined);
});

test('a BYOK provider key named by env_key in the copied codex config reaches codex', async () => {
  const { runCodex } = require('../src/lib/codex');
  const dir = tmpDir('arw-worker-env-byok-');
  const user = path.join(dir, 'user-codex');
  fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'config.toml'), '[model_providers.deepseek]\nname = "DeepSeek"\nbase_url = "https://api.example"\nenv_key = "DEEPSEEK_API_KEY"\n');
  const envFile = path.join(dir, 'env.json');
  const vars = {
    ...SECRETS,
    CODEX_BIN: fakeCodex(dir, envFile),
    CODEX_ARW_HOME: path.join(dir, 'codex-home'),
    CODEX_HOME: user,
    CODEX_USE_USER_CONFIG: '1',
    DEEPSEEK_API_KEY: 'byok-key',
  };
  const res = await withEnv(vars, () => runCodex({ prompt: 'p', cwd: dir, attemptDir: path.join(dir, 'attempt'), timeoutMs: 30000 }));
  assert.ok(res.ok, res.error_message);
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  assert.equal(env.DEEPSEEK_API_KEY, 'byok-key');
  for (const key of Object.keys(SECRETS)) assert.equal(env[key], undefined, `${key} reached codex`);
});

test('ARW_WORKER_ENV names extra variables a person chose to pass', () => {
  const env = workerEnv({ source: { CORP_CA_BUNDLE: '/ca.pem', OTHER: 'x', ARW_WORKER_ENV: 'CORP_CA_BUNDLE, MISSING' } });
  assert.equal(env.CORP_CA_BUNDLE, '/ca.pem');
  assert.equal(env.OTHER, undefined);
});
