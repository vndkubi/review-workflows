'use strict';
// Refactor suggestions are checked by the runtime, never taken on trust: the
// quote is real, the replaced lines are whole source lines that occur once,
// the replacement is code, a "reuse" names the helper it calls. What is valid
// but not worth showing (old code, lines under a defect finding, a replacement
// that does not measure simpler) is dropped with a reason, not repaired.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, sh, write } = require('./helpers');
const { splitLines } = require('../src/lib/validate');
const { parsePatch } = require('../src/lib/patch');
const git = require('../src/lib/git');
const { measure, isSimpler, refactorScope, validateSuggestions, triage, locateAsis } = require('../src/lib/refactor');

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
const DIGEST = 'b'.repeat(64);

function repo() {
  const dir = tmpDir('arw-refactor-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, FILE, BASE);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, FILE, HEAD);
  sh(dir, ['commit', '-q', '-am', 'fee and bounded']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

const r = repo();
const sources = {
  context: { context_digest: DIGEST },
  code: (file, rev) => {
    const text = git.showFile(r.dir, rev === 'base' ? r.base : r.head, file);
    return text == null ? null : splitLines(text);
  },
  input: () => null,
  artifact: () => null,
  artifactSha: () => null,
  inputIds: () => [],
  policyText: () => '',
};
const parsed = parsePatch(git.diffPatch(r.dir, r.base, r.head));

const lines = HEAD.split('\n');
// Code evidence for head lines from..to (1-based, inclusive).
const ev = (from, to) => ({ kind: 'code', path: FILE, start_line: from, end_line: to, quote: lines.slice(from - 1, to).join('\n') });
const FEE_ASIS = lines.slice(5, 12).join('\n');
const FEE_TOBE = '    if days is None or days <= 30:\n        return 0\n    return (days - 30) * 2';
const BOUNDED_ASIS = lines.slice(15, 20).join('\n');

const controlFlow = () => ({ id: 'RF1', kind: 'control_flow', title: 'Early return instead of nested else', reason: 'Two levels of nesting say the same as one guard.', evidence: [ev(6, 12)], fix: { asis: FEE_ASIS, tobe: FEE_TOBE } });
const reuse = () => ({ id: 'RF2', kind: 'reuse', title: 'clamp() already does this', reason: 'The file has a helper for bounding a value.', evidence: [ev(16, 20)], fix: { asis: BOUNDED_ASIS, tobe: '    return clamp(rate, 0, 1)' }, reuse: ev(1, 1) });
const doc = (...suggestions) => ({ schema_version: '1.0', context_digest: DIGEST, role: 'simplifier', suggestions, notes: '' });
const errorsOf = (...suggestions) => validateSuggestions(doc(...suggestions), { sources });

test('measure counts lines, nesting and branches for Python and Java', () => {
  assert.deepEqual(measure(FEE_ASIS, 'python'), { lines: 7, nesting: 2, branches: 2 });
  assert.deepEqual(measure(FEE_TOBE, 'python'), { lines: 3, nesting: 1, branches: 2 });
  const java = 'if (a) {\n    // a comment with if and for\n    if (b && c) {\n        run("if (x) {");\n    }\n}';
  assert.deepEqual(measure(java, 'java'), { lines: 5, nesting: 2, branches: 3 });
  assert.deepEqual(measure('return a ? b : c;', 'java'), { lines: 1, nesting: 0, branches: 1 });
});

test('simpler means something went down and neither nesting nor branches went up', () => {
  assert.equal(isSimpler({ lines: 6, nesting: 2, branches: 2 }, { lines: 3, nesting: 1, branches: 2 }), true);
  assert.equal(isSimpler({ lines: 6, nesting: 2, branches: 2 }, { lines: 6, nesting: 2, branches: 2 }), false);
  assert.equal(isSimpler({ lines: 6, nesting: 2, branches: 2 }, { lines: 4, nesting: 3, branches: 2 }), false);
  assert.equal(isSimpler({ lines: 6, nesting: 2, branches: 2 }, { lines: 2, nesting: 1, branches: 3 }), false);
});

test('locateAsis finds whole lines whatever their indentation', () => {
  assert.deepEqual(locateAsis(lines, FEE_ASIS), [{ start: 6, end: 12 }]);
  assert.deepEqual(locateAsis(lines, 'if rate < 0:\n  rate = 0'), [{ start: 16, end: 17 }]);
  // The exact text names one place even when its trimmed lines occur twice.
  assert.deepEqual(locateAsis(lines, '    else:\n        return 0'), [{ start: 11, end: 12 }]);
  assert.equal(locateAsis(lines, 'return 0').length, 2);
  assert.deepEqual(locateAsis(lines, 'days > 30'), []);
});

test('well-formed suggestions pass', () => {
  assert.deepEqual(errorsOf(controlFlow(), reuse()), []);
});

test('a quote that is not in the file is rejected', () => {
  const s = controlFlow();
  s.evidence = [{ ...ev(6, 12), quote: 'if days is None:\n        return 1' }];
  assert.match(errorsOf(s).join('\n'), /suggestions\[0\]\.evidence\[0\]: quote not found/);
});

test('fix.asis must be whole lines from the evidence that occur once', () => {
  const partial = controlFlow();
  partial.fix.asis = 'days > 30';
  assert.match(errorsOf(partial).join('\n'), /fix\.asis: .*whole source lines/);

  const elsewhere = controlFlow();
  elsewhere.fix.asis = BOUNDED_ASIS;
  assert.match(errorsOf(elsewhere).join('\n'), /fix\.asis: .*evidence/);

  const twice = controlFlow();
  twice.evidence = [ev(10, 10)];
  twice.fix = { asis: 'return 0', tobe: 'return None' };
  assert.match(errorsOf(twice).join('\n'), /fix\.asis: .*occurs 2 times/);
});

test('fix.tobe is code and differs from asis; only dead code may be removed', () => {
  const prose = controlFlow();
  prose.fix.tobe = 'Use an early return here.';
  assert.match(errorsOf(prose).join('\n'), /fix\.tobe: must be replacement code/);

  const same = controlFlow();
  same.fix.tobe = FEE_ASIS.replace(/ {4}/g, '  ');
  assert.match(errorsOf(same).join('\n'), /fix\.tobe: identical to fix\.asis/);

  const empty = controlFlow();
  empty.fix.tobe = '';
  assert.match(errorsOf(empty).join('\n'), /fix\.tobe: .*only a "dead_code" suggestion/);

  const dead = { ...controlFlow(), kind: 'dead_code', evidence: [ev(11, 12)], fix: { asis: lines.slice(10, 12).join('\n'), tobe: '' } };
  assert.deepEqual(errorsOf(dead), []);
});

test('a reuse suggestion quotes the existing helper and calls it', () => {
  const none = reuse();
  delete none.reuse;
  assert.match(errorsOf(none).join('\n'), /reuse: .*required/);

  const self = reuse();
  self.reuse = ev(16, 16);
  assert.match(errorsOf(self).join('\n'), /reuse: .*outside the lines it replaces/);

  const unrelated = reuse();
  unrelated.fix.tobe = '    return max(0, min(rate, 1))';
  assert.match(errorsOf(unrelated).join('\n'), /fix\.tobe: .*helper quoted in reuse/);
});

test('ids are unique and the document is bound to the context', () => {
  const a = controlFlow();
  const b = { ...reuse(), id: 'RF1' };
  assert.match(errorsOf(a, b).join('\n'), /duplicate id RF1/);
  assert.match(validateSuggestions({ ...doc(), context_digest: 'c'.repeat(64) }, { sources }).join('\n'), /context_digest/);
});

test('triage keeps a simpler change on added lines and measures it', () => {
  const scope = refactorScope(parsed, []);
  const out = triage(doc(controlFlow(), reuse()), { sources, scope });
  assert.deepEqual(out.map((x) => [x.id, x.status]), [['RF1', 'CANDIDATE'], ['RF2', 'CANDIDATE']]);
  assert.deepEqual(out[0].span, { path: FILE, start: 6, end: 12 });
  assert.deepEqual(out[0].metrics, { before: { lines: 7, nesting: 2, branches: 2 }, after: { lines: 3, nesting: 1, branches: 2 } });
});

test('triage drops old code, lines under a defect finding, a change that is not simpler, and overlaps', () => {
  const old = { id: 'RF1', kind: 'control_flow', title: 't', reason: 'r', evidence: [ev(2, 2)], fix: { asis: lines[1], tobe: '    return min(max(value, low), high)' } };
  const longer = controlFlow();
  longer.id = 'RF2';
  longer.fix.tobe = `${FEE_ASIS}\n    pass`;
  const scope = refactorScope(parsed, []);
  assert.deepEqual(triage(doc(old, longer), { sources, scope }).map((x) => [x.status, x.reason]), [['DROPPED', 'out_of_scope'], ['DROPPED', 'not_simpler']]);

  // A defect finding quotes line 8: the fix comes first.
  const defect = { id: 'T1-technical-F1', category: 'defect', evidence: [ev(8, 8)] };
  const testGap = { id: 'T1-technical-F2', category: 'test_gap', evidence: [ev(17, 17)] };
  const guarded = refactorScope(parsed, [defect, testGap]);
  assert.deepEqual(triage(doc(controlFlow(), reuse()), { sources, scope: guarded }).map((x) => [x.id, x.status, x.reason || null]), [['RF1', 'DROPPED', 'overlaps_finding'], ['RF2', 'CANDIDATE', null]]);

  const again = { ...controlFlow(), id: 'RF2', evidence: [ev(7, 10)], fix: { asis: lines.slice(6, 10).join('\n'), tobe: '        return (days - 30) * 2 if days > 30 else 0' } };
  assert.deepEqual(triage(doc(controlFlow(), again), { sources, scope }).map((x) => [x.status, x.reason || null]), [['CANDIDATE', null], ['DROPPED', 'overlaps_suggestion']]);
});
