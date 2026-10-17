'use strict';
// Trusted validators. Models produce candidates; these functions decide.
// Every error string is written for the repair prompt: it names the exact
// field and what to change.
const fs = require('node:fs');
const path = require('node:path');
const { sha256, sha256Value } = require('./util');
const { validateAgainst } = require('./schema');
const git = require('./git');
const { readInput, revisionDir } = require('./freeze');
const { checkRole } = require('./viewpoint-checks');
const { resolveAnchor, hunkAnchors } = require('./anchors');

const MAX_RANGE = 200;
const END_SLACK = 5;

function splitLines(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Read access to everything a citation may point at, bound to one context.
function makeSources(runDir, context) {
  const lineCache = new Map();
  const cached = (key, load) => {
    if (!lineCache.has(key)) {
      const text = load();
      lineCache.set(key, text == null ? null : splitLines(text));
    }
    return lineCache.get(key);
  };
  const dir = revisionDir(runDir, context.context_id);
  return {
    context,
    code(file, revision = 'reviewed') {
      const rev = revision === 'base' ? context.source.base_sha : context.source.head_sha;
      return cached(`code\0${rev}\0${file}`, () => git.showFile(context.source.checkout, rev, file));
    },
    input(id) {
      return cached(`input\0${id}`, () => readInput(runDir, context, id));
    },
    artifact(rel) {
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) return null;
      return cached(`artifact\0${rel}`, () => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null));
    },
    artifactSha(rel) {
      const abs = path.resolve(dir, rel);
      return fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
    },
    inputIds() {
      return context.inputs.map((i) => i.id);
    },
    // Hunk ids of the frozen review.patch (verified with the context).
    anchors() {
      if (!lineCache.has('anchors')) {
        const file = path.join(dir, 'review.patch');
        lineCache.set('anchors', fs.existsSync(file) ? hunkAnchors(fs.readFileSync(file, 'utf8')) : []);
      }
      return lineCache.get('anchors');
    },
    policyText() {
      return cached('policy-all', () =>
        context.inputs
          .filter((i) => i.kind === 'policy')
          .map((i) => readInput(runDir, context, i.id))
          .join('\n'),
      ).join('\n');
    },
  };
}

function hasSubstance(quote) {
  return /[\p{L}\p{N}]/u.test(quote);
}

function fragmentsInOrder(haystack, quote) {
  const fragments = quote.split(/\.\.\.|…/).map(collapse).filter(Boolean);
  if (fragments.length < 2) return false;
  let from = 0;
  for (const f of fragments) {
    const at = haystack.indexOf(f, from);
    if (at < 0) return false;
    from = at + f.length;
  }
  return true;
}

// A model reading UTF-8 through a console in another codepage (Windows
// PowerShell 5.1 Get-Content) sees "—" as "�?\"" or "â€”" and copies that.
// Each run of non-ASCII text in the file then stands for one garbled run in
// the quote (starting with a non-ASCII character); all ASCII stays verbatim.
const MARK = '\u0001';
function garbledMatches(region, quote) {
  if (!/[^\x00-\x7f]/.test(region) || !/[^\x00-\x7f]/.test(quote)) return false;
  const r = region.replace(/[^\x00-\x7f]+/g, MARK);
  const q = quote.replace(/[^\x00-\x7f](?:[^\x00-\x7f]|[?"'<])*/g, MARK);
  return q.includes(MARK) && /[\p{L}\p{N}]/u.test(q) && r.includes(q);
}

// Told to copy the garbage verbatim, a model swaps in an ASCII look-alike
// ("-" for "—", "Gia" for "Giá"), or the console already showed "?" for a
// letter its codepage lacks ("C?ng" for "Cổng"). Where the cited lines hold
// non-ASCII text, letters and digits (accents removed) must still appear in
// order, a "?" or non-ASCII character standing for at most two of them;
// punctuation and spacing are not compared.
function fold(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}
function foldedMatches(region, quote) {
  if (!/[^\x00-\x7f]/.test(region)) return false;
  const r = fold(region).replace(/[^A-Za-z0-9]/g, '');
  let pattern = '';
  let literals = 0;
  let wild = 0;
  for (const ch of fold(quote)) {
    if (/[A-Za-z0-9]/.test(ch)) {
      pattern += ch;
      literals += 1;
    } else if ((ch === '?' || ch > '\x7f') && !pattern.endsWith('}')) {
      pattern += '[A-Za-z0-9]{0,2}';
      wild += 1;
    }
  }
  return literals >= 8 && literals >= 3 * wild && new RegExp(pattern).test(r);
}

function regionMatches(region, quote) {
  if (region.includes(quote)) return 'exact';
  const r = collapse(region);
  const q = collapse(quote);
  if (q && r.includes(q)) return 'whitespace';
  if (fragmentsInOrder(r, quote)) return 'ellipsis';
  if (garbledMatches(r, q)) return 'mojibake';
  if (foldedMatches(r, q)) return 'folded';
  return null;
}

// Does `quote` occur in lines[start..end] (1-based, inclusive)? Fallbacks, in
// order: exact, whitespace-collapsed, ellipsis fragments in order, then the
// end line extended by up to END_SLACK lines (start stays pinned) — models
// routinely under-count the last line of a multi-line quote.
function quoteMatchesAt(lines, start, end, quote) {
  const q = String(quote).replace(/\r\n/g, '\n');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { ok: false, error: `invalid line range ${start}-${end}` };
  }
  if (start > lines.length) return { ok: false, error: `start_line ${start} is past the end of the file (${lines.length} lines)` };
  if (end - start > MAX_RANGE) return { ok: false, error: `range ${start}-${end} exceeds ${MAX_RANGE} lines; cite a narrower range` };
  if (!hasSubstance(q)) return { ok: false, error: 'quote has no letters or digits; quote meaningful code' };
  const last = Math.min(end, lines.length);
  const how = regionMatches(lines.slice(start - 1, last).join('\n'), q);
  if (how) return { ok: true, how };
  for (let e = last + 1; e <= Math.min(last + END_SLACK, lines.length); e += 1) {
    const slack = regionMatches(lines.slice(start - 1, e).join('\n'), q);
    if (slack) return { ok: true, how: `${slack}+end_slack` };
  }
  return { ok: false, error: `quote not found at lines ${start}-${end}` };
}

// 1-based start lines where `quote` matches a window of its own height.
function locateQuote(lines, quote) {
  const q = String(quote).replace(/\r\n/g, '\n');
  const height = q.split('\n').length;
  const hits = [];
  for (let i = 0; i + height <= lines.length; i += 1) {
    if (regionMatches(lines.slice(i, i + height).join('\n'), q)) hits.push(i + 1);
    if (hits.length > 1) break;
  }
  return { hits, height };
}

function linesFor(ev, sources) {
  if (ev.kind === 'code') return sources.code(ev.path, ev.revision);
  if (ev.kind === 'input') return sources.input(ev.path);
  return sources.artifact(ev.path);
}

// Canonicalize before validate: re-anchor a quote that occurs at exactly one
// place in the cited file, drop sha256 values models invent for code/input
// evidence, and strip decorations around requirement ids. Quote text itself
// is never altered. Returns the list of changes made.
function canonicalizeCandidate(candidate, sources) {
  const changes = [];
  const fixEvidence = (ev, at) => {
    if (!ev || typeof ev !== 'object') return;
    if ((ev.kind === 'code' || ev.kind === 'input') && 'sha256' in ev) {
      delete ev.sha256;
      changes.push(`${at}: dropped sha256 (only artifact evidence carries one)`);
    }
    // Strict structured outputs make every field present; a revision on
    // non-code evidence carries no meaning, so it is dropped, not rejected.
    if (ev.kind !== 'code' && 'revision' in ev) {
      delete ev.revision;
      changes.push(`${at}: dropped revision (only code evidence has one)`);
    }
    if (typeof ev.path === 'string' && ev.kind === 'code') {
      const cleaned = ev.path.replace(/\\/g, '/').replace(/^\.\//, '');
      if (cleaned !== ev.path) {
        ev.path = cleaned;
        changes.push(`${at}: normalized path`);
      }
    }
    // A shortened input id ("evidence", "inputs/plan.txt") that names exactly
    // one frozen input. Measured with `arw retro`: the most repeated reason
    // for repairs on real runs. The quote is still checked against it.
    if (ev.kind === 'input' && typeof ev.path === 'string' && sources && sources.inputIds) {
      const ids = sources.inputIds();
      if (!ids.includes(ev.path)) {
        const bare = ev.path.replace(/^inputs?[/:]/, '').replace(/\.txt$/, '');
        const hits = ids.includes(bare) ? [bare] : ids.filter((id) => id.startsWith(`${bare}-`));
        if (bare && hits.length === 1) {
          changes.push(`${at}.path: "${ev.path}" -> "${hits[0]}"`);
          ev.path = hits[0];
        }
      }
    }
    if (typeof ev.quote !== 'string' || typeof ev.path !== 'string') return;
    if (ev.kind === 'input' && /^\s*\d+\| /m.test(ev.quote)) {
      ev.quote = ev.quote.replace(/^\s*\d+\| /gm, '');
      changes.push(`${at}.quote: removed line-number prefixes`);
    }
    const lines = linesFor(ev, sources);
    if (!lines) return;
    if (quoteMatchesAt(lines, ev.start_line, ev.end_line, ev.quote).ok) return;
    const { hits, height } = locateQuote(lines, ev.quote);
    // Code must be unambiguous; a frozen input is the same evidence wherever
    // the text repeats, so its first occurrence is as good as any.
    if (hits.length === 1 || (ev.kind === 'input' && hits.length > 1)) {
      changes.push(`${at}: re-anchored ${ev.start_line}-${ev.end_line} -> ${hits[0]}-${hits[0] + height - 1}`);
      ev.start_line = hits[0];
      ev.end_line = hits[0] + height - 1;
    }
  };
  const list = (arr, at) => (Array.isArray(arr) ? arr.forEach((ev, i) => fixEvidence(ev, `${at}[${i}]`)) : null);
  // Coverage and verdict evidence may cite a diff hunk; the frozen source
  // supplies path, line and quote. An anchor that does not resolve is left
  // for the validator to name.
  const anchors = sources && sources.anchors ? sources.anchors() : null;
  const anchored = (arr, at) => {
    if (Array.isArray(arr) && anchors) {
      arr.forEach((ev, i) => {
        if (!ev || typeof ev !== 'object' || typeof ev.anchor !== 'string') return;
        const r = resolveAnchor(ev.anchor, anchors, (file, rev) => sources.code(file, rev));
        if (!r.evidence) return;
        changes.push(`${at}[${i}]: anchor ${ev.anchor} -> ${r.evidence.path}:${r.evidence.start_line}`);
        for (const k of Object.keys(ev)) delete ev[k];
        Object.assign(ev, r.evidence);
      });
    }
    list(arr, at);
  };
  if (!candidate || typeof candidate !== 'object') return changes;
  list(candidate.evidence, '$.evidence');
  (candidate.coverage || []).forEach((c, i) => anchored(c && c.evidence, `$.coverage[${i}].evidence`));
  (candidate.item_verdicts || []).forEach((v, i) => anchored(v && v.evidence, `$.item_verdicts[${i}].evidence`));
  (candidate.viewpoint_verdicts || []).forEach((v, i) => anchored(v && v.evidence, `$.viewpoint_verdicts[${i}].evidence`));
  (candidate.overview || []).forEach((f, i) => list(f && f.evidence, `$.overview[${i}].evidence`));
  (candidate.findings || []).forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    list(f.evidence, `$.findings[${i}].evidence`);
    if (f.verification) list(f.verification.evidence, `$.findings[${i}].verification.evidence`);
    if (f.authority) {
      fixEvidence(f.authority.source, `$.findings[${i}].authority.source`);
      const m = typeof f.authority.id === 'string' && f.authority.kind === 'requirement' && f.authority.id.match(/\b(?:AC|I)[1-9][0-9]*\b/);
      if (m && m[0] !== f.authority.id) {
        changes.push(`$.findings[${i}].authority.id: "${f.authority.id}" -> "${m[0]}"`);
        f.authority.id = m[0];
      }
    }
  });
  return changes;
}

function validateEvidence(ev, sources, at) {
  const errors = [];
  // Canonicalization resolves anchors where they are allowed; one still here
  // is unknown, or sits where the quote is the claim.
  if (ev.anchor !== undefined) {
    const r = sources.anchors ? resolveAnchor(ev.anchor, sources.anchors(), (file, rev) => sources.code(file, rev)) : { error: 'no diff anchors in this context' };
    return [`${at}.anchor: ${r.error || 'only coverage and verdict evidence may cite a hunk; quote the code verbatim'}`];
  }
  if (ev.kind === 'code') {
    if (path.isAbsolute(ev.path) || ev.path.split('/').includes('..')) {
      return [`${at}.path: must be repository-relative, got "${ev.path}"`];
    }
  } else if (ev.revision !== undefined) {
    errors.push(`${at}.revision: only code evidence has a revision`);
  }
  if (ev.kind === 'input' && !sources.inputIds().includes(ev.path)) {
    return [`${at}.path: "${ev.path}" is not a frozen input id (one of: ${sources.inputIds().join(', ')})`];
  }
  if (ev.kind === 'artifact') {
    const actual = sources.artifactSha(ev.path);
    if (!actual) return [`${at}.path: artifact "${ev.path}" does not exist in this revision`];
    if (ev.sha256 !== actual) errors.push(`${at}.sha256: must be ${actual} for artifact "${ev.path}"`);
  }
  const lines = linesFor(ev, sources);
  if (!lines) {
    const where = ev.kind === 'code' ? ` at ${ev.revision === 'base' ? 'base' : 'head'}` : '';
    return [...errors, `${at}.path: "${ev.path}" does not exist${where}`];
  }
  const match = quoteMatchesAt(lines, ev.start_line, ev.end_line, ev.quote);
  if (!match.ok) errors.push(`${at}: ${match.error} of ${ev.kind} "${ev.path}" — re-read the lines and copy the quote verbatim, or fix the range`);
  return errors;
}

function regionText(ev, sources) {
  const lines = linesFor(ev, sources);
  if (!lines) return '';
  return lines.slice(ev.start_line - 1, Math.min(ev.end_line + END_SLACK, lines.length)).join('\n');
}

const PROSE_START = /^(add|only|ensure|use|change|replace|consider|should|make|we|the|this|it)\b/i;
function looksLikeCode(s) {
  const t = String(s).trim();
  if (!t || PROSE_START.test(t)) return false;
  return /[;{}()=<>[\]:]/.test(t) || /^\s*(def|return|if|for|while|class|import|from|@|raise|throw)\b/m.test(t);
}

function sortRefs(refs) {
  return [...refs].sort((a, b) => `${a.unit_id}/${a.role}`.localeCompare(`${b.unit_id}/${b.role}`));
}

// env: { sources, unit, role, items, requirements, expectedDependencyRefs }
function validatePacket(packet, env) {
  const errors = validateAgainst('review', packet, 'packet');
  if (errors.length) return errors;
  const { sources, unit, role } = env;
  const digest = sources.context.context_digest;
  if (packet.context_digest !== digest) errors.push(`$.context_digest: must be ${digest}`);
  if (packet.unit_id !== unit.id) errors.push(`$.unit_id: must be "${unit.id}"`);
  if (packet.role !== role) errors.push(`$.role: must be "${role}"`);

  const expectedRefs = sortRefs(env.expectedDependencyRefs || []);
  if (JSON.stringify(sortRefs(packet.dependency_refs)) !== JSON.stringify(expectedRefs)) {
    errors.push(
      expectedRefs.length
        ? `$.dependency_refs: copy the supplied packet_refs exactly: ${JSON.stringify(expectedRefs)}`
        : '$.dependency_refs: must be [] for a first-pass packet',
    );
  }

  // Coverage: every covered file/viewpoint exactly once, reviewed rows backed
  // by evidence. Review items are accounted for by item_verdicts instead.
  const coverIds = unit.covers.filter((c) => c.startsWith('file:') || c.startsWith('viewpoint:'));
  const seen = new Map();
  packet.coverage.forEach((row, i) => {
    const at = `$.coverage[${i}]`;
    seen.set(row.id, (seen.get(row.id) || 0) + 1);
    if (!coverIds.includes(row.id)) errors.push(`${at}.id: "${row.id}" is not a coverage id of this unit (${coverIds.join(', ')})`);
    if (row.disposition === 'reviewed') {
      if (!row.evidence.length) errors.push(`${at}: disposition "reviewed" needs evidence; use "unverified" with a note if you could not check it`);
      if (row.id.startsWith('file:') && !row.evidence.some((ev) => ev.kind === 'code' && ev.path === row.id.slice(5))) {
        errors.push(`${at}: a reviewed "${row.id}" row needs at least one code evidence with path "${row.id.slice(5)}"`);
      }
    }
    row.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `${at}.evidence[${j}]`)));
  });
  for (const id of coverIds) {
    const n = seen.get(id) || 0;
    if (n === 0) errors.push(`$.coverage: missing a row for "${id}"`);
    if (n > 1) errors.push(`$.coverage: "${id}" appears ${n} times; exactly once is required`);
  }

  // Review item verdicts. Gap and contradiction items have no expected
  // result, so they can only be described, never passed or failed.
  const itemById = new Map((env.items || []).map((i) => [i.id, i]));
  const coveredItems = unit.covers.filter((c) => /^I[1-9][0-9]*$/.test(c));
  const verdictItems = new Map();
  packet.item_verdicts.forEach((v, i) => {
    const at = `$.item_verdicts[${i}]`;
    verdictItems.set(v.item, (verdictItems.get(v.item) || 0) + 1);
    if (!coveredItems.includes(v.item)) errors.push(`${at}.item: ${v.item} is not covered by unit ${unit.id}`);
    const item = itemById.get(v.item);
    if (item && ['gap', 'contradiction'].includes(item.kind) && ['pass', 'fail'].includes(v.verdict)) {
      errors.push(`${at}: ${v.item} is a ${item.kind} item with no expected result; use "cannot_determine" (describe what the code does in note, with code evidence) or "not_applicable"`);
    }
    if (v.verdict === 'pass' && !v.evidence.some((ev) => ev.kind === 'code')) errors.push(`${at}: "pass" needs code evidence; without it use "cannot_determine"`);
    if (v.verdict === 'fail' && !packet.findings.some((f) => f.items.includes(v.item) || (f.authority.kind === 'requirement' && f.authority.id === v.item))) {
      errors.push(`${at}: "fail" for ${v.item} needs a finding that lists "${v.item}" in its items`);
    }
    v.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `${at}.evidence[${j}]`)));
  });
  for (const [id, n] of verdictItems) if (n > 1) errors.push(`$.item_verdicts: ${id} appears ${n} times`);
  if (role === 'business') {
    for (const id of coveredItems) if (!verdictItems.has(id)) errors.push(`$.item_verdicts: missing a verdict for ${id}`);
  }

  // Viewpoint matrix: the runtime assigned the unit's checklist viewpoints;
  // the answering role gives exactly one verdict for each, the other none.
  const checks = unit.checks || [];
  const answering = checks.length && unit.roles ? checkRole(unit) : role;
  const vpVerdicts = packet.viewpoint_verdicts || [];
  if (role !== answering && vpVerdicts.length) {
    errors.push(`$.viewpoint_verdicts: must be []; the ${answering} reviewer of ${unit.id} answers them`);
  } else {
    const seenVp = new Map();
    vpVerdicts.forEach((v, i) => {
      const at = `$.viewpoint_verdicts[${i}]`;
      seenVp.set(v.viewpoint, (seenVp.get(v.viewpoint) || 0) + 1);
      if (!checks.includes(v.viewpoint)) errors.push(`${at}.viewpoint: ${v.viewpoint} is not a viewpoint assigned to unit ${unit.id} (${checks.join(', ') || 'none'})`);
      const under = packet.findings.filter((f) => f.authority.kind === 'curated_viewpoint' && f.authority.id === v.viewpoint);
      if (v.verdict === 'pass' && !v.evidence.some((ev) => ev.kind === 'code')) errors.push(`${at}: "pass" needs code evidence; without it use "cannot_determine"`);
      if (v.verdict === 'fail' && !under.length) errors.push(`${at}: "fail" for ${v.viewpoint} needs a finding whose authority is curated_viewpoint ${v.viewpoint}`);
      if (v.verdict !== 'fail' && under.length) errors.push(`${at}: ${under.map((f) => f.id).join(', ')} violates ${v.viewpoint}, but its verdict is "${v.verdict}"; use "fail"`);
      v.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `${at}.evidence[${j}]`)));
    });
    for (const [id, n] of seenVp) if (n > 1) errors.push(`$.viewpoint_verdicts: ${id} appears ${n} times`);
    if (role === answering) for (const id of checks) if (!seenVp.has(id)) errors.push(`$.viewpoint_verdicts: missing a verdict for ${id}`);
  }

  // Findings.
  // Requirement authority: a review item (I*) or a requirement item (AC*).
  const reqIds = new Set([...itemById.keys(), ...((env.requirements && env.requirements.items) || []).map((i) => i.id)]);
  const idPattern = new RegExp(`^${unit.id}-${role}-F[1-9][0-9]*$`);
  const ids = new Set();
  packet.findings.forEach((f, i) => {
    const at = `$.findings[${i}]`;
    if (!idPattern.test(f.id)) errors.push(`${at}.id: must look like "${unit.id}-${role}-F${i + 1}"`);
    if (ids.has(f.id)) errors.push(`${at}.id: duplicate id ${f.id}`);
    ids.add(f.id);
    const blocking = f.severity === 'P1' || f.severity === 'P2';
    if (blocking && f.confidence === 'HYPOTHESIS') errors.push(`${at}: a HYPOTHESIS cannot be ${f.severity}; downgrade to P3/P4 or support it as LIKELY`);
    for (const id of f.items) if (!itemById.has(id)) errors.push(`${at}.items: ${id} is not a review item`);
    if (!f.evidence.some((ev) => ev.kind === 'code')) errors.push(`${at}.evidence: needs at least one code evidence`);
    f.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `${at}.evidence[${j}]`)));

    const a = f.authority;
    errors.push(...validateEvidence(a.source, sources, `${at}.authority.source`));
    if (a.kind === 'requirement') {
      if (!reqIds.has(a.id)) errors.push(`${at}.authority.id: "${a.id}" is not a frozen review item (I*) or requirement item (AC*)`);
      if (a.source.kind !== 'input' || !['review-items', 'requirements', 'spec'].includes(a.source.path)) errors.push(`${at}.authority.source: cite the frozen input "review-items" (or "requirements" / "spec")`);
    } else if (a.kind === 'curated_viewpoint') {
      if (!sources.policyText().includes(a.id)) errors.push(`${at}.authority.id: "${a.id}" does not occur in any frozen policy/checklist input`);
    } else if (a.kind === 'inferred' && blocking) {
      errors.push(`${at}: inferred authority cannot support ${f.severity}; cite a requirement or checklist viewpoint, or downgrade to P3/P4`);
    }

    if (f.fix.kind === 'code_change') {
      if (!f.fix.asis.trim()) errors.push(`${at}.fix.asis: copy the exact current source lines`);
      else {
        const asis = collapse(f.fix.asis);
        const inEvidence = f.evidence.some((ev) => ev.kind === 'code' && collapse(regionText(ev, sources)).includes(asis));
        if (!inEvidence) errors.push(`${at}.fix.asis: must be copied verbatim from one of this finding's code evidence ranges`);
      }
      if (!looksLikeCode(f.fix.tobe)) errors.push(`${at}.fix.tobe: must be replacement code, not prose; explanations belong in fix.reason`);
      if (collapse(f.fix.tobe) === collapse(f.fix.asis)) errors.push(`${at}.fix.tobe: identical to fix.asis`);
    }
    if (f.verification.method === 'executed' && !f.verification.evidence.some((ev) => ev.kind === 'artifact')) {
      errors.push(`${at}.verification: "executed" needs a hash-bound artifact log; review workers are read-only, so use "inspected"`);
    }
    f.verification.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `${at}.verification.evidence[${j}]`)));
  });

  if (packet.findings.length && packet.recommendation !== 'findings') errors.push('$.recommendation: must be "findings" when findings are reported');
  if (!packet.findings.length && packet.recommendation === 'findings') errors.push('$.recommendation: "findings" with an empty findings list');
  return errors;
}

// Blind red-team defense of exactly one finding.
function validateRebuttal(rebuttal, env) {
  const errors = validateAgainst('review', rebuttal, 'rebuttal');
  if (errors.length) return errors;
  const { sources, finding } = env;
  if (rebuttal.context_digest !== sources.context.context_digest) errors.push(`$.context_digest: must be ${sources.context.context_digest}`);
  if (rebuttal.finding_id !== finding.id) errors.push(`$.finding_id: must be "${finding.id}"`);
  const expected = sha256Value(finding);
  if (rebuttal.finding_sha256 !== expected) errors.push(`$.finding_sha256: must be ${expected}`);
  rebuttal.evidence.forEach((ev, i) => errors.push(...validateEvidence(ev, sources, `$.evidence[${i}]`)));
  if (!rebuttal.evidence.some((ev) => ev.kind === 'code')) errors.push('$.evidence: needs at least one code evidence you found yourself');
  return errors;
}

// env: { sources, expectedPacketRefs, findingIds:Set, recommendation }
function validateSynthesis(synthesis, env) {
  const errors = validateAgainst('review', synthesis, 'synthesis');
  if (errors.length) return errors;
  const { sources } = env;
  if (synthesis.context_digest !== sources.context.context_digest) errors.push(`$.context_digest: must be ${sources.context.context_digest}`);
  if (JSON.stringify(sortRefs(synthesis.packet_refs)) !== JSON.stringify(sortRefs(env.expectedPacketRefs))) {
    errors.push('$.packet_refs: must equal the supplied packet_refs exactly');
  }
  const aliasOf = new Map();
  synthesis.aliases.forEach((a, i) => {
    if (!env.findingIds.has(a.id)) errors.push(`$.aliases[${i}].id: unknown finding ${a.id}`);
    if (!env.findingIds.has(a.duplicate_of)) errors.push(`$.aliases[${i}].duplicate_of: unknown finding ${a.duplicate_of}`);
    if (a.id === a.duplicate_of) errors.push(`$.aliases[${i}]: a finding cannot alias itself`);
    if (aliasOf.has(a.id)) errors.push(`$.aliases[${i}]: ${a.id} aliased twice`);
    aliasOf.set(a.id, a.duplicate_of);
  });
  for (const start of aliasOf.keys()) {
    const visited = new Set([start]);
    let cur = aliasOf.get(start);
    while (aliasOf.has(cur)) {
      if (visited.has(cur)) {
        errors.push(`$.aliases: cycle through ${start}`);
        break;
      }
      visited.add(cur);
      cur = aliasOf.get(cur);
    }
  }
  synthesis.overview.forEach((flow, i) => {
    flow.finding_ids.forEach((id) => {
      if (!env.findingIds.has(id)) errors.push(`$.overview[${i}].finding_ids: unknown finding ${id}`);
    });
    flow.evidence.forEach((ev, j) => errors.push(...validateEvidence(ev, sources, `$.overview[${i}].evidence[${j}]`)));
  });
  if (synthesis.recommendation !== env.recommendation) {
    errors.push(`$.recommendation: the runtime computed "${env.recommendation}" from packets and rebuttals; it must match`);
  }
  return errors;
}

module.exports = {
  splitLines,
  collapse,
  makeSources,
  quoteMatchesAt,
  locateQuote,
  canonicalizeCandidate,
  validateEvidence,
  validatePacket,
  validateRebuttal,
  validateSynthesis,
  looksLikeCode,
};
