'use strict';
// What a model provider supports, measured with tiny calls (`arw doctor
// --provider`). Self-hosted models behind codex (BYOK) differ: some cannot
// call tools, some reject structured output, some reject a reasoning effort
// the company did not allow. Each gap becomes a setting to change, never a
// silent degradation in the middle of a review.
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir } = require('./util');

const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };

// run: executor-like function ({ prompt, cwd, attemptDir, model, effort,
// outputSchema, timeoutMs }) -> { ok, output, error_class, error_message }.
// models: the distinct models the run will use. effort: the configured
// CODEX_EFFORT ('managed' = never sent).
async function probeProvider({ run, models, dir, effort }) {
  const checks = [];
  const recommend = {};
  const managed = effort === 'managed';
  for (const model of [...new Set(models.filter(Boolean))]) {
    const base = ensureDir(path.join(dir, model.replace(/[^\w.-]/g, '_')));

    // Tools: the worker must read files with shell commands.
    const token = `arw-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const canary = ensureDir(path.join(base, 'canary'));
    fs.writeFileSync(path.join(canary, 'canary.txt'), `${token}\n`);
    const t = await run({ prompt: 'Use a shell command to read the file canary.txt in the working directory. Reply with exactly its first line and nothing else.', cwd: canary, attemptDir: ensureDir(path.join(base, 'tools')), model, timeoutMs: 180000 });
    if (!t.ok) checks.push([`tools (${model})`, 'FAIL', `${t.error_class}: ${t.error_message}`]);
    else if (!String(t.output).includes(token)) checks.push([`tools (${model})`, 'FAIL', 'the model did not read the file with a shell command: it needs tool (function) calling on the server']);
    else checks.push([`tools (${model})`, 'ok', 'reads files with shell commands']);

    // Structured output: --output-schema; without it the repair loop alone
    // keeps the JSON valid (more repair calls).
    const s = await run({ prompt: 'Reply with the JSON object {"ok": true} and nothing else.', cwd: canary, attemptDir: ensureDir(path.join(base, 'schema')), model, outputSchema: SCHEMA, timeoutMs: 120000 });
    let parsed = null;
    try { parsed = s.ok ? JSON.parse(String(s.output).trim()) : null; } catch { parsed = null; }
    if (parsed && parsed.ok === true) checks.push([`structured output (${model})`, 'ok', 'accepts --output-schema']);
    else {
      checks.push([`structured output (${model})`, 'WARN', s.ok ? 'the reply did not follow the schema' : `${s.error_class}: ${s.error_message}; set CODEX_OUTPUT_SCHEMA=0 (the repair loop keeps output valid)`]);
      recommend.CODEX_OUTPUT_SCHEMA = '0';
    }

    // Reasoning effort: never probed when managed.
    if (managed) checks.push([`reasoning effort (${model})`, 'ok', 'managed: never sent; the server default applies']);
    else if (effort) {
      const e = await run({ prompt: 'Reply with the word OK.', cwd: canary, attemptDir: ensureDir(path.join(base, 'effort')), model, effort, timeoutMs: 120000 });
      if (e.ok) checks.push([`reasoning effort "${effort}" (${model})`, 'ok', 'accepted']);
      else {
        checks.push([`reasoning effort "${effort}" (${model})`, 'WARN', `${e.error_class}: ${e.error_message}; set CODEX_EFFORT=managed`]);
        recommend.CODEX_EFFORT = 'managed';
      }
    }
  }
  return { checks, recommend };
}

module.exports = { probeProvider };
