'use strict';
// Refactor suggestions: a lane beside the review, never inside its verdict.
// A simplifier model proposes simpler code for lines the PR added; the
// runtime decides which proposals are shown. A proposal is checked like any
// other model output (quotes against the frozen head, replaced lines that are
// whole and occur once), then triaged without the model: only the PR's own
// lines, never lines an open defect finding quotes, and only a replacement
// that measures simpler. Nothing here is read by computeOutcome.
const { validateAgainst } = require('./schema');
const { validateEvidence, looksLikeCode, collapse, SUGGESTION, END_SLACK } = require('./validate');

// ---------- measuring ----------
// Crude on purpose: counted from the text, the same way for asis and tobe, so
// the comparison is fair even where a single number is rough. Strings and
// comments are removed first: a keyword inside them is not a branch.
function stripped(code, language) {
  const s = String(code).replace(/\r\n/g, '\n').replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
  return language === 'python' ? s.replace(/#.*$/gm, '') : s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function languageOf(file) {
  return /\.py$/.test(String(file)) ? 'python' : 'c';
}

// { lines, nesting, branches }: code lines, the deepest block inside the
// snippet (indentation levels for Python, braces elsewhere) and the decision
// points (if/for/while/case/catch, boolean operators, ternaries).
function measure(code, language = 'c') {
  const text = stripped(code, language);
  const rows = text.split('\n').filter((l) => l.trim());
  let nesting = 0;
  if (language === 'python') {
    nesting = Math.max(0, new Set(rows.map((l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length)).size - 1);
  } else {
    let depth = 0;
    let low = 0;
    let high = 0;
    for (const ch of text) {
      if (ch === '{') high = Math.max(high, (depth += 1));
      else if (ch === '}') low = Math.min(low, (depth -= 1));
    }
    nesting = high - low;
  }
  const count = (re) => (text.match(re) || []).length;
  const branches = language === 'python'
    ? count(/\b(if|elif|for|while|except|case|and|or)\b/g)
    : count(/\b(if|for|while|case|catch)\b/g) + count(/&&|\|\|/g) + count(/\s\?\s/g);
  return { lines: rows.length, nesting, branches };
}

// Simpler: at least one number went down, and neither the nesting nor the
// branch count went up (fewer lines bought with a deeper block is not simpler).
function isSimpler(before, after) {
  if (after.nesting > before.nesting || after.branches > before.branches) return false;
  return after.lines < before.lines || after.nesting < before.nesting || after.branches < before.branches;
}

// ---------- locating ----------
// Where `asis` stands in the file as whole lines: [{ start, end }] (1-based).
// The exact text (trailing blanks aside) names its place; only when it occurs
// nowhere are the lines compared without their indentation.
function locateAsis(lines, asis) {
  const want = String(asis).replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (want.length && !want[0].trim()) want.shift();
  while (want.length && !want[want.length - 1].trim()) want.pop();
  if (!want.length) return [];
  const scan = (same) => {
    const hits = [];
    for (let i = 0; i + want.length <= lines.length; i += 1) {
      if (want.every((w, k) => same(lines[i + k], w))) hits.push({ start: i + 1, end: i + want.length });
    }
    return hits;
  };
  const exact = scan((line, w) => line.replace(/\s+$/, '') === w);
  return exact.length ? exact : scan((line, w) => line.trim() === w.trim());
}

// The one place a suggestion replaces: { span: { path, start, end } } or
// { error } phrased for the repair prompt.
function spanOf(s, sources) {
  const cited = s.evidence.filter((ev) => ev.kind === 'code' && ev.revision !== 'base');
  let found = null;
  for (const file of [...new Set(cited.map((ev) => ev.path))]) {
    const lines = sources.code(file);
    const hits = lines ? locateAsis(lines, s.fix.asis) : [];
    if (!hits.length) continue;
    if (hits.length > 1) return { error: `occurs ${hits.length} times in "${file}"; extend it to whole lines that occur once` };
    const inside = cited.some((ev) => ev.path === file && hits[0].start >= ev.start_line && hits[0].end <= ev.end_line + END_SLACK);
    if (!inside) return { error: `stands at ${file}:${hits[0].start}-${hits[0].end}, outside this suggestion's code evidence; quote the lines you replace in evidence` };
    found = { path: file, ...hits[0] };
    break;
  }
  return found ? { span: found } : { error: 'copy whole source lines verbatim from one of this suggestion\'s code evidence ranges at the reviewed head' };
}

const names = (text) => new Set(String(text).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []);

// ---------- validating ----------
// env: { sources }. Errors are written for the repair prompt.
function validateSuggestions(candidate, env) {
  const errors = validateAgainst('review', candidate, 'refactor');
  if (errors.length) return errors;
  const { sources } = env;
  const digest = sources.context.context_digest;
  if (candidate.context_digest !== digest) errors.push(`$.context_digest: must be ${digest}`);
  const ids = new Set();
  candidate.suggestions.forEach((s, i) => {
    const at = `$.suggestions[${i}]`;
    if (ids.has(s.id)) errors.push(`${at}.id: duplicate id ${s.id}`);
    ids.add(s.id);
    s.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `${at}.evidence[${j}]`)));
    if (!s.evidence.some((ev) => ev.kind === 'code' && ev.revision !== 'base')) errors.push(`${at}.evidence: needs code evidence at the reviewed head containing the lines to replace`);

    const where = spanOf(s, sources);
    if (where.error) errors.push(`${at}.fix.asis: ${where.error}`);

    const removal = !s.fix.tobe.trim();
    if (removal && s.kind !== 'dead_code') errors.push(`${at}.fix.tobe: empty; only a "dead_code" suggestion may remove lines without a replacement`);
    if (!removal && !looksLikeCode(s.fix.tobe)) errors.push(`${at}.fix.tobe: must be replacement code, not prose; explanations belong in reason`);
    if (collapse(s.fix.tobe) === collapse(s.fix.asis)) errors.push(`${at}.fix.tobe: identical to fix.asis`);

    if (s.kind === 'reuse') {
      const helper = s.reuse;
      if (!helper) {
        errors.push(`${at}.reuse: required for kind "reuse": code evidence of the existing helper that fix.tobe calls`);
      } else if (helper.kind !== 'code' || helper.revision === 'base') {
        errors.push(`${at}.reuse: must be code evidence at the reviewed head (the helper exists there)`);
      } else {
        errors.push(...validateEvidence(helper, sources, `${at}.reuse`));
        const span = where.span;
        if (span && helper.path === span.path && helper.start_line <= span.end && helper.end_line >= span.start) errors.push(`${at}.reuse: must quote the helper outside the lines it replaces (${span.path}:${span.start}-${span.end})`);
        const old = names(s.fix.asis);
        const used = names(s.fix.tobe);
        if (![...names(helper.quote)].some((n) => used.has(n) && !old.has(n))) errors.push(`${at}.fix.tobe: must call the helper quoted in reuse (none of its names is new in the replacement)`);
      }
    }
  });
  return errors;
}

// ---------- scope and triage ----------
// What may be replaced: `added` = the lines this PR added, per file;
// `defects` = head lines an open defect finding quotes (its fix comes first).
// findings: packet findings; test and process remarks do not reserve lines.
function refactorScope(parsed, findings = [], reviewable = null) {
  const allowed = reviewable ? new Set(reviewable) : null;
  const added = new Map();
  for (const file of parsed) {
    if (!file.path || file.binary || (allowed && !allowed.has(file.path))) continue;
    const set = new Set();
    for (const hunk of file.hunks) for (const l of hunk.lines) if (l.type === '+') set.add(l.new_line);
    if (set.size) added.set(file.path, set);
  }
  const defects = new Map();
  for (const f of findings) {
    if (SUGGESTION.has(f.category)) continue;
    for (const ev of f.evidence || []) {
      if (ev.kind !== 'code' || ev.revision === 'base') continue;
      if (!defects.has(ev.path)) defects.set(ev.path, new Set());
      for (let n = ev.start_line; n <= ev.end_line; n += 1) defects.get(ev.path).add(n);
    }
  }
  return { added, defects };
}

// "12-18, 30" for a set of line numbers.
function ranges(set) {
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(', ');
}

// One record per suggestion of a validated document: where it stands, what it
// measures, and CANDIDATE or DROPPED with the reason. Dropping is the
// runtime's decision and is reported; it is never sent back for repair.
function triage(candidate, { sources, scope }) {
  const kept = [];
  return candidate.suggestions.map((s) => {
    const where = spanOf(s, sources);
    if (!where.span) return { id: s.id, kind: s.kind, status: 'DROPPED', reason: 'invalid' };
    const span = where.span;
    const language = languageOf(span.path);
    const rec = { id: s.id, kind: s.kind, span, metrics: { before: measure(s.fix.asis, language), after: measure(s.fix.tobe, language) } };
    const drop = (reason) => ({ ...rec, status: 'DROPPED', reason });
    const lines = sources.code(span.path) || [];
    const own = [];
    for (let n = span.start; n <= span.end; n += 1) if ((lines[n - 1] || '').trim()) own.push(n);
    const added = scope.added.get(span.path) || new Set();
    // Mostly the PR's own lines: a block may close over a line it did not write.
    if (own.filter((n) => added.has(n)).length * 2 < own.length) return drop('out_of_scope');
    const reserved = scope.defects.get(span.path);
    if (reserved && own.some((n) => reserved.has(n))) return drop('overlaps_finding');
    if (!isSimpler(rec.metrics.before, rec.metrics.after)) return drop('not_simpler');
    if (kept.some((k) => k.path === span.path && k.start <= span.end && k.end >= span.start)) return drop('overlaps_suggestion');
    kept.push(span);
    return { ...rec, status: 'CANDIDATE' };
  });
}

module.exports = { measure, isSimpler, languageOf, locateAsis, spanOf, validateSuggestions, refactorScope, ranges, triage };
