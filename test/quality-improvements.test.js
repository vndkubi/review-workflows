'use strict';
// Measured on 3 labelled cases and 5 open PRs (luna, high/max), against a
// single plain review prompt:
//   - an "inferred" P1/P2 was capped at P3, so a change that does not compile
//     (keycloak M1) ended as "approve";
//   - the whole-diff sweeps V0/V1 cost 19% of the tokens for one finding,
//     while one free review of the whole PR found behaviour bugs the units
//     missed;
//   - test and process remarks (TestRail ids, weak assertions) were a third
//     of pipeline max's findings;
//   - synthesis cost 12% and the red team never withdrew a finding.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, sh, write, makeRepo } = require('./helpers');
const git = require('../src/lib/git');
const { parsePatch } = require('../src/lib/patch');
const { analyzeImpact, renderImpact } = require('../src/lib/impact');
const { assignImpacts } = require('../src/lib/impact-checks');
const { selectChecks } = require('../src/lib/viewpoint-checks');
const { validatePacket, canonicalizeCandidate, splitLines } = require('../src/lib/validate');
const { computeOutcome } = require('../src/lib/outcome');
const { buildUnits, smallPrUnits, isSmallPr } = require('../src/lib/plan');
const { effortFor } = require('../src/lib/effort');

// ---------- a signature change whose old callers no longer compile ----------
function signatureRepo() {
  const dir = tmpDir('arw-sig-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'src/main/java/acme/Form.java', 'package acme;\n\npublic class Form {\n    protected boolean enabled() {\n        return true;\n    }\n\n    public void render() {\n        if (enabled()) {\n            draw();\n        }\n    }\n\n    void draw() {\n    }\n}\n');
  write(dir, 'src/main/java/acme/UserForm.java', 'package acme;\n\npublic class UserForm extends Form {\n    public void show() {\n        if (enabled()) {\n            draw();\n        }\n    }\n}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'src/main/java/acme/Form.java', 'package acme;\n\npublic class Form {\n    protected boolean enabled(Object user) {\n        return user != null;\n    }\n\n    public void render() {\n        if (enabled(this)) {\n            draw();\n        }\n    }\n\n    void draw() {\n    }\n}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'enabled needs a user']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  return { dir, base, head, parsed: parsePatch(git.diffPatch(dir, base, head)) };
}

test('impact: a caller whose argument count matches no declaration is a signature mismatch', () => {
  const r = signatureRepo();
  const prev = process.env.ARW_JAVA_AST;
  process.env.ARW_JAVA_AST = 'off';
  try {
    const impact = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed });
    assert.deepEqual(impact.mismatches, [{ path: 'src/main/java/acme/UserForm.java', line: 5, name: 'enabled', args: 0, declared: [1] }]);
    assert.match(renderImpact(impact), /Signature mismatches[\s\S]*UserForm\.java:5 calls enabled with 0 argument\(s\); declarations take 1/);
    // The mismatched call site is an impact check that cannot be answered "compatible".
    const units = [{ id: 'T1', kind: 'technical', covers: ['file:src/main/java/acme/Form.java'], roles: ['technical'] }];
    assignImpacts(units, impact);
    const check = units[0].impacts.find((c) => c.from.path === 'src/main/java/acme/UserForm.java');
    assert.equal(check.mismatch, 'calls enabled with 0 argument(s); declarations take 1');
  } finally {
    if (prev === undefined) delete process.env.ARW_JAVA_AST;
    else process.env.ARW_JAVA_AST = prev;
  }
});

test('checklist: removing a method declaration asks whether its callers still compile', () => {
  const r = signatureRepo();
  const checklist = '- CK-CP-1: Public API changes are backward compatible.\n- CK-CP-4: Changed method signatures, return values and exceptions still fit every caller.\n';
  assert.deepEqual(selectChecks(r.parsed, checklist), ['CK-CP-4']);
});

// ---------- the packet contract ----------
const repo = makeRepo();
const ORDER = 'src/main/java/com/acme/OrderService.java';
const CONTROLLER = 'src/main/java/com/acme/CheckoutController.java';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';
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
const codeEv = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE };
const callerEv = { kind: 'code', path: CONTROLLER, start_line: 9, end_line: 9, quote: 'return total.subtract(orders.discount(member, total));' };

function finding(over = {}) {
  return {
    id: 'T1-technical-F1', severity: 'P2', confidence: 'LIKELY', title: 'Boundary excludes the threshold',
    asis: 'Exactly 1,000,000 gets nothing.', tobe: 'It gets 10%.',
    authority: { kind: 'inferred', id: 'engineering-judgement', source: codeEv }, items: [],
    trigger: { given: 'total 1,000,000', when: 'discount()', then: '0 returned' }, impact: 'overcharge', evidence: [codeEv],
    fix: { kind: 'not_code', asis: '', tobe: '', reason: 'inclusive boundary' }, verification: { method: 'inspected', detail: 'read it', evidence: [] },
    ...over,
  };
}
function packet(findings = [finding()], over = {}) {
  return {
    schema_version: '1.0', context_digest: DIGEST, unit_id: 'T1', role: 'technical', summary: 's', dependency_refs: [],
    coverage: [{ id: `file:${ORDER}`, disposition: 'reviewed', evidence: [codeEv], note: 'n' }],
    item_verdicts: [], viewpoint_verdicts: [], impact_verdicts: [], findings, recommendation: findings.length ? 'findings' : 'no_findings', ...over,
  };
}
const unit = { id: 'T1', kind: 'technical', covers: [`file:${ORDER}`], depends_on: [], roles: ['technical'], checks: [], impacts: [] };
const check = (p, u = unit) => validatePacket(p, { sources, unit: u, role: 'technical', items: [], expectedDependencyRefs: [] });
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);

test('severity: a LIKELY defect shown in code may be P2 on engineering judgement; P1 still needs authority', () => {
  assert.deepEqual(check(packet()), []);
  has(check(packet([finding({ severity: 'P1' })])), /inferred authority cannot support P1/);
  has(check(packet([finding({ confidence: 'HYPOTHESIS' })])), /HYPOTHESIS cannot be P2/);
});

test('impact: a mismatched caller can only be "broken" or "cannot_determine"', () => {
  const C1 = { id: 'C1', from: { path: CONTROLLER, line: 9, symbol: 'CheckoutController.quote' }, to: { path: ORDER, symbol: 'OrderService.discount' }, confidence: 'resolved', mismatch: 'calls discount with 2 argument(s); declarations take 3' };
  const u = { ...unit, impacts: [C1] };
  const p = packet([], { impact_verdicts: [{ caller: 'C1', verdict: 'compatible', evidence: [callerEv], note: 'fine' }] });
  has(check(p, u), /C1 calls discount with 2 argument\(s\); declarations take 3: it cannot be "compatible"/);
  p.impact_verdicts[0].verdict = 'cannot_determine';
  assert.deepEqual(check(p, u), []);
});

test('noise: test and process remarks become P4 suggestions, outside the verdict', () => {
  const p = packet([
    finding(),
    finding({ id: 'T1-technical-F2', severity: 'P2', title: 'Success test does not assert quantities', category: 'test_gap' }),
    finding({ id: 'T1-technical-F3', severity: 'P3', title: 'Scenarios have no TestRail ids', category: 'process' }),
  ]);
  const changes = canonicalizeCandidate(p, sources);
  assert.deepEqual(p.findings.map((f) => [f.category || 'defect', f.severity]), [['defect', 'P2'], ['test_gap', 'P4'], ['process', 'P4']]);
  assert.ok(changes.some((c) => /findings\[1\]\.severity: P2 -> P4 \(test_gap is a suggestion\)/.test(c)), changes.join('\n'));
  assert.deepEqual(check(p), []);
  const outcome = computeOutcome({ packets: [{ unit_id: 'T1', role: 'technical', packet: p }], jobs: [], clusters: [], rebuttals: new Map(), items: [], repro: new Map() });
  assert.deepEqual(outcome.findings.map((f) => [f.id, f.suggestion]), [['T1-technical-F1', false], ['T1-technical-F2', true], ['T1-technical-F3', true]]);
});

// ---------- the free review replaces the whole-diff sweeps ----------
test('plan: one free review of the whole PR (V0) replaces the two sweeps; it answers one coverage row', () => {
  const files = ['src/a.py', 'src/b.py'];
  const built = buildUnits({ units: [{ id: 'T1', kind: 'technical', desc: 'd', files, items: [] }] }, files, null);
  const v = built.units.filter((u) => u.kind === 'viewpoint');
  assert.deepEqual(v.map((u) => [u.id, u.roles]), [['V0', ['technical']]]);
  assert.ok(v[0].hunt);
  const hunt = { ...v[0], depends_on: [], checks: [], impacts: [] };
  const p = packet([], { unit_id: 'V0', coverage: [{ id: 'viewpoint:V0', disposition: 'reviewed', evidence: [codeEv], note: 'read the whole change' }] });
  assert.deepEqual(validatePacket({ ...p, findings: [] }, { sources, unit: hunt, role: 'technical', items: [], expectedDependencyRefs: [] }).filter((e) => !/ids/.test(e)), []);
});

test('plan: a small PR is one unit with both roles, no planner', () => {
  const parsed = [{ path: 'a.java', added: 120, removed: 10, hunks: [] }, { path: 'b.java', added: 40, removed: 0, hunks: [] }];
  assert.equal(isSmallPr(parsed, ['a.java', 'b.java'], {}), true);
  assert.equal(isSmallPr([...parsed, { path: 'c.java', added: 200, removed: 0, hunks: [] }], ['a.java', 'b.java', 'c.java'], {}), false);
  assert.equal(isSmallPr(parsed, ['a.java', 'b.java'], { ARW_SMALL_PR: 'off' }), false);
  const items = [{ id: 'I1', kind: 'rule' }];
  const one = smallPrUnits(['a.java', 'b.java'], items);
  assert.deepEqual(one.units.map((u) => [u.id, u.kind, u.roles]), [['B1', 'business', ['business', 'technical']], ['V0', 'viewpoint', ['technical']]]);
  assert.deepEqual(one.units[0].covers, ['file:a.java', 'file:b.java', 'I1']);
  assert.deepEqual(smallPrUnits(['a.java'], null).units.map((u) => [u.id, u.roles]), [['T1', ['technical']], ['V0', ['technical']]]);
});

// ---------- effort where it pays ----------
test('effort: free review at max, synthesis low, red team at most high, the riskiest unit boosted', () => {
  const env = {};
  assert.equal(effortFor('packet', { kind: 'viewpoint', hunt: true }, 'high', env), 'max');
  assert.equal(effortFor('packet', { kind: 'technical' }, 'high', env), 'high');
  assert.equal(effortFor('packet', { kind: 'technical', effort_boost: true }, 'high', env), 'max');
  assert.equal(effortFor('synthesis', null, 'max', env), 'low');
  assert.equal(effortFor('rebuttal', null, 'max', env), 'high');
  assert.equal(effortFor('rebuttal', null, 'medium', env), 'medium');
  // Each can be set; "inherit" keeps the run's effort.
  assert.equal(effortFor('synthesis', null, 'max', { ARW_SYNTHESIS_EFFORT: 'inherit' }), 'max');
  assert.equal(effortFor('packet', { kind: 'viewpoint', hunt: true }, 'high', { ARW_HUNT_EFFORT: 'high' }), 'high');
});
