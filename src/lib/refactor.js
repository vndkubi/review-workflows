'use strict';
// Refactor suggestions: a lane beside the review, never inside its verdict.
// A simplifier model proposes simpler code for lines the PR added; the
// runtime decides which proposals are shown. A proposal is checked like any
// other model output (quotes against the frozen head, replaced lines that are
// whole and occur once), then triaged without the model: only the PR's own
// lines, never lines an open defect finding quotes, and only a replacement
// that measures simpler. Nothing here is read by computeOutcome.
const fs = require('node:fs');
const path = require('node:path');
const { readJsonIfExists, writeJsonAtomic, ensureDir, nowIso, sha256, envInt } = require('./util');
const git = require('./git');
const confine = require('./confine');
const { validateAgainst, outputSchema } = require('./schema');
const { loadContext, verifyContext, revisionDir } = require('./freeze');
const { parsePatch } = require('./patch');
const { validateEvidence, canonicalizeCandidate, makeSources, looksLikeCode, collapse, SUGGESTION, END_SLACK } = require('./validate');

// Opt-in while it is being measured (ARW_REFACTOR=on).
function enabled(env = process.env) {
  return env.ARW_REFACTOR === 'on';
}

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

// ---------- verification by execution ----------
// Replaces lines span.start..span.end of a file in a worktree with `tobe`,
// re-indented to the block it replaces ("" removes the lines). The file is
// PR code in a worktree PR code has run in: read and written through confine.
function applyAt(wt, span, tobe) {
  const file = path.join(wt, span.path);
  if (!confine.isConfinedFile(wt, file)) return { applied: false, reason: `${span.path} is not a regular file inside the worktree` };
  const text = confine.readConfined(wt, file);
  if (text == null) return { applied: false, reason: `${span.path} cannot be read` };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (span.end > lines.length) return { applied: false, reason: `${span.path} has no line ${span.end}` };
  const indentOf = (l) => l.match(/^\s*/)[0];
  const shortest = (rows) => rows.filter((l) => l.trim()).map(indentOf).sort((a, b) => a.length - b.length)[0] || '';
  const body = String(tobe).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const rows = body.trim() ? body.split('\n') : [];
  const base = shortest(lines.slice(span.start - 1, span.end));
  const cut = shortest(rows).length;
  lines.splice(span.start - 1, span.end - span.start + 1, ...rows.map((l) => (l.trim() ? base + l.slice(cut) : '')));
  confine.rewriteFile(wt, file, lines.join(eol));
  return { applied: true };
}

// Runs the tests that cover each candidate's file on the head as it is and
// with the candidates applied. Returns { verdicts: Map id -> { status, reason,
// tests }, logs }. VERIFIED: its tests passed before and after. BROKEN: a test
// that passed fails, or no longer builds, with it applied. UNVERIFIED: nothing
// could show either. All candidates are applied together first (triage keeps
// them apart); only when that run is not green is each suspect run alone.
// PR code runs where the review's sandbox says, never on the host by fallback,
// and on a host only with the consent repro asks for (ARW_ALLOW_HOST_CODE=1).
async function verifySuggestions({ runDir, context, doc, records, runner = null, log = () => {} }) {
  const verdicts = new Map();
  const logs = [];
  const candidates = records.filter((x) => x.status === 'CANDIDATE');
  const unverified = (c, reason, tests = []) => verdicts.set(c.id, { status: 'UNVERIFIED', reason, tests });
  if (!candidates.length) return { verdicts, logs };
  if (process.env.ARW_REFACTOR_VERIFY === 'off') {
    for (const c of candidates) unverified(c, 'verification is off (ARW_REFACTOR_VERIFY=off)');
    return { verdicts, logs };
  }
  // Required here: impacted-tests and repro sit in the prompts/driver cycle.
  const { planRuns, runGroup, prepareWorktree } = require('./impacted-tests');
  const { defaultRunner } = require('./repro');
  const { checkout, head_sha: head } = context.source;
  // Which tests cover a file: the frozen test impact; a changed test covers itself.
  const impact = (readJsonIfExists(path.join(runDir, 'static.json')) || {}).tests || { sources: [], tests_changed: [] };
  const testsOf = (file) => {
    const src = (impact.sources || []).find((s) => s.source === file);
    return src ? src.tests.map((t) => t.path) : (impact.tests_changed || []).includes(file) ? [file] : [];
  };
  const groups = planRuns(checkout, [...new Set(candidates.flatMap((c) => testsOf(c.span.path)))]);
  const runnable = new Set(groups.flatMap((g) => g.tests.map((t) => t.path)));
  const want = new Map();
  for (const c of candidates) {
    const tests = testsOf(c.span.path).filter((t) => runnable.has(t));
    if (tests.length) want.set(c.id, tests);
    else unverified(c, `no test covers ${c.span.path}`);
  }
  const todo = candidates.filter((c) => want.has(c.id));
  if (!todo.length) return { verdicts, logs };

  const exec = runner || defaultRunner(runDir, () => {}, { fallback: false, requireHostConsent: true });
  const logDir = ensureDir(path.join(revisionDir(runDir, context.context_id), 'refactor', 'logs'));
  const timeoutMs = envInt('ARW_IMPACTED_TESTS_TIMEOUT_MS', 900000);
  const wt = path.join(runDir, 'refactor-wt');
  const byId = new Map(doc.suggestions.map((s) => [s.id, s]));
  // One pass over the groups that hold `only` (all of them when null).
  const run = async (label, only = null) => {
    const byTest = {};
    let problem = null;
    for (const [i, group] of groups.entries()) {
      const tests = only ? group.tests.filter((t) => only.has(t.path)) : group.tests;
      if (!tests.length) continue;
      const name = `${label}-${i + 1}`;
      log(`refactor: ${group.toolchain}${group.module ? ` in ${group.module}` : ''} ${label} (${tests.length} test file(s))`);
      const res = await runGroup({ wt, group: { ...group, tests }, rev: label, runner: exec, logDir, label: name, timeoutMs });
      const file = path.join(logDir, `${name}.log`);
      if (fs.existsSync(file)) logs.push({ label: name, path: `refactor/logs/${name}.log`, sha256: sha256(fs.readFileSync(file)) });
      Object.assign(byTest, res.byTest);
      problem = problem || res.spawn_error || (res.timed_out ? 'the test run timed out' : null);
    }
    return { byTest, problem };
  };
  const statusOf = (res, t) => (res.byTest[t] ? res.byTest[t].status : 'no_result');
  const judge = (c, usable, after) => {
    const tests = usable.map((t) => ({ path: t, baseline: 'pass', after: statusOf(after, t) }));
    const bad = tests.filter((t) => t.after === 'fail' || t.after === 'command_failed');
    const names = (list) => list.map((t) => t.path).join(', ');
    if (bad.length) return { status: 'BROKEN', reason: `${names(bad)} ${bad.some((t) => t.after === 'command_failed') ? 'no longer builds or runs' : bad.length === 1 ? 'fails' : 'fail'} with it applied`, tests };
    const open = tests.filter((t) => t.after !== 'pass');
    if (open.length) return { status: 'UNVERIFIED', reason: after.problem ? `the tests could not run: ${after.problem}` : `no result with it applied (${open.map((t) => `${t.path}: ${t.after}`).join(', ')})`, tests };
    return { status: 'VERIFIED', reason: `${names(tests)} ${tests.length === 1 ? 'passes' : 'pass'} before and after`, tests };
  };
  const reset = () => git.worktreeGit(checkout, wt, ['checkout', '--', '.'], { allowFail: true });
  // Bottom-up inside a file, so the spans of the lines above stay true.
  const apply = (list) => {
    const failed = new Map();
    for (const c of [...list].sort((a, b) => a.span.path.localeCompare(b.span.path) || b.span.start - a.span.start)) {
      const res = applyAt(wt, c.span, byId.get(c.id).fix.tobe);
      if (!res.applied) failed.set(c.id, res.reason);
    }
    return failed;
  };
  try {
    prepareWorktree(checkout, wt, head);
    const before = await run('baseline');
    const usable = new Map();
    for (const c of todo) {
      const tests = want.get(c.id);
      const green = tests.filter((t) => statusOf(before, t) === 'pass');
      if (green.length) usable.set(c.id, green);
      else unverified(c, before.problem ? `the tests could not run: ${before.problem}` : `its tests do not pass on the head as it is (${tests.map((t) => `${t}: ${statusOf(before, t)}`).join(', ')})`, tests.map((t) => ({ path: t, baseline: statusOf(before, t), after: null })));
    }
    let ready = todo.filter((c) => usable.has(c.id));
    if (ready.length) {
      const failed = apply(ready);
      for (const c of ready) if (failed.has(c.id)) unverified(c, `could not be applied: ${failed.get(c.id)}`);
      ready = ready.filter((c) => !failed.has(c.id));
    }
    if (ready.length) {
      const together = await run('all', new Set(ready.flatMap((c) => usable.get(c.id))));
      const first = ready.map((c) => [c, judge(c, usable.get(c.id), together)]);
      const suspects = first.filter(([, v]) => v.status !== 'VERIFIED');
      for (const [c, v] of first) if (v.status === 'VERIFIED' || ready.length === 1) verdicts.set(c.id, v);
      // A candidate whose tests were not green with all applied is tried
      // alone: the failure may belong to another suggestion on the same tests.
      if (ready.length > 1) {
        for (const [c] of suspects) {
          reset();
          const failed = apply([c]);
          if (failed.has(c.id)) unverified(c, `could not be applied: ${failed.get(c.id)}`);
          else verdicts.set(c.id, judge(c, usable.get(c.id), await run(c.id, new Set(usable.get(c.id)))));
        }
      }
    }
  } catch (err) {
    for (const c of todo) if (!verdicts.has(c.id)) unverified(c, `verification stopped: ${String(err.message).split('\n')[0]}`);
  } finally {
    git.git(checkout, ['worktree', 'remove', '--force', wt], { allowFail: true });
  }
  return { verdicts, logs };
}

// ---------- the job ----------
// The defect findings still open in this revision: valid packets only, minus
// what the red team withdrew and the test/process remarks.
function openFindings(dir) {
  const validation = readJsonIfExists(path.join(dir, 'validation.json'));
  if (!validation) return [];
  const open = new Set(validation.findings.filter((m) => !m.suggestion && m.state !== 'withdrawn').map((m) => m.id));
  const out = [];
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJsonIfExists(path.join(dir, 'packets', job.role, `${job.unit_id}.json`));
    for (const f of (packet && packet.findings) || []) if (open.has(f.id)) out.push(f);
  }
  return out;
}

function scopeOf(runDir, context) {
  const dir = revisionDir(runDir, context.context_id);
  const file = path.join(dir, 'review.patch');
  return refactorScope(parsePatch(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), openFindings(dir), context.source.reviewable);
}

// Identity fields and ids the runtime knows are filled, not copied, and a
// quote that occurs at one place is re-anchored, as for every other job.
function fillSuggestions(context, sources) {
  return (candidate) => {
    const changes = [];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return changes;
    for (const [key, value] of Object.entries({ schema_version: '1.0', context_digest: context.context_digest, role: 'simplifier' })) {
      if (candidate[key] !== value) changes.push(`$.${key}: filled by runtime`);
      candidate[key] = value;
    }
    if (typeof candidate.notes !== 'string') candidate.notes = '';
    (Array.isArray(candidate.suggestions) ? candidate.suggestions : []).forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      if (s.id !== `RF${i + 1}`) changes.push(`$.suggestions[${i}].id: filled by runtime`);
      s.id = `RF${i + 1}`;
      const at = (c) => c.replace(/^\$\.evidence/, `$.suggestions[${i}].evidence`);
      changes.push(...canonicalizeCandidate({ evidence: s.evidence }, sources).map(at));
      if (s.reuse && typeof s.reuse === 'object') changes.push(...canonicalizeCandidate({ evidence: [s.reuse] }, sources).map((c) => c.replace(/^\$\.evidence\[0\]/, `$.suggestions[${i}].reuse`)));
    });
    return changes;
  };
}

// Last attempt still rejected: the suggestions that are valid on their own are
// kept, the others are dropped and counted (`lost`), not silently lost.
function salvageSuggestions(candidate, sources, lost) {
  const changes = [];
  if (!candidate || !Array.isArray(candidate.suggestions)) return changes;
  candidate.suggestions = candidate.suggestions.filter((s, i) => {
    const errors = validateSuggestions({ ...candidate, suggestions: [s] }, { sources });
    if (!errors.length) return true;
    const first = errors[0].replace('$.suggestions[0]', `$.suggestions[${i}]`);
    changes.push(`${first} — suggestion dropped`);
    lost.push({ id: s && s.id ? s.id : null, error: first.slice(0, 300) });
    return false;
  });
  return changes;
}

// One simplifier job over the frozen context, then the triage. Returns the
// phase record ({ status, ... }); it never throws for a job that failed, and
// nothing it writes is read by the validation of the review.
async function runRefactor({ runDir, executor, models = {}, runner = null, log = () => {} }) {
  // Required here, not at the top: driver and prompts sit in a require cycle.
  const { runModelJob, STATUS } = require('./driver');
  const prompts = require('./prompts');
  const context = loadContext(runDir);
  const drift = verifyContext(runDir, context);
  if (drift.length) throw new Error(`context no longer holds: ${drift.join('; ')}`);
  const dir = revisionDir(runDir, context.context_id);
  const out = ensureDir(path.join(dir, 'refactor'));
  const done = (status, extra = {}) => {
    const rec = { status, at: nowIso(), ...extra };
    writeJsonAtomic(path.join(out, 'status.json'), rec);
    return rec;
  };
  const sources = makeSources(runDir, context);
  const scope = scopeOf(runDir, context);
  if (!scope.added.size) {
    log('refactor: the PR adds no lines in reviewable files');
    return done('SKIPPED', { reason: 'the PR adds no lines in reviewable files' });
  }
  const file = path.join(out, 'suggestions.json');
  const recordFile = path.join(out, 'verification.json');
  let doc = readJsonIfExists(file);
  let lost = ((readJsonIfExists(recordFile) || {}).invalid_dropped) || [];
  if (doc && validateSuggestions(doc, { sources }).length) doc = null;
  if (doc) {
    log('refactor: reusing the stored suggestions');
  } else {
    lost = [];
    const receiptsFile = path.join(dir, 'receipts.json');
    const receipts = readJsonIfExists(receiptsFile, {});
    const env = { runDir, context, executor, log, receipts, flushReceipts: () => writeJsonAtomic(receiptsFile, receipts), sources };
    const rows = (map) => [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, set]) => [p, ranges(set)]);
    // Only the reserved lines the simplifier could reach: files it has in scope.
    const reserved = rows(new Map([...scope.defects].filter(([p]) => scope.added.has(p))));
    const res = await runModelJob(env, {
      label: 'refactor',
      outRel: 'refactor/suggestions.json',
      model: models.refactor || models.review,
      effort: models.effort,
      outputSchema: outputSchema('review', 'refactor'),
      fill: fillSuggestions(context, sources),
      buildPrompt: (repair) => prompts.refactorPrompt(runDir, context, { added: rows(scope.added), reserved, repair }),
      validate: (candidate) => validateSuggestions(candidate, { sources }),
      salvage: (candidate) => salvageSuggestions(candidate, sources, lost),
    });
    if (res.status !== STATUS.PASS) {
      log(`refactor: no valid suggestions (${res.status}): ${(res.errors || [])[0] || ''}`);
      return done(res.status, { reason: (res.errors || [])[0] || res.status });
    }
    doc = res.value;
  }
  const triaged = triage(doc, { sources, scope });
  const { verdicts, logs } = await verifySuggestions({ runDir, context, doc, records: triaged, runner, log });
  const records = triaged.map((x) => (x.status === 'CANDIDATE' ? { ...x, status: verdicts.get(x.id).status, verification: { reason: verdicts.get(x.id).reason, tests: verdicts.get(x.id).tests } } : x));
  writeJsonAtomic(recordFile, { schema_version: '1.0', context_digest: context.context_digest, at: nowIso(), suggestions_sha256: sha256(fs.readFileSync(file)), invalid_dropped: lost, records, logs });
  const count = (status) => records.filter((x) => x.status === status).length;
  const dropped = count('DROPPED');
  log(`refactor: ${records.length} suggestion(s): ${count('VERIFIED')} verified, ${count('UNVERIFIED')} unverified, ${count('BROKEN')} broken, ${dropped} dropped by the runtime`);
  // The hash goes to run.json: an edit of the record after the run is seen.
  return done(STATUS.PASS, { suggestions: records.length, kept: records.length - dropped, dropped, verified: count('VERIFIED'), broken: count('BROKEN'), unverified: count('UNVERIFIED'), record_sha256: sha256(fs.readFileSync(recordFile)) });
}

// The stored verdicts, or the reason they prove nothing: the record must be
// the one the run wrote (its hash is in run.json), made for these suggestions,
// with every log as it was written.
function storedVerdicts(runDir, dir) {
  const file = path.join(dir, 'verification.json');
  if (!fs.existsSync(file)) return { reason: 'no test was run for it' };
  const phase = ((readJsonIfExists(path.join(runDir, 'run.json')) || {}).phases || {}).refactor || {};
  const changed = { reason: 'the verification record changed after the run' };
  if (!phase.record_sha256 || phase.record_sha256 !== sha256(fs.readFileSync(file))) return changed;
  const rec = readJsonIfExists(file) || {};
  const suggestions = path.join(dir, 'suggestions.json');
  if (!fs.existsSync(suggestions) || rec.suggestions_sha256 !== sha256(fs.readFileSync(suggestions))) return changed;
  const base = path.dirname(dir);
  for (const l of rec.logs || []) {
    const abs = path.resolve(base, l.path);
    if (!abs.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(abs) || sha256(fs.readFileSync(abs)) !== l.sha256) return { reason: `the log of a test run changed after the run (${l.path})` };
  }
  return { records: new Map((rec.records || []).map((x) => [x.id, x])), invalid: (rec.invalid_dropped || []).length };
}

// What the report, the publisher and the dashboard show. Nothing is taken from
// the stored record on trust: the document is validated and triaged again, so
// an edit after the run, or a finding that changed since, is seen here.
// null when the lane did not run for this context.
function loadRefactor(runDir, context) {
  const dir = path.join(revisionDir(runDir, context.context_id), 'refactor');
  const status = readJsonIfExists(path.join(dir, 'status.json'));
  if (!status) return null;
  const out = { status: status.status, reason: status.reason || null, suggestions: [], dropped: {}, invalid: 0, errors: [] };
  const file = path.join(dir, 'suggestions.json');
  const doc = readJsonIfExists(file);
  if (!doc) return out;
  const sources = makeSources(runDir, context);
  out.errors = validateSuggestions(doc, { sources });
  if (out.errors.length) return out;
  const stored = storedVerdicts(runDir, dir);
  out.invalid = stored.invalid || 0;
  const byId = new Map(doc.suggestions.map((s) => [s.id, s]));
  for (const rec of triage(doc, { sources, scope: scopeOf(runDir, context) })) {
    if (rec.status === 'DROPPED') {
      out.dropped[rec.reason] = (out.dropped[rec.reason] || 0) + 1;
      continue;
    }
    // A verdict counts only for the place it was run on.
    const was = stored.records ? stored.records.get(rec.id) : null;
    const same = was && was.verification && JSON.stringify(was.span) === JSON.stringify(rec.span) && ['VERIFIED', 'BROKEN', 'UNVERIFIED'].includes(was.status);
    out.suggestions.push({ ...byId.get(rec.id), span: rec.span, metrics: rec.metrics, status: same ? was.status : 'UNVERIFIED', verification: same ? was.verification : { reason: stored.reason || 'no test was run for it', tests: [] } });
  }
  return out;
}

module.exports = { enabled, measure, isSimpler, languageOf, locateAsis, spanOf, validateSuggestions, refactorScope, ranges, triage, applyAt, verifySuggestions, runRefactor, loadRefactor };
