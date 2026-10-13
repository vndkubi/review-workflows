'use strict';
// Ticket pipeline: understand the requirement before code or review.
//   intake (Jira/Confluence or file) -> requirements (AC items)
//   -> spec (model declares; code builds input matrix, decision table,
//      scenarios, boundaries, gaps, contradictions, review items)
//   -> GATE SPEC (approve | reject with a note that feeds the next attempt)
//   -> analysis of every review item against the repository -> READY
// Each invocation advances as far as it can and stops at the gate. With
// ARW_AUTO_APPROVE_SPEC=1 a deterministic policy (not a model) approves a
// spec that is clean: no gaps, no contradictions, no inferred rules.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJson, readJsonIfExists, writeJsonAtomic, writeFileAtomic, nowIso, ensureDir, sha256 } = require('./util');
const { validateAgainst, outputSchema } = require('./schema');
const { fetchTicketEvidence } = require('./jira');
const { fetchTicketEvidenceMcp, atlassianConfig } = require('./ticket-mcp');
const { extractRequirements, renderRequirementsMarkdown } = require('./requirements');
const { buildSpec, renderSpecMarkdown, itemsFromRequirements } = require('./spec');
const { runLooseJob } = require('./loose-job');
const { redactSecrets } = require('./guard');
const prompts = require('./prompts');
const { ticketDir, gateState, isApproved, recordGate } = require('./runs');

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

// Images that go to the model with the ticket text (codex -i). They inform
// the reading; what only an image shows has no quotable text, so it becomes
// an inferred requirement that a person approves at the SPEC gate.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function ticketImages(dir) {
  const manifest = readJsonIfExists(path.join(dir, 'attachments', 'manifest.json'), { images: [] });
  return manifest.images
    .map((i) => ({ ...i, file: path.join(dir, 'attachments', i.name) }))
    .filter((i) => fs.existsSync(i.file) && sha256(fs.readFileSync(i.file)) === i.sha256);
}

function saveImages(dir, images) {
  const adir = path.join(dir, 'attachments');
  fs.rmSync(adir, { recursive: true, force: true });
  if (!images.length) return [];
  ensureDir(adir);
  const used = new Set();
  const list = [];
  for (const img of images) {
    let name = path.basename(img.name).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!IMAGE_EXT.test(name)) continue;
    while (used.has(name)) name = `x${name}`;
    used.add(name);
    fs.writeFileSync(path.join(adir, name), img.bytes);
    list.push({ name, sha256: sha256(img.bytes), bytes: img.bytes.length, source: img.source });
  }
  writeJsonAtomic(path.join(adir, 'manifest.json'), { images: list });
  return list;
}

// Everything the later stages read: a change means they are stale.
function evidenceDigest(dir) {
  return JSON.stringify({ blocks: evidenceBlocks(dir), images: ticketImages(dir).map((i) => i.sha256) });
}

async function intake(dir, run, { key, fromFile, extras = [], imageFiles = [], log }) {
  let text;
  let source;
  const pages = [];
  const linked = [];
  const images = [];
  if (fromFile) {
    text = fs.readFileSync(fromFile, 'utf8');
    source = `file:${path.resolve(fromFile)}`;
  } else {
    // An MCP server wins when configured: it works where Jira/Confluence are
    // not reachable from this machine. Otherwise call the REST APIs directly.
    const viaMcp = Boolean(atlassianConfig());
    const fetched = viaMcp ? await fetchTicketEvidenceMcp(key, { log, imageDir: path.join(dir, 'work', 'mcp-attachments') }) : await fetchTicketEvidence(key, { log });
    text = fetched.ticket.text;
    source = viaMcp ? `mcp${fetched.server && fetched.server.name ? `:${fetched.server.name}` : ''}` : 'jira';
    pages.push(...fetched.pages);
    linked.push(...(fetched.linked || []));
    images.push(...(fetched.images || []));
  }
  for (const file of imageFiles) images.push({ name: path.basename(file), bytes: fs.readFileSync(file), source: 'file' });
  // Credentials in tickets or pages never reach a model or the run files.
  const redactions = [];
  const clean = (s) => {
    const r = redactSecrets(s);
    redactions.push(...r.redactions);
    return r.text;
  };
  writeFileAtomic(path.join(dir, 'ticket-evidence.md'), clean(text));
  for (const stale of fs.existsSync(path.join(dir, 'evidence')) ? fs.readdirSync(path.join(dir, 'evidence')).filter((n) => n.startsWith('linked-')) : []) fs.rmSync(path.join(dir, 'evidence', stale));
  for (const page of pages) writeFileAtomic(path.join(dir, 'evidence', `confluence-${page.id}.md`), clean(page.text));
  for (const l of linked) writeFileAtomic(path.join(dir, 'evidence', `linked-${l.key}.md`), clean(l.text));
  const savedImages = saveImages(dir, images);
  for (const file of extras) {
    writeFileAtomic(path.join(dir, 'evidence', path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')), clean(fs.readFileSync(file, 'utf8')));
  }
  setStage(dir, run, 'intake', 'EXECUTED_PASS', { source, confluence_pages: pages.map((p) => ({ id: p.id, title: p.title })), linked: linked.map((l) => ({ key: l.key, relation: l.relation })), images: savedImages.map((i) => ({ name: i.name, bytes: i.bytes, source: i.source })), extras: extras.map((f) => path.basename(f)), redactions: redactions.reduce((n, r) => n + r.count, 0) });
}

function validateAnalysis(candidate, { key, items, repoDir }) {
  const errors = validateAgainst('analysis', candidate);
  if (errors.length) return errors;
  if (candidate.ticket !== key) errors.push(`$.ticket: must be "${key}"`);
  const ids = new Set(items.map((i) => i.id));
  const check = (id, at) => {
    if (!ids.has(id)) errors.push(`${at}: ${id} is not a review item`);
  };
  const seen = new Set();
  candidate.items.forEach((x, i) => {
    check(x.item, `$.items[${i}].item`);
    if (seen.has(x.item)) errors.push(`$.items[${i}]: ${x.item} appears twice`);
    seen.add(x.item);
  });
  for (const item of items) if (!seen.has(item.id)) errors.push(`$.items: missing an entry for ${item.id}`);
  candidate.acceptance_tests.forEach((x, i) => check(x.item, `$.acceptance_tests[${i}].item`));
  candidate.questions.forEach((q, i) => q.blocks.forEach((id) => check(id, `$.questions[${i}].blocks`)));
  // A named file that does not exist is the most common hallucination.
  candidate.impacted.forEach((x, i) => {
    if (repoDir && !fs.existsSync(path.join(repoDir, x.path))) errors.push(`$.impacted[${i}].path: "${x.path}" does not exist in the repository`);
  });
  candidate.acceptance_tests.forEach((t, i) => {
    if (repoDir && t.existing_test && !fs.existsSync(path.join(repoDir, t.existing_test.split(/[#:]/)[0]))) {
      errors.push(`$.acceptance_tests[${i}].existing_test: "${t.existing_test}" does not exist; leave it out when no test exists`);
    }
  });
  return errors;
}

function renderAnalysisMarkdown(a, items) {
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = [`# Analysis — ${a.ticket}`, '', '## Current behaviour per review item', '', '| Item | Expected | Current | Status | Label |', '|---|---|---|---|---|'];
  a.items.forEach((x) => out.push(`| ${x.item} | ${cell((byId.get(x.item) || {}).expected)} | ${cell(x.current)} | ${x.status} | ${x.label} |`));
  out.push('', '## Open questions', '');
  a.questions.forEach((q) => out.push(`- **${q.id}** ${q.question} — ${q.why}${q.blocks.length ? ` (blocks ${q.blocks.join(', ')})` : ''}`));
  out.push('', '## Impacted', '');
  a.impacted.forEach((x) => out.push(`- \`${x.path}\`${x.symbol ? ` (${x.symbol})` : ''} [${x.label}] — ${x.reason}`));
  if (a.options.length) out.push('', '## Options', '', ...a.options.map((o) => `- **${o.name}** — ${o.summary} _Trade-offs:_ ${o.tradeoffs}`));
  out.push('', '## Acceptance tests', '');
  a.acceptance_tests.forEach((t) => out.push(`- ${t.item}: ${t.test}${t.existing_test ? ` (existing: \`${t.existing_test}\`)` : ''}`));
  return `${out.join('\n')}\n`;
}

// The note of a rejected SPEC gate becomes feedback for the next attempt.
function rejectionFeedback(dir) {
  const g = gateState(dir, 'SPEC');
  if (g.decision !== 'rejected' || !g.record) return null;
  return g.record.note ? g.record.note : 'The previous spec was rejected without a note; re-read the ticket and model it more carefully.';
}

// Advance the pipeline; returns { dir, state, message }.
async function advanceTicket({ key, fromFile, extras, images: imageFiles = [], repoDir, executor, models = {}, log = () => {}, redo }) {
  const dir = ensureDir(ticketDir(key));
  const run = loadRun(dir, key);
  if (redo && redo !== 'intake') {
    const order = ['requirements', 'spec', 'analysis'];
    for (const stage of order.slice(order.indexOf(redo))) delete run.stages[stage];
  }

  if (!run.stages.intake || run.stages.intake.status !== 'EXECUTED_PASS' || fromFile || imageFiles.length || redo === 'intake') {
    log('intake');
    const before = evidenceDigest(dir);
    await intake(dir, run, { key, fromFile, extras, imageFiles, log });
    if (evidenceDigest(dir) !== before) {
      // New evidence: everything derived from the old evidence is stale.
      for (const stage of ['requirements', 'spec', 'analysis', 'ready']) delete run.stages[stage];
      run.stages.intake.evidence_changed = true;
      saveRun(dir, run);
    }
  }

  if (!run.stages.requirements || run.stages.requirements.status !== 'EXECUTED_PASS') {
    log('requirements');
    const req = await extractRequirements({
      ticket: key,
      blocks: evidenceBlocks(dir),
      images: ticketImages(dir).map((i) => i.file),
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
    delete run.stages.spec;
    if (req.extraction === 'none') return { dir, state: 'FAILED', message: `no requirement items: ${req.note}` };
  }
  const requirements = readJson(path.join(dir, 'requirements.json'));

  // Spec: re-built when missing, or when the last one was rejected.
  const specFile = path.join(dir, 'spec.json');
  const feedback = rejectionFeedback(dir);
  const rejectedCurrent = feedback && run.stages.spec && run.stages.spec.feedback_used !== gateState(dir, 'SPEC').record.at;
  if (!run.stages.spec || run.stages.spec.status !== 'EXECUTED_PASS' || rejectedCurrent) {
    if (!executor) return { dir, state: 'FAILED', message: 'building the spec needs a model executor' };
    log(feedback ? 'spec (with reviewer feedback)' : 'spec');
    const blocks = evidenceBlocks(dir);
    let built = null;
    const res = await runLooseJob({
      executor,
      label: 'spec',
      images: ticketImages(dir).map((i) => i.file),
      workDir: ensureDir(path.join(dir, 'work')),
      cwd: ensureDir(path.join(dir, 'work')),
      model: models.spec || models.analysis,
      effort: models.effort,
      log,
      outputSchema: outputSchema('spec', 'specModel'),
      buildPrompt: (repair) => prompts.specPrompt({ ticket: key, requirements, evidenceBlocks: blocks, feedback, repair }),
      validate: (candidate) => {
        const out = buildSpec({ model: candidate, requirements, ticket: key, blocks });
        if (out.errors) return out.errors;
        built = out.spec;
        return [];
      },
    });
    if (!res.ok) {
      setStage(dir, run, 'spec', res.blocked ? 'ENVIRONMENT_BLOCKED' : 'EXECUTED_FAIL', { errors: res.errors.slice(0, 10) });
      return { dir, state: 'FAILED', message: `spec failed: ${res.errors[0]}` };
    }
    if (fs.existsSync(specFile)) {
      const history = ensureDir(path.join(dir, 'history'));
      fs.renameSync(specFile, path.join(history, `spec-${Date.now()}.json`));
    }
    writeJsonAtomic(specFile, built);
    writeFileAtomic(path.join(dir, 'spec.md'), renderSpecMarkdown(built));
    setStage(dir, run, 'spec', 'EXECUTED_PASS', { ...built.stats, clean: built.clean, feedback_used: feedback ? gateState(dir, 'SPEC').record.at : null });
    delete run.stages.analysis;
    delete run.stages.ready;
    saveRun(dir, run);
  }
  const spec = readJson(specFile);

  if (!isApproved(dir, 'SPEC')) {
    if (process.env.ARW_AUTO_APPROVE_SPEC === '1' && spec.clean && gateState(dir, 'SPEC').decision !== 'rejected') {
      recordGate(dir, 'SPEC', 'approved', { by: 'policy:clean-spec', note: 'auto-approved: no gaps, no contradictions, no inferred rules' });
      log('SPEC auto-approved by policy (clean spec)');
    } else {
      const g = gateState(dir, 'SPEC');
      let why = 'waiting for a decision';
      if (g.decision === 'approved') why = 'the spec changed after approval';
      else if (g.decision === 'rejected') why = g.valid ? 'rejected — the next run rebuilds the spec from your note' : 'rebuilt from your rejection note; waiting for a decision (auto-approval is off after a rejection)';
      const s = spec.stats;
      return {
        dir,
        state: 'AWAIT_GATE_SPEC',
        message: `${why}. ${s.rules} rules, ${s.combinations} combinations, ${s.gaps} gaps, ${s.contradictions} contradictions, ${s.inferred_rules} inferred rules, ${s.items} review items. Review ${path.join(dir, 'spec.md')}, then: arw gate approve|reject --ticket ${key} --gate SPEC [--note "..."]`,
      };
    }
  }

  const items = spec.review_items;
  const stale = run.stages.analysis && run.stages.analysis.spec_sha256 !== gateState(dir, 'SPEC').record.bound.sha256;
  if (!run.stages.analysis || run.stages.analysis.status !== 'EXECUTED_PASS' || stale) {
    if (!executor) return { dir, state: 'FAILED', message: 'analysis needs a model executor' };
    log('analysis');
    const charter = fs.readFileSync(path.join(ROOT, 'agents', 'ticket-analyst.md'), 'utf8');
    const workDir = ensureDir(path.join(dir, 'work'));
    const res = await runLooseJob({
      executor,
      label: 'analysis',
      images: ticketImages(dir).map((i) => i.file),
      workDir,
      cwd: repoDir || workDir,
      model: models.analysis,
      effort: models.effort,
      log,
      outputSchema: outputSchema('analysis'),
      buildPrompt: (repair) => prompts.analysisPrompt({ ticket: key, items, specMarkdown: fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'), evidenceBlocks: evidenceBlocks(dir), charter, hasRepo: Boolean(repoDir), repair }),
      validate: (c) => validateAnalysis(c, { key, items, repoDir }),
    });
    if (!res.ok) {
      setStage(dir, run, 'analysis', res.blocked ? 'ENVIRONMENT_BLOCKED' : 'EXECUTED_FAIL', { errors: res.errors.slice(0, 10) });
      return { dir, state: 'FAILED', message: `analysis failed: ${res.errors[0]}` };
    }
    writeJsonAtomic(path.join(dir, 'analysis.json'), res.value);
    writeFileAtomic(path.join(dir, 'analysis.md'), renderAnalysisMarkdown(res.value, items));
    setStage(dir, run, 'analysis', 'EXECUTED_PASS', { spec_sha256: gateState(dir, 'SPEC').record.bound.sha256, repo_dir: repoDir || null });
  }
  setStage(dir, run, 'ready', 'READY');
  return { dir, state: 'READY', message: `Spec approved and analysed: ${items.length} review items will grade PRs for ${key}.` };
}

// What a PR review may use from a ticket run. Items come from the approved
// spec; without one, from the requirement items, labelled unapproved.
function approvedTicketInputs(key) {
  const dir = ticketDir(key);
  if (!fs.existsSync(dir)) return null;
  const out = { dir, requirements: null, items: null, specMarkdown: null, evidence: null, approved: false };
  if (fs.existsSync(path.join(dir, 'ticket-evidence.md'))) out.evidence = fs.readFileSync(path.join(dir, 'ticket-evidence.md'), 'utf8');
  if (fs.existsSync(path.join(dir, 'requirements.json'))) out.requirements = readJson(path.join(dir, 'requirements.json'));
  if (isApproved(dir, 'SPEC')) {
    const spec = readJson(path.join(dir, 'spec.json'));
    out.items = spec.review_items;
    out.requirements = { ...out.requirements, items: spec.requirement_items };
    out.specMarkdown = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8');
    out.approved = true;
  } else if (out.requirements && out.requirements.items.length) {
    out.items = itemsFromRequirements(out.requirements);
  }
  return out;
}

module.exports = { advanceTicket, approvedTicketInputs, validateAnalysis, renderAnalysisMarkdown, evidenceBlocks, ticketImages };
