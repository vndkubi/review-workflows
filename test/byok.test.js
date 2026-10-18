'use strict';
// Self-hosted models through codex (BYOK): the company fixes the reasoning
// effort, the server may lack structured output or effort, and two models
// (GLM, DeepSeek flash) can share the work. The tool must never send an
// effort the company did not allow, must say what the provider supports, and
// can spread the free review over several lenses and models.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir } = require('./helpers');
const { codexArgs, executorConfig } = require('../src/lib/codex');
const { effortFor } = require('../src/lib/effort');
const { probeProvider } = require('../src/lib/provider');
const { huntUnits, LENSES } = require('../src/lib/plan');
const { modelFor } = require('../src/lib/driver');
const settings = require('../src/lib/settings');

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('managed effort: no stage and no call ever sends model_reasoning_effort', () => {
  withEnv({ CODEX_EFFORT: 'managed' }, () => {
    for (const effort of ['low', 'high', 'max', 'managed']) {
      const args = codexArgs({ cwd: '.', outFile: 'o', model: 'glm-5.3', effort, sandbox: 'read-only' });
      assert.ok(!args.join(' ').includes('model_reasoning_effort'), args.join(' '));
    }
    assert.equal(executorConfig().effort, null);
    assert.equal(effortFor('packet', { kind: 'viewpoint', hunt: true }, null), null);
    assert.equal(effortFor('packet', { kind: 'technical', effort_boost: true }, null), null);
    assert.equal(effortFor('synthesis', null, null), null);
    assert.equal(effortFor('rebuttal', null, null), null);
  });
  // Without managed, an explicit effort is still passed through.
  withEnv({ CODEX_EFFORT: 'high' }, () => {
    assert.ok(codexArgs({ cwd: '.', outFile: 'o', model: 'm', effort: 'high', sandbox: 'read-only' }).includes('model_reasoning_effort="high"'));
  });
});

// A scripted provider: what it supports decides each answer.
function provider({ tools = true, schema = true, effort = true } = {}) {
  const calls = [];
  const exec = async (opts) => {
    calls.push(opts);
    if (opts.effort && !effort) return { ok: false, error_class: 'config', error_message: 'unsupported parameter: reasoning_effort' };
    if (opts.outputSchema && !schema) return { ok: false, error_class: 'config', error_message: 'response_format json_schema is not supported' };
    if (/canary/.test(opts.prompt)) {
      const token = require('node:fs').readFileSync(require('node:path').join(opts.cwd, 'canary.txt'), 'utf8').trim();
      return { ok: true, output: tools ? token : 'I cannot run commands', usage: { input_tokens: 10 }, elapsed_ms: 5, commands: tools ? 1 : 0 };
    }
    return { ok: true, output: '{"ok":true}', usage: { input_tokens: 10 }, elapsed_ms: 5, commands: 0 };
  };
  exec.calls = calls;
  return exec;
}

test('doctor --provider: a capable server passes every probe', async () => {
  const run = provider();
  const res = await probeProvider({ run, models: ['deepseek-v4-flash'], dir: tmpDir('arw-probe-'), effort: 'high' });
  assert.deepEqual(res.checks.map(([n, s]) => [n, s]), [
    ['tools (deepseek-v4-flash)', 'ok'],
    ['structured output (deepseek-v4-flash)', 'ok'],
    ['reasoning effort "high" (deepseek-v4-flash)', 'ok'],
  ]);
  assert.deepEqual(res.recommend, {});
});

test('doctor --provider: what the server lacks becomes a setting to change', async () => {
  const run = provider({ schema: false, effort: false });
  const res = await probeProvider({ run, models: ['glm-5.3', 'deepseek-v4-flash'], dir: tmpDir('arw-probe-'), effort: 'high' });
  const status = Object.fromEntries(res.checks.map(([n, s]) => [n, s]));
  assert.equal(status['tools (glm-5.3)'], 'ok');
  assert.equal(status['structured output (glm-5.3)'], 'WARN');
  assert.equal(status['reasoning effort "high" (deepseek-v4-flash)'], 'WARN');
  assert.deepEqual(res.recommend, { CODEX_OUTPUT_SCHEMA: '0', CODEX_EFFORT: 'managed' });
});

test('doctor --provider: a model that cannot run commands fails; managed effort is not probed', async () => {
  const run = provider({ tools: false });
  const res = await probeProvider({ run, models: ['glm-5.3'], dir: tmpDir('arw-probe-'), effort: 'managed' });
  const rows = Object.fromEntries(res.checks.map(([n, s, d]) => [n, [s, d]]));
  assert.equal(rows['tools (glm-5.3)'][0], 'FAIL');
  assert.deepEqual(rows['reasoning effort (glm-5.3)'], ['ok', 'managed: never sent; the server default applies']);
  assert.ok(!run.calls.some((c) => c.effort), 'no call carried an effort');
});

test('hunt lenses: several free reviews, each with its own lens and model in turn', () => {
  const files = ['a.java', 'b.java'];
  const one = withEnv({ ARW_HUNT_LENSES: null, ARW_HUNT_MODELS: null }, () => huntUnits(files));
  assert.deepEqual(one.map((u) => [u.id, u.lens, u.model || null]), [['V0', 'general', null]]);
  const three = withEnv({ ARW_HUNT_LENSES: '3', ARW_HUNT_MODELS: 'deepseek-v4-flash,glm-5.3' }, () => huntUnits(files));
  assert.deepEqual(three.map((u) => [u.id, u.lens, u.model]), [['V0', 'general', 'deepseek-v4-flash'], ['V1', 'business', 'glm-5.3'], ['V2', 'adversarial', 'deepseek-v4-flash']]);
  assert.ok(three.every((u) => u.hunt && u.covers.includes('file:a.java')));
  assert.ok(LENSES.every((l) => l.name && l.brief));
  // Named lenses pick the set.
  const named = withEnv({ ARW_HUNT_LENSES: 'general,maintainer', ARW_HUNT_MODELS: null }, () => huntUnits(files));
  assert.deepEqual(named.map((u) => [u.id, u.lens]), [['V0', 'general'], ['V1', 'maintainer']]);
});

test('models per role: a hunt unit runs on its own model, then CODEX_HUNT_MODEL, then the review model', () => {
  const models = { review: 'deepseek-v4-flash', hunt: 'glm-5.3' };
  assert.equal(modelFor({ kind: 'technical' }, models), 'deepseek-v4-flash');
  assert.equal(modelFor({ kind: 'viewpoint', hunt: true }, models), 'glm-5.3');
  assert.equal(modelFor({ kind: 'viewpoint', hunt: true, model: 'qwen' }, models), 'qwen');
  assert.equal(modelFor({ kind: 'viewpoint', hunt: true }, { review: 'r' }), 'r');
});

test('settings: managed effort and the BYOK keys are documented', () => {
  const byKey = Object.fromEntries(settings.ENV_SETTINGS.map((s) => [s.key, s]));
  assert.ok(byKey.CODEX_EFFORT.options.includes('managed'));
  for (const k of ['CODEX_HUNT_MODEL', 'CODEX_REVIEW_MODEL', 'ARW_HUNT_LENSES', 'ARW_HUNT_MODELS']) assert.ok(byKey[k], k);
});
