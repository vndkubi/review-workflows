'use strict';
// Human-facing views rendered from validated artifacts only.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, readJsonIfExists } = require('./util');
const { revisionDir, readInput, loadContext } = require('./freeze');
const { packetRel } = require('./driver');
const { SEVERITY_RANK } = require('./cluster');
const memory = require('./memory');
const { effectiveAliases } = require('./outcome');

const STATE_TEXT = {
  stands: 'red-team defense failed — finding stands',
  withdrawn: 'withdrawn by red-team',
  unresolved: 'red-team could not decide',
  unverified: 'no valid rebuttal',
  not_challenged: 'P3/P4 — not challenged',
};

function fence(lang, text) {
  const ticks = String(text).includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${String(text).replace(/\n$/, '')}\n${ticks}`;
}

function langOf(file) {
  if (/\.py$/.test(file)) return 'python';
  if (/\.(java|kt)$/.test(file)) return 'java';
  if (/\.xml$/.test(file)) return 'xml';
  if (/\.sql$/.test(file)) return 'sql';
  return '';
}

function diffBlock(asis, tobe) {
  const minus = String(asis).replace(/\n$/, '').split('\n').map((l) => `- ${l}`);
  const plus = String(tobe).replace(/\n$/, '').split('\n').map((l) => `+ ${l}`);
  return fence('diff', [...minus, ...plus].join('\n'));
}

function loadArtifacts(runDir, validation) {
  const dir = revisionDir(runDir, validation.context_id);
  const findings = new Map();
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJson(path.join(dir, packetRel(job.unit_id, job.role)));
    for (const f of packet.findings) findings.set(f.id, f);
  }
  const rebuttal = (id) => readJsonIfExists(path.join(dir, 'rebuttals', `${id}.json`));
  const synthesis = validation.synthesis && validation.synthesis.valid ? readJson(path.join(dir, 'synthesis.json')) : null;
  return { findings, rebuttal, synthesis };
}

const BLOCKING_SEVERITIES = new Set(['P1', 'P2']);

// A quote shows where the code is, not that the defect can be reached. From
// the frozen call graph: who calls the method the finding sits in, and how
// sure that is. A hint for the person, not a verdict.
function reachability(f, impact, source) {
  if (!impact || !impact.edges) return null;
  const anchor = memory.anchorOf(f, source);
  if (!anchor.symbol) return null;
  const edges = impact.edges.filter((e) => e.to.symbol === anchor.symbol && e.to.path === anchor.path);
  const changed = (impact.changed || []).some((c) => c.symbol === anchor.symbol && c.path === anchor.path);
  if (!changed) return `\`${anchor.symbol}\` is not among the changed declarations; its callers were not analysed.`;
  if (!edges.length) return `no caller of \`${anchor.symbol}\` found in this repository${(impact.related || []).length ? ' or the related ones' : ''} — reachability is unknown (entry point, reflection, another service?).`;
  const by = {};
  for (const e of edges) by[e.confidence] = (by[e.confidence] || 0) + 1;
  const sample = edges.filter((e) => e.confidence !== 'name-only').slice(0, 3).map((e) => `${e.repo ? `[${e.repo}] ` : ''}${e.from.symbol} (${e.from.path}:${e.from.line})`);
  return `\`${anchor.symbol}\` is reached from ${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')} site(s)${sample.length ? `, e.g. ${sample.join('; ')}` : ''}.`;
}

function renderFinding(f, meta, rebuttal) {
  const code = f.evidence.find((e) => e.kind === 'code');
  const out = [];
  out.push(`### [${f.severity}] ${f.title}`);
  out.push('');
  out.push(`\`${f.id}\` · ${meta.label} (${meta.evidence_level}) · confidence ${f.confidence} · votes ${meta.votes}${meta.cluster_id ? ` (${meta.cluster_id})` : ''} · ${meta.withdrawal_overruled ? 'withdrawn by red-team, overruled by the reproduction' : STATE_TEXT[meta.state]}`);
  out.push('');
  out.push(`**Evidence**: ${f.evidence.filter((e) => e.kind === 'code').map((e) => `\`${e.path}:${e.start_line}-${e.end_line}\`${e.revision === 'base' ? ' (base)' : ''}`).join(', ')}`);
  out.push('', `**ASIS** — ${f.asis}`, '', `**TOBE** — ${f.tobe}`);
  out.push('', `**Authority**: ${f.authority.kind} \`${f.authority.id}\``);
  out.push('', '**Trigger scenario**', `1. Given ${f.trigger.given}`, `2. When ${f.trigger.when}`, `3. Then ${f.trigger.then}`);
  out.push('', `**Impact** — ${f.impact}`);
  if (f.fix.kind === 'code_change') {
    out.push('', `**Suggested fix** (${code ? code.path : ''}) — ${f.fix.reason}`, '', diffBlock(f.fix.asis, f.fix.tobe));
  } else {
    out.push('', `**Fix**: not a code change — ${f.fix.reason}`);
  }
  if (meta.repro) {
    const rr = meta.repro;
    const fixText = (rr.fix_verified === true ? ' · the suggested fix makes it pass' : rr.fix_verified === false ? ' · the suggested fix does NOT make it pass' : '')
      + (rr.status === 'RED_PROVEN' ? (rr.control === 'base' ? ' · passes on the base commit (regression)' : !rr.control ? ' · no control: REPRODUCED, not CONFIRMED' : '') : '');
    out.push('', `**Reproduction** \`${rr.status}\`${rr.test ? ` — \`${rr.test}\`` : ''}${rr.from && rr.from !== f.id ? ` (from ${rr.from})` : ''}${fixText}${rr.reason ? ` — ${rr.reason}` : ''}`);
  }
  if (rebuttal) {
    out.push('', `**Rebuttal** \`${rebuttal.verdict}\`${meta.rebuttal_from && meta.rebuttal_from !== f.id ? ` (inherited from ${meta.rebuttal_from})` : ''} — tried: ${rebuttal.defense_attempted}. ${rebuttal.reason}`);
  }
  if (code) out.push('', '<details><summary>Quoted code</summary>', '', fence(langOf(code.path), code.quote), '', '</details>');
  return out.join('\n');
}

function renderReport(runDir, validation, identity) {
  const { findings, rebuttal, synthesis } = loadArtifacts(runDir, validation);
  const metas = [...validation.findings].sort(
    (a, b) => (a.state === 'withdrawn') - (b.state === 'withdrawn') || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.votes - a.votes || a.id.localeCompare(b.id),
  );
  const aliases = effectiveAliases(synthesis, validation.findings);
  const aliased = new Set(aliases.map((a) => a.id));
  const out = [];
  out.push(`# Code review — ${identity.repo}#${identity.pr}`, '');
  out.push(`${identity.title}`, '');
  out.push(`- head \`${identity.head_sha}\` · context \`${validation.context_id}\``);
  out.push(`- runtime recommendation: **${validation.recommendation}** (${validation.complete ? 'complete' : 'INCOMPLETE'}) — not an approval`);
  if (identity.intent) out.push(`- intent: derived from the PR as ${identity.ticket} — **${identity.intent === 'confirmed' ? 'confirmed at the SPEC gate' : 'NOT confirmed: review items may grade against a misreading; check the spec'}**`);
  out.push(`- human gate REVIEW: **${validation.human_gate.recorded}**${validation.human_gate.bound_to_current_context ? '' : ' (not bound to this context)'}`);
  const counts = ['P1', 'P2', 'P3', 'P4'].map((s) => `${s}: ${metas.filter((m) => m.severity === s && m.state !== 'withdrawn' && !aliased.has(m.id)).length}`);
  out.push(`- open findings — ${counts.join(' · ')} · withdrawn: ${metas.filter((m) => m.state === 'withdrawn').length}`);
  const u = validation.usage;
  const p = u.plan || { calls: 0, input_tokens: 0, output_tokens: 0 };
  const co = validation.carried_over;
  if (co && !co.skipped) out.push(`- incremental: ${co.packets.length} packet(s) and ${co.rebuttals} rebuttal(s) carried over unchanged from context \`${co.from_context_id}\` (re-validated here)`);
  else if (co) out.push(`- full re-review: ${co.skipped}`);
  out.push(`- review calls ${u.calls} (${u.repair_calls} repairs) · tokens in ${u.input_tokens} (cached ${u.cached_input_tokens}) / out ${u.output_tokens} · planning calls ${p.calls}, tokens in ${p.input_tokens} / out ${p.output_tokens}`);
  if (validation.warnings && validation.warnings.length) {
    out.push('', `## ⚠ Instruction-like text aimed at AI reviewers (${validation.warnings.length})`, '', 'The PR content contains text that tries to steer an automated reviewer. It was treated as data; check whether it is intentional.', '');
    out.push(...validation.warnings.map((w) => `- \`${w.where}\` [${w.kind}] ${w.text}`));
  }
  const size = validation.size;
  if (size && size.large) {
    out.push('', `## Large PR: ${size.files} files, ${size.lines} changed lines`, '', `Above the review limits (${size.limits.files} files / ${size.limits.lines} lines): the review is spread thin and a person cannot check it well. Units ran riskiest first. Consider splitting along the planned units (riskiest first; units that share files stay together):`, '');
    for (const p of validation.split || []) out.push(`- **${p.units.join(' + ')}** (${p.files.length} file(s), ${p.lines} lines, risk ${p.risk}) — ${p.desc}`);
  }
  const impacted = (readJsonIfExists(path.join(runDir, 'static.json'), {}) || {}).impacted_tests;
  if (impacted && impacted.results && impacted.results.length) {
    const broken = impacted.results.filter((r) => ['newly_failing', 'new_test_failing'].includes(r.verdict));
    out.push('', `## Impacted tests (run at base and head)${broken.length ? ` — ${broken.length} broken by this change` : ''}`, '');
    for (const r of impacted.results) out.push(`- \`${r.test}\`: **${r.verdict}**${r.head && r.head.failing && r.head.failing.length ? ` — ${r.head.failing.map((f) => `${f.name}: ${String(f.message || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('; ')}` : ''}`);
  }
  if (validation.gaps.length) out.push('', '## Not verified', '', ...validation.gaps.map((g) => `- ${g}`));
  if (validation.items && validation.items.length) {
    const texts = new Map(JSON.parse(readInput(runDir, loadContext(runDir), 'review-items') || '[]').map((i) => [i.id, i]));
    const tally = {};
    for (const r of validation.items) tally[r.result] = (tally[r.result] || 0) + 1;
    out.push('', `## Review items (${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(' · ')})`, '');
    out.push('| Item | Kind | Risk | Result | Expected | Reviewer notes |', '|---|---|---|---|---|---|');
    const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    for (const r of validation.items) {
      const item = texts.get(r.id) || {};
      const notes = r.verdicts.map((v) => `${v.unit_id}/${v.role}: ${v.verdict} — ${v.note}`).join('; ');
      out.push(`| ${r.id} | ${r.kind} | ${r.risk} | **${r.result}** | ${cell(item.expected)} | ${cell(notes).slice(0, 400)} |`);
    }
  }
  if (validation.checks && validation.checks.length) {
    const tally = {};
    for (const c of validation.checks) tally[c.verdict] = (tally[c.verdict] || 0) + 1;
    const unitIds = [...new Set(validation.checks.map((c) => c.unit_id))];
    const viewpoints = [...new Set(validation.checks.map((c) => c.viewpoint))].sort();
    const MARK = { pass: 'pass', fail: '**FAIL**', not_applicable: 'n/a', cannot_determine: '?', not_answered: '—' };
    out.push('', `## Viewpoint checks (${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(' · ')})`, '');
    out.push('Viewpoints the runtime assigned from what each unit\'s changed lines touch. "?" could not be determined; "—" no valid packet answered.', '');
    out.push(`| Viewpoint | ${unitIds.join(' | ')} |`, `|---|${unitIds.map(() => '---').join('|')}|`);
    for (const vp of viewpoints) {
      const row = unitIds.map((u) => {
        const c = validation.checks.find((x) => x.unit_id === u && x.viewpoint === vp);
        return c ? MARK[c.verdict] || c.verdict : '';
      });
      out.push(`| ${vp} | ${row.join(' | ')} |`);
    }
  }
  if (synthesis) {
    out.push('', '## Overview', '');
    for (const flow of synthesis.overview) out.push(`- **${flow.flow}** — ${flow.change}${flow.finding_ids.length ? ` (${flow.finding_ids.join(', ')})` : ''}`);
    if (synthesis.unverified.length) out.push('', ...synthesis.unverified.map((u) => `- unverified: ${u}`));
  }
  out.push('', '## Findings', '');
  if (!metas.length) out.push('No findings were reported by any valid packet.');
  const staticImpact = (readJsonIfExists(path.join(runDir, 'static.json'), {}) || {}).impact || null;
  const ctxSource = (readJsonIfExists(path.join(revisionDir(runDir, validation.context_id), 'context.json')) || {}).source || null;
  const scope = memory.memoryScope(identity);
  const entries = memory.loadMemory().entries;
  for (const meta of metas) {
    if (aliased.has(meta.id)) continue;
    const f = findings.get(meta.id);
    if (!f) continue;
    out.push(renderFinding(f, meta, rebuttal(meta.rebuttal_from || meta.id)), '');
    const reach = reachability(f, staticImpact, ctxSource);
    if (reach && BLOCKING_SEVERITIES.has(f.severity)) out.push(`**Reachability** — ${reach}`, '');
    const match = memory.matchRejected(f, { scope, run: path.basename(runDir), source: (readJsonIfExists(path.join(revisionDir(runDir, validation.context_id), 'context.json')) || {}).source }, entries);
    if (match) out.push(`> ${match.same ? 'Rejected' : `Looks like a finding rejected earlier (${match.entry_id}, ${match.how || 'similar'}, ${match.score})`}: ${match.reason}. ${memory.publishAction(f, match) === 'omit' ? 'Left out of the published draft.' : 'Still published because of its severity.'}`, '');
    const dups = aliases.filter((a) => a.duplicate_of === meta.id).map((a) => a.id);
    if (dups.length) out.push(`_Duplicates: ${dups.join(', ')}_`, '');
  }
  out.push('## Units', '', '| Unit/role | Status | Errors |', '|---|---|---|');
  for (const j of validation.jobs) out.push(`| ${j.unit_id}/${j.role} | ${j.status} | ${(j.errors[0] || '').replace(/\|/g, '\\|').slice(0, 160)} |`);
  out.push('', '---', 'Generated by the review runtime from validated packets. Labels: SUSPECTED = static evidence validated (L1); CONFIRMED needs an executed reproduction. Only a person approves.');
  return `${out.join('\n')}\n`;
}

function writeReport(runDir, validation, identity) {
  const text = renderReport(runDir, validation, identity);
  const file = path.join(revisionDir(runDir, validation.context_id), 'report.md');
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(runDir, 'report.md'), text);
  return file;
}

module.exports = { renderReport, writeReport, diffBlock };
