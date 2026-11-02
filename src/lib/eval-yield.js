'use strict';
// Stage yield: what each stage of a review costs and what it finds, over
// stored eval runs scored on the current labels. No model call. It answers
// which stages earn their tokens: a stage whose findings are never true and
// whose labels another stage also finds is a candidate to drop or merge
// (measured then with a matrix cell, never decided from this table alone).
const path = require('node:path');
const { readJsonIfExists } = require('./util');
const { revisionDir } = require('./freeze');

// "sweep": the checklist sweeps V0/V1 that the free review replaced (runs
// before 18 Oct 2026).
const STAGES = ['raw', 'plan', 'plain', 'free', 'sweep', 'business', 'technical', 'orphan', 'seam', 'red team', 'synthesis', 'other'];

function unitStage(unit) {
  if (!unit) return 'other';
  if (unit.plain) return 'plain';
  if (unit.hunt) return 'free';
  if (['business', 'technical', 'orphan', 'seam'].includes(unit.kind)) return unit.kind;
  if (unit.kind === 'viewpoint') return 'sweep';
  return 'other';
}

// Job key (receipt outRel) -> stage. Packets and plain reviews belong to
// their unit; a plain review's prose and its conversion are both "plain".
function jobStage(key, units) {
  if (key === 'synthesis.json') return 'synthesis';
  if (key.startsWith('rebuttals/')) return 'red team';
  const m = key.match(/^(?:packets\/[a-z]+|plain)\/([^/]+)\.json$/);
  return m ? unitStage(units.get(m[1])) : 'other';
}

// Finding id "<unit>-<role>-F<n>" -> stage; a raw-prompt finding is "raw".
function findingStage(id, units, raw) {
  if (raw) return 'raw';
  const m = String(id).match(/^(.+)-(?:business|technical)-F\d+$/);
  return m ? unitStage(units.get(m[1])) : 'other';
}

// The receipts of one case run, keyed by job: { key: [attempt, ...] }.
function jobsOf(runDir) {
  const raw = readJsonIfExists(path.join(runDir, 'raw-review.json'));
  if (raw) return { raw: true, units: new Map(), jobs: [['raw', raw.receipts || []]] };
  const run = readJsonIfExists(path.join(runDir, 'run.json')) || {};
  const units = new Map(((run.review && run.review.units) || []).map((u) => [u.id, u]));
  const jobs = [];
  const plan = readJsonIfExists(path.join(runDir, 'plan-work', 'receipts.json'));
  if (plan) jobs.push(...Object.values(plan).map((list) => ['plan', list]));
  const pointer = readJsonIfExists(path.join(runDir, 'review', 'context.json'));
  const review = pointer ? readJsonIfExists(path.join(revisionDir(runDir, pointer.context_id), 'receipts.json')) : null;
  for (const [key, list] of Object.entries(review || {})) jobs.push([jobStage(key, units), list]);
  return { raw: false, units, jobs };
}

function median(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.ceil(v.length / 2) - 1] : null;
}

// cards: scorecards scored on the current labels (eval.scoredNow), with the
// directory each was stored in. Returns { stages: [row, ...], cases }.
function stageYield(cards) {
  const rows = new Map(STAGES.map((s) => [s, { stage: s, jobs: 0, calls: 0, repairs: 0, input_tokens: 0, reads: [], findings: 0, tp: 0, fp: 0, unlabelled: 0, labels: new Set(), only: new Set() }]));
  let cases = 0;
  for (const { card, dir } of cards) {
    for (const s of card.cases) {
      if (!s.run_dir || s.status === 'NO_RESULT') continue;
      cases += 1;
      const { raw, units, jobs } = jobsOf(path.join(dir, s.run_dir));
      for (const [stage, list] of jobs) {
        const row = rows.get(stage);
        row.jobs += 1;
        for (const r of list) {
          if (r.mode === 'rate_limited') continue;
          row.calls += 1;
          if (r.mode === 'repair') row.repairs += 1;
          row.input_tokens += (r.usage && r.usage.input_tokens) || 0;
          if (typeof r.commands === 'number') row.reads.push(r.commands);
        }
      }
      const tag = `${card.id}/${s.id}${s.repeat > 1 ? `#${s.repeat}` : ''}`;
      const stageOf = new Map();
      for (const f of (s.details && s.details.findings) || []) {
        const stage = findingStage(f.id, units, raw);
        stageOf.set(f.id, stage);
        const row = rows.get(stage);
        row.findings += 1;
        if (f.verdict === 'tp') row.tp += 1;
        else if (f.verdict === 'fp') row.fp += 1;
        else row.unlabelled += 1;
      }
      for (const e of (s.details && s.details.expected) || []) {
        const by = new Set((e.by || []).map((id) => stageOf.get(id) || findingStage(id, units, raw)));
        for (const stage of by) rows.get(stage).labels.add(`${tag}/${e.id}`);
        if (by.size === 1) rows.get([...by][0]).only.add(`${tag}/${e.id}`);
      }
    }
  }
  const stages = [...rows.values()]
    .filter((r) => r.jobs || r.findings)
    .map(({ reads, labels, only, ...r }) => ({ ...r, reads_p50: median(reads), reads_jobs: reads.length, labels_found: labels.size, labels_only: only.size }));
  return { stages, cases };
}

function renderYield({ stages, cases }, runIds) {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const calls = stages.reduce((n, r) => n + r.calls, 0);
  const tokens = stages.reduce((n, r) => n + r.input_tokens, 0);
  const out = [
    `# Stage yield: ${runIds.join(', ')}`,
    '',
    `${cases} case run(s), scored on the current labels. "only" = labels no other stage found: what dropping the stage would lose on these cases.`,
    '',
    '| Stage | Jobs | Calls | Repairs | Input tokens | Reads/job p50 | Findings | TP | FP | Unlabelled | Labels found | only |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of stages) {
    out.push(`| ${r.stage} | ${r.jobs} | ${r.calls} (${pct(r.calls, calls)}) | ${r.repairs} | ${(r.input_tokens / 1e6).toFixed(1)}M (${pct(r.input_tokens, tokens)}) | ${r.reads_p50 == null ? '-' : r.reads_p50} | ${r.findings} | ${r.tp} | ${r.fp} | ${r.unlabelled} | ${r.labels_found} | ${r.labels_only} |`);
  }
  return out.join('\n');
}

module.exports = { stageYield, renderYield, jobStage, findingStage, STAGES };
