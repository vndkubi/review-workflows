'use strict';
// Two-step publish: the runtime creates a PENDING GitHub review (visible only
// to the person running it); that person edits, then submits it on GitHub
// with their own verdict. Each comment carries a stable finding marker so
// acceptance can be measured later.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJsonAtomic, nowIso } = require('./util');
const { loadContext, revisionDir } = require('./freeze');
const { parsePatch, commentableLines } = require('./patch');
const { packetRel } = require('./driver');
const { diffBlock } = require('./report');
const { SEVERITY_RANK } = require('./cluster');
const memory = require('./memory');
const { bodyHash } = require('./feedback');

function marker(findingId, contextId) {
  return `<!-- arw:finding=${findingId} context=${contextId} -->`;
}

function commentBody(f, meta, contextId, rejected) {
  const lines = [
    `**[${f.severity}] ${f.title}** · ${meta.label} · votes ${meta.votes}${meta.state === 'stands' ? ' · red-team defense failed' : ''}`,
    '',
    `**Current:** ${f.asis}`,
    `**Expected:** ${f.tobe}`,
    '',
    `**Scenario:** Given ${f.trigger.given}; when ${f.trigger.when}; then ${f.trigger.then}.`,
    `**Impact:** ${f.impact}`,
    `**Authority:** ${f.authority.kind} \`${f.authority.id}\``,
  ];
  if (meta.repro && meta.repro.status === 'RED_PROVEN') {
    lines.push('', `**Reproduced** by a test that fails twice on this commit${meta.repro.test ? ` (\`${meta.repro.test}\`)` : ''}${meta.repro.fix_verified ? '; the suggested fix makes it pass' : ''}.`);
  }
  if (rejected) lines.push('', `_A similar finding was rejected earlier (${rejected.reason}); it is kept because of its severity._`);
  if (f.fix.kind === 'code_change') lines.push('', `**Suggested fix** — ${f.fix.reason}`, '', diffBlock(f.fix.asis, f.fix.tobe));
  else lines.push('', `**Decision needed:** ${f.fix.reason}`);
  lines.push('', marker(f.id, contextId));
  return lines.join('\n');
}

// Returns { comments, summaryOnly, body } without calling GitHub.
function buildReview(runDir, { minSeverity = 'P3' } = {}) {
  const context = loadContext(runDir);
  const dir = revisionDir(runDir, context.context_id);
  const validation = readJson(path.join(dir, 'validation.json'));
  if (validation.context_digest !== context.context_digest) throw new Error('validation.json is for another context; re-run validate');
  const run = readJson(path.join(runDir, 'run.json'));
  const files = new Map(parsePatch(fs.readFileSync(path.join(dir, 'review.patch'), 'utf8')).map((f) => [f.path, commentableLines(f)]));
  const synthesis = validation.synthesis.valid ? readJson(path.join(dir, 'synthesis.json')) : null;
  const aliased = new Set((synthesis ? synthesis.aliases : []).map((a) => a.id));
  const byId = new Map();
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    for (const f of readJson(path.join(dir, packetRel(job.unit_id, job.role))).findings) byId.set(f.id, f);
  }
  const metas = validation.findings
    .filter((m) => m.state !== 'withdrawn' && !aliased.has(m.id) && m.canonical !== false && SEVERITY_RANK[m.severity] <= SEVERITY_RANK[minSeverity])
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id));
  const comments = [];
  const summaryOnly = [];
  const omitted = [];
  const scope = memory.memoryScope(run.identity);
  const entries = memory.loadMemory().entries;
  for (const meta of metas) {
    const f = byId.get(meta.id);
    if (!f) continue;
    const match = memory.matchRejected(f, { scope, run: path.basename(runDir) }, entries);
    const action = memory.publishAction(f, match);
    if (action === 'omit') {
      omitted.push({ finding_id: f.id, severity: f.severity, title: f.title, rejected: match });
      continue;
    }
    const body = commentBody(f, meta, context.context_id, action === 'publish_with_note' ? match : null);
    const ev = f.evidence.find((e) => e.kind === 'code' && e.revision !== 'base' && files.has(e.path));
    const lines = ev ? files.get(ev.path) : null;
    const line = lines ? [ev.end_line, ev.start_line].find((l) => lines.has(l)) : null;
    if (ev && line) comments.push({ path: ev.path, line, side: 'RIGHT', body, finding_id: f.id });
    else summaryOnly.push({ body, finding_id: f.id });
  }
  const header = [
    `Automated review draft for \`${run.identity.head_sha.slice(0, 12)}\` — ${comments.length + summaryOnly.length} finding(s), runtime recommendation **${validation.recommendation}**${validation.complete ? '' : ' (review incomplete)'}.`,
    'Findings are SUSPECTED (static evidence, quotes machine-verified) unless marked otherwise. A person reviewed and submitted this draft.',
  ];
  if (validation.warnings && validation.warnings.length) {
    header.push('', `**Instruction-like text aimed at automated reviewers** was found in this PR (${validation.warnings.length}); it was treated as data:`, ...validation.warnings.map((w) => `- \`${w.where}\` ${w.text}`));
  }
  if (omitted.length) header.push('', `${omitted.length} finding(s) were left out because a person rejected them or similar ones before.`);
  if (validation.gaps.length) header.push('', '**Not verified:**', ...validation.gaps.map((g) => `- ${g}`));
  if (summaryOnly.length) header.push('', '---', '', ...summaryOnly.map((s) => s.body).join('\n\n---\n\n').split('\n'));
  return { context, run, comments, summaryOnly, omitted, body: header.join('\n') };
}

function publish(runDir, { minSeverity, dryRun, createPendingReview }) {
  const identity = readJson(path.join(runDir, 'run.json')).identity || {};
  if (identity.local && !dryRun) throw new Error('this is a local review: there is no pull request to publish to yet (use --dry-run, or open a PR and review it)');
  const review = buildReview(runDir, { minSeverity });
  const record = {
    at: nowIso(),
    context_id: review.context.context_id,
    head_sha: review.run.identity.head_sha,
    inline: review.comments.map((c) => ({ finding_id: c.finding_id, path: c.path, line: c.line })),
    summary_only: review.summaryOnly.map((s) => s.finding_id),
    omitted: review.omitted.map((o) => ({ finding_id: o.finding_id, entry_id: o.rejected.entry_id })),
    bodies: Object.fromEntries([...review.comments, ...review.summaryOnly].map((c) => [c.finding_id, bodyHash(c.body)])),
    dry_run: Boolean(dryRun),
  };
  if (!dryRun) {
    const res = createPendingReview({
      repo: review.run.identity.repo,
      pr: review.run.identity.pr,
      commitId: review.run.identity.head_sha,
      body: review.body,
      comments: review.comments.map(({ finding_id, ...c }) => c),
    });
    record.review_id = res.id;
    record.html_url = res.html_url;
  }
  writeJsonAtomic(path.join(runDir, 'published.json'), record);
  return { record, review };
}

module.exports = { buildReview, publish, marker };
