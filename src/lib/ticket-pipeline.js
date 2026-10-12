'use strict';
// Ticket pipeline (understand the requirement before code or review):
//   intake -> requirements -> GATE REQUIREMENTS -> analysis -> GATE ANALYSIS -> READY
// Each invocation advances as far as it can and stops at the next human gate.
// A person may edit requirements.json before approving; the gate binds the
// edited bytes.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJson, readJsonIfExists, writeJsonAtomic, writeFileAtomic, nowIso, ensureDir } = require('./util');
const { validateAgainst, outputSchema } = require('./schema');
const { fetchJiraIssue } = require('./jira');
const { extractRequirements, renderRequirementsMarkdown } = require('./requirements');
const { runLooseJob } = require('./loose-job');
const prompts = require('./prompts');
const { ticketDir, gateState, isApproved } = require('./runs');

function loadRun(dir, key) {
  return readJsonIfExists(path.join(dir, 'run.json'), { schema_version: '1.0', kind: 'ticket', ticket: key, created_at: nowIso(), stages: {} });
}

function saveRun(dir, run) {
  writeJsonAtomic(path.join(dir, 'run.json'), run);
}

function setStage(dir, run, stage, status, extra = {}) {
  run.stages[stage] = { status, at: nowIso(), ...extra };
  saveRun(dir, run);
}

function evidenceBlocks(dir) {
  const blocks = [];
  const main = path.join(dir, 'ticket-evidence.md');
  if (fs.existsSync(main)) blocks.push({ name: 'ticket', text: fs.readFileSync(main, 'utf8') });
  const extra = path.join(dir, 'evidence');
  if (fs.existsSync(extra)) {
    for (const name of fs.readdirSync(extra).sort()) blocks.push({ name: `attachment:${name}`, text: fs.readFileSync(path.join(extra, name), 'utf8') });
  }
  return blocks;
}

async function intake(dir, run, { key, fromFile, extras = [] }) {
  let text;
  let source;
  if (fromFile) {
    text = fs.readFileSync(fromFile, 'utf8');
    source = `file:${path.resolve(fromFile)}`;
  } else {
    const issue = await fetchJiraIssue(key);
    text = issue.text;
    source = 'jira';
  }
  writeFileAtomic(path.join(dir, 'ticket-evidence.md'), text);
  for (const file of extras) {
    writeFileAtomic(path.join(dir, 'evidence', path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')), fs.readFileSync(file, 'utf8'));
  }
  setStage(dir, run, 'intake', 'EXECUTED_PASS', { source, extras: extras.map((f) => path.basename(f)) });
}

function validateAnalysis(candidate, { key, requirements, repoDir }) {
  const errors = validateAgainst('analysis', candidate);
  if (errors.length) return errors;
  if (candidate.ticket !== key) errors.push(`$.ticket: must be "${key}"`);
  const acIds = new Set(requirements.items.map((i) => i.id));
  const checkAc = (ac, at) => {
    if (!acIds.has(ac)) errors.push(`${at}: ${ac} is not an approved requirement item`);
  };
  candidate.current_vs_expected.forEach((x, i) => checkAc(x.ac, `$.current_vs_expected[${i}].ac`));
  candidate.scenarios.forEach((x, i) => checkAc(x.ac, `$.scenarios[${i}].ac`));
  candidate.acceptance_tests.forEach((x, i) => checkAc(x.ac, `$.acceptance_tests[${i}].ac`));
  candidate.questions.forEach((q, i) => q.blocks.forEach((ac) => checkAc(ac, `$.questions[${i}].blocks`)));
  for (const [field, list] of [['rules', candidate.rules], ['questions', candidate.questions], ['scenarios', candidate.scenarios]]) {
    const ids = list.map((x) => x.id);
    if (new Set(ids).size !== ids.length) errors.push(`$.${field}: ids must be unique`);
  }
  for (const item of requirements.items) {
    if (item.kind !== 'inferred' && !candidate.acceptance_tests.some((t) => t.ac === item.id)) errors.push(`$.acceptance_tests: no test for ${item.id}`);
  }
  // Paths the analyst cites must exist: a named file that does not exist is
  // the most common hallucination.
  candidate.impacted.forEach((x, i) => {
    if (!repoDir) return;
    if (!fs.existsSync(path.join(repoDir, x.path))) errors.push(`$.impacted[${i}].path: "${x.path}" does not exist in the repository`);
  });
  candidate.acceptance_tests.forEach((t, i) => {
    if (repoDir && t.existing_test && !fs.existsSync(path.join(repoDir, t.existing_test.split(/[#:]/)[0]))) {
      errors.push(`$.acceptance_tests[${i}].existing_test: "${t.existing_test}" does not exist; leave it out when no test exists`);
    }
  });
  return errors;
}

function renderAnalysisMarkdown(a) {
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = [`# Analysis — ${a.ticket}`, ''];
  out.push('## Current vs expected', '', '| AC | Current | Expected | Label |', '|---|---|---|---|');
  a.current_vs_expected.forEach((x) => out.push(`| ${x.ac} | ${cell(x.current)} | ${cell(x.expected)} | ${x.label} |`));
  out.push('', '## Business rules', '');
  a.rules.forEach((r) => out.push(`- **${r.id}** [${r.label}] ${r.rule} — _${r.source}_`));
  out.push('', '## Open questions', '');
  a.questions.forEach((q) => out.push(`- **${q.id}** ${q.question} — ${q.why}${q.blocks.length ? ` (blocks ${q.blocks.join(', ')})` : ''}`));
  if (a.contradictions.length) {
    out.push('', '## Contradictions', '');
    a.contradictions.forEach((c) => out.push(`- ${c.items.join(' vs ')}: ${c.description}`));
  }
  out.push('', '## Scenarios', '', '| ID | AC | Kind | Given | When | Then |', '|---|---|---|---|---|---|');
  a.scenarios.forEach((s) => out.push(`| ${s.id} | ${s.ac} | ${s.kind} | ${cell(s.given)} | ${cell(s.when)} | ${cell(s.then)} |`));
  out.push('', '## Impacted', '');
  a.impacted.forEach((x) => out.push(`- \`${x.path}\`${x.symbol ? ` (${x.symbol})` : ''} [${x.label}] — ${x.reason}`));
  if (a.options.length) {
    out.push('', '## Options', '');
    a.options.forEach((o) => out.push(`- **${o.name}** — ${o.summary} _Trade-offs:_ ${o.tradeoffs}`));
  }
  out.push('', '## Acceptance tests', '');
  a.acceptance_tests.forEach((t) => out.push(`- ${t.ac}: ${t.test}${t.existing_test ? ` (existing: \`${t.existing_test}\`)` : ''}`));
  return `${out.join('\n')}\n`;
}

// Advance the pipeline; returns { dir, state, message }.
async function advanceTicket({ key, fromFile, extras, repoDir, executor, models = {}, log = () => {}, redo }) {
  const dir = ensureDir(ticketDir(key));
  const run = loadRun(dir, key);
  if (redo) delete run.stages[redo];

  if (!run.stages.intake || run.stages.intake.status !== 'EXECUTED_PASS' || fromFile || redo === 'intake') {
    log('intake');
    const before = JSON.stringify(evidenceBlocks(dir));
    await intake(dir, run, { key, fromFile, extras });
    if (JSON.stringify(evidenceBlocks(dir)) !== before) {
      // New evidence: everything derived from the old evidence is stale.
      delete run.stages.requirements;
      delete run.stages.analysis;
      run.stages.intake.evidence_changed = true;
    }
  }

  if (!run.stages.requirements || run.stages.requirements.status !== 'EXECUTED_PASS') {
    log('requirements');
    const req = await extractRequirements({
      ticket: key,
      blocks: evidenceBlocks(dir),
      executor,
      workDir: ensureDir(path.join(dir, 'work')),
      model: models.requirements,
      auditModel: models.audit,
      effort: models.effort,
      log,
    });
    writeJsonAtomic(path.join(dir, 'requirements.json'), req);
    writeFileAtomic(path.join(dir, 'requirements.md'), renderRequirementsMarkdown(req));
    setStage(dir, run, 'requirements', req.extraction === 'none' ? 'EXECUTED_FAIL' : 'EXECUTED_PASS', { items: req.items.length, extraction: req.extraction });
    if (req.extraction === 'none') return { dir, state: 'FAILED', message: `no requirement items: ${req.note}` };
  }

  // A person may have edited requirements.json; it must still be valid.
  const requirements = readJson(path.join(dir, 'requirements.json'));
  const reqErrors = validateAgainst('requirements', requirements);
  if (reqErrors.length) return { dir, state: 'FAILED', message: `requirements.json is invalid: ${reqErrors.join('; ')}` };
  if (!isApproved(dir, 'REQUIREMENTS')) {
    const g = gateState(dir, 'REQUIREMENTS');
    const why = g.decision === 'approved' ? 'requirements.json changed after approval' : g.decision === 'rejected' ? 'rejected — edit requirements.json and approve again' : 'waiting for a person';
    return { dir, state: 'AWAIT_GATE_REQUIREMENTS', message: `${why}. Review ${path.join(dir, 'requirements.md')} (edit requirements.json if needed), then: arw gate approve --ticket ${key} --gate REQUIREMENTS` };
  }

  const analysisFile = path.join(dir, 'analysis.json');
  const stale = run.stages.analysis && run.stages.analysis.requirements_sha256 !== gateState(dir, 'REQUIREMENTS').record.bound.sha256;
  if (!run.stages.analysis || run.stages.analysis.status !== 'EXECUTED_PASS' || stale) {
    if (!executor) return { dir, state: 'FAILED', message: 'analysis needs a model executor' };
    log('analysis');
    const charter = fs.readFileSync(path.join(ROOT, 'agents', 'ticket-analyst.md'), 'utf8');
    const workDir = ensureDir(path.join(dir, 'work'));
    const res = await runLooseJob({
      executor,
      label: 'analysis',
      outputSchema: outputSchema('analysis'),
      workDir,
      cwd: repoDir || workDir,
      model: models.analysis,
      effort: models.effort,
      log,
      buildPrompt: (repair) => prompts.analysisPrompt({ ticket: key, requirements, evidenceBlocks: evidenceBlocks(dir), charter, hasRepo: Boolean(repoDir), repair }),
      validate: (c) => validateAnalysis(c, { key, requirements, repoDir }),
    });
    if (!res.ok) {
      setStage(dir, run, 'analysis', res.blocked ? 'ENVIRONMENT_BLOCKED' : 'EXECUTED_FAIL', { errors: res.errors.slice(0, 10) });
      return { dir, state: 'FAILED', message: `analysis failed: ${res.errors[0]}` };
    }
    writeJsonAtomic(analysisFile, res.value);
    writeFileAtomic(path.join(dir, 'analysis.md'), renderAnalysisMarkdown(res.value));
    setStage(dir, run, 'analysis', 'EXECUTED_PASS', { requirements_sha256: gateState(dir, 'REQUIREMENTS').record.bound.sha256, repo_dir: repoDir || null });
  }
  if (!isApproved(dir, 'ANALYSIS')) {
    return { dir, state: 'AWAIT_GATE_ANALYSIS', message: `Review ${path.join(dir, 'analysis.md')}; answer the open questions in the ticket if needed, then: arw gate approve --ticket ${key} --gate ANALYSIS` };
  }
  setStage(dir, run, 'ready', 'READY');
  return { dir, state: 'READY', message: 'Requirements and analysis approved; PR reviews for this ticket will use them.' };
}

// What a PR review may use from a ticket run: approved items only.
function approvedTicketInputs(key) {
  const dir = ticketDir(key);
  if (!fs.existsSync(dir)) return null;
  const out = { dir, requirements: null, scenarios: null, evidence: null, requirements_approved: false };
  if (fs.existsSync(path.join(dir, 'ticket-evidence.md'))) out.evidence = fs.readFileSync(path.join(dir, 'ticket-evidence.md'), 'utf8');
  if (fs.existsSync(path.join(dir, 'requirements.json'))) {
    out.requirements = readJson(path.join(dir, 'requirements.json'));
    out.requirements_approved = isApproved(dir, 'REQUIREMENTS');
  }
  if (isApproved(dir, 'ANALYSIS')) {
    const a = readJson(path.join(dir, 'analysis.json'));
    out.scenarios = a.scenarios.map((s) => `${s.id} [${s.ac}, ${s.kind}] Given ${s.given} When ${s.when} Then ${s.then}`).join('\n');
  }
  return out;
}

module.exports = { advanceTicket, approvedTicketInputs, validateAnalysis, renderAnalysisMarkdown, evidenceBlocks };
