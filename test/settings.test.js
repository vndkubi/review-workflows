'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeRepo } = require('./helpers');

const dir = tmpDir('arw-settings-');
process.env.ARW_ENV_FILE = path.join(dir, '.env');
process.env.ARW_REPOS_FILE = path.join(dir, 'repos.json');
process.env.ARW_MCP_CONFIG = path.join(dir, 'mcp.json');

const settings = require('../src/lib/settings');
const { reposConfig } = require('../src/lib/github');

test('.env edits keep comments and order, apply to this process, and validate', () => {
  fs.writeFileSync(process.env.ARW_ENV_FILE, '# my notes\nCODEX_MODEL=gpt-5.6-luna\n\n# jira\nJIRA_URL=https://jira.example\nUNRELATED=keep me\n');
  settings.writeEnvSettings({ CODEX_MODEL: 'gpt-6-luna', ARW_WORKERS: '6', JIRA_URL: null, JIRA_PAT: 'pat-secret-1' });
  const text = fs.readFileSync(process.env.ARW_ENV_FILE, 'utf8');
  assert.match(text, /^# my notes\nCODEX_MODEL=gpt-6-luna\n/);
  assert.ok(!/JIRA_URL/.test(text), 'null removes the key');
  assert.match(text, /UNRELATED=keep me/);
  assert.match(text, /# set from the dashboard\nARW_WORKERS=6\nJIRA_PAT=pat-secret-1\n$/);
  assert.equal(process.env.CODEX_MODEL, 'gpt-6-luna');
  assert.equal(process.env.ARW_WORKERS, '6');
  assert.equal(process.env.JIRA_URL, undefined);

  const bad = (changes, re) => assert.throws(() => settings.writeEnvSettings(changes), re);
  bad({ ARW_WORKERS: '99' }, /between 1 and 8/);
  bad({ CODEX_OUTPUT_SCHEMA: 'yes' }, /0 or 1/);
  bad({ CODEX_EFFORT: 'extreme' }, /one of low, medium, high/);
  bad({ JIRA_URL: 'ftp://x' }, /http\(s\) URL/);
  bad({ CODEX_MODEL: 'x\nCODEX_USE_USER_CONFIG=1' }, /single line/);
  bad({ PATH: '/tmp' }, /not a known setting/);
  assert.match(fs.readFileSync(process.env.ARW_ENV_FILE, 'utf8'), /ARW_WORKERS=6/, 'a rejected save writes nothing');
});

test('secrets are write-only', () => {
  const env = settings.readEnvSettings();
  const pat = env.find((e) => e.key === 'JIRA_PAT');
  assert.equal(pat.set, true);
  assert.ok(!('value' in pat));
  assert.ok(!JSON.stringify(settings.readAll()).includes('pat-secret-1'));
  settings.writeEnvSettings({ JIRA_PAT: '' });
  assert.equal(process.env.JIRA_PAT, 'pat-secret-1', 'an empty secret field keeps the stored value');
  settings.writeEnvSettings({ JIRA_PAT: null });
  assert.equal(settings.readEnvSettings().find((e) => e.key === 'JIRA_PAT').set, false);
  const model = env.find((e) => e.key === 'CODEX_MODEL');
  assert.deepEqual([model.value, model.source], ['gpt-6-luna', '.env']);
});

test('repositories: owner/name, existing git checkout, one line test command', () => {
  const repo = makeRepo();
  settings.writeRepos([{ name: 'acme/shop', checkout: repo.dir, test_command: 'mvn -q test -Dtest={selector}' }]);
  assert.equal(reposConfig().repos['acme/shop'].test_command, 'mvn -q test -Dtest={selector}');
  assert.throws(() => settings.writeRepos([{ name: 'shop', checkout: repo.dir }]), /owner\/repository/);
  assert.throws(() => settings.writeRepos([{ name: 'a/b', checkout: path.join(dir, 'nope') }]), /does not exist/);
  assert.throws(() => settings.writeRepos([{ name: 'a/b', checkout: dir }]), /not a git repository/);
  assert.throws(() => settings.writeRepos([{ name: 'a/b', checkout: repo.dir }, { name: 'a/b', checkout: repo.dir }]), /listed twice/);
  // Fields the editor does not manage survive a save from the dashboard.
  const file = process.env.ARW_REPOS_FILE;
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.repos['acme/shop'].static_commands = [{ name: 'lint', command: ['mylint', '{files}'] }];
  fs.writeFileSync(file, JSON.stringify(cfg));
  settings.writeRepos([{ name: 'acme/shop', checkout: repo.dir }]);
  assert.deepEqual(reposConfig().repos['acme/shop'].static_commands, [{ name: 'lint', command: ['mylint', '{files}'] }]);
  assert.equal(reposConfig().repos['acme/shop'].test_command, undefined, 'a cleared test command is removed');
});

test('MCP config: stdio or http, secrets only as ${NAME}, tool mapping validated', () => {
  assert.throws(() => settings.writeMcp({ transport: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer abc123' } }), /reference it as \$\{NAME\}/);
  settings.writeMcp({ transport: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer ${ATLASSIAN_MCP_TOKEN}' }, tools: { issue: { name: 'getJiraIssue', args: { issueIdOrKey: '{key}' } }, search: null } });
  const saved = settings.readMcp();
  assert.equal(saved.tools.issue.name, 'getJiraIssue');
  assert.equal(saved.tools.search, null);
  assert.throws(() => settings.writeMcp({ transport: 'stdio', args: ['x'] }), /command is required/);
  assert.throws(() => settings.writeMcp({ transport: 'stdio', command: 'docker', tools: { other: { name: 'x' } } }), /only issue, page, search/);
  settings.writeMcp(null);
  assert.equal(settings.readMcp(), null);
});
