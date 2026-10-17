'use strict';
// The viewpoint matrix: the runtime, not the model, decides which checklist
// viewpoints a unit must answer, from what its changed lines touch. Two
// models (or two runs) then answer the same questions, so their reviews can
// be compared cell by cell instead of by whatever each chose to look at.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');
const { parsePatch } = require('../src/lib/patch');
const { validatePacket, splitLines } = require('../src/lib/validate');
const { computeOutcome } = require('../src/lib/outcome');
const { checklistIds, selectChecks, assignChecks, checkRole } = require('../src/lib/viewpoint-checks');
const git = require('../src/lib/git');

const CHECKLIST = [
  '- CK-TX-1: A read-modify-write of shared state runs in one transaction.',
  '- CK-TX-3: Spring `@Transactional` is effective.',
  '- CK-TX-4: External calls are not made inside a database transaction.',
  '- CK-ER-1: Exceptions are not swallowed.',
  '- CK-ER-3: Every outbound network call has a timeout.',
  '- CK-BZ-1: Boundary conditions match the requirement wording.',
  '- CK-BZ-2: Money uses exact decimal types.',
  '- CK-CP-2: Database migrations are safe for existing data.',
  '- CK-TS-1: Changed behaviour has a test that fails without the change.',
  '- CK-TS-2: Tests are not weakened, skipped or deleted.',
  '- CK-PY-1: No mutable default arguments.',
  '',
].join('\n');

function diff(file, added, removed = []) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const SERVICE = 'src/main/java/com/acme/PaymentService.java';
const PATCH = parsePatch(
  [
    diff(SERVICE, ['    @Transactional', '    public void pay(Order o) {', '        rest.postForObject(url, o, Receipt.class);', '        try { repo.save(o); } catch (Exception e) { }', '    }']),
    diff('db/migration/V7__fee.sql', ['ALTER TABLE invoice ADD COLUMN fee DECIMAL(10,2);']),
    diff('src/test/java/com/acme/PaymentServiceTest.java', ['    @Disabled'], ['    @Test']),
    diff('README.md', ['Payments now post a receipt.']),
  ].join(''),
);

test('checklistIds: ids in checklist order, each once', () => {
  assert.deepEqual(checklistIds('- CK-TX-1: a\n- CK-ER-3: b, see CK-TX-1\n- CK-BZ-1: c\n'), ['CK-TX-1', 'CK-ER-3', 'CK-BZ-1']);
  assert.deepEqual(checklistIds(''), []);
});

test('selectChecks: viewpoints follow what the changed lines touch, in checklist order', () => {
  const service = PATCH.filter((p) => p.path === SERVICE);
  assert.deepEqual(selectChecks(service, CHECKLIST), ['CK-TX-1', 'CK-TX-3', 'CK-TX-4', 'CK-ER-1', 'CK-ER-3', 'CK-TS-1']);
  assert.deepEqual(selectChecks(PATCH.filter((p) => p.path.endsWith('.sql')), CHECKLIST), ['CK-CP-2']);
  assert.deepEqual(selectChecks(PATCH.filter((p) => p.path.endsWith('Test.java')), CHECKLIST), ['CK-TS-2']);
  // Docs touch no viewpoint; a viewpoint the team's checklist lacks is never asked.
  assert.deepEqual(selectChecks(PATCH.filter((p) => p.path === 'README.md'), CHECKLIST), []);
  assert.deepEqual(selectChecks(service, '- CK-ER-3: timeouts\n'), ['CK-ER-3']);
});

test('selectChecks: a unit answers at most max viewpoints, the first in checklist order', () => {
  const service = PATCH.filter((p) => p.path === SERVICE);
  assert.deepEqual(selectChecks(service, CHECKLIST, { max: 2 }), ['CK-TX-1', 'CK-TX-3']);
});

test('selectChecks: no cap unless ARW_UNIT_CHECKS sets one', () => {
  // A busy legacy method touches more than a dozen viewpoints; every one is asked.
  const busy = parsePatch(diff(SERVICE, [
    '    @Transactional @KafkaListener',
    '    public void settle(BigDecimal amount, LocalDate day) {',
    '        if (repo.existsById(id) && amount > LIMIT) { rest.postForObject(url, o, R.class); }',
    '        try (InputStream in = open()) { repo.save(o); } catch (Exception e) { log.info("token " + token); }',
    '        retry(3); counter = new AtomicLong(); equals(o);',
    '    }',
  ]));
  const full = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'config', 'policies', 'checklist.md'), 'utf8');
  const before = process.env.ARW_UNIT_CHECKS;
  try {
    delete process.env.ARW_UNIT_CHECKS;
    assert.ok(selectChecks(busy, full).length > 12, `got ${selectChecks(busy, full).join(', ')}`);
    process.env.ARW_UNIT_CHECKS = '3';
    assert.deepEqual(selectChecks(PATCH.filter((p) => p.path === SERVICE), CHECKLIST), ['CK-TX-1', 'CK-TX-3', 'CK-TX-4']);
  } finally {
    if (before === undefined) delete process.env.ARW_UNIT_CHECKS;
    else process.env.ARW_UNIT_CHECKS = before;
  }
});

test('assignChecks: substantive units get their files\' viewpoints; sweeps and seams get none', () => {
  const units = [
    { id: 'B1', kind: 'business', covers: [`file:${SERVICE}`, 'I1'], roles: ['business', 'technical'] },
    { id: 'T1', kind: 'technical', covers: ['file:db/migration/V7__fee.sql'], roles: ['technical'] },
    { id: 'O1', kind: 'orphan', covers: ['file:README.md'], roles: ['technical'] },
    { id: 'S1', kind: 'seam', covers: [`file:${SERVICE}`], roles: ['technical'], depends_on: ['B1', 'T1'] },
    { id: 'V0', kind: 'viewpoint', covers: ['viewpoint:V0', `file:${SERVICE}`], roles: ['technical'] },
  ];
  assignChecks(units, PATCH, CHECKLIST);
  assert.deepEqual(units.map((u) => [u.id, u.checks]), [
    ['B1', ['CK-TX-1', 'CK-TX-3', 'CK-TX-4', 'CK-ER-1', 'CK-ER-3', 'CK-TS-1']],
    ['T1', ['CK-CP-2']],
    ['O1', []],
    ['S1', []],
    ['V0', []],
  ]);
  // The technical reviewer answers the matrix; a business-only unit answers it itself.
  assert.equal(checkRole(units[0]), 'technical');
  assert.equal(checkRole({ roles: ['business'] }), 'business');
});

// ---------- the packet contract ----------
const repo = makeRepo();
const ORDER = 'src/main/java/com/acme/OrderService.java';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';
const DIGEST = 'a'.repeat(64);
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
};
const codeEv = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE };
const ckEv = { kind: 'input', path: 'policy-policies-checklist', start_line: 6, end_line: 6, quote: 'CK-BZ-1: Boundary conditions match the requirement wording.' };
const unit = { id: 'T1', kind: 'technical', covers: [`file:${ORDER}`], depends_on: [], roles: ['technical'], checks: ['CK-BZ-1', 'CK-BZ-2'] };

function finding() {
  return {
    id: 'T1-technical-F1',
    severity: 'P2',
    confidence: 'LIKELY',
    title: 'Boundary excludes the threshold',
    asis: 'Exactly 1,000,000 gets nothing.',
    tobe: 'It gets 10%.',
    authority: { kind: 'curated_viewpoint', id: 'CK-BZ-1', source: ckEv },
    items: [],
    trigger: { given: 'total 1,000,000', when: 'discount()', then: '0 returned' },
    impact: 'overcharge',
    evidence: [codeEv],
    fix: { kind: 'code_change', asis: IF_LINE, tobe: 'if (member && total.compareTo(THRESHOLD) >= 0) {', reason: 'inclusive' },
    verification: { method: 'inspected', detail: 'read it', evidence: [] },
  };
}

function packet() {
  return {
    schema_version: '1.0',
    context_digest: DIGEST,
    unit_id: 'T1',
    role: 'technical',
    summary: 's',
    dependency_refs: [],
    coverage: [{ id: `file:${ORDER}`, disposition: 'reviewed', evidence: [codeEv], note: 'n' }],
    item_verdicts: [],
    viewpoint_verdicts: [
      { viewpoint: 'CK-BZ-1', verdict: 'fail', evidence: [codeEv], note: 'strict > excludes the threshold' },
      { viewpoint: 'CK-BZ-2', verdict: 'pass', evidence: [codeEv], note: 'BigDecimal with compareTo' },
    ],
    findings: [finding()],
    recommendation: 'findings',
  };
}

const check = (p, u = unit, role = 'technical') => validatePacket(p, { sources, unit: u, role, items: [], expectedDependencyRefs: [] });
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);

test('a packet answering every assigned viewpoint validates', () => {
  assert.deepEqual(check(packet()), []);
});

test('viewpoint verdicts: each assigned viewpoint answered once, honestly', () => {
  let p = packet();
  p.viewpoint_verdicts.pop();
  has(check(p), /missing a verdict for CK-BZ-2/);

  p = packet();
  p.viewpoint_verdicts.push({ viewpoint: 'CK-TX-1', verdict: 'not_applicable', evidence: [], note: 'n' });
  has(check(p), /CK-TX-1 is not a viewpoint assigned to unit T1/);

  p = packet();
  p.viewpoint_verdicts.push({ ...p.viewpoint_verdicts[1] });
  has(check(p), /CK-BZ-2 appears 2 times/);

  p = packet();
  p.viewpoint_verdicts[1] = { viewpoint: 'CK-BZ-2', verdict: 'pass', evidence: [], note: 'looks fine' };
  has(check(p), /"pass" needs code evidence/);

  // A failed viewpoint names its defect; a finding under a viewpoint cannot sit beside a pass.
  p = packet();
  p.findings = [];
  p.recommendation = 'no_findings';
  has(check(p), /"fail" for CK-BZ-1 needs a finding whose authority is curated_viewpoint CK-BZ-1/);

  p = packet();
  p.viewpoint_verdicts[0] = { viewpoint: 'CK-BZ-1', verdict: 'pass', evidence: [codeEv], note: 'fine' };
  has(check(p), /T1-technical-F1 violates CK-BZ-1, but its verdict is "pass"/);

  p = packet();
  p.viewpoint_verdicts[0].evidence = [{ ...codeEv, quote: 'if (total > 0) {' }];
  has(check(p), /viewpoint_verdicts\[0\]\.evidence\[0\]/);
});

test('viewpoint verdicts: only the answering role gives them', () => {
  const b1 = { ...unit, id: 'B1', kind: 'business', roles: ['business', 'technical'] };
  const p = { ...packet(), unit_id: 'B1', role: 'business', findings: [], recommendation: 'no_findings', viewpoint_verdicts: [{ viewpoint: 'CK-BZ-2', verdict: 'not_applicable', evidence: [], note: 'n' }] };
  has(check(p, b1, 'business'), /viewpoint_verdicts: must be \[\]; the technical reviewer of B1 answers them/);
  assert.deepEqual(check({ ...p, viewpoint_verdicts: [] }, { ...b1, checks: [] }, 'business').filter((e) => /viewpoint/.test(e)), []);
});

test('computeOutcome: the matrix keeps every assigned cell, answered or not', () => {
  const units = [unit, { id: 'T2', kind: 'technical', covers: [], roles: ['technical'], checks: ['CK-TS-1'] }];
  const packets = [{ unit_id: 'T1', role: 'technical', packet: { findings: [], item_verdicts: [], viewpoint_verdicts: packet().viewpoint_verdicts } }];
  const outcome = computeOutcome({ packets, jobs: [], clusters: [], rebuttals: new Map(), items: [], repro: new Map(), units });
  assert.deepEqual(
    outcome.checks.map((c) => [c.unit_id, c.viewpoint, c.verdict]),
    [['T1', 'CK-BZ-1', 'fail'], ['T1', 'CK-BZ-2', 'pass'], ['T2', 'CK-TS-1', 'not_answered']],
  );
  // Without units (older runs), there is no matrix.
  assert.deepEqual(computeOutcome({ packets, jobs: [], clusters: [], rebuttals: new Map(), items: [], repro: new Map() }).checks, []);
});
