'use strict';
// Retrospective over past review runs: where the model calls go, what the
// validator keeps rejecting, which reviewers produce findings people keep,
// and rule-based suggestions on what to change. Reads run directories only;
// no model is involved, so the numbers can be trusted as measurements.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists, nowIso } = require('./util');
const { RUNS } = require('./runs');
const memory = require('./memory');

// A validator message without its specifics, so the same mistake counts once.
function errorPattern(msg) {
  return String(msg)
    .replace(/\s*\(one of:[^)]*\)/g, '')
    .replace(/\[\d+\]/g, '[]')
    .replace(/"[^"]{0,200}"/g, '"…"')
    .replace(/`[^`]{0,200}`/g, '`…`')
    .replace(/\b[a-f0-9]{12,64}\b/g, '<sha>')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

// plan, rebuttal, synthesis, repro or packet:<unit kind>/<role>.
function jobKind(label) {
  if (label === 'plan' || label === 'synthesis') return label;
  if (label.startsWith('rebuttal-')) return 'rebuttal';
  if (label.startsWith('repro')) return 'repro';
  const m = /^([A-Z])[A-Za-z0-9_]*-(business|technical)$/.exec(label);
  if (m) return `packet:${{ B: 'business', T: 'technical', O: 'orphan', S: 'seam', V: 'viewpoint' }[m[1]] || m[1]}/${m[2]}`;
  return 'other';
}

const UNIT_KIND = { B: 'business', T: 'technical', O: 'orphan', S: 'seam', V: 'viewpoint' };

function within(at, since) {
  return !since || (at && String(at) >= since);
}

function walkRuns({ sinceDays } = {}) {
  const since = sinceDays ? new Date(Date.now() - sinceDays * 86400000).toISOString() : null;
  const base = path.join(RUNS, 'prs');
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const id of fs.readdirSync(base)) {
    const dir = path.join(base, id);
    const run = readJsonIfExists(path.join(dir, 'run.json'));
    if (!run || !run.identity) continue;
    const revBase = path.join(dir, 'review', 'revisions');
    const revisions = fs.existsSync(revBase) ? fs.readdirSync(revBase).map((r) => path.join(revBase, r)) : [];
    const at = Object.values(run.phases || {}).map((p) => p.at).filter(Boolean).sort().pop() || run.created_at;
    if (!within(at, since)) continue;
    out.push({ id, dir, run, revisions, at });
  }
  return out;
}

function retrospective({ sinceDays } = {}) {
  const runs = walkRuns({ sinceDays });
  const kinds = {};
  const patterns = new Map();
  const blocked = {};
  const totals = { runs: runs.length, calls: 0, repairs: 0, input_tokens: 0, output_tokens: 0, elapsed_ms: 0, budget_stops: 0, findings: 0, withdrawn: 0, confirmed: 0 };
  const perRun = [];
  const producers = {};
  const kindOf = (k) => (kinds[k] = kinds[k] || { jobs: 0, calls: 0, repairs: 0, first_try: 0, failed: 0, input_tokens: 0 });
  const addPattern = (msg, kind, where) => {
    const key = errorPattern(msg);
    const p = patterns.get(key) || { pattern: key, count: 0, kinds: {}, example: String(msg).slice(0, 300), where };
    p.count += 1;
    p.kinds[kind] = (p.kinds[kind] || 0) + 1;
    patterns.set(key, p);
  };

  for (const r of runs) {
    const receiptSets = [
      ...r.revisions.map((rev) => readJsonIfExists(path.join(rev, 'receipts.json'), {})),
      readJsonIfExists(path.join(r.dir, 'plan-work', 'receipts.json'), {}),
    ];
    let runCalls = 0;
    let runTokens = 0;
    let sawErrors = false;
    for (const set of receiptSets) {
      for (const [key, list] of Object.entries(set)) {
        const label = list[0] && list[0].label ? list[0].label : key;
        const kind = jobKind(label);
        const k = kindOf(kind);
        k.jobs += 1;
        if (list.length === 1 && !list[0].error_class && !list[0].validation_errors) k.first_try += 1;
        for (const rc of list) {
          k.calls += 1;
          runCalls += 1;
          if (rc.mode === 'repair') k.repairs += 1;
          const inTok = (rc.usage && rc.usage.input_tokens) || 0;
          k.input_tokens += inTok;
          runTokens += inTok;
          totals.output_tokens += (rc.usage && rc.usage.output_tokens) || 0;
          totals.elapsed_ms += rc.elapsed_ms || 0;
          if (rc.error_class) blocked[rc.error_class] = (blocked[rc.error_class] || 0) + 1;
          for (const e of rc.errors || []) {
            sawErrors = true;
            addPattern(e, kind, r.id);
          }
        }
      }
    }
    // Runs from before receipts kept error samples: the driver log has the first error of each rejection.
    if (!sawErrors) {
      const log = path.join(r.dir, 'review', 'driver.log');
      if (fs.existsSync(log)) {
        for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
          const m = / rejected (\S+): \d+ error\(s\); first: (.*)$/.exec(line);
          if (m) addPattern(m[2], jobKind(m[1]), r.id);
        }
      }
    }
    totals.calls += runCalls;
    totals.input_tokens += runTokens;
    for (const k of Object.values(kinds)) k.failed = k.failed || 0;
    // Findings and who produced them, on the current context.
    const pointer = readJsonIfExists(path.join(r.dir, 'review', 'context.json'));
    const v = pointer && readJsonIfExists(path.join(r.dir, 'review', 'revisions', pointer.context_id, 'validation.json'));
    if (v) {
      for (const j of v.jobs) {
        if (j.status === 'EXECUTED_FAIL') kindOf(`packet:${UNIT_KIND[j.unit_id[0]] || j.unit_id[0]}/${j.role}`).failed += 1;
        if (j.status === 'BUDGET_EXCEEDED') totals.budget_stops += 1;
      }
      const fb = readJsonIfExists(path.join(r.dir, 'feedback.json'));
      const verdict = new Map(((fb && fb.findings) || []).map((f) => [f.id, f.verdict]));
      for (const f of v.findings) {
        totals.findings += 1;
        if (f.state === 'withdrawn') totals.withdrawn += 1;
        if (f.label === 'CONFIRMED') totals.confirmed += 1;
        const m = /^([A-Z])[A-Za-z0-9_]*-(business|technical)-F\d+$/.exec(f.id);
        const who = m ? `${UNIT_KIND[m[1]] || m[1]}/${m[2]}` : 'other';
        const p = (producers[who] = producers[who] || { findings: 0, withdrawn: 0, canonical: 0, kept: 0, dropped: 0 });
        p.findings += 1;
        if (f.state === 'withdrawn') p.withdrawn += 1;
        if (f.canonical !== false) p.canonical += 1;
        const vd = verdict.get(f.id);
        if (vd === 'kept' || vd === 'edited') p.kept += 1;
        if (vd === 'dropped') p.dropped += 1;
      }
    }
    perRun.push({ id: r.id, at: r.at, calls: runCalls, input_tokens: runTokens, status: v ? v.status : 'NOT_VALIDATED', findings: v ? v.findings.length : 0 });
  }
  for (const k of Object.values(kinds)) {
    k.repair_rate = k.calls ? Math.round((k.repairs / k.calls) * 1000) / 1000 : null;
    k.first_try_rate = k.jobs ? Math.round((k.first_try / k.jobs) * 1000) / 1000 : null;
  }
  totals.repairs = Object.values(kinds).reduce((n, k) => n + k.repairs, 0);
  const rejections = memory.loadMemory().entries.filter((e) => !sinceDays || within(e.at, new Date(Date.now() - sinceDays * 86400000).toISOString()));
  const result = {
    at: nowIso(),
    since_days: sinceDays || null,
    totals,
    kinds,
    patterns: [...patterns.values()].sort((a, b) => b.count - a.count),
    blocked,
    producers,
    rejections: { count: rejections.length, by_source: count(rejections.map((e) => e.source.split(' ')[0])), reasons: rejections.slice(-10).map((e) => ({ scope: e.scope, title: e.title, reason: e.reason })) },
    runs: perRun.sort((a, b) => String(b.at).localeCompare(String(a.at))),
  };
  result.suggestions = suggestions(result);
  return result;
}

function count(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] || 0) + 1;
  return out;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// Deterministic rules over the measurements. Each suggestion names the
// evidence it is based on, so a person can check it before acting.
function suggestions(r) {
  const out = [];
  const t = r.totals;
  if (t.calls >= 10 && t.repairs / t.calls >= 0.2) {
    const top = r.patterns[0];
    out.push({ area: 'prompts', text: `${pct(t.repairs / t.calls)} of model calls were repairs.${top ? ` Most common rejection (${top.count}×): "${top.pattern}". State that rule plainly in the prompt, or let the runtime fill or canonicalize the field.` : ''}` });
  }
  for (const p of r.patterns.slice(0, 5)) {
    if (p.count >= 3) out.push({ area: 'validator', text: `"${p.pattern}" was rejected ${p.count}× (${Object.entries(p.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}). Example: ${p.example}` });
  }
  for (const [kind, k] of Object.entries(r.kinds)) {
    if (k.jobs >= 5 && k.first_try_rate != null && k.first_try_rate < 0.5) out.push({ area: 'prompts', text: `${kind}: only ${pct(k.first_try_rate)} of ${k.jobs} jobs were accepted on the first try.` });
    if (k.failed >= 2) out.push({ area: 'coverage', text: `${kind}: ${k.failed} job(s) ended invalid after every repair, leaving reviews incomplete.` });
  }
  if (t.findings >= 10 && t.withdrawn / t.findings >= 0.3) out.push({ area: 'first pass', text: `The red team withdrew ${pct(t.withdrawn / t.findings)} of ${t.findings} findings: first passes over-report. Tighten the evidence bar in the reviewer charters.` });
  for (const [who, p] of Object.entries(r.producers)) {
    const decided = p.kept + p.dropped;
    if (decided >= 5 && p.kept / decided < 0.5) out.push({ area: 'noise', text: `${who}: people kept ${p.kept} of ${decided} published findings (${pct(p.kept / decided)}). Look at what was dropped (arw memory) and narrow this reviewer.` });
  }
  const runs = r.runs.length;
  for (const [who, p] of Object.entries(r.producers)) {
    if (runs >= 5 && p.canonical === 0) out.push({ area: 'cost', text: `${who} produced no finding of its own in ${runs} runs; consider --single-role or skipping it.` });
  }
  for (const kind of ['synthesis', 'rebuttal', 'plan']) {
    const k = r.kinds[kind];
    if (k && runs >= 5 && t.input_tokens && k.input_tokens / t.input_tokens > 0.3) out.push({ area: 'cost', text: `${kind} uses ${pct(k.input_tokens / t.input_tokens)} of all input tokens.` });
  }
  if (t.budget_stops) out.push({ area: 'budget', text: `${t.budget_stops} job(s) stopped at the budget ceiling; raise ARW_MAX_CALLS / ARW_MAX_INPUT_TOKENS or split large PRs.` });
  for (const [cls, n] of Object.entries(r.blocked)) {
    if (['rate_limit', 'auth', 'billing', 'config'].includes(cls)) out.push({ area: 'executor', text: `${n} call(s) failed with ${cls}.` });
  }
  if (!out.length) out.push({ area: 'none', text: runs ? 'Nothing stands out yet. Suggestions appear once enough runs and feedback exist.' : 'No review runs found.' });
  return out;
}

function renderRetro(r) {
  const t = r.totals;
  const lines = [
    `# Retrospective (${r.since_days ? `last ${r.since_days} days` : 'all runs'}, ${r.at})`,
    '',
    `- ${t.runs} run(s) · ${t.calls} model calls (${t.repairs} repairs) · tokens in ${t.input_tokens} / out ${t.output_tokens}`,
    `- ${t.findings} finding(s): ${t.withdrawn} withdrawn by the red team, ${t.confirmed} CONFIRMED by reproduction · ${t.budget_stops} budget stop(s)`,
    `- ${r.rejections.count} remembered rejection(s)`,
    '',
    '## Suggestions',
    '',
    ...r.suggestions.map((s) => `- **${s.area}** — ${s.text}`),
    '',
    '## Jobs',
    '',
    '| Kind | Jobs | Calls | Repairs | First try | Ended invalid | Input tokens |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(r.kinds).sort((a, b) => b[1].input_tokens - a[1].input_tokens).map(([k, x]) => `| ${k} | ${x.jobs} | ${x.calls} | ${x.repairs} | ${x.first_try_rate == null ? '–' : pct(x.first_try_rate)} | ${x.failed} | ${x.input_tokens} |`),
    '',
    '## Most common validator rejections',
    '',
    ...(r.patterns.length ? r.patterns.slice(0, 15).map((p) => `- ${p.count}× \`${p.pattern}\` (${Object.keys(p.kinds).join(', ')})`) : ['(none recorded)']),
    '',
    '## Who produces findings',
    '',
    '| Reviewer | Findings | Own (canonical) | Withdrawn | Kept | Dropped |',
    '|---|---|---|---|---|---|',
    ...Object.entries(r.producers).map(([w, p]) => `| ${w} | ${p.findings} | ${p.canonical} | ${p.withdrawn} | ${p.kept} | ${p.dropped} |`),
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { retrospective, renderRetro, errorPattern, jobKind };
