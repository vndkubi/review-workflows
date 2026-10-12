'use strict';
// Unattended PR review, end to end:
//   0 prepare (PR info, worktree) -> 0.5 ticket inputs -> 1 plan (model)
//   -> 2 freeze (no model) -> 3 batch (driver waves) -> 4 validate + report.
// Every phase is resumable: a valid plan and frozen context are reused when
// the PR head and the tool are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJson, readJsonIfExists, writeJsonAtomic, writeFileAtomic, nowIso, ensureDir } = require('./util');
const git = require('./git');
const { parsePatch } = require('./patch');
const { buildEvidencePack } = require('./evidence-pack');
const { validateAgainst, outputSchema } = require('./schema');
const { buildUnits, renderPlanMarkdown } = require('./plan');
const { freezeContext, loadContext, verifyContext } = require('./freeze');
const { runLooseJob } = require('./loose-job');
const { runBatch, finish } = require('./driver');
const { writeReport } = require('./report');
const { extractTicketKey } = require('./jira');
const { approvedTicketInputs } = require('./ticket-pipeline');
const { prDir, worktreeDir } = require('./runs');
const github = require('./github');
const prompts = require('./prompts');

function phase(run, runDir, name, status, extra = {}) {
  run.phases[name] = { status, at: nowIso(), ...extra };
  writeJsonAtomic(path.join(runDir, 'run.json'), run);
}

// Phase 0. `prepared` lets tests inject a ready checkout instead of GitHub.
function prepare({ repo, pr, prepared }) {
  const runDir = ensureDir(prDir(repo, pr));
  let info;
  let wt;
  if (prepared) {
    ({ info } = prepared);
    wt = { checkout: prepared.checkout, head: prepared.head, base: prepared.base, source: prepared.checkout };
  } else {
    info = github.prView(repo, pr);
    wt = github.preparePrWorktree({ repo, pr, info, worktree: worktreeDir(repo, pr) });
  }
  const runFile = path.join(runDir, 'run.json');
  const previous = readJsonIfExists(runFile);
  const run = previous && previous.identity && previous.identity.head_sha === wt.head ? previous : { schema_version: '1.0', kind: 'pr-review', created_at: nowIso(), phases: {} };
  if (previous && previous !== run) run.previous_head = previous.identity && previous.identity.head_sha;
  run.identity = {
    repo,
    pr,
    title: info.title,
    url: info.url || null,
    head_ref: info.headRefName,
    base_ref: info.baseRefName,
    head_sha: wt.head,
    base_sha: wt.base,
    checkout: wt.checkout,
    source_checkout: wt.source,
    ticket: run.identity && run.identity.ticket,
  };
  writeFileAtomic(path.join(runDir, 'pr-body.txt'), info.body || '');
  phase(run, runDir, 'prepare', 'EXECUTED_PASS');
  return { runDir, run, info };
}

// Phase 0.5: review items from the ticket's approved spec when it exists;
// otherwise one item per requirement item, frozen but labelled unapproved.
function ticketInputs(run, { ticket, info }) {
  const key = ticket || extractTicketKey(info.title, info.headRefName, (info.body || '').slice(0, 2000));
  run.identity.ticket = key || null;
  if (!key) return { key: null };
  const t = approvedTicketInputs(key);
  if (!t) return { key, note: `no ticket run for ${key}; run "arw ticket ${key}" first for requirement-grounded review` };
  return { key, ...t };
}

async function planPhase({ runDir, run, info, executor, models, log, singleRole, tickets }) {
  const { checkout, head_sha: head, base_sha: base } = run.identity;
  const changed = git.changedFiles(checkout, base, head);
  const patch = git.diffPatch(checkout, base, head);
  const parsed = parsePatch(patch);
  const pack = buildEvidencePack({ cwd: checkout, base, head, changed, parsed });
  const reviewable = pack.reviewable.filter((f) => f.status !== 'D').map((f) => f.path);
  const deleted = pack.reviewable.filter((f) => f.status === 'D').map((f) => f.path);
  const stats = Object.fromEntries(parsed.map((p) => [p.path, { added: p.added, removed: p.removed }]));
  const requirements = tickets.requirements && tickets.requirements.items.length ? tickets.requirements : null;
  const items = tickets.items && tickets.items.length ? tickets.items : null;
  if (!reviewable.length) throw new Error('the PR changes no reviewable files');

  const planFile = path.join(runDir, 'plan.json');
  let built;
  const cached = readJsonIfExists(planFile);
  if (cached && cached.head_sha === head && cached.items_sha === JSON.stringify(items)) {
    built = buildUnits(cached.plan, reviewable, items, { singleRole });
    if (built.errors.length) built = null;
  }
  let plan = built ? cached.plan : null;
  if (!built) {
    const res = await runLooseJob({
      executor,
      label: 'plan',
      outputSchema: outputSchema('review', 'plan'),
      workDir: ensureDir(path.join(runDir, 'plan-work')),
      cwd: checkout,
      model: models.plan,
      effort: models.effort,
      log,
      buildPrompt: (repair) =>
        prompts.planPrompt({
          identity: run.identity,
          reviewable,
          skipped: [...pack.skipped.map((f) => f.path), ...deleted.map((f) => `${f} (deleted)`)],
          stats,
          evidencePack: pack.text,
          items,
          specMarkdown: tickets.specMarkdown,
          prBody: info.body,
          repair,
          plannerCharter: fs.readFileSync(path.join(ROOT, 'agents', 'planner.md'), 'utf8'),
        }),
      validate: (candidate) => {
        const errors = validateAgainst('review', candidate, 'plan');
        return errors.length ? errors : buildUnits(candidate, reviewable, items, { singleRole }).errors;
      },
    });
    if (!res.ok) throw new Error(`planning failed: ${res.errors.join('; ')}`);
    plan = res.value;
    built = buildUnits(plan, reviewable, items, { singleRole });
    writeJsonAtomic(planFile, { head_sha: head, items_sha: JSON.stringify(items), plan });
  }
  run.review = { plan_path: 'pr-review-plan.md', required_coverage: built.required_coverage, units: built.units, single_role: Boolean(singleRole) };
  const planMd = renderPlanMarkdown({ identity: run.identity, plan, units: built.units, items, reviewable, skipped: pack.skipped.map((f) => f.path) });
  writeFileAtomic(path.join(runDir, 'pr-review-plan.md'), planMd);
  phase(run, runDir, 'plan', 'EXECUTED_PASS', { units: built.units.length });
  return { changed, patch, pack, reviewable, requirements, items, planMd };
}

function freezePhase({ runDir, run, info, tickets, planned }) {
  const inputs = [
    { id: 'evidence-pack', kind: 'evidence', content: planned.pack.text },
    { id: 'plan', kind: 'plan', content: planned.planMd },
    { id: 'pr-body', kind: 'untrusted', content: info.body || '' },
  ];
  const kind = tickets.approved ? 'requirement' : 'requirement-unapproved';
  if (planned.requirements) inputs.push({ id: 'requirements', kind, content: `${JSON.stringify(planned.requirements, null, 2)}\n` });
  if (planned.items) inputs.push({ id: 'review-items', kind, content: `${JSON.stringify(planned.items, null, 2)}\n` });
  if (tickets.specMarkdown) inputs.push({ id: 'spec', kind, content: tickets.specMarkdown });
  if (tickets.evidence) inputs.push({ id: 'ticket-evidence', kind: 'untrusted', content: tickets.evidence });
  const context = freezeContext({
    runDir,
    checkout: run.identity.checkout,
    base: run.identity.base_sha,
    head: run.identity.head_sha,
    changed: planned.changed,
    reviewable: planned.reviewable,
    patch: planned.patch,
    review: run.review,
    inputs,
  });
  phase(run, runDir, 'freeze', 'EXECUTED_PASS', { context_id: context.context_id });
  return context;
}

async function reviewPr({ repo, pr, ticket, executor, preflight, models = {}, workers, singleRole, skipSeams, skipRebuttals, skipSynthesis, refresh, log = () => {}, prepared }) {
  const { runDir, run, info } = prepare({ repo, pr, prepared });
  log(`run dir ${runDir}; head ${run.identity.head_sha.slice(0, 12)} base ${run.identity.base_sha.slice(0, 12)}`);
  const tickets = ticketInputs(run, { ticket, info });
  if (tickets.note) log(tickets.note);
  if (tickets.items && !tickets.approved) log(`the spec for ${tickets.key} is NOT approved; review items come from raw requirement items and are labelled unapproved`);
  phase(run, runDir, 'ticket', tickets.key ? 'EXECUTED_PASS' : 'SKIPPED', { ticket: tickets.key, spec_approved: Boolean(tickets.approved), items: tickets.items ? tickets.items.length : 0 });

  // Reuse the frozen context when it still holds.
  let context = null;
  if (!refresh) {
    try {
      context = loadContext(runDir);
      const drift = verifyContext(runDir, context);
      if (drift.length || context.source.head_sha !== run.identity.head_sha) {
        log(`frozen context ${context.context_id} is stale: ${drift.join('; ') || 'PR head moved'}`);
        context = null;
      } else {
        log(`reusing frozen context ${context.context_id}`);
      }
    } catch {
      context = null;
    }
  }
  if (!context) {
    if (preflight) {
      const pf = await preflight();
      if (!pf.ok) throw new Error(`executor preflight failed (${pf.error_class}): ${pf.error_message}`);
    }
    const planned = await planPhase({ runDir, run, info, executor, models, log, singleRole, tickets });
    context = freezePhase({ runDir, run, info, tickets, planned });
    log(`froze context ${context.context_id} (${run.review.units.length} units)`);
  } else if (preflight) {
    const pf = await preflight();
    if (!pf.ok) throw new Error(`executor preflight failed (${pf.error_class}): ${pf.error_message}`);
  }

  phase(run, runDir, 'batch', 'RUNNING');
  const validation = await runBatch({ runDir, executor, workers, skipSeams, skipRebuttals, skipSynthesis, models });
  const fresh = readJson(path.join(runDir, 'run.json'));
  fresh.phases.batch = { status: validation.status, at: nowIso() };
  writeJsonAtomic(path.join(runDir, 'run.json'), fresh);
  const report = writeReport(runDir, validation, fresh.identity);
  return { runDir, validation, report };
}

// Re-validate on disk and re-render, with no model calls.
function revalidate(runDir) {
  const validation = finish(runDir);
  const run = readJson(path.join(runDir, 'run.json'));
  return { validation, report: writeReport(runDir, validation, run.identity) };
}

module.exports = { reviewPr, revalidate, prepare, planPhase, freezePhase };
