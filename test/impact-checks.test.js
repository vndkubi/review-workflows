'use strict';
// Impact as required coverage. In a large legacy codebase the defect is often
// in a caller the diff never shows. The runtime, not the model, picks which
// callers a unit must answer for: every direct call site the impact index
// found for a changed declaration the unit owns (name-only matches and other
// repositories excepted). Each gets one verdict, read at the caller itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');
const git = require('../src/lib/git');
const { assignImpacts, impactLine } = require('../src/lib/impact-checks');
const { validatePacket, splitLines } = require('../src/lib/validate');
const { computeOutcome } = require('../src/lib/outcome');

const ORDER = 'src/main/java/com/acme/OrderService.java';
const CONTROLLER = 'src/main/java/com/acme/CheckoutController.java';
const CALL = 'return total.subtract(orders.discount(member, total));';

const IMPACT = {
  changed: [{ path: ORDER, symbol: 'OrderService.discount', lines: [8, 13] }],
  edges: [
    { level: 1, to: { path: ORDER, symbol: 'OrderService.discount' }, from: { path: CONTROLLER, line: 9, symbol: 'CheckoutController.quote' }, confidence: 'ast' },
    { level: 1, to: { path: ORDER, symbol: 'OrderService.discount' }, from: { path: 'src/Other.java', line: 3, symbol: 'Other.run' }, confidence: 'name-only' },
    { level: 2, to: { path: CONTROLLER, symbol: 'CheckoutController.quote' }, from: { path: 'src/Web.java', line: 20, symbol: 'Web.post' }, confidence: 'resolved' },
    { level: 1, repo: 'front', to: { path: ORDER, symbol: 'OrderService.discount' }, from: { path: 'app.ts', line: 4, symbol: '(http client)' }, confidence: 'http' },
    { level: 1, to: { path: ORDER, symbol: 'OrderService.discount' }, from: { path: 'src/main/resources/beans.xml', line: 12, symbol: '(config)' }, confidence: 'config', note: 'bean wiring' },
    { level: 1, to: { path: ORDER, symbol: 'OrderService.discount' }, from: { path: 'src/test/java/com/acme/OrderServiceTest.java', line: 14, symbol: 'OrderServiceTest.member' }, confidence: 'ast' },
    { level: 1, to: { path: 'billing/fees.py', symbol: 'late_fee' }, from: { path: 'billing/run.py', line: 5, symbol: 'run' }, confidence: 'resolved' },
  ],
};

test('assignImpacts: direct, resolvable, non-test callers go to the unit owning the changed declaration', () => {
  const units = [
    { id: 'B1', kind: 'business', covers: [`file:${ORDER}`, 'I1'], roles: ['business', 'technical'] },
    { id: 'T1', kind: 'technical', covers: ['file:billing/fees.py'], roles: ['technical'] },
    { id: 'S1', kind: 'seam', covers: [`file:${ORDER}`], roles: ['technical'] },
    { id: 'V0', kind: 'viewpoint', covers: ['viewpoint:V0', `file:${ORDER}`], roles: ['technical'] },
  ];
  assignImpacts(units, IMPACT);
  assert.deepEqual(units.map((u) => [u.id, (u.impacts || []).map((c) => `${c.id} ${c.from.path}:${c.from.line}`)]), [
    ['B1', [`C1 ${CONTROLLER}:9`, 'C2 src/main/resources/beans.xml:12']],
    ['T1', ['C3 billing/run.py:5']],
    ['S1', []],
    ['V0', []],
  ]);
  assert.equal(impactLine(units[0].impacts[0]), `C1 CheckoutController.quote at ${CONTROLLER}:9 -> OrderService.discount [ast]`);
  // A run without an impact index (or one that failed) assigns nothing.
  assignImpacts(units, null);
  assert.deepEqual(units.map((u) => u.impacts), [[], [], [], []]);
});

// ---------- the packet contract ----------
const repo = makeRepo();
const DIGEST = 'a'.repeat(64);
const sources = {
  context: { context_digest: DIGEST },
  code: (file, rev) => {
    const text = git.showFile(repo.dir, rev === 'base' ? repo.base : repo.head, file);
    return text == null ? null : splitLines(text);
  },
  input: () => null,
  artifact: () => null,
  artifactSha: () => null,
  inputIds: () => [],
  policyText: () => '',
};
const callerEv = { kind: 'code', path: CONTROLLER, start_line: 9, end_line: 9, quote: CALL };
const orderEv = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: 'if (member && total.compareTo(THRESHOLD) > 0) {' };
const C1 = { id: 'C1', from: { path: CONTROLLER, line: 9, symbol: 'CheckoutController.quote' }, to: { path: ORDER, symbol: 'OrderService.discount' }, confidence: 'ast' };
const unit = { id: 'T1', kind: 'technical', covers: [`file:${ORDER}`], depends_on: [], roles: ['technical'], checks: [], impacts: [C1] };

function packet() {
  return {
    schema_version: '1.0',
    context_digest: DIGEST,
    unit_id: 'T1',
    role: 'technical',
    summary: 's',
    dependency_refs: [],
    coverage: [{ id: `file:${ORDER}`, disposition: 'reviewed', evidence: [orderEv], note: 'n' }],
    item_verdicts: [],
    viewpoint_verdicts: [],
    impact_verdicts: [{ caller: 'C1', verdict: 'compatible', evidence: [callerEv], note: 'quote subtracts whatever discount returns; a larger discount is still a valid subtraction' }],
    findings: [],
    recommendation: 'no_findings',
  };
}

function brokenFinding(evidence) {
  return {
    id: 'T1-technical-F1', severity: 'P3', confidence: 'LIKELY', title: 'Quote shows the wrong total at the threshold',
    asis: 'a', tobe: 'b', authority: { kind: 'inferred', id: 'engineering-judgement', source: orderEv }, items: [],
    trigger: { given: 'g', when: 'w', then: 't' }, impact: 'i', evidence,
    fix: { kind: 'not_code', asis: '', tobe: '', reason: 'r' }, verification: { method: 'inspected', detail: 'd', evidence: [] },
  };
}

const check = (p, u = unit, role = 'technical') => validatePacket(p, { sources, unit: u, role, items: [], expectedDependencyRefs: [] });
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);

test('a packet answering every assigned caller validates', () => {
  assert.deepEqual(check(packet()), []);
});

test('impact verdicts: every caller once, read at the caller', () => {
  let p = packet();
  p.impact_verdicts = [];
  has(check(p), /impact_verdicts: missing a verdict for C1 \(CheckoutController\.quote/);

  p = packet();
  p.impact_verdicts.push({ caller: 'C7', verdict: 'cannot_determine', evidence: [], note: 'n' });
  has(check(p), /C7 is not a caller assigned to unit T1/);

  p = packet();
  p.impact_verdicts.push({ ...p.impact_verdicts[0] });
  has(check(p), /C1 appears 2 times/);

  // "compatible" and "not_affected" are claims about the caller: read it there.
  for (const verdict of ['compatible', 'not_affected']) {
    p = packet();
    p.impact_verdicts[0] = { caller: 'C1', verdict, evidence: [orderEv], note: 'n' };
    has(check(p), new RegExp(`"${verdict}" needs code evidence in the caller ${CONTROLLER.replace(/\./g, '\\.')}`));
  }

  // "broken" names the defect, and the defect is shown at the call site.
  p = packet();
  p.impact_verdicts[0] = { caller: 'C1', verdict: 'broken', evidence: [callerEv], note: 'n' };
  has(check(p), /"broken" for C1 needs a finding with code evidence in the caller/);
  p.findings = [brokenFinding([orderEv, callerEv])];
  p.recommendation = 'findings';
  assert.deepEqual(check(p), []);

  p = packet();
  p.impact_verdicts[0] = { caller: 'C1', verdict: 'cannot_determine', evidence: [], note: 'the caller is generated at build time' };
  assert.deepEqual(check(p), []);
});

test('impact verdicts: only the answering role gives them', () => {
  const b1 = { ...unit, id: 'B1', kind: 'business', roles: ['business', 'technical'] };
  const p = { ...packet(), unit_id: 'B1', role: 'business' };
  has(check(p, b1, 'business'), /impact_verdicts: must be \[\]; the technical reviewer of B1 answers them/);
  assert.deepEqual(check({ ...p, impact_verdicts: [] }, b1, 'business').filter((e) => /impact/.test(e)), []);
});

test('computeOutcome: every assigned caller is a cell, answered or not', () => {
  const units = [unit, { id: 'T2', kind: 'technical', covers: [], roles: ['technical'], impacts: [{ ...C1, id: 'C2' }] }];
  const packets = [{ unit_id: 'T1', role: 'technical', packet: { findings: [], item_verdicts: [], impact_verdicts: packet().impact_verdicts } }];
  const outcome = computeOutcome({ packets, jobs: [], clusters: [], rebuttals: new Map(), items: [], repro: new Map(), units });
  assert.deepEqual(outcome.impacts.map((c) => [c.unit_id, c.caller, c.verdict, c.from.symbol]), [
    ['T1', 'C1', 'compatible', 'CheckoutController.quote'],
    ['T2', 'C2', 'not_answered', 'CheckoutController.quote'],
  ]);
});
