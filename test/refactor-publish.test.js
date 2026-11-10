'use strict';
// What leaves the machine: only a VERIFIED refactor suggestion becomes an
// inline GitHub suggestion; an UNVERIFIED one is listed in the review body, a
// BROKEN one is not published. They are kept apart from the findings in the
// draft, in the read-back and in the acceptance numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, viewpointVerdicts, impactVerdicts, coverageIdsOf } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-refactor-publish-runs-');
process.env.ARW_REFACTOR = 'on';

const { reviewPr } = require('../src/lib/pr-review');
const { loadContext } = require('../src/lib/freeze');
const { buildReview, publish, inOneHunk } = require('../src/lib/publish');
const { readBack, acceptanceStats } = require('../src/lib/feedback');
const { parsePatch } = require('../src/lib/patch');
const data = require('../src/web/data');

const CALC = 'billing/calc.py';
const OTHER = 'billing/other.py';
const CALC_BASE = 'def clamp(value, low, high):\n    return max(low, min(value, high))\n\n\ndef fee(days):\n    return 0\n';
const CALC_HEAD = `def clamp(value, low, high):
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
const OTHER_HEAD = 'def sign(n):\n    if n >= 0:\n        if n == 0:\n            return 0\n        else:\n            return 1\n    else:\n        return -1\n';
const HEADS = { [CALC]: CALC_HEAD, [OTHER]: OTHER_HEAD };
const block = (file, from, to) => HEADS[file].split('\n').slice(from - 1, to).join('\n');
const ev = (file, from, to) => ({ kind: 'code', path: file, start_line: from, end_line: to, quote: block(file, from, to) });
const FEE_TOBE = 'if days is None or days <= 30:\n    return 0\nreturn (days - 30) * 2';
const SUGGESTIONS = [
  // Not indented the way the file is: the runtime re-indents what it publishes.
  { id: 'x', kind: 'control_flow', title: 'Early return instead of nested else', reason: 'One guard says what two levels of nesting say.', evidence: [ev(CALC, 6, 12)], fix: { asis: block(CALC, 6, 12), tobe: FEE_TOBE }, reuse: null },
  { id: 'x', kind: 'control_flow', title: 'One expression for the bound', reason: 'min() does the same.', evidence: [ev(CALC, 16, 20)], fix: { asis: block(CALC, 16, 20), tobe: '    return min(rate, 1)' }, reuse: null },
  { id: 'x', kind: 'control_flow', title: 'Flatten sign()', reason: 'Two returns instead of three levels.', evidence: [ev(OTHER, 2, 8)], fix: { asis: block(OTHER, 2, 8), tobe: '    if n == 0:\n        return 0\n    return 1 if n > 0 else -1' }, reuse: null },
];

function repo() {
  const dir = tmpDir('arw-refactor-publish-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, CALC, CALC_BASE);
  write(dir, 'tests/test_calc.py', 'from billing.calc import fee\n\n\ndef test_fee():\n    assert fee(31) == 2\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, CALC, CALC_HEAD);
  write(dir, OTHER, OTHER_HEAD);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'fee, bounded, sign']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

const executor = async (opts) => {
  fs.mkdirSync(opts.attemptDir, { recursive: true });
  const p = opts.prompt;
  const ok = (o) => ({ ok: true, output: JSON.stringify(o), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 10, output_tokens: 5 }, error_class: null, model: 'fake', prompt_bytes: p.length });
  if (p.startsWith('You are a read-only planner')) return ok({ schema_version: '1.0', hypotheses: [], units: [{ id: 'T1', kind: 'technical', desc: 'billing', files: [CALC, OTHER], items: [] }], gaps: [], notes: '' });
  if (p.includes('JOB: refactor suggestions')) return ok({ schema_version: '1.0', context_digest: 'x', role: 'simplifier', suggestions: SUGGESTIONS, notes: '' });
  const unit = JSON.parse(p.match(/^UNIT: (.*)$/m)[1]);
  const role = p.match(/^JOB: .* role (business|technical)\.$/m)[1];
  const coverage = coverageIdsOf(p).map((id) => (id.startsWith('file:') ? { id, disposition: 'reviewed', evidence: [ev(id.slice(5), 1, 1)], note: 'read it' } : { id, disposition: 'unverified', evidence: [], note: 'nothing to cite' }));
  return ok({ schema_version: '1.0', context_digest: p.match(/context_digest: ([a-f0-9]{64})/)[1], unit_id: unit.id, role, summary: 'done', dependency_refs: [], coverage, item_verdicts: [], viewpoint_verdicts: viewpointVerdicts(p, []), impact_verdicts: impactVerdicts(p), findings: [], recommendation: 'no_findings' });
};

// Stands in for pytest: red once bounded() lost its lower bound.
const runner = async ({ command, cwd, logFile }) => {
  const pass = !fs.readFileSync(path.join(cwd, CALC), 'utf8').includes('return min(rate, 1)');
  fs.writeFileSync(command.match(/--junitxml=(\S+)/)[1], `<testsuite><testcase classname="tests.test_calc" name="test_fee">${pass ? '' : '<failure message="assert 0 == 1"/>'}</testcase></testsuite>`);
  fs.writeFileSync(logFile, 'pytest\n');
  return { exit_code: pass ? 0 : 1, elapsed_ms: 1 };
};

let shared = null;
async function reviewed() {
  if (shared) return shared;
  const r = repo();
  const prepared = { info: { title: 'fee, bounded, sign', body: '', headRefName: 'f', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { runDir } = await reviewPr({ repo: 'acme/calc', pr: 1, executor, prepared, workers: 1, skipSynthesis: true, noRepro: true, refactorRunner: runner });
  shared = { runDir, context: loadContext(runDir) };
  return shared;
}

test('inOneHunk: a multi-line comment needs every line in the same hunk', () => {
  const [file] = parsePatch('diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10,2 +11,3 @@\n x\n+y\n z\n');
  assert.equal(inOneHunk(file, { start: 1, end: 3 }), true);
  assert.equal(inOneHunk(file, { start: 12, end: 12 }), true);
  assert.equal(inOneHunk(file, { start: 3, end: 11 }), false, 'two hunks');
  assert.equal(inOneHunk(file, { start: 3, end: 5 }), false, 'lines the diff does not show');
  assert.equal(inOneHunk(undefined, { start: 1, end: 1 }), false);
});

test('the draft: VERIFIED inline as a GitHub suggestion, UNVERIFIED listed, BROKEN left out', async () => {
  const { runDir, context } = await reviewed();
  const review = buildReview(runDir);
  assert.equal(review.comments.length, 0, 'refactor suggestions are not findings');
  assert.match(review.body.split('\n')[0], /0 finding\(s\) inline/);

  assert.equal(review.refactorComments.length, 1);
  const c = review.refactorComments[0];
  assert.deepEqual([c.path, c.start_line, c.line, c.side, c.start_side, c.finding_id], [CALC, 6, 12, 'RIGHT', 'RIGHT', 'RF1']);
  assert.ok(c.body.includes('```suggestion\n    if days is None or days <= 30:\n        return 0\n    return (days - 30) * 2\n```'), c.body);
  assert.match(c.body, /\*\*Refactor suggestion\*\* \(not in the verdict\) · control_flow · Early return instead of nested else/);
  assert.match(c.body, /Verified: tests\/test_calc\.py passes before and after · code lines 7 → 3 · nesting 2 → 1 · branches 2 → 2/);
  assert.ok(c.body.includes(`<!-- arw:finding=RF1 context=${context.context_id} -->`));

  assert.match(review.body, /## Refactor suggestions \(not in the verdict\)/);
  assert.match(review.body, /1 inline as a GitHub suggestion/);
  assert.match(review.body, /- `RF3` \[control_flow\] Flatten sign\(\) — `billing\/other\.py:2-8` · UNVERIFIED \(no test covers billing\/other\.py\)/);
  assert.ok(review.body.includes(`<!-- arw:finding=RF3 context=${context.context_id} -->`));
  assert.doesNotMatch(review.body, /RF2|One expression for the bound/, 'a suggestion that broke a test is not published');
});

test('publish sends the suggestion with its line range and records it apart from the findings', async () => {
  const { runDir } = await reviewed();
  let sent = null;
  const { record } = publish(runDir, { createPendingReview: (req) => { sent = req; return { id: 7, html_url: 'https://github.example/r/7' }; } });
  assert.equal(sent.comments.length, 1);
  assert.deepEqual([sent.comments[0].path, sent.comments[0].start_line, sent.comments[0].line, sent.comments[0].start_side, sent.comments[0].side], [CALC, 6, 12, 'RIGHT', 'RIGHT']);
  assert.equal(sent.comments[0].finding_id, undefined, 'internal ids stay here');
  assert.deepEqual(record.inline, []);
  assert.deepEqual(record.refactor, [{ id: 'RF1', inline: true, path: CALC, line: 12, title: 'Early return instead of nested else' }, { id: 'RF3', inline: false, path: OTHER, line: 8, title: 'Flatten sign()' }]);
  assert.ok(record.bodies.RF1);
});

test('read-back: what the reviewer did with each suggestion, counted apart from findings', async () => {
  const { runDir, context } = await reviewed();
  const body = buildReview(runDir).body;
  // The reviewer deleted the inline suggestion and kept the review body.
  const api = (url) => {
    if (/\/reviews\/7$/.test(url)) return { state: 'COMMENTED', submitted_at: '2026-11-11T10:00:00Z', body };
    if (/\/reviews\/7\/comments/.test(url)) return [];
    return [];
  };
  const { record, remembered } = readBack(runDir, { api });
  assert.deepEqual(record.findings, []);
  assert.deepEqual(record.refactor.map((x) => [x.id, x.verdict]), [['RF1', 'dropped'], ['RF3', 'kept']]);
  assert.deepEqual(record.refactor_counts, { kept: 1, edited: 0, dropped: 1, pending: 0, dismissed: 0 });
  assert.deepEqual(remembered, [], 'a dropped suggestion is not a rejected finding');
  const stats = acceptanceStats();
  assert.deepEqual([stats.total.kept, stats.total.dropped], [0, 0], 'finding acceptance is unchanged');
  assert.deepEqual(stats.refactor, { kept: 1, edited: 0, dropped: 1, rate: 50 });
  assert.ok(context.context_id);
});

test('dashboard stepper: a Refactor step only for a run that has the lane; a failed simplifier is a warning, not a failed review', () => {
  const { reviewSteps } = require('../src/web/insights');
  const phases = { prepare: { status: 'EXECUTED_PASS' }, batch: { status: 'EXECUTED_PASS' } };
  assert.equal(reviewSteps({ run: { phases } }).some((s) => s.id === 'refactor'), false);
  const on = reviewSteps({ run: { phases: { ...phases, refactor: { status: 'EXECUTED_PASS', verified: 1, unverified: 2, broken: 0, dropped: 3 } } }, hasReport: true });
  assert.deepEqual(on.slice(-2).map((s) => [s.id, s.state, s.detail]), [['refactor', 'done', '1 verified · 2 unverified · 0 broken · 3 dropped'], ['report', 'done', '']]);
  const bad = reviewSteps({ run: { phases: { ...phases, refactor: { status: 'EXECUTED_FAIL', reason: 'output is not one JSON object' } } } }).find((s) => s.id === 'refactor');
  assert.deepEqual([bad.state, bad.detail], ['warn', 'no valid suggestions: output is not one JSON object']);
});

test('dashboard data: the PR detail carries the suggestions and their labels', async () => {
  const { runDir } = await reviewed();
  const d = data.prDetail(path.basename(runDir));
  assert.equal(d.refactor.status, 'EXECUTED_PASS');
  assert.deepEqual(d.refactor.suggestions.map((s) => [s.id, s.status, s.span.path]), [['RF1', 'VERIFIED', CALC], ['RF2', 'BROKEN', CALC], ['RF3', 'UNVERIFIED', OTHER]]);
  assert.equal(d.refactor.suggestions[0].replacement, '    if days is None or days <= 30:\n        return 0\n    return (days - 30) * 2');
  assert.equal(d.phases.refactor.verified, 1);
});
