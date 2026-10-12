'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgainst, prunedSchema } = require('../src/lib/schema');
const { quoteMatchesAt, locateQuote, splitLines, looksLikeCode } = require('../src/lib/validate');
const { findingClusters } = require('../src/lib/cluster');
const { buildUnits } = require('../src/lib/plan');
const { parsePatch, commentableLines } = require('../src/lib/patch');
const { parseDeterministicAC, splitGWT, classifyRisk, normalizeItems } = require('../src/lib/requirements');
const { wikiToMarkdown, extractTicketKey } = require('../src/lib/jira');
const { summarizeEvents, classifyError } = require('../src/lib/codex');
const { parseModelJson, canonicalJson } = require('../src/lib/util');
const { computeOutcome } = require('../src/lib/outcome');

test('schema: reports precise paths and prunes to reachable $defs', () => {
  const errors = validateAgainst('review', { schema_version: '1.0', hypotheses: [], units: [{ id: 'X1', kind: 'business', desc: 'd', files: [], acs: [] }], gaps: [], notes: '', extra: 1 }, 'plan');
  assert.ok(errors.some((e) => e.includes('$.units[0].id')));
  assert.ok(errors.some((e) => e.includes('$.units[0].files: needs at least 1')));
  assert.ok(errors.some((e) => e.includes('unknown field "extra"')));
  const pruned = prunedSchema('review', 'rebuttal');
  assert.ok(pruned.$defs.rebuttal && pruned.$defs.evidence && pruned.$defs.digest);
  assert.equal(pruned.$defs.packet, undefined);
});

test('quoteMatchesAt: exact, whitespace, ellipsis, end slack, and rejections', () => {
  const lines = splitLines('a\n    if (x > 1) {\n        y();\n    }\nfoo(bar,\n    baz);\n');
  assert.equal(quoteMatchesAt(lines, 2, 2, 'if (x > 1) {').how, 'exact');
  assert.equal(quoteMatchesAt(lines, 2, 3, 'if (x > 1) {\n y();').how, 'whitespace');
  assert.equal(quoteMatchesAt(lines, 2, 4, 'if (x > 1) { ... }').how, 'ellipsis');
  assert.match(quoteMatchesAt(lines, 5, 5, 'foo(bar, baz);').how, /end_slack/);
  assert.equal(quoteMatchesAt(lines, 3, 3, 'if (x > 1)').ok, false);
  assert.match(quoteMatchesAt(lines, 9, 9, 'x').error, /past the end/);
  assert.match(quoteMatchesAt(lines, 2, 2, '{').error, /no letters/);
  assert.deepEqual(locateQuote(lines, 'y();').hits, [3]);
});

test('looksLikeCode rejects prose fixes', () => {
  assert.equal(looksLikeCode('Use >= instead of >'), false);
  assert.equal(looksLikeCode('if (total.compareTo(T) >= 0) {'), true);
  assert.equal(looksLikeCode('def late_fee(days, rate=Decimal("0.5")):'), true);
});

test('clusters: same defect from different voters merges; same voter never does', () => {
  const ev = (start) => [{ kind: 'code', path: 'A.java', start_line: start, end_line: start, quote: 'x' }];
  const fix = { kind: 'code_change', asis: 'if (total > LIMIT) {', tobe: 'if (total >= LIMIT) {', reason: 'r' };
  const f = (id, title, start, severity = 'P2') => ({ id, title, severity, evidence: ev(start), fix });
  const clusters = findingClusters([
    { finding: f('B1-business-F1', 'Discount boundary excludes exact threshold', 10), voter: 'B1/business' },
    { finding: f('B1-technical-F1', 'Boundary check excludes the exact threshold amount', 11, 'P3'), voter: 'B1/technical' },
    { finding: f('B1-business-F2', 'Discount boundary excludes exact threshold', 10), voter: 'B1/business' },
    { finding: f('T1-technical-F1', 'Missing timeout on HTTP client', 90, 'P3'), voter: 'T1/technical' },
  ]);
  const big = clusters.find((c) => c.members.includes('B1-technical-F1'));
  assert.equal(big.votes, 2);
  assert.ok(big.members.length === 3 && big.canonical_id.startsWith('B1-business'));
  assert.ok(clusters.find((c) => c.members.includes('T1-technical-F1')).votes === 1);
});

test('plan: orphans, seams and viewpoints are added by code; review item coverage enforced', () => {
  const files = ['a/A.java', 'a/B.java', 'b/c.py', 'b/d.py'];
  const items = [{ id: 'I1', kind: 'rule' }, { id: 'I2', kind: 'boundary' }, { id: 'I3', kind: 'gap' }];
  const plan = {
    schema_version: '1.0',
    hypotheses: [],
    units: [
      { id: 'B1', kind: 'business', desc: 'd', files: ['a/A.java', 'b/c.py'], items: ['I1', 'I2'] },
      { id: 'T1', kind: 'technical', desc: 'd', files: ['a/A.java'], items: [] },
    ],
    gaps: [],
    notes: '',
  };
  const res = buildUnits(plan, files, items);
  assert.deepEqual(res.errors, ['I3 (gap) is not covered by any business (B*) unit']);
  const ids = res.units.map((u) => u.id);
  assert.deepEqual(ids, ['B1', 'T1', 'O1', 'S1', 'V0', 'V1']);
  const seam = res.units.find((u) => u.id === 'S1');
  assert.deepEqual(seam.depends_on, ['B1', 'T1']);
  assert.deepEqual(seam.covers, ['file:a/A.java']);
  assert.deepEqual(res.units.find((u) => u.id === 'O1').covers, ['file:a/B.java', 'file:b/d.py']);
  assert.ok(res.units.find((u) => u.id === 'V0').covers.includes('file:b/d.py'));
  assert.deepEqual(res.units.find((u) => u.id === 'B1').roles, ['business', 'technical']);
  const bad = buildUnits({ ...plan, units: [{ id: 'T2', kind: 'technical', desc: 'd', files: ['nope.java'], items: ['I1'] }] }, files, null);
  assert.ok(bad.errors.some((e) => e.includes('only business')));
  assert.ok(bad.errors.some((e) => e.includes('not a reviewable changed file')));
});

test('patch parsing and commentable lines', () => {
  const patch = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,3 @@\n-def f():\n+def f(a):\n+    a += 1\n     return 0\n';
  const [file] = parsePatch(patch);
  assert.equal(file.path, 'x.py');
  assert.equal(file.added, 2);
  assert.deepEqual([...commentableLines(file)].sort(), [1, 2, 3]);
});

test('requirements: deterministic AC parse, GWT split, risk, quote verification', () => {
  const text = wikiToMarkdown('h2. Description\nSome text\nh2. Acceptance Criteria\n# Members get 10% off orders of 1,000,000 or more.\n# Given a late invoice When 30 days pass Then a fee applies\nh2. Notes\n* not an AC');
  const items = parseDeterministicAC(text);
  assert.deepEqual(items, ['Members get 10% off orders of 1,000,000 or more.', 'Given a late invoice When 30 days pass Then a fee applies']);
  assert.deepEqual(splitGWT(items[1]), { given: 'a late invoice', when: '30 days pass', then: 'a fee applies' });
  assert.equal(classifyRisk(items[0]), 'money');
  assert.equal(classifyRisk('show the order history page'), 'normal');
  assert.equal(classifyRisk('delete old rows'), 'data');
  const notes = [];
  const out = normalizeItems(
    [
      { id: 'AC9', kind: 'acceptance', given: 'g', when: 'w', then: 't', evidence: { source: 'ticket', quote: 'Members get 10% off' }, risk: 'money' },
      { id: 'AC3', kind: 'acceptance', given: 'g', when: 'w', then: 't', evidence: { source: 'ticket', quote: 'invented sentence' }, risk: 'normal' },
    ],
    [{ name: 'ticket', text }],
    notes,
  );
  assert.deepEqual(out.map((i) => [i.id, i.kind]), [['AC1', 'acceptance'], ['AC2', 'inferred']]);
  assert.equal(out[1].evidence.quote, '');
  assert.equal(extractTicketKey('feat: x', 'feature/ACME-12-discount'), 'ACME-12');
});

test('codex events: usage summed from turn.completed, errors classified', () => {
  const jsonl = [
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7,"reasoning_output_tokens":2}}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":3,"reasoning_output_tokens":0}}',
    '{"type":"error","message":"unexpected status 429 Too Many Requests"}',
  ].join('\n');
  const s = summarizeEvents(jsonl);
  assert.equal(s.usage.input_tokens, 150);
  assert.equal(s.usage.cached_input_tokens, 40);
  assert.equal(s.turns, 2);
  assert.equal(classifyError(s.errors[0]), 'rate_limit');
  assert.equal(classifyError('402 Payment Required: Insufficient Balance'), 'billing');
  assert.equal(classifyError("The 'x' model is not supported when using Codex with a ChatGPT account."), 'auth');
});

test('parseModelJson tolerates one fence, rejects garbage; canonicalJson sorts keys', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Here: {"a":2}'), { a: 2 });
  assert.throws(() => parseModelJson('no json'), /no JSON object/);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

test('outcome: withdrawal never propagates; STANDS is inherited; risky items must be decided', () => {
  const finding = (id, severity) => ({ id, severity, confidence: 'LIKELY', title: id });
  const packets = [
    { unit_id: 'B1', role: 'business', packet: { findings: [finding('B1-business-F1', 'P1')], item_verdicts: [{ item: 'I1', verdict: 'cannot_determine', note: 'n' }, { item: 'I2', verdict: 'cannot_determine', note: 'returns 0' }] } },
    { unit_id: 'B1', role: 'technical', packet: { findings: [finding('B1-technical-F1', 'P2')], item_verdicts: [{ item: 'I1', verdict: 'fail', note: 'x' }] } },
  ];
  const clusters = [{ id: 'C1', canonical_id: 'B1-business-F1', members: ['B1-business-F1', 'B1-technical-F1'], voters: ['a', 'b'], votes: 2, severity: 'P1' }];
  const jobs = [{ unit_id: 'B1', role: 'business', required: true, status: 'EXECUTED_PASS' }];
  const items = [{ id: 'I1', kind: 'rule', risk: 'money' }, { id: 'I2', kind: 'gap', risk: 'money' }];
  const withdrawn = computeOutcome({ packets, jobs, clusters, rebuttals: new Map([['B1-business-F1', { verdict: 'FINDING_WITHDRAWN' }]]), items });
  assert.equal(withdrawn.findings.find((f) => f.id === 'B1-business-F1').state, 'withdrawn');
  assert.equal(withdrawn.findings.find((f) => f.id === 'B1-technical-F1').state, 'unverified');
  assert.equal(withdrawn.recommendation, 'changes_requested');
  assert.ok(withdrawn.gaps.some((g) => g.includes('I1 (money risk rule)')), 'a technical verdict does not decide a business item');
  assert.ok(!withdrawn.gaps.some((g) => g.includes('I2')), 'gap items are reported, not decided');
  assert.deepEqual(withdrawn.items.map((r) => [r.id, r.result]), [['I1', 'fail'], ['I2', 'cannot_determine']]);
  const stands = computeOutcome({ packets, jobs, clusters, rebuttals: new Map([['B1-business-F1', { verdict: 'FINDING_STANDS' }]]), items });
  assert.equal(stands.findings.find((f) => f.id === 'B1-technical-F1').rebuttal_from, 'B1-business-F1');
});
