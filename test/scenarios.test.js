'use strict';
// Scenario execution and intent drift: expected values come from the
// approved rules (computed by the harness), a model writes only the adapter,
// and drift is decided by code from executed, hash-bound observations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-scenario-runs-');

const { parseExpr, evaluate } = require('../src/lib/expr');
const { buildSpec, scenarioInput, renderSpecMarkdown } = require('../src/lib/spec');
const sc = require('../src/lib/scenarios');
const { reviewPr } = require('../src/lib/pr-review');
const { ticketDir, recordGate } = require('../src/lib/runs');
const { loadContext, revisionDir, readInput } = require('../src/lib/freeze');
const { finish } = require('../src/lib/driver');

// ---------- expressions ----------
test('expr: arithmetic, min/max, round half away from zero', () => {
  assert.equal(evaluate('min(total * 0.1, 100000)', { total: 2000000 }), 100000);
  assert.equal(evaluate('min(total * 0.1, 100000)', { total: 999999 }), 99999.90000000001);
  assert.equal(evaluate('round(total * 0.1)', { total: 15 }), 2, '1.5 rounds up');
  assert.equal(evaluate('round(-1.5)', {}), -2, 'half away from zero');
  assert.equal(evaluate('round(1.005, 2)', {}), 1.01, 'binary noise does not round 1.005 down');
  assert.equal(evaluate('(days - 30) * 2 + -1', { days: 31 }), 1);
  assert.equal(evaluate('max(floor(x / 3), ceil(0.2))', { x: 10 }), 3);
  assert.deepEqual(parseExpr('min(a, b) + c').variables.sort(), ['a', 'b', 'c']);
  for (const [bad, msg] of [['pow(2, 3)', /unknown function pow/], ['a; b', /unexpected ";"/], ['(a + 1', /expected "\)"/], ['a b', /unexpected b/], ['round(1, 2, 3)', /takes 1..2/]]) {
    assert.throws(() => parseExpr(bad), msg, bad);
  }
  assert.throws(() => evaluate('a / 0', { a: 1 }), /division by zero/);
  assert.throws(() => evaluate('a + 1', { a: NaN }), /no numeric value/);
});

// ---------- typed spec ----------
const TICKET = '## AC\n- A late fee of 2 per day applies to invoices paid more than 30 days late.';
const requirements = { items: [{ id: 'AC1', kind: 'acceptance', given: 'an invoice', when: 'paid late', then: 'A late fee of 2 per day applies to invoices paid more than 30 days late.', evidence: { source: 'ticket', quote: 'x' }, risk: 'money' }] };

function feeModel({ expr = '(days_late - 30) * 2', type = 'integer' } = {}) {
  return {
    schema_version: '1.0',
    ticket: 'ACME-9',
    other_acs: [],
    notes: '',
    features: [{
      id: 'F1',
      name: 'Late fee',
      variables: [{
        id: 'days_late',
        description: 'days between due date and payment',
        type: 'integer',
        classes: [
          { id: 'negative', label: 'negative', validity: 'invalid', max: '0', max_inclusive: false },
          { id: 'not_late', label: '0..30 days', validity: 'valid', min: '0', min_inclusive: true, max: '30', max_inclusive: true },
          { id: 'late', label: '> 30 days', validity: 'valid', min: '30', min_inclusive: false },
        ],
      }],
      outcomes: [{ id: 'fee', description: 'late fee', type }],
      rules: [
        { id: 'R1', conditions: [{ variable: 'days_late', classes: ['late'] }], results: [{ outcome: 'fee', value: '2 per day after day 30', expr }], acs: ['AC1'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'A late fee of 2 per day applies to invoices paid more than 30 days late.' } },
        { id: 'R2', conditions: [{ variable: 'days_late', classes: ['not_late'] }], results: [{ outcome: 'fee', value: '0' }], acs: ['AC1'], label: 'INFERRED', source: { source: 'ticket', quote: '' } },
      ],
    }],
  };
}

function feeSpec(model = feeModel()) {
  const out = buildSpec({ model, requirements, ticket: 'ACME-9', blocks: [{ name: 'ticket', text: TICKET }] });
  assert.equal(out.errors, undefined, JSON.stringify(out.errors));
  return out.spec;
}

test('spec: typed outcomes get harness-computed expected values, with edge rows for expressions', () => {
  const spec = feeSpec();
  const rows = spec.features[0].scenarios.map((s) => [s.values.days_late, s.kind, s.expected_values ? s.expected_values.fee : null]);
  assert.deepEqual(rows.sort((a, b) => Number(a[0]) - Number(b[0])), [['-1', 'gap', null], ['0', 'rule', '0'], ['30', 'rule', '0'], ['31', 'rule', '2'], ['62', 'rule', '64']]);
  assert.ok(spec.features[0].scenarios.find((s) => s.values.days_late === '62').edge, 'an open-ended class is also checked well above its edge');
  assert.equal(spec.stats.executable_scenarios, 4);
  const md = renderSpecMarkdown(spec);
  assert.match(md, /2 per day after day 30 = \(days_late - 30\) \* 2/, 'the person approving the spec sees the expression');
  assert.match(md, /fee=2 per day after day 30 ⇒ fee=2/);
  const input = scenarioInput(spec);
  assert.equal(input.features[0].rows.length, 5);
  const r31 = input.features[0].rows.find((r) => r.values.days_late === '31');
  assert.deepEqual([r31.expected, r31.labels], [{ fee: '2' }, ['CONFIRMED']]);
  assert.ok(r31.items.length >= 1);
});

test('spec: typed results are checked; text-only specs have nothing to execute', () => {
  const bad = feeModel();
  bad.features[0].rules[1].results[0].value = 'none';
  assert.match(buildSpec({ model: bad, requirements, ticket: 'ACME-9', blocks: [] }).errors.join('\n'), /"none" is not an integer literal/);
  const enumExpr = feeModel({ type: 'enum' });
  assert.match(buildSpec({ model: enumExpr, requirements, ticket: 'ACME-9', blocks: [] }).errors.join('\n'), /only an integer or decimal outcome takes an expression/);
  const unknownVar = feeModel({ expr: 'days * 2' });
  assert.match(buildSpec({ model: unknownVar, requirements, ticket: 'ACME-9', blocks: [] }).errors.join('\n'), /unknown variable "days"/);
  const na = feeModel();
  na.features[0].rules[1].results[0].value = 'n/a';
  assert.equal(buildSpec({ model: na, requirements, ticket: 'ACME-9', blocks: [] }).errors, undefined, '"n/a" is allowed and not checked');
  const text = feeModel({ type: 'text' });
  text.features[0].rules[0].results[0].expr = '';
  assert.equal(scenarioInput(buildSpec({ model: text, requirements, ticket: 'ACME-9', blocks: [] }).spec), null);
  // Two rules with the same readable value but different expressions conflict.
  const both = feeModel();
  both.features[0].rules.push({ id: 'R3', conditions: [{ variable: 'days_late', classes: ['late'] }], results: [{ outcome: 'fee', value: '2 per day after day 30', expr: '(days_late - 30) * 3' }], acs: ['AC1'], label: 'INFERRED', source: { source: 'ticket', quote: '' } });
  assert.equal(buildSpec({ model: both, requirements, ticket: 'ACME-9', blocks: [] }).spec.stats.contradictions, 1);
});

// ---------- judging ----------
const FEATURE = { id: 'F1', outcomes: [{ id: 'fee', type: 'integer' }, { id: 'rate', type: 'decimal', step: '0.01' }, { id: 'ok', type: 'boolean' }, { id: 'code', type: 'enum' }] };

test('values are compared by outcome type', () => {
  const o = (id) => FEATURE.outcomes.find((x) => x.id === id);
  assert.ok(sc.sameValue(o('fee'), '100000', '100000.0'));
  assert.ok(sc.sameValue(o('fee'), '100000', '1E+5'), 'BigDecimal.toString scientific form');
  assert.ok(!sc.sameValue(o('fee'), '100000', '100001'));
  assert.ok(sc.sameValue(o('rate'), '99999.90', '99999.9'));
  assert.ok(!sc.sameValue(o('rate'), '0.13', '0.12'), 'a different rounding mode is a real difference');
  assert.ok(sc.sameValue(o('ok'), 'true', 'True'));
  assert.ok(sc.sameValue(o('code'), 'REJECTED', 'rejected'));
  assert.ok(!sc.sameValue(o('fee'), '0', 'abc'));
  assert.ok(!sc.sameValue(o('fee'), '0', null));
});

function rowsOf(expected) {
  return expected.map((e, i) => ({ id: `S${i + 1}`, values: {}, expected: e == null ? null : { fee: e }, items: ['I1'], rules: ['R1'], labels: ['CONFIRMED'] }));
}
const obsOf = (vals) => vals.map((v, i) => (v instanceof Error ? { id: `S${i + 1}`, error: v.message } : { id: `S${i + 1}`, observed: { fee: v } }));

test('drift: a stable mismatch with a base control is DRIFT (L3); flaky, insensitive or uncalibrated adapters stay UNKNOWN', () => {
  const rows = rowsOf(['0', '2', '64', null]);
  const f = { id: 'F1', outcomes: [{ id: 'fee', type: 'integer' }], rows };
  const input = { features: [f] };
  const items = [{ id: 'I1', kind: 'rule', risk: 'money', label: 'CONFIRMED' }, { id: 'I2', kind: 'gap', risk: 'money' }];
  const judge = (h1, h2, base) => {
    const { rows: judged, trust } = sc.assess(f, rows, { 'head-1': obsOf(h1), 'head-2': obsOf(h2), base: base ? obsOf(base) : null });
    return { status: 'OBSERVED', rows: judged, trust };
  };
  const drift = (rec) => sc.computeDrift({ input, records: new Map([['F1', rec]]), items, testsGreen: true });

  let [d] = drift(judge(['0', '3', '96', '0'], ['0', '3', '96', '0'], ['0', '2', '64', '0']));
  assert.deepEqual([d.verdict, d.control, d.evidence_level, d.tests_green], ['DRIFT', 'base', 'L3', true]);
  assert.equal(d.rows.filter((r) => r.verdict === 'MISMATCH').length, 2);
  assert.equal(drift(judge(['0', '3', '96', '0'], ['0', '3', '96', '0'], null))[0].evidence_level, 'L2', 'no base control: L2');
  // Calibration, K1 and K2 alone earn CALIBRATED; ALIGNED waits for K3.
  [d] = drift(judge(['0', '2', '64', '5'], ['0', '2', '64', '5'], null));
  assert.equal(d.verdict, 'CALIBRATED', 'the gap row is observed, not judged');
  assert.match(d.reason, /not yet K3/);
  // Wrong everywhere, base too: the adapter is not shown to work.
  [d] = drift(judge(['9', '9', '9', '0'], ['9', '9', '9', '0'], ['9', '9', '9', '0']));
  assert.equal(d.verdict, 'UNKNOWN');
  assert.match(d.reason, /adapter UNKNOWN: .*no row matches the spec/);
  // Errors in most rows: not trusted either.
  [d] = drift(judge([new Error('NPE'), new Error('NPE'), '96', '0'], [new Error('NPE'), new Error('NPE'), '96', '0'], ['0', '2', '64', '0']));
  assert.match(d.reason, /2 of 3 rows raised an error/);
  // K2: one row that differs between the two head runs and the adapter is
  // FLAKY; a stable mismatch elsewhere is no longer reported as drift.
  [d] = drift(judge(['0', '3', '96', '0'], ['0', '2', '96', '0'], ['0', '2', '64', '0']));
  assert.equal(d.verdict, 'UNKNOWN', 'S3 mismatches stably, but the adapter did not repeat');
  assert.match(d.reason, /adapter FLAKY: K2 .*S2/);
  [d] = drift(judge(['0', '3', '64', '0'], ['0', '2', '64', '0'], ['0', '2', '64', '0']));
  assert.match(d.reason, /adapter FLAKY/);
  assert.equal(drift({ status: 'INCONCLUSIVE', reason: 'head-1: build_error' })[0].reason, 'scenarios F1 INCONCLUSIVE: head-1: build_error');
  assert.match(sc.computeDrift({ input: null, records: new Map(), items }).find((x) => x.item === 'I1').reason, /no approved spec/);
});

test('K1 variance: an adapter whose output does not move while the expected value does is insensitive', () => {
  const rows = rowsOf(['0', '0', '2', '64', null]);
  const f = { id: 'F1', outcomes: [{ id: 'fee', type: 'integer' }], rows };
  const run = (vals) => sc.assess(f, rows, { 'head-1': obsOf(vals), 'head-2': obsOf(vals), base: obsOf(vals) }).trust;
  // The real function is called and discarded; the constant matches two rows,
  // which is all the calibration rule asks for.
  const t = run(['0', '0', '0', '0', '0']);
  assert.equal(t.calibration.passed, true, 'calibration alone is fooled');
  assert.deepEqual([t.status, t.k1.passed, t.k2.passed], ['UNKNOWN', false, true]);
  assert.deepEqual(t.k1.insensitive, [{ outcome: 'fee', expected_values: 3, observed_values: 1 }]);
  assert.match(t.reasons.join('; '), /K1 .*fee takes 1 value on 4 executed rows where the spec expects 3/);
  // Numerically equal spellings are one value, not two.
  assert.equal(run(['0', '0.0', '0', '0E+1', '0']).k1.passed, false);
  // Rows that raise an error are not executed rows.
  assert.equal(run(['0', '0', new Error('NPE'), '64', '7']).k1.passed, true);
  // Where the spec expects one value only, K1 has nothing to check.
  const flat = rowsOf(['0', '0', null]);
  const t2 = sc.assess({ id: 'F1', outcomes: f.outcomes, rows: flat }, flat, { 'head-1': obsOf(['0', '0', '0']), 'head-2': obsOf(['0', '0', '0']), base: null }).trust;
  assert.deepEqual([t2.status, t2.k1.passed, t2.k1.applicable], ['CALIBRATED', true, false]);
});

test('K2 repeatability: the second head run is the same rows in reverse order, compared row by row', () => {
  const rows = rowsOf(['0', '2', '64', null]);
  const f = { id: 'F1', outcomes: [{ id: 'fee', type: 'integer' }], rows };
  const t = sc.assess(f, rows, { 'head-1': obsOf(['0', '2', '64', '5']), 'head-2': obsOf(['0', '2', '64', '6']), base: null }).trust;
  assert.deepEqual([t.status, t.k1.passed, t.k2.passed], ['FLAKY', true, false]);
  assert.deepEqual(t.k2.differing, [{ id: 'S4', first: '{"fee":"5"}', reversed: '{"fee":"6"}' }], 'gap rows are compared too');
  // An error in one run and a value in the other differ; the same error class does not.
  assert.equal(sc.assess(f, rows, { 'head-1': obsOf([new Error('E: a'), '2', '64', '5']), 'head-2': obsOf(['0', '2', '64', '5']), base: null }).trust.k2.passed, false);
  assert.equal(sc.assess(f, rows, { 'head-1': obsOf([new Error('java.lang.NullPointerException: x@1a'), '2', '64', '5']), 'head-2': obsOf([new Error('java.lang.NullPointerException: x@2b'), '2', '64', '5']), base: null }).trust.k2.passed, true);
  // The reversed run is checked for its order: a report in forward order is not the reversed run.
  assert.equal(sc.classifyRun({ exit_code: 0 }, JSON.stringify(obsOf(['0', '2', '64', '5'])), sc.rowsForPhase('head-2', rows)), 'bad_report');
  assert.equal(sc.classifyRun({ exit_code: 0 }, JSON.stringify(obsOf(['0', '2', '64', '5']).reverse()), sc.rowsForPhase('head-2', rows)), 'observed');
});

// ---------- generated tests, executed for real ----------
function findPython() {
  for (const cand of ['python', 'python3']) {
    const r = spawnSync(cand, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return cand;
  }
  return null;
}
const PY = findPython();
const hasJavac = spawnSync('javac', ['-version'], { encoding: 'utf8' }).status === 0;

const ODD_FEATURE = { id: 'F1', variables: [{ id: 'name' }, { id: 'total' }] };
const ODD_ROWS = [
  { id: 'S1', values: { name: 'a "quoted" \\ back', total: '10' } },
  { id: 'S2', values: { name: 'line\nbreak\ttab', total: '(missing)' } },
  { id: 'S3', values: { name: 'Tiếng Việt 💰', total: '-1' } },
];

test('generated Java test compiles (Java 8 source), feeds every row and records results and errors', { skip: !hasJavac && 'no javac' }, () => {
  const dir = tmpDir('arw-scenario-java-');
  write(dir, 'src/org/junit/jupiter/api/Test.java', 'package org.junit.jupiter.api;\nimport java.lang.annotation.*;\n@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD) public @interface Test {}\n');
  write(dir, 'src/com/acme/ArwScenarioAdapterF1.java', 'package com.acme;\nimport java.util.*;\npublic class ArwScenarioAdapterF1 {\n  public static Map<String, Object> observe(Map<String, String> in) throws Exception {\n    if (in.get("total") == null) throw new IllegalArgumentException("total is missing");\n    Map<String, Object> out = new LinkedHashMap<>();\n    out.put("echo", in.get("name"));\n    out.put("fee", new java.math.BigDecimal("1E+5"));\n    return out;\n  }\n}\n');
  write(dir, 'src/com/acme/ArwScenarioF1Test.java', sc.javaTest({ pkg: 'com.acme', feature: ODD_FEATURE, rows: ODD_ROWS, junit: 5 }));
  write(dir, 'src/Main.java', 'public class Main { public static void main(String[] a) throws Exception { new com.acme.ArwScenarioF1Test().observeScenarios(); } }\n');
  const files = ['org/junit/jupiter/api/Test.java', 'com/acme/ArwScenarioAdapterF1.java', 'com/acme/ArwScenarioF1Test.java', 'Main.java'].map((f) => path.join(dir, 'src', f));
  const c = spawnSync('javac', ['-encoding', 'UTF-8', '--release', '8', '-d', path.join(dir, 'out'), ...files], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  // Run from a subdirectory (a module): the test walks up to the output dir.
  fs.mkdirSync(path.join(dir, sc.OUT_DIR));
  fs.mkdirSync(path.join(dir, 'module'));
  const r = spawnSync('java', ['-cp', path.join(dir, 'out'), 'Main'], { cwd: path.join(dir, 'module'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const obs = JSON.parse(fs.readFileSync(path.join(dir, sc.OUT_DIR, 'F1.json'), 'utf8'));
  assert.deepEqual(obs[0], { id: 'S1', observed: { echo: 'a "quoted" \\ back', fee: '100000' } });
  assert.match(obs[1].error, /IllegalArgumentException: total is missing/, 'a missing input reaches the adapter as null');
  assert.equal(obs[2].observed.echo, 'Tiếng Việt 💰');
  assert.equal(sc.classifyRun({ exit_code: 0 }, JSON.stringify(obs), ODD_ROWS), 'observed');
});

test('generated Python test runs the adapter on every row and records results and errors', { skip: !PY && 'no python 3' }, () => {
  const dir = tmpDir('arw-scenario-py-');
  write(dir, 'tests/arw_scenario_adapter_f1.py', 'def observe(inputs):\n    if inputs["total"] is None:\n        raise ValueError("total is missing")\n    return {"echo": inputs["name"], "ok": True, "fee": 1.5}\n');
  write(dir, 'tests/test_arw_scenario_f1.py', sc.pythonTest({ feature: ODD_FEATURE, rows: ODD_ROWS }));
  fs.mkdirSync(path.join(dir, sc.OUT_DIR));
  const r = spawnSync(PY, ['-c', 'import sys; sys.path.insert(0, "tests"); import test_arw_scenario_f1 as t; t.test_observe_arw_scenario_f1()'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(r.status, 0, r.stderr);
  const obs = JSON.parse(fs.readFileSync(path.join(dir, sc.OUT_DIR, 'F1.json'), 'utf8'));
  assert.deepEqual(obs[0], { id: 'S1', observed: { echo: 'a "quoted" \\ back', ok: 'true', fee: '1.5' } });
  assert.match(obs[1].error, /ValueError: total is missing/);
  assert.equal(obs[2].observed.echo, 'Tiếng Việt 💰');
});

// ---------- adapter validation ----------
test('adapter validation: names, observe signature, no assertions, calls changed code', () => {
  const r = makeFeeRepo();
  const context = { source: { checkout: r.dir, head_sha: r.head } };
  const feature = { id: 'F1' };
  const ok = { language: 'python', path: 'tests/arw_scenario_adapter_f1.py', content: ADAPTER, calls: 'late_fee' };
  assert.deepEqual(sc.validateAdapter(ok, { context, feature, targets: ['late_fee'] }), []);
  const errs = (c) => sc.validateAdapter({ ...ok, ...c }, { context, feature, targets: ['late_fee'] }).join('\n');
  assert.match(errs({ content: 'def observe(inputs):\n    return {"fee": 2}\n' }), /does not call code this pull request changed/);
  assert.match(errs({ content: `${ADAPTER}\nassert late_fee(31) == 2\n` }), /must not assert/);
  assert.match(errs({ path: 'tests/helper.py' }), /arw_scenario_adapter_f1\.py/);
  assert.match(errs({ path: 'billing/fees.py' }), /already exists|arw_scenario_adapter_f1/);
  assert.match(errs({ path: '../x/arw_scenario_adapter_f1.py' }), /repository-relative/);
  const java = { language: 'java', path: 'core/src/test/java/com/acme/ArwScenarioAdapterF1.java', content: 'package com.acme;\npublic class ArwScenarioAdapterF1 {\n  public static java.util.Map<String, Object> observe(java.util.Map<String, String> in) { return Fees.lateFee(1); }\n}\n', calls: 'Fees.lateFee' };
  assert.deepEqual(sc.validateAdapter(java, { context, feature, targets: ['lateFee'] }), []);
  assert.match(sc.validateAdapter({ ...java, content: java.content.replace('package com.acme;', 'package com.other;') }, { context, feature }).join('\n'), /must declare "package com\.acme;"/);
  assert.match(sc.validateAdapter({ ...java, content: java.content.replace('static ', '') }, { context, feature }).join('\n'), /public static java\.util\.Map<String, \?> observe/);
});

// ---------- end to end through the review ----------
const BASE = 'def late_fee(days):\n    if days <= 30:\n        return 0\n    return (days - 30) * 2\n';
const HEAD = 'def late_fee(days):\n    if days <= 30:\n        return 0\n    return (days - 30) * 3\n';
const ADAPTER = 'from billing.fees import late_fee\n\n\ndef observe(inputs):\n    return {"fee": late_fee(int(inputs["days_late"]))}\n';

function makeFeeRepo() {
  const dir = tmpDir('arw-scenario-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/fees.py', BASE);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/fees.py', HEAD);
  sh(dir, ['commit', '-q', '-am', 'ACME-9 new late fee rate']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

function approveTicket() {
  const spec = feeSpec();
  const dir = ticketDir('ACME-9');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.json'), JSON.stringify(requirements));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, 'spec.md'), renderSpecMarkdown(spec));
  recordGate(dir, 'SPEC', 'approved', { by: 'test' });
  return spec;
}

// A reviewer that misses the drift: it passes every item with code evidence.
function executor(prompts, adapter = ADAPTER) {
  return async (opts) => {
    fs.mkdirSync(opts.attemptDir, { recursive: true });
    const p = opts.prompt;
    prompts.push(p);
    const ok = (o) => ({ ok: true, output: JSON.stringify(o), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 1, output_tokens: 1 }, error_class: null, model: 'fake', prompt_bytes: p.length });
    const line = '    return (days - 30) * 3';
    const code = { kind: 'code', path: 'billing/fees.py', start_line: 4, end_line: 4, quote: line.trim() };
    if (p.startsWith('You are a read-only planner')) {
      const items = JSON.parse(p.match(/REVIEW ITEMS \(every item[^\n]*\n([\s\S]*?)\n\n/)[1]).map((i) => i.id);
      return ok({ schema_version: '1.0', hypotheses: [], units: [{ id: 'B1', kind: 'business', desc: 'late fee', files: ['billing/fees.py'], items }], gaps: [], notes: '' });
    }
    if (p.includes('JOB: write ONE scenario adapter')) return ok({ language: 'python', path: 'tests/arw_scenario_adapter_f1.py', content: adapter, calls: 'late_fee' });
    const unit = JSON.parse(p.match(/^UNIT: (.*)$/m)[1]);
    const role = p.match(/^JOB: .* role (business|technical)\.$/m)[1];
    const itemsInput = JSON.parse(p.slice(p.indexOf('INPUT review-items:\n') + 20).split('\n\n')[0].replace(/^\s*\d+\| ?/gm, ''));
    const coverage = unit.covers.filter((id) => !/^I\d+$/.test(id)).map((id) => (id.startsWith('file:') ? { id, disposition: 'reviewed', evidence: [code], note: 'read it' } : { id, disposition: 'unverified', evidence: [], note: 'see verdict' }));
    const verdicts = unit.covers.filter((c) => /^I\d+$/.test(c)).map((id) => {
      const gap = ['gap', 'contradiction'].includes(itemsInput.find((i) => i.id === id).kind);
      return gap ? { item: id, verdict: 'cannot_determine', note: 'unspecified', evidence: [] } : { item: id, verdict: 'pass', note: 'looks right', evidence: [code] };
    });
    return ok({ schema_version: '1.0', context_digest: p.match(/context_digest: ([a-f0-9]{64})/)[1], unit_id: unit.id, role, summary: 'done', dependency_refs: [], coverage, item_verdicts: verdicts, findings: [], recommendation: 'no_findings' });
  };
}

// Runs the generated test with the real interpreter, without pytest.
function pyRunner(calls) {
  return async ({ cwd, logFile, test: t, phase }) => {
    calls.push(phase);
    const mod = path.basename(t.path, '.py');
    const code = `import sys; sys.path.insert(0, ${JSON.stringify(path.dirname(t.path))}); import ${mod} as t; t.test_observe_${mod.replace(/^test_/, '')}()`;
    const r = spawnSync(PY, ['-c', code], { cwd, encoding: 'utf8' });
    fs.writeFileSync(logFile, `$ python ${t.path} (${phase})\n${r.stdout}${r.stderr}`);
    return { exit_code: r.status, elapsed_ms: 1 };
  };
}

test('review: the approved spec runs through the code; a changed rate the reviewer missed is DRIFT with a base control', { skip: !PY && 'no python 3' }, async () => {
  approveTicket();
  const r = makeFeeRepo();
  const prompts = [];
  const calls = [];
  const prepared = { info: { title: 'ACME-9 new late fee rate', body: '', headRefName: 'fee', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { validation, runDir } = await reviewPr({ repo: 'acme/fees', pr: 1, ticket: 'ACME-9', executor: executor(prompts), prepared, workers: 1, skipSeams: true, skipRebuttals: true, skipSynthesis: true, noRepro: true, scenarioRunner: pyRunner(calls) });
  assert.deepEqual(calls, ['head-1', 'head-2', 'base']);

  // The adapter job never saw an expected value.
  const adapterPrompt = prompts.find((p) => p.includes('JOB: write ONE scenario adapter'));
  assert.ok(adapterPrompt);
  assert.doesNotMatch(adapterPrompt, /"expected"|INPUT review-items|INPUT spec|\b64\b|days_late - 30/);
  assert.match(adapterPrompt, /late_fee/, 'it is told which changed code to call');

  const v = validation;
  assert.equal(v.scenarios.features[0].status, 'OBSERVED');
  assert.equal(v.scenarios.features[0].trust.status, 'CALIBRATED');
  assert.deepEqual(v.scenarios.intent, { aligned: 0, calibrated: 1, drift: 2, unknown: 0 });
  const ruleItem = v.items.find((i) => i.kind === 'rule' && i.drift && i.drift.label === 'CONFIRMED');
  assert.equal(ruleItem.result, 'pass', 'the reviewer passed it by reading');
  assert.deepEqual([ruleItem.drift.verdict, ruleItem.drift.control, ruleItem.drift.evidence_level], ['DRIFT', 'base', 'L3']);
  const s31 = ruleItem.drift.rows.find((x) => x.expected && x.expected.fee === '2');
  assert.deepEqual([s31.verdict, s31.observed.fee, s31.base], ['MISMATCH', '3', 'match']);
  // Report-only, but a money item that drifts leaves the review incomplete.
  assert.equal(v.findings.length, 0);
  assert.ok(v.gaps.some((g) => g.startsWith(`${ruleItem.id} (money risk): executed scenarios contradict the approved spec`)));
  assert.deepEqual([v.complete, v.recommendation], [false, 'needs_investigation']);
  assert.deepEqual(v.scenarios.gap_observations.map((g) => [g.id, g.observed.fee]), [[v.scenarios.gap_observations[0].id, '0']], 'where the spec is silent (negative days) the code charges 0');

  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /## Intent: approved spec scenarios run through the code \(aligned 0 · calibrated 1 · drift 2 · unknown 0\)/);
  assert.match(report, /expected fee=2 · head fee=3 · base match/);

  // Evidence is hash-bound: a changed observation is not evidence.
  const context = loadContext(runDir);
  assert.ok(readInput(runDir, context, 'scenarios'));
  const obsFile = path.join(revisionDir(runDir, context.context_id), 'scenarios', 'F1', 'head-1.observations.json');
  const runFile = path.join(runDir, 'run.json');
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).phases.scenarios.status, 'EXECUTED_PASS');
  fs.writeFileSync(obsFile, fs.readFileSync(obsFile, 'utf8').replace('"3"', '"2"'));
  const again = finish(runDir);
  assert.ok(again.gaps.some((g) => /scenarios F1: artifact scenarios\/F1\/head-1\.observations\.json is missing or changed/.test(g)));
  assert.equal(again.items.find((i) => i.id === ruleItem.id).drift.verdict, 'UNKNOWN');
});

test('review: the worktree is left clean and the generated files are gone', { skip: !PY && 'no python 3' }, async () => {
  const r = makeFeeRepo();
  const prepared = { info: { title: 'ACME-9 again', body: '', headRefName: 'fee2', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { runDir } = await reviewPr({ repo: 'acme/fees', pr: 2, ticket: 'ACME-9', executor: executor([]), prepared, workers: 1, skipSeams: true, skipRebuttals: true, skipSynthesis: true, noRepro: true, scenarioRunner: pyRunner([]) });
  const wt = path.join(runDir, 'repro-wt');
  // The repository's own line-ending settings, as the harness checked it out.
  const git = (args) => spawnSync('git', args, { cwd: wt, encoding: 'utf8' }).stdout.trim();
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(git(['rev-parse', 'HEAD']), r.head);
});

// ---------- K1/K2 fixtures: scripted runner, no interpreter ----------
// Plays an adapter in JS on the rows the generated test feeds, in the order it
// feeds them, with fresh state per run (one process per run), and writes the
// observations where the generated test would.
function scriptedRunner(play, calls = []) {
  return async ({ cwd, logFile, test: t, phase }) => {
    calls.push(phase);
    const rows = JSON.parse(JSON.parse(fs.readFileSync(path.join(cwd, t.path), 'utf8').match(/^ROWS = json\.loads\((.*)\)$/m)[1]));
    const rate = Number(fs.readFileSync(path.join(cwd, 'billing/fees.py'), 'utf8').match(/\* (\d+)/)[1]);
    const lateFee = (d) => (d <= 30 ? 0 : (d - 30) * rate);
    const state = {};
    const out = rows.map((r) => ({ id: r.id, observed: { fee: String(play(Number(r.inputs.days_late), lateFee, state)) } }));
    fs.writeFileSync(path.join(cwd, sc.OUT_DIR, 'F1.json'), JSON.stringify(out));
    fs.writeFileSync(logFile, `$ scripted ${t.path} (${phase}) rows ${rows.map((r) => r.id).join(',')}\n`);
    return { exit_code: 0, elapsed_ms: 1 };
  };
}

const FIXTURES = {
  // Calls the real function, discards the result, returns a constant that
  // matches the rows where the fee is 0.
  constant: {
    adapter: 'from billing.fees import late_fee\n\n\ndef observe(inputs):\n    late_fee(int(inputs["days_late"]))\n    return {"fee": 0}\n',
    play: (days, lateFee) => (lateFee(days), 0),
  },
  // A lazily initialised cache: the first call in a process returns a stale 0.
  orderDependent: {
    adapter: 'from billing.fees import late_fee\n\n_warm = False\n\n\ndef observe(inputs):\n    global _warm\n    fee = late_fee(int(inputs["days_late"])) if _warm else 0\n    _warm = True\n    return {"fee": fee}\n',
    play: (days, lateFee, s) => {
      const fee = s.warm ? lateFee(days) : 0;
      s.warm = true;
      return fee;
    },
  },
  correct: { adapter: ADAPTER, play: (days, lateFee) => lateFee(days) },
};

let fixturePr = 100;
async function reviewWith(name) {
  approveTicket();
  const r = makeFeeRepo();
  const calls = [];
  fixturePr += 1;
  const prepared = { info: { title: `ACME-9 ${name}`, body: '', headRefName: `fee-${name}`, baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const out = await reviewPr({ repo: 'acme/fees', pr: fixturePr, ticket: 'ACME-9', executor: executor([], FIXTURES[name].adapter), prepared, workers: 1, skipSeams: true, skipRebuttals: true, skipSynthesis: true, noRepro: true, scenarioRunner: scriptedRunner(FIXTURES[name].play, calls) });
  const verdicts = out.validation.items.filter((i) => i.drift).map((i) => i.drift.verdict).sort();
  return { ...out, calls, feature: out.validation.scenarios.features[0], verdicts };
}

test('fixture: a constant adapter passes calibration but fails K1, so nothing is DRIFT or CALIBRATED', async () => {
  const { feature, verdicts, calls, validation } = await reviewWith('constant');
  assert.deepEqual(calls, ['head-1', 'head-2', 'base'], 'K1 costs no extra execution');
  assert.equal(feature.status, 'OBSERVED');
  assert.deepEqual([feature.trust.status, feature.trust.calibration.passed, feature.trust.k1.passed, feature.trust.k2.passed], ['UNKNOWN', true, false, true]);
  assert.deepEqual(verdicts, ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.ok(validation.items.filter((i) => i.drift).every((i) => /adapter UNKNOWN: K1/.test(i.drift.reason)));
  assert.deepEqual(validation.scenarios.intent, { aligned: 0, calibrated: 0, drift: 0, unknown: 3 });
});

test('fixture: an order-dependent adapter fails K2 (reverse order) and is FLAKY', async () => {
  const { feature, verdicts, calls, runDir } = await reviewWith('orderDependent');
  assert.deepEqual(calls, ['head-1', 'head-2', 'base']);
  assert.deepEqual([feature.trust.status, feature.trust.calibration.passed, feature.trust.k1.passed, feature.trust.k2.passed], ['FLAKY', true, true, false]);
  assert.ok(feature.trust.k2.differing.length >= 1, 'the differing rows are recorded');
  assert.deepEqual(verdicts, ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  // The reversed run really fed the rows in reverse order.
  const context = loadContext(runDir);
  const dir = path.join(revisionDir(runDir, context.context_id), 'scenarios', 'F1');
  const ids = (phase) => JSON.parse(fs.readFileSync(path.join(dir, `${phase}.observations.json`), 'utf8')).map((r) => r.id);
  assert.deepEqual(ids('head-2'), ids('head-1').reverse());
});

test('fixture: a correct adapter passes K1 and K2 and ends CALIBRATED, never ALIGNED', async () => {
  const { feature, verdicts, validation, runDir } = await reviewWith('correct');
  assert.deepEqual([feature.trust.status, feature.trust.k1.passed, feature.trust.k2.passed], ['CALIBRATED', true, true]);
  assert.deepEqual(verdicts, ['CALIBRATED', 'DRIFT', 'DRIFT'], 'the rate change still drifts; DRIFT comes from an adapter that passed K1 and K2');
  assert.deepEqual(validation.scenarios.intent, { aligned: 0, calibrated: 1, drift: 2, unknown: 0 });
  const report = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  assert.match(report, /adapter \*\*CALIBRATED\*\* \(calibration, K1 variance and K2 repeat passed; ALIGNED needs K3\)/);

  // The record stores the controls; validation recomputes them from the
  // hash-bound observations and rejects a record that disagrees.
  const context = loadContext(runDir);
  const recFile = path.join(revisionDir(runDir, context.context_id), 'scenarios', 'F1.json');
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  assert.equal(rec.controls.status, 'CALIBRATED');
  assert.ok(rec.runs.find((r) => r.phase === 'head-2').observations.sha256);
  fs.writeFileSync(recFile, JSON.stringify({ ...rec, controls: { ...rec.controls, k1: { ...rec.controls.k1, passed: false } } }));
  let again = finish(runDir);
  assert.ok(again.gaps.some((g) => /scenarios F1: recorded controls do not follow from the observations/.test(g)), again.gaps.join('\n'));
  assert.ok(again.items.filter((i) => i.drift).every((i) => i.drift.verdict === 'UNKNOWN'));
  const { controls, ...bare } = rec;
  assert.ok(controls);
  fs.writeFileSync(recFile, JSON.stringify(bare));
  again = finish(runDir);
  assert.ok(again.gaps.some((g) => /scenarios F1: recorded controls do not follow/.test(g)), 'a record without controls is not evidence either');
  fs.writeFileSync(recFile, JSON.stringify(rec));
  assert.equal(finish(runDir).scenarios.intent.calibrated, 1);
});
