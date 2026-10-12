'use strict';
// Repair-loop runner for model jobs that happen before a context is frozen
// (requirements, audit, ticket analysis, review planning). Same contract as
// the driver: the model proposes, `validate` decides, errors go back verbatim.
const fs = require('node:fs');
const path = require('node:path');
const { parseModelJson, writeJsonAtomic, readJsonIfExists, envInt, nowIso, ensureDir } = require('./util');
const { stripNulls } = require('./schema');

async function runLooseJob({ executor, label, workDir, cwd, model, effort, buildPrompt, validate, outputSchema, log = () => {} }) {
  const repairs = envInt('ARW_REPAIR_ATTEMPTS', 2);
  const receiptsFile = path.join(workDir, 'receipts.json');
  const receipts = readJsonIfExists(receiptsFile, {});
  let repair = null;
  let useSchema = true; // switched off after a degenerate structured response
  let lastErrors = [];
  for (let attempt = 0; attempt <= repairs + 1; attempt += 1) {
    const mode = attempt === 0 ? 'full' : repair && attempt <= repairs ? 'repair' : 'fresh';
    if (mode !== 'repair') repair = null;
    const attemptDir = ensureDir(path.join(workDir, 'attempts', `${label}-${attempt + 1}`));
    log(`start ${label} attempt=${attempt + 1} mode=${mode}`);
    const res = await executor({ prompt: buildPrompt(repair), cwd, attemptDir, model, effort, sandbox: 'read-only', outputSchema: useSchema ? outputSchema : undefined });
    if (res.error_class === 'degenerate') {
      useSchema = false;
      log(`${label}: degenerate structured output; retrying without --output-schema`);
    }
    (receipts[label] = receipts[label] || []).push({
      attempt: attempt + 1,
      mode,
      model: res.model,
      exit_code: res.exit_code,
      elapsed_ms: res.elapsed_ms,
      prompt_bytes: res.prompt_bytes,
      usage: res.usage,
      error_class: res.error_class,
      error_message: res.error_message,
      at: nowIso(),
    });
    writeJsonAtomic(receiptsFile, receipts);
    if (['auth', 'billing', 'rate_limit', 'config'].includes(res.error_class)) {
      return { ok: false, blocked: true, errors: [`${res.error_class}: ${res.error_message}`] };
    }
    if (!res.ok || res.output == null) {
      lastErrors = [`process failed (${res.error_class || 'no output'}): ${res.error_message || ''}`];
      continue;
    }
    fs.writeFileSync(path.join(attemptDir, 'raw-candidate.txt'), res.output);
    let candidate;
    try {
      candidate = stripNulls(parseModelJson(res.output));
    } catch (err) {
      lastErrors = [`output is not one JSON object: ${err.message}`];
      repair = { errors: lastErrors, previous: res.output };
      continue;
    }
    const errors = validate(candidate);
    if (errors.length) {
      lastErrors = errors;
      repair = { errors: errors.slice(0, 40), previous: JSON.stringify(candidate, null, 1) };
      log(`rejected ${label}: ${errors[0]}`);
      continue;
    }
    log(`accepted ${label}`);
    return { ok: true, value: candidate };
  }
  return { ok: false, errors: lastErrors };
}

module.exports = { runLooseJob };
