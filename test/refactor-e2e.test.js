'use strict';
// The refactor lane through a whole review. It is off unless ARW_REFACTOR=on,
// it never changes what the review decides (status, recommendation, findings,
// gaps), and what the runtime drops is counted in the report.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, viewpointVerdicts, impactVerdicts, coverageIdsOf } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-refactor-runs-');

const { reviewPr } = require('../src/lib/pr-review');
const { loadContext, revisionDir } = require('../src/lib/freeze');
const { readJson } = require('../src/lib/util');
const { loadRefactor } = require('../src/lib/refactor');

const FILE = 'billing/calc.py';
const BASE = `def clamp(value, low, high):
    return max(low, min(value, high))


def fee(days):
    return 0
`;
const HEAD = `def clamp(value, low, high):
    return max(low, min(value, high))


def fee(days):
    if days is not None:
        if days > 30:
            return (days - 30) * 2
        else:
            return 0
    else:
        return 0


def bounded(rate):
    if rate < 0:
        rate = 0
    if rate > 1:
        rate = 1
    return rate
`;
const LINES = HEAD.split('\n');
const ev = (from, to) => ({ kind: 'code', path: FILE, start_line: from, end_line: to, quote: LINES.slice(from - 1, to).join('\n') });
const FEE_ASIS = LINES.slice(5, 12).join('\n');

function repo() {
  const dir = tmpDir('arw-refactor-e2e-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, FILE, BASE);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, FILE, HEAD);
  sh(dir, ['commit', '-q', '-am', 'fee and bounded']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

// What the scripted simplifier answers. Ids and the context digest are wrong
// on purpose: the runtime fills them.
const SUGGESTIONS = [
  { id: 'RF9', kind: 'control_flow', title: 'Early return instead of nested else', reason: 'One guard says what two levels of nesting say.', evidence: [ev(6, 12)], fix: { asis: FEE_ASIS, tobe: '    if days is None or days <= 30:\n        return 0\n    return (days - 30) * 2' }, reuse: null },
  { id: 'RF9', kind: 'reuse', title: 'clamp() already does this', reason: 'The file has a helper for bounding a value.', evidence: [ev(16, 20)], fix: { asis: LINES.slice(15, 20).join('\n'), tobe: '    return clamp(rate, 0, 1)' }, reuse: ev(1, 1) },
  { id: 'RF9', kind: 'control_flow', title: 'Spell the clamp out', reason: 'Same result.', evidence: [ev(2, 2)], fix: { asis: LINES[1], tobe: '    if value < low:\n        return low\n    return min(value, high)' }, reuse: null },
];

function executor({ refactor = 'good', prompts = [] } = {}) {
  return async (opts) => {
    fs.mkdirSync(opts.attemptDir, { recursive: true });
    const p = opts.prompt;
    prompts.push(p);
    const ok = (o) => ({ ok: true, output: typeof o === 'string' ? o : JSON.stringify(o), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 10, output_tokens: 5 }, error_class: null, model: 'fake', prompt_bytes: p.length });
    if (p.startsWith('You are a read-only planner')) return ok({ schema_version: '1.0', hypotheses: [], units: [{ id: 'T1', kind: 'technical', desc: 'calc', files: [FILE], items: [] }], gaps: [], notes: '' });
    if (p.includes('JOB: refactor suggestions')) {
      if (refactor === 'garbage') return ok('I would simplify fee() a little.');
      return ok({ schema_version: '1.0', context_digest: 'x', role: 'simplifier', suggestions: SUGGESTIONS, notes: '' });
    }
    const unit = JSON.parse(p.match(/^UNIT: (.*)$/m)[1]);
    const role = p.match(/^JOB: .* role (business|technical)\.$/m)[1];
    const coverage = coverageIdsOf(p).map((id) => (id.startsWith('file:') ? { id, disposition: 'reviewed', evidence: [ev(5, 5)], note: 'read it' } : { id, disposition: 'unverified', evidence: [], note: 'nothing to cite' }));
    // One minor defect on line 17: the lines it quotes are not for the simplifier.
    const findings = unit.id === 'T1' ? [{
      id: 'T1-technical-F1', severity: 'P3', category: 'defect', confidence: 'LIKELY', title: 'A negative rate is silently raised to zero',
      asis: 'bounded(-1) returns 0.', tobe: 'A negative rate is rejected.',
      trigger: { given: 'rate -1', when: 'bounded(-1)', then: 'it should raise' }, impact: 'A wrong rate is hidden.',
      evidence: [ev(17, 17)], fix: { kind: 'not_code', asis: '', tobe: '', reason: 'decide whether a negative rate is an error' },
      verification: { method: 'inspected', detail: 'read bounded', evidence: [] },
      authority: { kind: 'inferred', id: 'engineering-judgement', source: ev(17, 17) }, items: [],
    }] : [];
    return ok({ schema_version: '1.0', context_digest: p.match(/context_digest: ([a-f0-9]{64})/)[1], unit_id: unit.id, role, summary: 'done', dependency_refs: [], coverage, item_verdicts: [], viewpoint_verdicts: viewpointVerdicts(p, findings), impact_verdicts: impactVerdicts(p), findings, recommendation: findings.length ? 'findings' : 'no_findings' });
  };
}

async function review(pr, { on, refactor, prompts = [] } = {}) {
  const r = repo();
  const prepared = { info: { title: 'fee and bounded', body: '', headRefName: 'f', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const saved = process.env.ARW_REFACTOR;
  if (on) process.env.ARW_REFACTOR = 'on';
  else delete process.env.ARW_REFACTOR;
  try {
    const { validation, runDir } = await reviewPr({ repo: 'acme/calc', pr, executor: executor({ refactor, prompts }), prepared, workers: 1, skipSynthesis: true, noRepro: true });
    const context = loadContext(runDir);
    return { validation, runDir, context, dir: revisionDir(runDir, context.context_id), report: fs.readFileSync(path.join(runDir, 'report.md'), 'utf8'), run: readJson(path.join(runDir, 'run.json')), prompts };
  } finally {
    if (saved === undefined) delete process.env.ARW_REFACTOR;
    else process.env.ARW_REFACTOR = saved;
  }
}

const decided = (v) => ({ status: v.status, recommendation: v.recommendation, complete: v.complete, gaps: v.gaps, findings: v.findings.map((f) => [f.id, f.severity, f.state, f.suggestion]) });

test('off by default: no simplifier call, no section, no phase', async () => {
  const off = await review(1, { on: false });
  assert.equal(off.prompts.some((p) => p.includes('JOB: refactor suggestions')), false);
  assert.doesNotMatch(off.report, /Refactor suggestions/);
  assert.equal(off.run.phases.refactor, undefined);
  assert.equal(fs.existsSync(path.join(off.dir, 'refactor')), false);
  assert.equal(loadRefactor(off.runDir, off.context), null);
});

test('on: the suggestions are checked, triaged and reported, and the review decides the same', async () => {
  const off = await review(2, { on: false });
  const on = await review(3, { on: true });
  assert.deepEqual(decided(on.validation), decided(off.validation), 'the lane never reaches the verdict');
  assert.equal(on.validation.status, 'EXECUTED_PASS');

  const prompt = on.prompts.find((p) => p.includes('JOB: refactor suggestions'));
  assert.match(prompt, /^- billing\/calc\.py: 6-20$/m, 'the scope is the added lines');
  assert.match(prompt, /DO NOT TOUCH[^\n]*\n- billing\/calc\.py: 17$/m, 'lines of the open defect finding are reserved');
  assert.match(prompt, /# Simplifier \(refactor suggestions\)/, 'the charter is a frozen input');

  const stored = readJson(path.join(on.dir, 'refactor', 'suggestions.json'));
  assert.deepEqual(stored.suggestions.map((s) => s.id), ['RF1', 'RF2', 'RF3'], 'ids are filled by the runtime');
  assert.equal(stored.context_digest, on.context.context_digest);
  const records = readJson(path.join(on.dir, 'refactor', 'verification.json')).records;
  assert.deepEqual(records.map((x) => [x.id, x.status, x.reason || null]), [['RF1', 'UNVERIFIED', null], ['RF2', 'DROPPED', 'overlaps_finding'], ['RF3', 'DROPPED', 'out_of_scope']]);
  assert.equal(records[0].verification.reason, 'no test covers billing/calc.py', 'kept, but this repository has no test for it');
  assert.deepEqual([on.run.phases.refactor.status, on.run.phases.refactor.kept, on.run.phases.refactor.dropped], ['EXECUTED_PASS', 1, 2]);

  assert.match(on.report, /## Refactor suggestions \(not in the verdict\)/);
  assert.match(on.report, /### `RF1` \[control_flow\] Early return instead of nested else/);
  assert.match(on.report, /`billing\/calc\.py:6-12` · code lines 7 → 3 · nesting 2 → 1 · branches 2 → 2/);
  assert.doesNotMatch(on.report, /clamp\(\) already does this|Spell the clamp out/, 'dropped suggestions are not shown');
  assert.match(on.report, /2 dropped by the runtime: 1 on lines an open defect finding quotes, 1 on lines this PR did not add/);
  assert.match(on.report, /- runtime recommendation: \*\*no_blocking_findings\*\*/);

  const loaded = loadRefactor(on.runDir, on.context);
  assert.deepEqual(loaded.suggestions.map((s) => [s.id, s.status]), [['RF1', 'UNVERIFIED']]);
});

test('a stored suggestion edited after the runtime checked it is not shown', async () => {
  const on = await review(4, { on: true });
  const file = path.join(on.dir, 'refactor', 'suggestions.json');
  const doc = readJson(file);
  doc.suggestions[0].evidence[0].quote = 'if days is None:';
  fs.writeFileSync(file, JSON.stringify(doc));
  const loaded = loadRefactor(on.runDir, on.context);
  assert.deepEqual(loaded.suggestions, []);
  assert.match(loaded.errors.join('\n'), /quote not found/);
});

test('a simplifier that never answers validly leaves the review as it was', async () => {
  const off = await review(5, { on: false });
  const bad = await review(6, { on: true, refactor: 'garbage' });
  assert.deepEqual(decided(bad.validation), decided(off.validation));
  assert.equal(bad.run.phases.refactor.status, 'EXECUTED_FAIL');
  assert.match(bad.report, /## Refactor suggestions \(not in the verdict\)/);
  assert.match(bad.report, /The simplifier gave no valid answer \(EXECUTED_FAIL/);
});
