'use strict';
// Requirement items from ticket evidence: tier 1 deterministic parse of an
// explicit acceptance-criteria section, tier 2 model extraction when there is
// none, then a second-model audit. Code checks every quote against the
// evidence; an unquotable item is downgraded to "inferred", never trusted.
const { validateAgainst, outputSchema } = require('./schema');
const { collapse } = require('./validate');
const prompts = require('./prompts');
const { runLooseJob } = require('./loose-job');
const { nowIso } = require('./util');

const AC_HEADING = /^\s*(?:#{1,6}\s*|h[1-6]\.\s*|\*{1,2}|_{1,2})?\s*(acceptance\s+criteria|AC|definition\s+of\s+done|tiêu\s+chí\s+(?:chấp\s+nhận|nghiệm\s+thu)|受け入れ(?:基準|条件)|验收标准)\s*:?\s*(?:\*{1,2}|_{1,2})?\s*$/i;
const ANY_HEADING = /^\s*(?:#{1,6}\s+\S|h[1-6]\.\s+\S|\*\*[^*]+\*\*\s*:?\s*$)/;
// Jira wiki numbered lists ("# item") are converted to "1. item" at intake,
// so "#" here always means a Markdown heading.
const BULLET = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+(?:\[[ xX]?\]\s+)?(.+)$/;

function classifyRisk(text) {
  const t = String(text).toLowerCase();
  if (/amount|balance|charge|price|payment|refund|invoice|discount|\d\s*% off|fee|tax|money|currency|円|tiền|giá|thanh toán|giảm giá/.test(t)) return 'money';
  if (/auth|permission|role|token|password|pii|personal data|secret|encrypt|login|quyền|bảo mật/.test(t)) return 'security';
  if (/delete|purge|migrat|corrupt|backfill|truncate|overwrite|xóa|di chuyển dữ liệu/.test(t)) return 'data';
  return 'normal';
}

function splitGWT(text) {
  const m = text.match(/given\s+(.+?)\s*,?\s+when\s+(.+?)\s*,?\s+then\s+(.+)/i);
  if (m) return { given: m[1].trim(), when: m[2].trim(), then: m[3].trim().replace(/\.$/, '') };
  return { given: 'the change described by the ticket is in place', when: 'this criterion applies', then: text.trim() };
}

// Returns criterion lines found under an acceptance-criteria heading.
function parseDeterministicAC(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let inSection = false;
  for (const line of lines) {
    if (AC_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_HEADING.test(line) && !BULLET.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(BULLET);
    if (m && m[1].trim().length > 3) items.push(m[1].trim());
  }
  return items;
}

function quoteFound(quote, blocks) {
  const q = collapse(quote);
  return q.length > 0 && blocks.some((b) => collapse(b.text).includes(q));
}

// Normalize model items: schema-check each, verify quotes, renumber AC1..n.
function normalizeItems(items, blocks, notes) {
  const out = [];
  for (const raw of items || []) {
    const item = { ...raw, evidence: { ...(raw.evidence || {}) } };
    if (!item.risk || !['money', 'data', 'security', 'normal'].includes(item.risk)) item.risk = classifyRisk(`${item.given} ${item.when} ${item.then}`);
    if (item.kind !== 'inferred' && !quoteFound(item.evidence.quote || '', blocks)) {
      notes.push(`${raw.id || '?'}: quote not found verbatim in the evidence; downgraded to inferred`);
      item.kind = 'inferred';
    }
    if (item.kind === 'inferred') item.evidence.quote = '';
    if (!item.evidence.source) item.evidence.source = blocks[0] ? blocks[0].name : 'ticket';
    item.id = `AC${out.length + 1}`;
    const errs = validateAgainst('requirements', item, 'item');
    if (errs.length) {
      notes.push(`dropped an item: ${errs[0]}`);
      continue;
    }
    out.push(item);
  }
  return out;
}

// blocks: [{ name, text }] — untrusted evidence (ticket, attachments, PR body).
async function extractRequirements({ ticket, blocks, images = [], executor, workDir, model, auditModel, effort, log }) {
  const notes = [];
  const sources = blocks.map((b) => b.name);
  const base = { schema_version: '1.0', ticket, generated_at: nowIso(), sources };
  const deterministic = [];
  for (const b of blocks) {
    for (const text of parseDeterministicAC(b.text)) {
      deterministic.push({ id: 'AC0', kind: 'acceptance', ...splitGWT(text), evidence: { source: b.name, quote: text }, risk: classifyRisk(text) });
    }
  }
  let items;
  let extraction;
  if (deterministic.length) {
    items = normalizeItems(deterministic, blocks, notes);
    extraction = 'deterministic';
  } else if (executor) {
    const res = await runLooseJob({
      executor,
      label: 'requirements',
      images,
      outputSchema: outputSchema('requirements', 'modelItems'),
      workDir,
      cwd: workDir,
      model,
      effort,
      log,
      buildPrompt: (repair) => prompts.requirementsPrompt(blocks, repair),
      validate: (c) => validateAgainst('requirements', c, 'modelItems'),
    });
    if (!res.ok) {
      return { ...base, extraction: 'none', note: `model extraction failed: ${res.errors.join('; ')}`, items: [] };
    }
    items = normalizeItems(res.value.items, blocks, notes);
    extraction = 'model';
  } else {
    return { ...base, extraction: 'none', note: 'no acceptance-criteria section and no model executor', items: [] };
  }

  let audit = null;
  if (executor && items.length) {
    const res = await runLooseJob({
      executor,
      label: 'requirements-audit',
      images,
      outputSchema: outputSchema('requirements', 'audit'),
      workDir,
      cwd: workDir,
      model: auditModel || model,
      effort,
      log,
      buildPrompt: (repair) => prompts.auditPrompt(blocks, items, repair),
      validate: (c) => validateAgainst('requirements', c, 'audit'),
    });
    if (res.ok) {
      const known = new Set(items.map((i) => i.id));
      // Sanity floor: an audit may never remove more than half of the items.
      const invalid = res.value.invalid.filter((x) => known.has(x.id)).slice(0, Math.floor(items.length / 2));
      const dropped = new Set(invalid.map((x) => x.id));
      const kept = items.filter((i) => !dropped.has(i.id));
      const merged = normalizeItems([...kept, ...res.value.missing], blocks, notes);
      audit = {
        model: auditModel || model || null,
        missing_count: res.value.missing.length,
        invalid: invalid,
        note: invalid.length < res.value.invalid.length ? 'some invalid claims ignored (unknown id or sanity floor)' : '',
      };
      items = merged;
    } else {
      audit = { error: res.errors.join('; ') };
    }
  }
  const result = { ...base, extraction, items };
  if (notes.length) result.note = notes.join('\n');
  if (audit) result.audit = audit;
  const errors = validateAgainst('requirements', result);
  if (errors.length) throw new Error(`requirements.json failed its own schema: ${errors.join('; ')}`);
  return result;
}

function renderRequirementsMarkdown(req) {
  const out = [`# Requirements — ${req.ticket}`, '', `extraction: ${req.extraction} · sources: ${req.sources.join(', ') || '(none)'}`, ''];
  if (req.note) out.push('> ' + req.note.split('\n').join('\n> '), '');
  out.push('| ID | Kind | Risk | Given | When | Then | Quote |', '|---|---|---|---|---|---|---|');
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const i of req.items) out.push(`| ${i.id} | ${i.kind} | ${i.risk} | ${cell(i.given)} | ${cell(i.when)} | ${cell(i.then)} | ${cell(i.evidence.quote).slice(0, 120)} |`);
  if (req.audit) out.push('', `Audit: ${JSON.stringify(req.audit)}`);
  return `${out.join('\n')}\n`;
}

module.exports = { extractRequirements, parseDeterministicAC, splitGWT, classifyRisk, normalizeItems, renderRequirementsMarkdown };
