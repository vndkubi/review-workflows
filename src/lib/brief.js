'use strict';
// The review brief: one screen at the top of the report and the dashboard.
// It says what the PR does, how the code at head meets each situation the
// spec names, who else is affected, what a person must decide, and the order
// to read the files in. The runtime assembles it from validated artifacts
// only: every line names the artifact it comes from (H, B, I, C, Q ids or a
// finding id), so the brief adds no model text of its own.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists } = require('./util');
const { revisionDir } = require('./freeze');
const { packetRel } = require('./driver');
const { effectiveAliases } = require('./outcome');
const { TEST } = require('./viewpoint-checks');

const BLOCKING = new Set(['P1', 'P2']);
const RESULT_ORDER = ['fail', 'cannot_determine', 'not_graded', 'not_applicable', 'pass'];
const ATTENTION = new Set(['broken', 'cannot_determine', 'not_answered']);
const MAX_ROWS = 10;

// Cells of a markdown table row; "\|" stays inside its cell.
function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

// Scenario values per feature, from the "### Scenarios" tables spec.js
// renders: Map("F1:S1" -> { variable: value }).
function parseScenarios(specMd) {
  const out = new Map();
  let feature = null;
  let header = null;
  for (const line of String(specMd || '').split('\n')) {
    const f = /^## (F\d+)\b/.exec(line);
    if (f) {
      feature = f[1];
      header = null;
      continue;
    }
    if (/^\| ID \|/.test(line)) {
      header = cells(line);
      continue;
    }
    if (!header || !feature) continue;
    if (!/^\| S\d+ \|/.test(line)) {
      if (!/^\|/.test(line)) header = null;
      continue;
    }
    const row = cells(line);
    const values = {};
    header.forEach((name, i) => {
      if (i === 0 || name === 'Expected' || name === 'Rule') return;
      values[name] = row[i];
    });
    out.set(`${feature}:${row[0]}`, values);
  }
  return out;
}

// "- **Q1** (gap) text" lines of the spec's "## Open questions".
function parseQuestions(specMd) {
  const out = [];
  let inside = false;
  for (const line of String(specMd || '').split('\n')) {
    if (/^## /.test(line)) inside = /^## Open questions/.test(line);
    const m = inside && /^- \*\*(Q\d+)\*\* (.*)$/.exec(line);
    if (m) out.push({ id: m[1], text: m[2].trim() });
  }
  return out;
}

function situationOf(item, scenarios) {
  const shown = (item.scenarios || [])
    .map((s) => scenarios.get(`${item.feature}:${s}`))
    .filter(Boolean)
    .map((v) => Object.entries(v).map(([k, x]) => `${k}=${x}`).join(', '));
  if (shown.length) return shown.join(' / ');
  // "AC1: given X, when Y, then Z": the situation is the given and when; the
  // then is what the spec expects, shown in its own column.
  const gwt = /^[A-Z]+\d+: given (.*?), when (.*?), then /s.exec(item.text || '');
  if (gwt) return `Given ${gwt[1].replace(/\.$/, '')}, when ${gwt[2].replace(/\.$/, '')}`;
  return item.text || item.id;
}

// What the reviewers found the code does: one note when they agree on the
// verdict, every role's verdict when they do not. Null when none answered.
function headOf(verdicts) {
  if (!verdicts || !verdicts.length) return null;
  const kinds = new Set(verdicts.map((v) => v.verdict));
  if (kinds.size === 1) return (verdicts.find((v) => v.note) || verdicts[0]).note || verdicts[0].verdict;
  return verdicts.map((v) => `${v.role}: ${v.verdict} — ${v.note}`).join('; ');
}

// What the code did at base for the same situation, when a reviewer said so.
function beforeOf(verdicts) {
  const v = (verdicts || []).find((x) => x.before);
  return v ? v.before : null;
}

function unitFiles(unit) {
  const files = unit.files || [];
  return files.length > 3 ? `${files.slice(0, 3).join(', ')} +${files.length - 3}` : files.join(', ');
}

function groupOf(file) {
  if (TEST.test(file)) return 'tests';
  if (/\.(md|rst|adoc|txt)$/i.test(file) || /(^|\/)docs?\//.test(file)) return 'docs';
  const base = file.split('/').pop();
  if (/(^|\/)(api|controllers?|resources?|routes?|handlers?|endpoints?|cli|bin|scripts?|deploy)\//i.test(file)
    || /(controller|resource|endpoint|handler|router|main|app|cli)\.\w+$/i.test(base)
    || /\.(sh|ps1|bat|cmd)$/i.test(base)) return 'entry';
  if (/^\.env|^\.\w*ignore$|^\.git(attributes|modules)$|^\.editorconfig$|^Dockerfile|^Makefile$/i.test(base) || /\.(ya?ml|json|properties|toml|ini|xml|cfg|conf|sql|gradle|example|lock)$/i.test(base)) return 'config';
  return 'logic';
}
const GROUPS = ['entry', 'logic', 'config', 'docs', 'tests'];

// inputs: { identity, validation, plan, items, specMd, findings (Map id ->
// finding), synthesis, related: [repository names] }
function buildBrief({ identity, validation, plan, items = [], specMd = '', findings = new Map(), synthesis = null, related = [], impactIndex = null }) {
  const scenarios = parseScenarios(specMd);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const units = (plan && plan.units) || [];
  const unitById = new Map(units.map((u) => [u.id, u]));
  const jobs = validation.jobs || [];

  const confirmed = identity.intent === 'confirmed';
  // Runs from before identity.intent existed: a PR<NAME>-<n> key is still an
  // intent derived from the PR, whether it was confirmed is not recorded.
  const derivedKey = identity.ticket && identity.repo && identity.pr && identity.ticket === require('./pr-intent').prTicketKey(identity.repo, identity.pr);
  const intent = identity.intent
    ? { text: `derived from the PR as ${identity.ticket} — ${confirmed ? 'confirmed at the SPEC gate' : 'not confirmed: the situations below may grade against a misreading'}`, confirmed }
    : derivedKey
      ? { text: `derived from the PR as ${identity.ticket} (whether it was confirmed is not recorded for this run)`, confirmed: null }
      : identity.ticket
      ? { text: `ticket ${identity.ticket}`, confirmed: true }
      : { text: 'no ticket and no intent derived from the PR', confirmed: false };

  const purpose = [
    ...((plan && plan.hypotheses) || []).map((h) => ({ source: h.id, text: `${h.statement} (${h.confidence})` })),
    ...((synthesis && synthesis.overview) || []).map((o) => ({ source: o.flow, text: o.change, findings: o.finding_ids || [] })),
  ];

  const parts = units.filter((u) => u.kind !== 'viewpoint').map((u) => {
    const own = jobs.filter((j) => j.unit_id === u.id);
    return { source: u.id, kind: u.kind, text: u.desc, files: (u.files || []).length, checked: own.length > 0 && own.every((j) => j.status === 'EXECUTED_PASS') };
  });

  const rank = (r) => (RESULT_ORDER.includes(r) ? RESULT_ORDER.indexOf(r) : RESULT_ORDER.length - 1);
  const allRows = (validation.items || []).map((r) => {
    const item = itemById.get(r.id) || { id: r.id, text: r.id };
    return { source: r.id, situation: situationOf(item, scenarios), expected: item.expected || '', head: headOf(r.verdicts), before: beforeOf(r.verdicts), result: r.result, label: item.label || null };
  }).sort((a, b) => rank(a.result) - rank(b.result) || a.source.localeCompare(b.source, undefined, { numeric: true }));
  const collapse = allRows.length > MAX_ROWS;
  const behaviour = {
    rows: collapse ? allRows.filter((r) => r.result !== 'pass') : allRows,
    passed: collapse ? allRows.filter((r) => r.result === 'pass').map((r) => r.source) : [],
    tally: allRows.reduce((t, r) => ({ ...t, [r.result]: (t[r.result] || 0) + 1 }), {}),
    base_recorded: allRows.some((r) => r.before),
  };

  const impacts = validation.impacts || [];
  const counts = {};
  for (const c of impacts) counts[c.verdict] = (counts[c.verdict] || 0) + 1;
  const affected = {
    counts,
    attention: impacts.filter((c) => ATTENTION.has(c.verdict)).map((c) => ({ source: c.caller, where: `${c.from.path}:${c.from.line}`, symbol: c.from.symbol, verdict: c.verdict, note: c.note || '' })),
    outside: related.length
      ? `other repositories searched for callers and clients: ${related.join(', ')}`
      : 'no related repositories are configured: callers and clients outside this repository (BFF, mobile, other services) are unknown',
    index_gap: impactIndex && impactIndex.skipped && impactIndex.skipped.count
      ? `${impactIndex.skipped.count} of ${impactIndex.total} Java/Python files were not searched for callers (${(impactIndex.skipped.by_dir || []).slice(0, 3).map((d) => `${d.dir} ${d.n}`).join(', ')})`
      : null,
  };

  const decisions = [];
  if (identity.intent && !confirmed) decisions.push({ source: 'intent', text: `Confirm the intent derived from the PR at the SPEC gate of ${identity.ticket}.` });
  for (const q of parseQuestions(specMd)) decisions.push({ source: q.id, text: q.text });
  if ((validation.warnings || []).length) decisions.push({ source: 'warnings', text: `${validation.warnings.length} piece(s) of PR text try to steer an automated reviewer: check whether they are intentional.` });
  const gate = validation.human_gate || {};
  if (gate.recorded === 'NOT_RECORDED' || gate.bound_to_current_context === false) decisions.push({ source: 'REVIEW', text: 'Record the REVIEW gate: only a person approves.' });

  const aliased = new Set(effectiveAliases(synthesis && synthesis.aliases ? synthesis : null, validation.findings || []).map((a) => a.id));
  const open = (validation.findings || []).filter((m) => m.state !== 'withdrawn' && !aliased.has(m.id));
  const blocking = open.filter((m) => BLOCKING.has(m.severity) && !m.suggestion).map((m) => {
    const f = findings.get(m.id) || {};
    const code = (f.evidence || []).find((e) => e.kind === 'code');
    const a = f.authority || {};
    return { source: m.id, severity: m.severity, label: m.label, text: f.title || m.id, where: code ? `${code.path}:${code.start_line}` : null, against: a.kind === 'inferred' ? 'reviewer judgement' : a.id || null };
  }).sort((a, b) => a.severity.localeCompare(b.severity));
  const others = {
    P3: open.filter((m) => m.severity === 'P3' && !m.suggestion).length,
    P4: open.filter((m) => m.severity === 'P4' && !m.suggestion).length,
    suggestions: open.filter((m) => m.suggestion).length,
  };
  const unchecked = [];
  const seenUnits = new Set();
  for (const g of validation.gaps || []) {
    const job = /^(\S+)\/(\w+) is (\w+)$/.exec(g);
    if (job) {
      if (seenUnits.has(job[1])) continue;
      seenUnits.add(job[1]);
      const u = unitById.get(job[1]);
      unchecked.push({ source: job[1], text: u ? `${u.desc}${u.files && u.files.length ? ` (${unitFiles(u)})` : ''}` : `${job[1]} did not return a valid answer (${job[3]})` });
      continue;
    }
    // Items without a decision are rows of the situations table already.
    if (/^I\d+ \(.*\) has no determinate/.test(g)) continue;
    const file = /^file:(.+) has no "reviewed" coverage/.exec(g);
    if (file) {
      unchecked.push({ source: 'coverage', text: `not reviewed: ${file[1]}` });
      continue;
    }
    unchecked.push({ source: 'gap', text: g });
  }
  const undecided = allRows.filter((r) => r.result !== 'pass' && r.result !== 'not_applicable').map((r) => r.source);
  const verdict = { recommendation: validation.recommendation, complete: Boolean(validation.complete), blocking, others, unchecked, undecided };

  const files = [...new Set(units.flatMap((u) => u.files || []))];
  const findingsAt = (file) => blocking.filter((b) => b.where && b.where.startsWith(`${file}:`)).map((b) => b.source);
  const reading = files.map((f) => ({ group: groupOf(f), path: f, findings: findingsAt(f) }))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.path.localeCompare(b.path));

  return { title: identity.title || '', intent, purpose, parts, behaviour, affected, decisions, verdict, reading };
}

const cell = (s, n = 220) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return (t.length > n ? `${t.slice(0, n - 1)}…` : t).replace(/\|/g, '\\|');
};
const MARK = { pass: '✅ pass', fail: '❌ fail', cannot_determine: '? undecided', not_graded: '— not checked', not_applicable: 'n/a' };

function renderBrief(b) {
  const out = ['## Review brief', ''];
  out.push(`**What this PR does** — ${b.title}`, '');
  out.push(`- \`intent\` ${b.intent.text}`);
  for (const p of b.purpose) out.push(`- \`${p.source}\` ${p.text}${p.findings && p.findings.length ? ` (${p.findings.join(', ')})` : ''}`);
  if (b.parts.length) {
    out.push('', '**Parts of the change**', '');
    for (const p of b.parts) out.push(`- \`${p.source}\` ${p.text} — ${p.files} file(s)${p.checked ? '' : ' · **not checked**'}`);
  }
  out.push('', `**Situations the spec names, as reviewed**${Object.keys(b.behaviour.tally).length ? ` (${Object.entries(b.behaviour.tally).map(([k, n]) => `${k} ${n}`).join(' · ')})` : ''}`, '');
  if (!b.behaviour.rows.length && !b.behaviour.passed.length) {
    out.push('_No review items: the code was reviewed against the checklist and the reviewers\' judgement only._');
  } else {
    if (b.behaviour.rows.length) {
      const base = b.behaviour.base_recorded;
      out.push(`| Situation |${base ? ' Before (base) |' : ''} Spec expects | Code at head (reviewers) | Result |`, `|---|${base ? '---|' : ''}---|---|---|`);
      for (const r of b.behaviour.rows) {
        const before = base ? ` ${r.before ? cell(`${r.before.status}: ${r.before.text}`) : '_not recorded_'} |` : '';
        out.push(`| \`${r.source}\` ${cell(r.situation, 160)} |${before} ${cell(r.expected)} | ${r.head == null ? '_no verdict_' : cell(r.head)} | ${MARK[r.result] || r.result} |`);
      }
    }
    if (b.behaviour.passed.length) out.push('', `- \`${b.behaviour.passed.join(', ')}\` ${b.behaviour.passed.length} situations behave as the spec expects.`);
    if (!b.behaviour.base_recorded) out.push('', '_Behaviour at base is not recorded: this compares the code at head with the spec, not before with after._');
  }
  out.push('', '**Who else is affected**', '');
  const counts = Object.entries(b.affected.counts);
  if (counts.length) out.push(`- \`impact\` callers of the changed code: ${counts.map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  for (const c of b.affected.attention) out.push(`- \`${c.source}\` ${c.where} ${c.symbol} — **${c.verdict}**${c.note ? `: ${cell(c.note, 200)}` : ''}`);
  out.push(`- \`impact\` ${b.affected.outside}`);
  if (b.affected.index_gap) out.push(`- \`impact\` ${b.affected.index_gap}`);
  if (b.decisions.length) {
    out.push('', '**Needs your decision**', '');
    for (const d of b.decisions) out.push(`- \`${d.source}\` ${d.text}`);
  }
  const v = b.verdict;
  out.push('', `**Verdict** — runtime recommendation **${v.recommendation}** (${v.complete ? 'complete' : 'incomplete'}), not an approval`, '');
  for (const f of v.blocking) out.push(`- \`${f.source}\` [${f.severity}] ${f.text}${f.where ? ` — ${f.where}` : ''}${f.against ? ` · against ${f.against}` : ''}`);
  if (!v.blocking.length) out.push('- `findings` no open P1/P2 finding.');
  out.push(`- \`findings\` also open: P3 ${v.others.P3} · P4 ${v.others.P4} · suggestions ${v.others.suggestions}`);
  if (v.undecided.length) out.push(`- \`${v.undecided.join(', ')}\` ${v.undecided.length} situation(s) the code does not meet or nobody decided: see the table above.`);
  for (const u of v.unchecked) out.push(`- \`${u.source}\` not checked: ${cell(u.text, 240)}`);
  if (b.reading.length) {
    out.push('', '**Reading order**', '');
    const shown = b.reading.slice(0, 12);
    for (const r of shown) out.push(`- \`${r.group}\` ${r.path}${r.findings.length ? ` · ${r.findings.join(', ')}` : ''}`);
    if (b.reading.length > shown.length) out.push(`- \`more\` ${b.reading.length - shown.length} more file(s): see the units below.`);
  }
  return out.join('\n');
}

// Reads what the brief needs from a validated run: the frozen inputs of the
// context (review items, spec), the plan, the valid packets and synthesis.
function loadBrief(runDir, validation, identity) {
  const dir = revisionDir(runDir, validation.context_id);
  const input = (id) => {
    const file = path.join(dir, 'inputs', `${id}.txt`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  let items = [];
  try {
    items = JSON.parse(input('review-items') || '[]');
  } catch {
    items = [];
  }
  const planFile = readJsonIfExists(path.join(runDir, 'plan.json'));
  const findings = new Map();
  for (const job of validation.jobs || []) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJsonIfExists(path.join(dir, packetRel(job.unit_id, job.role)));
    if (packet) for (const f of packet.findings) findings.set(f.id, f);
  }
  const synthesis = validation.synthesis && validation.synthesis.valid ? readJsonIfExists(path.join(dir, 'synthesis.json')) : null;
  const impact = ((readJsonIfExists(path.join(runDir, 'static.json'), {}) || {}).impact) || {};
  const related = (impact.related || []).map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
  return buildBrief({ identity, validation, plan: planFile ? planFile.plan : null, items, specMd: input('spec'), findings, synthesis, related, impactIndex: impact.index || null });
}

module.exports = { buildBrief, renderBrief, loadBrief, parseScenarios, parseQuestions };
