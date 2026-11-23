'use strict';
// Eval honesty: a missing result is a gap, precision needs a labelled
// denominator, a tool change is visible, and repeat=1 is not spread.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

process.env.ARW_EVAL_DIR = tmpDir('arw-honesty-eval-');
process.env.ARW_ENV_FILE = path.join(tmpDir('arw-honesty-env-'), '.env');
const evals = require('../src/lib/eval');
const measure = require('../src/lib/eval-measure');
const git = require('../src/lib/git');

const LABEL = { id: 'N1', path: 'a.py', keywords: ['style'], why: 'not a defect' };
const FINDING = {
  id: 'F1', severity: 'P3', title: 'style nit', asis: 'style', tobe: 'clean',
  evidence: [{ kind: 'code', path: 'a.py', start_line: 1, end_line: 1, quote: 'x' }],
};

function rawRun(findings) {
  const dir = tmpDir('arw-honesty-run-');
  fs.writeFileSync(path.join(dir, 'raw-review.json'), JSON.stringify({
    status: 'EXECUTED_PASS', findings, receipts: [{ model: 'fake', usage: { input_tokens: 1, output_tokens: 1 }, elapsed_ms: 1 }],
  }));
  return dir;
}

test('NO_RESULT is excluded from recall and listed as a gap', () => {
  const repo = tmpDir('arw-honesty-repo-');
  const gap = evals.scoreCase({ id: 'gap', repo, base: 'b', head: 'h', expected: [{ id: 'E1', path: 'a.py' }] }, null);
  const hit = evals.scoreCase({ id: 'hit', repo, base: 'b', head: 'h', expected: [{ id: 'E1', path: 'a.py' }] }, rawRun([FINDING]));
  assert.equal(gap.recall, null);
  assert.equal(gap.scored_expected, 0);
  assert.match(gap.gap, /NO_RESULT|no review result/);
  assert.equal(hit.recall, 1);
  const totals = evals.aggregate([gap, hit]);
  assert.equal(totals.expected, 2);
  assert.equal(totals.scored_expected, 1);
  assert.equal(totals.gaps, 1);
  assert.equal(totals.recall, 1, 'the gap does not enter the recall denominator');
  const card = evals.finalize({ id: 'gaps', repeat: 1, tool_sha256: 'a'.repeat(64), cases: [gap, hit] });
  assert.deepEqual(card.gaps.map((g) => g.id), ['gap']);
  const md = evals.renderScorecard(card);
  assert.match(md, /## Gaps \(NO_RESULT, not counted as misses\)/);
  assert.match(md, /gap: no review result/);
  assert.match(md, /NO_RESULT \(gap, excluded from recall\)/);
});

test('a not_expected label gives precision a denominator; no labels means N/A', () => {
  const repo = tmpDir('arw-honesty-precision-');
  const without = evals.scoreCase({ id: 'none', repo, base: 'b', head: 'h', expected: [], not_expected: [] }, rawRun([FINDING]));
  assert.equal(without.fp, 0);
  assert.equal(without.precision, null, 'no false-positive labels: precision is not 100%');
  const withLabel = evals.scoreCase({ id: 'one', repo, base: 'b', head: 'h', expected: [], not_expected: [LABEL] }, rawRun([FINDING]));
  assert.equal(withLabel.fp, 1);
  assert.equal(withLabel.not_expected, 1);
  assert.equal(withLabel.precision, 0, 'the labelled finding lowers precision');
  const md = evals.renderScorecard(evals.finalize({ id: 'p', repeat: 1, tool_sha256: 'b'.repeat(64), cases: [without] }));
  assert.match(md, /precision not measurable: no not_expected labels/);
});

// Incident: `arw eval list` showed "precision 100%" for runs where one finding
// was labelled and 14 were not; the headline hid that precision was unknown.
test('unlabelled findings widen precision into a range instead of hiding behind 100%', () => {
  const repo = tmpDir('arw-honesty-range-');
  const other = (id) => ({ ...FINDING, id, title: `other ${id}`, evidence: [{ kind: 'code', path: 'b.py', start_line: 9, end_line: 9, quote: 'y' }] });
  const s = evals.scoreCase({ id: 'r', repo, base: 'b', head: 'h', expected: [{ id: 'E1', path: 'a.py' }], not_expected: [{ id: 'N9', path: 'zzz.py' }] }, rawRun([FINDING, other('F2'), other('F3'), other('F4')]));
  assert.equal(s.tp, 1);
  assert.equal(s.fp, 0);
  assert.equal(s.unlabelled, 3);
  assert.equal(s.precision, 1, 'on the one labelled finding');
  assert.deepEqual(s.precision_range, { lo: 0.25, hi: 1 }, 'unlabelled counted false, then true');
  assert.equal(s.labelled_share, 0.25);
  const t = evals.aggregate([s]);
  assert.deepEqual(t.precision_range, { lo: 0.25, hi: 1 });
  assert.equal(t.labelled_share, 0.25);
  assert.equal(evals.precisionText(t), '100% of 1 labelled · range 25–100% (3 unlabelled)');
  const md = evals.renderScorecard(evals.finalize({ id: 'r', repeat: 1, tool_sha256: 'c'.repeat(64), cases: [s] }));
  assert.match(md, /range 25–100%/);
  // Everything labelled: the range closes on the point value.
  const none = evals.scoreCase({ id: 'n', repo, base: 'b', head: 'h', expected: [{ id: 'E1', path: 'a.py' }], not_expected: [{ id: 'N9', path: 'zzz.py' }] }, rawRun([FINDING]));
  assert.deepEqual(none.precision_range, { lo: 1, hi: 1 });
  assert.equal(evals.precisionText(evals.aggregate([none])), '100% of 1 labelled');
  // No findings at all: nothing to measure.
  const empty = evals.scoreCase({ id: 'e', repo, base: 'b', head: 'h', expected: [{ id: 'E1', path: 'a.py' }] }, rawRun([]));
  assert.equal(empty.precision_range, null);
  assert.equal(evals.precisionText(evals.aggregate([empty])), 'no findings');
});

test('raw review has no validator, but scoring marks quotes it could not check', () => {
  const q = measure.quoteStats({ dir: tmpDir('arw-honesty-quotes-'), base: 'b', head: 'h' }, [{
    evidence: [{ kind: 'code', path: 'missing.py', start_line: 1, end_line: 1, quote: 'x' }],
  }]);
  assert.deepEqual(q, { quotes: 1, fabricated: 0, unchecked: 1, rate: null });

  const root = path.join(__dirname, '..');
  const head = git.git(root, ['rev-parse', 'HEAD']).trim();
  const base = git.git(root, ['rev-parse', 'HEAD~1']).trim();
  const ev = (over) => ({ evidence: [{ kind: 'code', path: 'README.md', start_line: 1, end_line: 1, quote: 'agent-review-workflows', ...over }] });
  assert.equal(measure.quoteStats({ dir: root, base, head }, [ev({ start_line: null, end_line: null })]).unchecked, 1);
  assert.equal(measure.quoteStats({ dir: root, base, head }, [ev({ start_line: 999999, end_line: 999999 })]).unchecked, 1);
  const mismatch = measure.quoteStats({ dir: root, base, head }, [ev({ quote: 'definitely-not-in-readme' })]);
  assert.equal(mismatch.fabricated, 1);
  assert.equal(mismatch.unchecked, 0);
});

test('compare across tool hashes returns rows plus tool_changed with --allow-tool-diff', () => {
  const run = (id, tool) => {
    const dir = path.join(process.env.ARW_EVAL_DIR, 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scorecard.json'), JSON.stringify({
      id, started_at: '2026-11-04T00:00:00.000Z', tool_sha256: tool, arw_commit: 'a'.repeat(40),
      model: 'fake', config: 'single-agent', repeat: 1,
      cases: [{
        id: 'c', repeat: 1, status: 'EXECUTED_PASS', expected: 1, scored_expected: 1, not_expected: 0,
        found: 1, recall: 1, tp: 1, fp: 0, precision: null, cost: { calls: 1 },
        details: { expected: [{ id: 'E1', found: true }], findings: [] },
      }],
    }));
  };
  run('a', 'a'.repeat(64));
  run('b', 'b'.repeat(64));
  const refused = evals.compare('a', 'b');
  assert.match(refused.stats.tool_mismatch, /tool_sha256 differs/);
  assert.equal(refused.rows.length, 1);
  const allowed = evals.compare('a', 'b', { allowToolDiff: true });
  assert.equal(allowed.rows.length, 1);
  assert.match(allowed.stats.tool_changed, /tool_sha256 differs/);
  assert.ok(allowed.stats.mcnemar, 'paired statistics are computed with the warning');
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli', 'arw.js'), 'eval', 'compare', 'a', 'b', '--allow-tool-diff'], {
    encoding: 'utf8', timeout: 30000, env: process.env,
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /tool_changed:/);
});

test('the decision report shows repeat count and per-case spread', () => {
  const c = (found, expected) => ({
    id: 'case', repeat: 1, status: 'EXECUTED_PASS', expected, scored_expected: expected, not_expected: 0,
    found, recall: found / expected, tp: 0, fp: 0, precision: null, cost: { calls: 1 },
    details: { expected: [], findings: [] },
  });
  const card = evals.finalize({
    id: 'decision', tool_sha256: 'c'.repeat(64), repeat: 2, started_at: '2026-11-04T00:00:00.000Z',
    cases: [c(1, 2), c(2, 2)],
  });
  assert.equal(card.repeat, 2);
  assert.deepEqual(card.case_spread[0].recall, { mean: 0.75, sd: 0.3536 });
  const md = evals.renderScorecard(card);
  assert.match(md, /repeat 2/);
  assert.match(md, /## Per-case spread/);
  assert.match(md, /75% ± 35\.4%/);
  assert.match(md, /Found mean ± sd/);
  assert.match(md, /\| 1\.5 ± 0\.7071 \|/);
  assert.doesNotMatch(md, /150%/);
});
