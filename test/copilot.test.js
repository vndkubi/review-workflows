'use strict';
// GitHub Copilot CLI as the worker (ARW_EXECUTOR=copilot). Every case comes
// from a probe against copilot 1.0.88 (2026-10-19): the JSONL fixtures are
// those sessions, trimmed. What the probes showed:
// - AGENTS.md and .github/copilot-instructions.md of the checkout reach the
//   system prompt unless --no-custom-instructions, and no event says so;
// - without the experimental sandbox the permission layer is the only
//   boundary: it denied `; Remove-Item`, `>` and `| Out-File`, but let
//   `git diff --output=out2.txt` write a file;
// - a sandbox policy path that did not resolve left the working directory
//   writable while every event still said "sandboxed": true;
// - token counts are only in --usage-output-file, never in the stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');
const copilot = require('../src/lib/copilot');

const FIX = path.join(__dirname, 'fixtures', 'copilot');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

test('copilot args: no author instructions, no auto-update, no write tools, never all permissions', () => {
  withEnv({ COPILOT_SANDBOX: null, CODEX_EFFORT: null }, () => {
    const args = copilot.copilotArgs({ model: 'deepseek-flash', usageFile: 'u.json', platform: 'win32' });
    const s = args.join(' ');
    for (const flag of ['--no-custom-instructions', '--no-auto-update', '--disable-builtin-mcps', '--no-ask-user', '--output-format json']) assert.ok(s.includes(flag), `${flag} missing: ${s}`);
    for (const flag of ['--allow-all-tools', '--allow-all', '--yolo', '--allow-all-paths', '--allow-all-urls', '--experimental']) assert.ok(!args.includes(flag), `${flag} present: ${s}`);
    const tools = args.slice(args.indexOf('--available-tools') + 1, args.findIndex((a, i) => i > args.indexOf('--available-tools') && a.startsWith('--')));
    for (const t of ['create', 'edit', 'web_fetch', 'task', 'sql', 'skill', 'write_agent']) assert.ok(!tools.includes(t), `${t} available`);
    assert.ok(tools.includes('powershell') && tools.includes('view'));
    assert.ok(args.includes('--deny-tool') && args[args.indexOf('--deny-tool') + 1] === 'write');
    // Without the sandbox the shell is an allowlist of read commands, never all of it.
    const allowed = args.slice(args.indexOf('--allow-tool') + 1, args.findIndex((a, i) => i > args.indexOf('--allow-tool') && a.startsWith('--')));
    assert.ok(!allowed.includes('shell'), 'bare shell allowed without a sandbox');
    assert.ok(allowed.includes('shell(git show)') && allowed.includes('shell(Get-Content)'));
    for (const a of allowed) assert.ok(!/Remove-Item|Set-Content|Out-File|ForEach-Object|Where-Object|Invoke|sed|sort|uniq|rg\)|find\)/.test(a), `${a} can write or run code`);
    assert.equal(args[args.indexOf('--model') + 1], 'deepseek-flash');
    assert.ok(!args.includes('-p'), 'the prompt goes on stdin (Windows argv limits)');
  });
});

test('copilot args: effort and images; managed never sends an effort', () => {
  withEnv({ CODEX_EFFORT: null }, () => {
    const args = copilot.copilotArgs({ model: 'm', effort: 'high', images: ['a.png', 'b.png'], usageFile: 'u.json' });
    assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'high');
    assert.deepEqual(args.flatMap((a, i) => (a === '--attachment' ? [args[i + 1]] : [])), ['a.png', 'b.png']);
  });
  withEnv({ CODEX_EFFORT: 'managed' }, () => {
    assert.ok(!copilot.copilotArgs({ model: 'm', effort: 'high', usageFile: 'u.json' }).includes('--reasoning-effort'));
  });
});

test('copilot args: with COPILOT_SANDBOX=1 the OS sandbox holds the line, so the shell is open', () => {
  withEnv({ COPILOT_SANDBOX: '1' }, () => {
    const args = copilot.copilotArgs({ model: 'm', usageFile: 'u.json', platform: 'win32' });
    assert.ok(args.includes('--experimental'));
    assert.ok(args.slice(args.indexOf('--allow-tool') + 1).includes('shell'));
  });
});

test('sandbox policy: every path absolute and existing; an empty one is refused (it opened the sandbox)', () => {
  const dir = tmpDir();
  const s = copilot.sandboxSettings({ readonly: [dir] });
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.addCurrentWorkingDirectory, false);
  assert.equal(s.sandbox.allowBypass, false);
  assert.equal(s.sandbox.userPolicy.network.allowOutbound, false);
  assert.deepEqual(s.sandbox.userPolicy.filesystem.readonlyPaths, [path.resolve(dir)]);
  assert.equal(s.disableAllHooks, true);
  assert.throws(() => copilot.sandboxSettings({ readonly: [''] }), /sandbox path/);
  assert.throws(() => copilot.sandboxSettings({ readonly: [path.join(dir, 'missing')] }), /sandbox path/);
});

test('events: final message, turns and shell commands of a real session', () => {
  const s = copilot.summarizeCopilotEvents(fixture('canary-read.jsonl'));
  assert.equal(s.output, 'arw-canary-1595331674');
  assert.equal(s.exitCode, 0);
  assert.deepEqual(s.errors, []);
  assert.equal(s.commands, 1);
  assert.equal(s.turns, 2);
  assert.deepEqual(s.violations, []);
});

test('usage comes from the usage file, in codex field names', () => {
  const u = copilot.usageFromFile(JSON.parse(fixture('canary-read.usage.json')));
  assert.deepEqual(u, { input_tokens: 23171, cached_input_tokens: 11392, output_tokens: 105, reasoning_output_tokens: 21 });
  assert.deepEqual(copilot.usageFromFile(null), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
});

test('a rejected model name is configuration, not a flaky model', () => {
  const s = copilot.summarizeCopilotEvents(fixture('model-rejected.jsonl'));
  assert.equal(s.exitCode, 1);
  assert.equal(s.errors.length, 1);
  assert.equal(copilot.classifyCopilot(s), 'config');
  assert.equal(copilot.classifyCopilot({ errors: ['x'], statusCodes: [429] }), 'rate_limit');
  assert.equal(copilot.classifyCopilot({ errors: ['x'], statusCodes: [401] }), 'auth');
  // Seen with GitHub routing: no event, only this on stderr, exit 1.
  assert.equal(copilot.classifyCopilot({ errors: ['Error: Model "gpt-6-luna" from --model flag is not available.'] }), 'config');
});

test('the write that got past the allowlist is a violation: git diff --output', () => {
  const s = copilot.summarizeCopilotEvents(fixture('allowlist-bypass.jsonl'));
  assert.deepEqual(s.violations.map((v) => v.command), ['git diff --output=out2.txt']);
  // Commands the permission layer denied never ran: not violations.
  for (const c of ['Get-Content canary.txt; Remove-Item victim.txt', 'Remove-Item victim.txt']) assert.ok(!s.violations.some((v) => v.command === c));
  assert.deepEqual(copilot.commandViolations(['git log --output=x', 'git show --ext-diff HEAD', 'git -c core.pager=x log', 'git grep -O vim foo', 'git show HEAD:a.txt']).map((v) => v.command), ['git log --output=x', 'git show --ext-diff HEAD', 'git -c core.pager=x log', 'git grep -O vim foo']);
});

test('sandboxed session: the denied write is recorded, the read still ran', () => {
  const s = copilot.summarizeCopilotEvents(fixture('sandbox-write-denied.jsonl'));
  assert.equal(s.sandboxed, true);
  assert.equal(s.commands, 2);
  assert.match(s.output, /denied|Access/i);
});

function fakeEnv(dir, extra = {}) {
  return {
    COPILOT_BIN: path.join(__dirname, 'fixtures', 'fake-copilot.js'),
    COPILOT_ARW_HOME: path.join(dir, 'home'),
    FAKE_COPILOT_EVENTS: path.join(FIX, 'canary-read.jsonl'),
    FAKE_COPILOT_USAGE: path.join(FIX, 'canary-read.usage.json'),
    FAKE_COPILOT_RECORD: path.join(dir, 'record.json'),
    FAKE_COPILOT_TOUCH: null,
    COPILOT_SANDBOX: null,
    ...extra,
  };
}

function gitRepo() {
  const repo = tmpDir('arw-copilot-repo-');
  sh(repo, ['init', '-q']);
  write(repo, 'a.txt', 'a\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-qm', 'init']);
  return repo;
}

test('runCopilot: prompt on stdin, isolated home without hooks, result in the codex shape', async () => {
  const dir = tmpDir();
  const repo = gitRepo();
  await withEnv(fakeEnv(dir), async () => {
    const res = await copilot.runCopilot({ prompt: 'read canary', cwd: repo, attemptDir: path.join(dir, 'a1'), model: 'deepseek-flash' });
    assert.equal(res.ok, true, res.error_message);
    assert.equal(res.output, 'arw-canary-1595331674');
    assert.equal(res.usage.input_tokens, 23171);
    assert.equal(res.commands, 1);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
    assert.equal(rec.stdin, 'read canary');
    assert.equal(path.resolve(rec.home), path.resolve(dir, 'home'));
    assert.equal(path.resolve(rec.cwd), path.resolve(repo));
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'home', 'settings.json'), 'utf8'));
    assert.equal(settings.disableAllHooks, true);
    assert.ok(!settings.sandbox, 'no sandbox block unless COPILOT_SANDBOX=1');
    assert.ok(fs.existsSync(path.join(dir, 'a1', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'a1', 'last-message.txt')));
  });
});

test('runCopilot: a worker that changed the checkout fails the job as integrity', async () => {
  const dir = tmpDir();
  const repo = gitRepo();
  await withEnv(fakeEnv(dir, { FAKE_COPILOT_TOUCH: 'out2.txt' }), async () => {
    const res = await copilot.runCopilot({ prompt: 'p', cwd: repo, attemptDir: path.join(dir, 'a1') });
    assert.equal(res.ok, false);
    assert.equal(res.error_class, 'integrity');
    assert.match(res.error_message, /out2\.txt/);
  });
});

test('runCopilot: a forbidden command in the session fails the job as integrity', async () => {
  const dir = tmpDir();
  const repo = gitRepo();
  await withEnv(fakeEnv(dir, { FAKE_COPILOT_EVENTS: path.join(FIX, 'allowlist-bypass.jsonl') }), async () => {
    const res = await copilot.runCopilot({ prompt: 'p', cwd: repo, attemptDir: path.join(dir, 'a1') });
    assert.equal(res.error_class, 'integrity');
    assert.match(res.error_message, /git diff --output=out2\.txt/);
  });
});

test('runCopilot: a model the provider rejects is config', async () => {
  const dir = tmpDir();
  const repo = gitRepo();
  await withEnv(fakeEnv(dir, { FAKE_COPILOT_EVENTS: path.join(FIX, 'model-rejected.jsonl'), FAKE_COPILOT_USAGE: null }), async () => {
    const res = await copilot.runCopilot({ prompt: 'p', cwd: repo, attemptDir: path.join(dir, 'a1') });
    assert.equal(res.ok, false);
    assert.equal(res.error_class, 'config');
    assert.match(res.error_message, /DeepSeek-V4\.1-Flash/);
  });
});

test('an integrity failure blocks a loose job instead of being retried', async () => {
  const { runLooseJob } = require('../src/lib/loose-job');
  let calls = 0;
  const executor = async () => { calls += 1; return { ok: false, output: null, error_class: 'integrity', error_message: 'checkout changed: out2.txt' }; };
  const res = await runLooseJob({ executor, label: 'x', workDir: tmpDir(), cwd: '.', buildPrompt: () => 'p', validate: () => [] });
  assert.equal(res.blocked, true);
  assert.equal(calls, 1);
});

test('the execution manifest names copilot, its sandbox and version, so results are not mixed with codex', () => {
  const { executionManifest } = require('../src/lib/freeze');
  withEnv({ ARW_EXECUTOR: 'copilot', ARW_EXECUTOR_MODULE: null, COPILOT_SANDBOX: null, COPILOT_BIN: path.join(__dirname, 'fixtures', 'fake-copilot.js') }, () => {
    const m = executionManifest();
    assert.match(m.executor, /^copilot@/);
    assert.equal(m.executor_sandbox, 'allowlist');
    assert.equal(m.output_schema, false);
  });
  withEnv({ ARW_EXECUTOR: null, ARW_EXECUTOR_MODULE: null }, () => {
    const m = executionManifest();
    assert.equal(m.executor, 'codex');
    assert.ok(!('executor_sandbox' in m), 'codex manifests stay as they were');
  });
});
