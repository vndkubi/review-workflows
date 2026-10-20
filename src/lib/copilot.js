'use strict';
// GitHub Copilot CLI executor (ARW_EXECUTOR=copilot), same contract as
// runCodex. Measured with copilot 1.0.88 (probes, 2026-10-19; the sessions
// are test/fixtures/copilot):
// - the prompt goes in on stdin; the final message is the last
//   assistant.message of the --output-format json stream;
// - AGENTS.md and .github/copilot-instructions.md of the working directory
//   reach the system prompt unless --no-custom-instructions, and no event
//   says so: the flag is the only guard, so it is always passed;
// - no structured output: outputSchema is ignored and the repair loop keeps
//   the JSON valid;
// - token counts are only in --usage-output-file, never in the stream;
// - repo hooks, skills, plugins and MCP servers load from a trusted folder:
//   copilot runs with its own COPILOT_HOME (hooks off), never the user's.
// Read-only has two modes. Default (allowlist): only read tools and an
// allowlist of read commands; the permission layer denied `; Remove-Item`,
// `>` and `| Out-File`, but let `git diff --output=f` write a file. So every
// command that ran is checked for write and exec flags, and the checkout is
// compared before and after: either one fails the job as 'integrity'.
// COPILOT_SANDBOX=1: the experimental OS sandbox (MXC) makes the working
// directory read-only and the shell is open, as with codex. A policy path
// that did not resolve left the directory writable while every event said
// "sandboxed": true, so the sandbox is proven by a write canary in
// preflight, never assumed.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, envInt, writeJsonAtomic, readJsonIfExists } = require('./util');
const { redactSecrets } = require('./guard');
const { classifyError, killTree } = require('./codex');

function resolveCopilot() {
  // COPILOT_BIN: the npm package's JS entry (run with this node) or a
  // standalone binary (run as it is).
  if (process.env.COPILOT_BIN) return /\.[cm]?js$/i.test(process.env.COPILOT_BIN) ? { cmd: process.execPath, pre: [process.env.COPILOT_BIN] } : { cmd: process.env.COPILOT_BIN, pre: [] };
  if (process.platform === 'win32') {
    // npm installs a .cmd shim that cannot be spawned without a shell.
    const js = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@github', 'copilot', 'npm-loader.js');
    if (fs.existsSync(js)) return { cmd: process.execPath, pre: [js] };
  }
  return { cmd: 'copilot', pre: [] };
}

const sandboxed = () => process.env.COPILOT_SANDBOX === '1';

// Tools the model can see. Not: create, edit, web_fetch, task (subagents),
// sql, skill, write_agent.
function readTools(platform) {
  const shell = platform === 'win32' ? 'powershell' : 'bash';
  return [shell, `read_${shell}`, `list_${shell}`, 'view', 'grep', 'glob'];
}

// Commands that only read, by the stem copilot matches on. Left out on
// purpose: anything taking a script block (ForEach-Object, Where-Object) or
// an output file (sort -o, uniq IN OUT), sed (-i), find (-delete), rg (--pre
// runs a command).
const GIT_READ = ['git show', 'git diff', 'git log', 'git blame', 'git ls-files', 'git ls-tree', 'git rev-parse', 'git cat-file', 'git status', 'git merge-base'];
const PS_READ = ['Get-Content', 'Select-String', 'Get-ChildItem', 'Get-Item', 'Test-Path', 'Resolve-Path', 'Get-FileHash', 'Select-Object', 'Measure-Object', 'Sort-Object', 'Group-Object', 'ConvertFrom-Json', 'Format-List', 'Format-Table', 'Out-String', 'Write-Output'];
const SH_READ = ['cat', 'head', 'tail', 'grep', 'ls', 'wc', 'nl', 'cut', 'stat', 'file'];

function allowedCommands(platform) {
  return [...GIT_READ, ...(platform === 'win32' ? PS_READ : SH_READ)].map((c) => `shell(${c})`);
}

function copilotArgs({ model, effort, images = [], usageFile, platform = process.platform, addDirs = [] }) {
  const args = ['--no-auto-update', '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user', '--no-remote', '--no-color', '--output-format', 'json', '--usage-output-file', usageFile];
  if (sandboxed()) args.push('--experimental');
  args.push('--available-tools', ...readTools(platform));
  args.push('--allow-tool', ...(sandboxed() ? ['shell'] : allowedCommands(platform)));
  args.push('--deny-tool', 'write', 'url');
  for (const d of addDirs) args.push('--add-dir', d);
  for (const img of images) args.push('--attachment', img);
  if (model) args.push('--model', model);
  // CODEX_EFFORT=managed: the provider's own default applies.
  if (effort && effort !== 'managed' && process.env.CODEX_EFFORT !== 'managed') args.push('--reasoning-effort', effort);
  return args;
}

// settings.json of the private COPILOT_HOME. Every sandbox path must exist:
// one that did not resolve opened the sandbox.
function sandboxSettings({ readonly = [] } = {}) {
  const base = { disableAllHooks: true, autoUpdate: false };
  if (!readonly.length) return base;
  const paths = readonly.map((p) => {
    if (!p || !fs.existsSync(p)) throw new Error(`sandbox path does not exist: "${p}"`);
    return path.resolve(p);
  });
  return {
    ...base,
    sandbox: {
      enabled: true,
      addCurrentWorkingDirectory: false,
      allowDevToolAccess: false,
      allowBypass: false,
      auth: { git: false, gh: false },
      userPolicy: { filesystem: { readonlyPaths: [...new Set(paths)] }, network: { allowOutbound: false, allowLocalNetwork: false } },
    },
  };
}

function copilotHome() {
  return process.env.COPILOT_ARW_HOME ? path.resolve(process.env.COPILOT_ARW_HOME) : path.join(require('./runs').RUNS, '.copilot-home');
}

function prepareHome(cwd) {
  const home = ensureDir(copilotHome());
  const settings = sandboxed() ? sandboxSettings({ readonly: [require('./runs').RUNS, cwd].filter((p) => fs.existsSync(p)) }) : sandboxSettings();
  const file = path.join(home, 'settings.json');
  if (JSON.stringify(readJsonIfExists(file, null)) !== JSON.stringify(settings)) writeJsonAtomic(file, settings);
  return home;
}

// Write and exec flags a read command can carry; the permission layer
// matches the command stem only.
const VIOLATIONS = [
  ['writes a file', /(^|\s)--output(=|\s|$)/],
  ['runs an external diff', /(^|\s)--ext-diff\b/],
  ['runs a pager command', /(^|\s)--open-files-in-pager\b|\bgit\s+grep\b[^|;]*\s-O/],
  ['overrides git config', /\bgit\s+(-c|--config-env|--exec-path)\b/],
];

function commandViolations(commands) {
  const out = [];
  for (const command of commands) {
    const hit = VIOLATIONS.find(([, re]) => re.test(command));
    if (hit) out.push({ command, rule: hit[0] });
  }
  return out;
}

function summarizeCopilotEvents(jsonl) {
  let output = null;
  let exitCode = null;
  let turns = 0;
  let commands = 0;
  let isSandboxed = false;
  const errors = [];
  const statusCodes = [];
  const ran = [];
  const started = new Map();
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const d = ev.data || {};
    if (ev.type === 'assistant.message' && String(d.content || '').trim()) output = d.content;
    else if (ev.type === 'assistant.turn_end') turns += 1;
    else if (ev.type === 'session.error') {
      errors.push(d.message || 'session error');
      if (d.statusCode) statusCodes.push(d.statusCode);
    } else if (ev.type === 'tool.execution_start') started.set(d.toolCallId, d.arguments && d.arguments.command);
    else if (ev.type === 'tool.execution_complete') {
      if (d.sandboxed) isSandboxed = true;
      // Only commands that ran: a denied one has no shellExecution.
      if (d.shellExecution) {
        commands += 1;
        const cmd = started.get(d.toolCallId);
        if (cmd) ran.push(cmd);
      }
    } else if (ev.type === 'result') exitCode = ev.exitCode;
  }
  return { output, exitCode, turns, commands, errors, statusCodes, ran, violations: commandViolations(ran), sandboxed: isSandboxed };
}

function classifyCopilot({ errors = [], statusCodes = [] }) {
  const code = statusCodes[statusCodes.length - 1];
  if (code === 400 || code === 404 || code === 422) return 'config';
  if (code === 401 || code === 403) return 'auth';
  if (code === 402) return 'billing';
  if (code === 429) return 'rate_limit';
  // A model the login does not offer: stderr only, no event.
  if (/\bmodel\b.*\bis not available\b/i.test(errors.join('\n'))) return 'config';
  return classifyError(errors.join('\n'));
}

function usageFromFile(data) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const m of Object.values((data && data.modelMetrics) || {})) {
    const u = m.usage || {};
    usage.input_tokens += Number(u.inputTokens) || 0;
    usage.cached_input_tokens += Number(u.cacheReadTokens) || 0;
    usage.output_tokens += Number(u.outputTokens) || 0;
    usage.reasoning_output_tokens += Number(u.reasoningTokens) || 0;
  }
  return usage;
}

// The checkout as git sees it (HEAD and every changed or untracked path);
// null outside a git work tree.
function checkoutState(cwd) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return { head, entries: status.split('\0').filter(Boolean) };
  } catch {
    return null;
  }
}

function checkoutChanges(before, after) {
  if (!before || !after) return [];
  const out = [];
  if (before.head !== after.head) out.push(`HEAD ${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)}`);
  const was = new Set(before.entries);
  const now = new Set(after.entries);
  for (const e of now) if (!was.has(e)) out.push(e.trim());
  for (const e of was) if (!now.has(e)) out.push(`reverted: ${e.trim()}`);
  return out;
}

// Returns the runCodex result shape. Never throws for model-side failures.
function runCopilot({ prompt: rawPrompt, cwd, attemptDir, model, effort, timeoutMs, images = [] }) {
  ensureDir(attemptDir);
  const { text: prompt, redactions } = redactSecrets(rawPrompt);
  const outFile = path.join(attemptDir, 'last-message.txt');
  const eventsFile = path.join(attemptDir, 'events.jsonl');
  const stderrFile = path.join(attemptDir, 'stderr.txt');
  const usageFile = path.join(attemptDir, 'usage.json');
  fs.writeFileSync(path.join(attemptDir, 'prompt.txt'), prompt);
  for (const f of [outFile, usageFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const started = Date.now();
  const base = { exit_code: null, elapsed_ms: 0, usage: usageFromFile(null), turns: 0, commands: 0, model: model || null, prompt_bytes: Buffer.byteLength(prompt), redactions: redactions.reduce((n, r) => n + r.count, 0) };
  let home;
  try {
    home = prepareHome(cwd);
  } catch (err) {
    return Promise.resolve({ ...base, ok: false, output: null, error_class: 'config', error_message: err.message });
  }
  const { cmd, pre } = resolveCopilot();
  const runs = require('./runs').RUNS;
  const addDirs = fs.existsSync(runs) && !path.resolve(cwd).startsWith(path.resolve(runs)) ? [runs] : [];
  const args = [...pre, ...copilotArgs({ model, effort, images, usageFile, addDirs })];
  const limit = timeoutMs || envInt('CODEX_TIMEOUT_MS', 30 * 60 * 1000);
  const before = checkoutState(cwd);

  return new Promise((resolve) => {
    const events = fs.createWriteStream(eventsFile);
    const stderr = fs.createWriteStream(stderrFile);
    let stdoutText = '';
    let stderrText = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: 'false', COPILOT_ALLOW_ALL: '' }, windowsHide: true, detached: process.platform !== 'win32' });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit);
    child.stdout.on('data', (d) => {
      events.write(d);
      stdoutText += d;
    });
    child.stderr.on('data', (d) => {
      stderr.write(d);
      if (stderrText.length < 200000) stderrText += d;
    });
    let done = false;
    const finish = (exitCode, spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      events.end();
      stderr.end();
      const s = summarizeCopilotEvents(stdoutText);
      if (s.output != null) fs.writeFileSync(outFile, s.output);
      const changed = checkoutChanges(before, checkoutState(cwd));
      let errorClass = null;
      let errorMessage = null;
      if (changed.length || s.violations.length) {
        errorClass = 'integrity';
        errorMessage = [
          ...s.violations.map((v) => `forbidden command (${v.rule}): ${v.command}`),
          ...(changed.length ? [`the worker changed the checkout: ${changed.slice(0, 10).join(', ')}`] : []),
        ].join(' | ');
      } else if (timedOut) {
        errorClass = 'timeout';
        errorMessage = `killed after ${limit} ms`;
      } else if (spawnError) {
        errorClass = 'spawn';
        errorMessage = spawnError.message;
      } else if (exitCode !== 0 || s.errors.length) {
        errorMessage = s.errors.join(' | ') || stderrText.trim().split('\n').slice(-3).join(' | ') || `exit ${exitCode}`;
        errorClass = classifyCopilot({ errors: s.errors.length ? s.errors : [errorMessage, stderrText], statusCodes: s.statusCodes });
      }
      resolve({
        ...base,
        ok: !errorClass && s.output != null,
        output: s.output,
        exit_code: exitCode,
        elapsed_ms: Date.now() - started,
        usage: usageFromFile(readJsonIfExists(usageFile, null)),
        turns: s.turns,
        commands: s.commands,
        error_class: errorClass,
        error_message: errorMessage,
      });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code, null));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// Fail fast before any real job: the worker must read a file with a shell
// command, and with COPILOT_SANDBOX=1 a write it attempts must be refused by
// the sandbox (a sandbox reporting itself on proves nothing).
async function preflight({ cwd, attemptDir, model }) {
  ensureDir(attemptDir);
  const token = `arw-canary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const canaryDir = ensureDir(path.join(attemptDir, 'canary'));
  fs.writeFileSync(path.join(canaryDir, 'canary.txt'), `${token}\n`);
  const writeFile = 'arw-write-canary.txt';
  if (fs.existsSync(path.join(canaryDir, writeFile))) fs.unlinkSync(path.join(canaryDir, writeFile));
  const writeCmd = process.platform === 'win32' ? `Set-Content -Path ${writeFile} -Value x` : `echo x > ${writeFile}`;
  const prompt = sandboxed()
    ? `This is a harness self-test. First run exactly this shell command once and ignore whether it fails: ${writeCmd}\nThen use a shell command to read the file canary.txt in the working directory. Reply with exactly its first line and nothing else.`
    : 'Use a shell command to read the file canary.txt in the working directory. Reply with exactly its first line and nothing else.';
  const res = await runCopilot({ prompt, cwd: canaryDir, attemptDir, model, effort: process.env.CODEX_EFFORT === 'managed' ? null : 'low', timeoutMs: 180000 });
  if (!res.ok) return { ok: false, error_class: res.error_class, error_message: res.error_message };
  if (!res.output.includes(token)) {
    return { ok: false, error_class: 'tools', error_message: `the worker could not read a file with a shell command (replied: ${res.output.trim().slice(0, 160)}); check the copilot model supports tool calls` };
  }
  if (sandboxed()) {
    const s = summarizeCopilotEvents(fs.readFileSync(path.join(attemptDir, 'events.jsonl'), 'utf8'));
    if (fs.existsSync(path.join(canaryDir, writeFile))) return { ok: false, error_class: 'sandbox', error_message: 'COPILOT_SANDBOX=1 but a worker wrote a file in its working directory: the sandbox is not enforced on this host' };
    if (!s.ran.some((c) => c.includes(writeFile))) return { ok: false, error_class: 'sandbox', error_message: 'the sandbox could not be proven: the worker did not attempt the write canary' };
  }
  return { ok: true, usage: res.usage, elapsed_ms: res.elapsed_ms, commands: res.commands };
}

function executorConfig() {
  // Stage models keep their CODEX_* names; COPILOT_MODEL (copilot's own) is
  // the fallback, then copilot's default.
  const model = process.env.CODEX_MODEL || process.env.COPILOT_MODEL || null;
  return {
    model,
    judgeModel: process.env.CODEX_JUDGE_MODEL || model,
    effort: process.env.CODEX_EFFORT && process.env.CODEX_EFFORT !== 'managed' ? process.env.CODEX_EFFORT : null,
  };
}

let versionCache = null;
function copilotVersion() {
  if (versionCache) return versionCache;
  try {
    const { cmd, pre } = resolveCopilot();
    const out = execFileSync(cmd, [...pre, '--no-auto-update', '--version'], { encoding: 'utf8', input: '', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, COPILOT_AUTO_UPDATE: 'false' } });
    versionCache = (out.match(/\d+\.\d+\.\d+/) || ['unknown'])[0];
  } catch {
    versionCache = 'unknown';
  }
  return versionCache;
}

function manifest() {
  return { executor: `copilot@${copilotVersion()}`, executor_sandbox: sandboxed() ? 'os' : 'allowlist' };
}

module.exports = { runCopilot, preflight, executorConfig, manifest, resolveCopilot, copilotVersion, copilotArgs, sandboxSettings, summarizeCopilotEvents, commandViolations, classifyCopilot, usageFromFile, checkoutState, checkoutChanges };
