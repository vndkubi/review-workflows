'use strict';
// codex CLI executor. One `codex exec --json` per job; the prompt goes in on
// stdin (Windows argv limits), the final message is captured with -o, and
// token usage is read from the JSONL `turn.completed` events — never from a
// log-tail regex.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, envInt } = require('./util');
const { redactSecrets } = require('./guard');

function resolveCodex() {
  if (process.env.CODEX_BIN) return { cmd: process.execPath, pre: [process.env.CODEX_BIN] };
  if (process.platform === 'win32') {
    // npm installs a .cmd shim that cannot be spawned without a shell;
    // run the package's JS entry with this node instead.
    const js = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) return { cmd: process.execPath, pre: [js] };
  }
  return { cmd: 'codex', pre: [] };
}

function codexArgs({ cwd, outFile, model, effort, sandbox, schemaFile, images = [] }) {
  // project_doc_max_bytes=0: never auto-load AGENTS.md from the working
  // directory — in a PR checkout that file is author-controlled and would be
  // an instruction channel into the reviewer.
  // --image takes several values: each one is followed by another option so
  // the trailing '-' (prompt on stdin) is never read as an image.
  const args = ['exec', ...images.flatMap((img) => ['--image', img]), '--json', '--skip-git-repo-check', '--ephemeral', '-s', sandbox, '-C', cwd, '-o', outFile, '-c', 'project_doc_max_bytes=0'];
  if (process.env.CODEX_USE_USER_CONFIG !== '1') {
    args.push('--ignore-user-config');
    // Since codex 0.162 Windows has no default sandbox: without one, every
    // shell command is rejected ("blocked by policy") and workers silently
    // review nothing. The restricted-token sandbox still enforces read-only.
    if (process.platform === 'win32') args.push('-c', `windows.sandbox="${process.env.CODEX_WINDOWS_SANDBOX || 'unelevated'}"`);
  } else if (process.env.CODEX_PROFILE) args.push('-p', process.env.CODEX_PROFILE);
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (schemaFile) args.push('--output-schema', schemaFile);
  args.push('-');
  return args;
}

function classifyError(text) {
  const t = String(text || '');
  // A rejected request (bad schema, bad parameter) fails identically on every
  // retry: report it as configuration, not as a flaky model.
  if (/invalid_request_error|invalid_json_schema/i.test(t) && !/rate.?limit|not supported when using/i.test(t)) return 'config';
  if (/\b429\b|rate.?limit|too many requests/i.test(t)) return 'rate_limit';
  if (/\b402\b|insufficient (balance|quota)|billing|payment required/i.test(t)) return 'billing';
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|not logged in|login required|not supported when using/i.test(t)) return 'auth';
  return 'error';
}

function summarizeEvents(jsonl) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const errors = [];
  let turns = 0;
  let commands = 0;
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      turns += 1;
      for (const k of Object.keys(usage)) usage[k] += Number(ev.usage[k]) || 0;
    } else if (ev.type === 'turn.failed') {
      errors.push((ev.error && ev.error.message) || 'turn failed');
    } else if (ev.type === 'error') {
      errors.push(ev.message || 'error');
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type === 'command_execution') {
      commands += 1;
    }
  }
  return { usage, errors, turns, commands };
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL'); // the whole process group (codex and its children)
  } catch {
    /* already gone */
  }
}

// Returns { ok, output, exit_code, elapsed_ms, usage, turns, commands,
// error_class, error_message, model }. Never throws for model-side failures.
// outputSchema: a strict JSON schema (schema.strictSchema) enforced by the
// provider's structured outputs; it removes JSON syntax errors entirely.
// Verified with codex 0.147 that tools stay usable with --output-schema.
// Disable with CODEX_OUTPUT_SCHEMA=0 for providers that do not support it.
function runCodex({ prompt: rawPrompt, cwd, attemptDir, model, effort, sandbox = 'read-only', timeoutMs, outputSchema, images = [] }) {
  ensureDir(attemptDir);
  const { text: prompt, redactions } = redactSecrets(rawPrompt);
  const outFile = path.join(attemptDir, 'last-message.txt');
  const eventsFile = path.join(attemptDir, 'events.jsonl');
  const stderrFile = path.join(attemptDir, 'stderr.txt');
  fs.writeFileSync(path.join(attemptDir, 'prompt.txt'), prompt);
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  let schemaFile = null;
  if (outputSchema && process.env.CODEX_OUTPUT_SCHEMA !== '0') {
    schemaFile = path.join(attemptDir, 'output-schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(outputSchema));
  }
  const { cmd, pre } = resolveCodex();
  const args = [...pre, ...codexArgs({ cwd, outFile, model, effort, sandbox, schemaFile, images })];
  const limit = timeoutMs || envInt('CODEX_TIMEOUT_MS', 30 * 60 * 1000);
  const started = Date.now();

  return new Promise((resolve) => {
    const events = fs.createWriteStream(eventsFile);
    const stderr = fs.createWriteStream(stderrFile);
    let stdoutText = '';
    let stderrText = '';
    let timedOut = false;
    let degenerate = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, RUST_LOG: process.env.RUST_LOG || 'warn' }, windowsHide: true, detached: process.platform !== 'win32' });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit);
    child.stdout.on('data', (d) => {
      events.write(d);
      stdoutText += d;
      // A response cut at max_output_tokens is degenerate output (seen: endless
      // whitespace under a strict schema). codex would reconnect and repeat it
      // until the timeout, so stop now and let the runner fall back.
      if (!degenerate && /max_output_tokens/.test(String(d))) {
        degenerate = true;
        killTree(child);
      }
    });
    child.stderr.on('data', (d) => {
      stderr.write(d);
      if (stderrText.length < 200000) stderrText += d;
    });
    const finish = (exitCode, spawnError) => {
      clearTimeout(timer);
      events.end();
      stderr.end();
      const summary = summarizeEvents(stdoutText);
      const output = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
      let errorClass = null;
      let errorMessage = null;
      if (degenerate) {
        errorClass = 'degenerate';
        errorMessage = 'response hit max_output_tokens (degenerate output); stopped early';
      } else if (timedOut) {
        errorClass = 'timeout';
        errorMessage = `killed after ${limit} ms`;
      } else if (spawnError) {
        errorClass = 'spawn';
        errorMessage = spawnError.message;
      } else if (exitCode !== 0 || summary.errors.length) {
        errorMessage = summary.errors.join(' | ') || stderrText.trim().split('\n').slice(-3).join(' | ') || `exit ${exitCode}`;
        errorClass = classifyError(`${errorMessage}\n${stderrText}`);
      }
      resolve({
        ok: !errorClass && output != null,
        output,
        exit_code: exitCode,
        elapsed_ms: Date.now() - started,
        usage: summary.usage,
        turns: summary.turns,
        commands: summary.commands,
        error_class: errorClass,
        error_message: errorMessage,
        model: model || null,
        prompt_bytes: Buffer.byteLength(prompt),
        redactions: redactions.reduce((n, r) => n + r.count, 0),
      });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code, null));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// Fail fast before any real job is spent: the model must answer AND be able
// to run a read-only shell command. A worker that cannot read files still
// returns valid JSON — full of honest "cannot_determine" — so a reply alone
// proves nothing (seen after a codex upgrade removed the Windows sandbox).
async function preflight({ cwd, attemptDir, model }) {
  ensureDir(attemptDir);
  const token = `arw-canary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const canaryDir = ensureDir(path.join(attemptDir, 'canary'));
  fs.writeFileSync(path.join(canaryDir, 'canary.txt'), `${token}\n`);
  const res = await runCodex({
    prompt: 'Use a shell command to read the file canary.txt in the working directory. Reply with exactly its first line and nothing else.',
    cwd: canaryDir,
    attemptDir,
    model,
    effort: 'low',
    timeoutMs: 180000,
  });
  if (!res.ok) return { ok: false, error_class: res.error_class, error_message: res.error_message };
  if (!res.output.includes(token)) {
    return { ok: false, error_class: 'tools', error_message: `the worker could not read a file with a shell command (replied: ${res.output.trim().slice(0, 160)}); check the codex sandbox (CODEX_WINDOWS_SANDBOX) or approval settings` };
  }
  return { ok: true, usage: res.usage, elapsed_ms: res.elapsed_ms, commands: res.commands };
}

const DEFAULT_MODEL = 'gpt-6-luna';

function executorConfig() {
  const model = process.env.CODEX_MODEL || DEFAULT_MODEL;
  return {
    model,
    judgeModel: process.env.CODEX_JUDGE_MODEL || model,
    effort: process.env.CODEX_EFFORT || null,
  };
}

module.exports = { runCodex, preflight, summarizeEvents, classifyError, executorConfig, resolveCodex, codexArgs, DEFAULT_MODEL };
