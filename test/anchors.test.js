'use strict';
// Incident (runs/prs, 466 attempts): a third of all model calls were repairs,
// and 85% of validator errors were "quote not found", mostly in coverage rows
// and item verdicts, where evidence only shows the reviewer read the change.
// Those may now cite a frozen diff hunk by id; the runtime fills in the lines
// and the quote from the frozen source. Findings still quote verbatim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');
const git = require('../src/lib/git');
const { hunkAnchors, renderAnchors } = require('../src/lib/anchors');
const { canonicalizeCandidate, validatePacket, splitLines } = require('../src/lib/validate');

const repo = makeRepo();
const PATCH = git.diffPatch(repo.dir, repo.base, repo.head);
const ORDER = 'src/main/java/com/acme/OrderService.java';
const FEES = 'billing/fees.py';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';
const DIGEST = 'a'.repeat(64);
const CHECKLIST = '- CK-BZ-1: Boundary conditions match the requirement wording.\n';

const anchors = hunkAnchors(PATCH);
const sources = {
  context: { context_digest: DIGEST },
  code: (file, rev) => {
    const text = git.showFile(repo.dir, rev === 'base' ? repo.base : repo.head, file);
    return text == null ? null : splitLines(text);
  },
  input: (id) => ({ 'policy-policies-checklist': splitLines(CHECKLIST) })[id] || null,
  artifact: () => null,
  artifactSha: () => null,
  inputIds: () => ['policy-policies-checklist'],
  policyText: () => CHECKLIST,
  anchors: () => anchors,
};

test('hunkAnchors: one id per hunk in patch order, with its changed span', () => {
  assert.deepEqual(
    anchors.map((a) => [a.id, a.path, a.revision, a.start, a.end, a.first_line, a.first]),
    [
      ['H1', FEES, 'reviewed', 1, 4, 1, 'def late_fee(days, rate=0.5):'],
      ['H2', 'package-lock.json', 'reviewed', 1, 1, 1, '{"lockfileVersion":3}'],
      ['H3', ORDER, 'reviewed', 6, 14, 9, IF_LINE],
    ],
  );
});

test('renderAnchors: only the unit\'s files, one short line each', () => {
  const text = renderAnchors(anchors, [ORDER]);
  assert.match(text, /^- H3 src\/main\/java\/com\/acme\/OrderService\.java lines 6-14 \(\+3 -0\): if \(member && total\.compareTo\(THRESHOLD\) > 0\) \{$/m);
  assert.doesNotMatch(text, /H1|H2/);
  assert.equal(renderAnchors(anchors, ['README.md']), '');
});

const placeholder = (anchor) => ({ kind: 'code', anchor, path: '-', start_line: 0, end_line: 0, quote: '-' });
const unit = { id: 'T1', kind: 'technical', covers: [`file:${ORDER}`, `file:${FEES}`], depends_on: [], roles: ['technical'], checks: ['CK-BZ-1'] };

function packet() {
  return {
    schema_version: '1.0',
    context_digest: DIGEST,
    unit_id: 'T1',
    role: 'technical',
    summary: 's',
    dependency_refs: [],
    coverage: [
      { id: `file:${ORDER}`, disposition: 'reviewed', evidence: [placeholder('H3')], note: 'read the new branch' },
      { id: `file:${FEES}`, disposition: 'reviewed', evidence: [placeholder('H1:2')], note: 'read the new guard' },
    ],
    item_verdicts: [],
    viewpoint_verdicts: [{ viewpoint: 'CK-BZ-1', verdict: 'pass', evidence: [placeholder('H3')], note: 'checked the comparison' }],
    findings: [],
    recommendation: 'no_findings',
  };
}

const check = (p) => {
  const changes = canonicalizeCandidate(p, sources);
  return { changes, errors: validatePacket(p, { sources, unit, role: 'technical', items: [], expectedDependencyRefs: [] }) };
};
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);

test('an anchor becomes the hunk\'s first changed line, or the line it names', () => {
  const p = packet();
  const { changes, errors } = check(p);
  assert.deepEqual(errors, []);
  assert.deepEqual(p.coverage[0].evidence[0], { kind: 'code', path: ORDER, revision: 'reviewed', start_line: 9, end_line: 9, quote: IF_LINE });
  assert.deepEqual(p.coverage[1].evidence[0], { kind: 'code', path: FEES, revision: 'reviewed', start_line: 2, end_line: 2, quote: 'if days > 30:' });
  assert.equal(p.viewpoint_verdicts[0].evidence[0].start_line, 9);
  assert.ok(changes.some((c) => /coverage\[0\]\.evidence\[0\]: anchor H3 -> src\/main\/java\/com\/acme\/OrderService\.java:9/.test(c)), changes.join('\n'));
});

test('anchors that do not resolve are rejected, and findings must quote', () => {
  let p = packet();
  p.coverage[0].evidence = [placeholder('H9')];
  has(check(p).errors, /coverage\[0\]\.evidence\[0\]\.anchor: "H9" is not a diff hunk of this review/);

  p = packet();
  p.coverage[0].evidence = [placeholder('H3:40')];
  has(check(p).errors, /"H3:40": line 40 is outside hunk H3 \(lines 6-14\)/);

  // A line with nothing to show (a closing brace) is still rejected as a quote.
  p = packet();
  p.coverage[0].evidence = [placeholder('H3:11')];
  has(check(p).errors, /quote has no letters or digits/);

  p = packet();
  p.findings = [{
    id: 'T1-technical-F1', severity: 'P3', confidence: 'LIKELY', title: 't', asis: 'a', tobe: 'b',
    authority: { kind: 'inferred', id: 'engineering-judgement', source: placeholder('H3') },
    items: [], trigger: { given: 'g', when: 'w', then: 't' }, impact: 'i', evidence: [placeholder('H3')],
    fix: { kind: 'not_code', asis: '', tobe: '', reason: 'r' }, verification: { method: 'inspected', detail: 'd', evidence: [] },
  }];
  p.recommendation = 'findings';
  // The finding contract has no anchor at all: the quote is the claim.
  has(check(p).errors, /findings\[0\]\.evidence\[0\][^\n]*unknown field "anchor"/);
  const { validateEvidence } = require('../src/lib/validate');
  assert.deepEqual(validateEvidence(placeholder('H3'), sources, '$.evidence[0]'), ['$.evidence[0].anchor: only coverage and verdict evidence may cite a hunk; quote the code verbatim']);
});

test('viewpoint verdict evidence is re-anchored like the rest', () => {
  const p = packet();
  p.viewpoint_verdicts[0].evidence = [{ kind: 'code', path: ORDER, start_line: 2, end_line: 2, quote: IF_LINE }];
  const { changes, errors } = check(p);
  assert.deepEqual(errors, []);
  assert.ok(changes.some((c) => /viewpoint_verdicts\[0\]\.evidence\[0\]: re-anchored 2-2 -> 9-9/.test(c)), changes.join('\n'));
});
