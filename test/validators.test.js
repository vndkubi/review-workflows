'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo, sh } = require('./helpers');
const { validatePacket, splitLines } = require('../src/lib/validate');
const { buildEvidencePack } = require('../src/lib/evidence-pack');
const { parsePatch } = require('../src/lib/patch');
const git = require('../src/lib/git');

const repo = makeRepo();
const ORDER = 'src/main/java/com/acme/OrderService.java';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';
const DIGEST = 'a'.repeat(64);
const REQUIREMENTS = '{\n  "items": [\n    { "id": "AC1", "then": "10% off from 1,000,000" }\n  ]\n}\n';
const ITEMS = [
  '[',
  '  { "id": "I1", "kind": "rule", "text": "R1: member and total >= 1,000,000 -> 10%" },',
  '  { "id": "I2", "kind": "gap", "text": "total negative: unspecified" }',
  ']',
  '',
].join('\n');
const CHECKLIST = '- CK-BZ-1: Boundary conditions match the requirement wording.\n';

// Minimal stand-in for makeSources(): code from the fixture repo, two inputs.
const sources = {
  context: { context_digest: DIGEST },
  code: (file, rev) => {
    const text = git.showFile(repo.dir, rev === 'base' ? repo.base : repo.head, file);
    return text == null ? null : splitLines(text);
  },
  input: (id) => ({ requirements: splitLines(REQUIREMENTS), 'review-items': splitLines(ITEMS), 'policy-policies-checklist': splitLines(CHECKLIST) })[id] || null,
  artifact: () => null,
  artifactSha: () => null,
  inputIds: () => ['requirements', 'review-items', 'policy-policies-checklist'],
  policyText: () => CHECKLIST,
};

const unit = { id: 'B1', kind: 'business', covers: [`file:${ORDER}`, 'I1', 'I2'], depends_on: [] };
const codeEv = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE };
const reqEv = { kind: 'input', path: 'requirements', start_line: 3, end_line: 3, quote: '10% off from 1,000,000' };
const itemEv = { kind: 'input', path: 'review-items', start_line: 2, end_line: 2, quote: 'R1: member and total >= 1,000,000 -> 10%' };

function goodFinding() {
  return {
    id: 'B1-business-F1',
    severity: 'P2',
    confidence: 'LIKELY',
    title: 'Boundary excludes the threshold',
    asis: 'Exactly 1,000,000 gets nothing.',
    tobe: 'It gets 10%.',
    authority: { kind: 'requirement', id: 'I1', source: itemEv },
    items: ['I1'],
    trigger: { given: 'total 1,000,000', when: 'discount()', then: '0 returned' },
    impact: 'overcharge',
    evidence: [codeEv],
    fix: { kind: 'code_change', asis: IF_LINE, tobe: 'if (member && total.compareTo(THRESHOLD) >= 0) {', reason: 'inclusive' },
    verification: { method: 'inspected', detail: 'read it', evidence: [] },
  };
}

function goodPacket() {
  return {
    schema_version: '1.0',
    context_digest: DIGEST,
    unit_id: 'B1',
    role: 'business',
    summary: 's',
    dependency_refs: [],
    coverage: [
      { id: `file:${ORDER}`, disposition: 'reviewed', evidence: [codeEv], note: 'n' },
    ],
    item_verdicts: [{ item: 'I1', verdict: 'fail', evidence: [codeEv], note: 'n' }, { item: 'I2', verdict: 'cannot_determine', evidence: [codeEv], note: 'negative totals fall through to zero discount' }],
    viewpoint_verdicts: [],
    impact_verdicts: [],
    findings: [goodFinding()],
    recommendation: 'findings',
  };
}

const check = (packet) => validatePacket(packet, { sources, unit, role: 'business', requirements: { items: [{ id: 'AC1' }] }, items: [{ id: 'I1', kind: 'rule' }, { id: 'I2', kind: 'gap' }], expectedDependencyRefs: [] });
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);

test('a correct packet validates', () => {
  assert.deepEqual(check(goodPacket()), []);
});

test('packet rules reject what a reviewer would reject', () => {
  let p = goodPacket();
  p.findings = [];
  p.recommendation = 'no_findings';
  has(check(p), /"fail" for I1 needs a finding/);

  p = goodPacket();
  p.findings[0].confidence = 'HYPOTHESIS';
  has(check(p), /HYPOTHESIS cannot be P2/);

  p = goodPacket();
  p.findings[0].authority = { kind: 'inferred', id: 'judgement', source: codeEv };
  assert.ok(!check(p).some((e) => /inferred authority/.test(e)), 'inferred authority supports P2');
  p.findings[0].severity = 'P1';
  has(check(p), /inferred authority cannot support P1/);

  p = goodPacket();
  p.findings[0].authority = { kind: 'curated_viewpoint', id: 'CK-XX-9', source: { kind: 'input', path: 'policy-policies-checklist', start_line: 1, end_line: 1, quote: 'CK-BZ-1' } };
  has(check(p), /CK-XX-9" does not occur/);

  p = goodPacket();
  p.coverage[0].id = 'viewpoint:V0';
  has(check(p), /missing a row for "file:/);
  has(check(p), /"viewpoint:V0" is not a coverage id/);

  p = goodPacket();
  p.coverage.push({ id: 'I1', disposition: 'unverified', evidence: [], note: 'n' });
  has(check(p), /"I1" is not a coverage id/);

  p = goodPacket();
  p.item_verdicts[1] = { item: 'I2', verdict: 'pass', evidence: [codeEv], note: 'fine' };
  has(check(p), /I2 is a gap item with no expected result/);

  p = goodPacket();
  p.item_verdicts.pop();
  has(check(p), /missing a verdict for I2/);

  p = goodPacket();
  p.coverage.push({ ...p.coverage[0] });
  has(check(p), /appears 2 times/);

  p = goodPacket();
  p.findings[0].evidence = [{ ...codeEv, quote: 'if (member && total > THRESHOLD) {' }];
  has(check(p), /quote not found at lines 9-9/);

  p = goodPacket();
  p.findings[0].fix.asis = 'return total.multiply(BigDecimal.TEN);';
  has(check(p), /fix\.asis: must be copied verbatim/);

  p = goodPacket();
  p.findings[0].verification = { method: 'executed', detail: 'ran it', evidence: [] };
  has(check(p), /"executed" needs a hash-bound artifact/);

  p = goodPacket();
  p.findings[0].evidence = [{ ...codeEv, path: '../../etc/passwd' }];
  has(check(p), /must be repository-relative/);

  p = goodPacket();
  p.item_verdicts[0] = { item: 'I1', verdict: 'pass', evidence: [], note: 'looks fine' };
  has(check(p), /"pass" needs code evidence/);

  p = goodPacket();
  p.valid = true;
  has(check(p), /unknown field "valid"/);
});

test('canonicalize: strips N| prefixes from input quotes only, never touches normal quotes', () => {
  const { canonicalizeCandidate } = require('../src/lib/validate');
  // Regression: a backslash-stripped regex once deleted spaces from quotes.
  const normal = { evidence: [{ kind: 'input', path: 'requirements', start_line: 3, end_line: 3, quote: '10% off from 1,000,000' }] };
  assert.deepEqual(canonicalizeCandidate(normal, sources), []);
  assert.equal(normal.evidence[0].quote, '10% off from 1,000,000');

  const prefixed = { evidence: [{ kind: 'input', path: 'requirements', start_line: 3, end_line: 3, quote: '3|     { "id": "AC1", "then": "10% off from 1,000,000" }' }] };
  canonicalizeCandidate(prefixed, sources);
  assert.equal(prefixed.evidence[0].quote, '    { "id": "AC1", "then": "10% off from 1,000,000" }');

  const code = { evidence: [{ kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: '9| x' }] };
  canonicalizeCandidate(code, sources);
  assert.equal(code.evidence[0].quote, '9| x', 'code quotes are never rewritten');
});

// Measured with arw retro on real runs: models cite "evidence" for
// "evidence-pack", costing a repair each time.
test('canonicalize: a shortened input id that names exactly one input is completed', () => {
  const { canonicalizeCandidate } = require('../src/lib/validate');
  const short = { evidence: [{ kind: 'input', path: 'review', start_line: 1, end_line: 1, quote: 'x' }] };
  const changes = canonicalizeCandidate(short, sources);
  assert.equal(short.evidence[0].path, 'review-items');
  assert.match(changes.join(), /"review" -> "review-items"/);
  const file = { evidence: [{ kind: 'input', path: 'inputs/requirements.txt', start_line: 1, end_line: 1, quote: 'x' }] };
  canonicalizeCandidate(file, sources);
  assert.equal(file.evidence[0].path, 'requirements');
  const ambiguous = { evidence: [{ kind: 'input', path: 'policy', start_line: 1, end_line: 1, quote: 'x' }] };
  canonicalizeCandidate({ evidence: ambiguous.evidence }, { ...sources, inputIds: () => ['policy-a', 'policy-b'] });
  assert.equal(ambiguous.evidence[0].path, 'policy', 'two candidates: left for the validator');
});

test('canonicalize: a repeated input quote re-anchors to its first occurrence; repeated code does not', () => {
  const { canonicalizeCandidate } = require('../src/lib/validate');
  const dup = { evidence: [{ kind: 'input', path: 'policy-policies-checklist', start_line: 9, end_line: 9, quote: 'Boundary conditions' }] };
  canonicalizeCandidate(dup, sources);
  assert.equal(dup.evidence[0].start_line, 1);
  const ambiguous = { evidence: [{ kind: 'code', path: ORDER, start_line: 1, end_line: 1, quote: 'BigDecimal' }] };
  canonicalizeCandidate(ambiguous, sources);
  assert.equal(ambiguous.evidence[0].start_line, 1, 'ambiguous code quotes are left for the validator to reject');
});

test('strict output schema: every property required, optional ones nullable; nulls stripped after', () => {
  const { outputSchema, stripNulls, validateAgainst } = require('../src/lib/schema');
  const s = outputSchema('review', 'rebuttal');
  assert.equal(s.type, 'object');
  const ev = s.$defs.evidence;
  assert.deepEqual(ev.required.sort(), ['end_line', 'kind', 'path', 'quote', 'revision', 'sha256', 'start_line']);
  assert.deepEqual(ev.properties.revision.anyOf[1], { type: 'null' });
  // Strict mode rejects a const/enum leaf without an explicit type (seen live).
  assert.equal(outputSchema('review', 'packet').properties.schema_version.type, 'string');
  assert.equal(s.properties.verdict.type, 'string');
  const { classifyError } = require('../src/lib/codex');
  assert.equal(classifyError('{"code":"invalid_json_schema","type":"invalid_request_error"}'), 'config');
  const cleaned = stripNulls({ kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE, revision: null, sha256: null });
  assert.deepEqual(validateAgainst('review', cleaned, 'evidence'), []);
});

test('evidence pack: Java and Python symbols, callers, skips, boundary signals', () => {
  const changed = git.changedFiles(repo.dir, repo.base, repo.head);
  const parsed = parsePatch(git.diffPatch(repo.dir, repo.base, repo.head));
  const pack = buildEvidencePack({ cwd: repo.dir, base: repo.base, head: repo.head, changed, parsed });
  assert.deepEqual(pack.skipped.map((f) => f.path), ['package-lock.json']);
  const sym = Object.fromEntries(pack.symbols.map((s) => [s.name, s]));
  assert.ok(sym.OrderService.referenced_in.includes('src/main/java/com/acme/CheckoutController.java'));
  assert.ok(sym.discount.referenced_in.includes('src/main/java/com/acme/CheckoutController.java'));
  assert.equal(sym.late_fee.language, 'python');
  assert.match(pack.text, /## Notes/);
  sh(repo.dir, ['status']);
});

test('a degenerate structured response is stopped and retried without the output schema', async () => {
  const { runLooseJob } = require('../src/lib/loose-job');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const seen = [];
  const exec = async (opts) => {
    seen.push(Boolean(opts.outputSchema));
    if (seen.length === 1) return { ok: false, output: null, error_class: 'degenerate', error_message: 'max_output_tokens', usage: {}, elapsed_ms: 1 };
    return { ok: true, output: '{"ok":true}', error_class: null, usage: {}, elapsed_ms: 1 };
  };
  const res = await runLooseJob({ executor: exec, label: 'spec', workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'arw-lj-')), cwd: '.', outputSchema: { type: 'object' }, buildPrompt: () => 'p', validate: () => [] });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [true, false]);
  const { classifyError } = require('../src/lib/codex');
  assert.equal(classifyError('Incomplete response returned, reason: max_output_tokens'), 'error', 'detected from the event stream, not by message class');
});

test('driver job: 429 backs off and retries; auth failure blocks without retrying', async () => {
  process.env.ARW_429_BACKOFF_MS = '1';
  const { runModelJob } = require('../src/lib/driver');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arw-job-'));
  const context = { context_id: 'c0ffee', context_digest: DIGEST, source: { checkout: repo.dir } };
  {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n === 1) return { ok: false, output: null, error_class: 'rate_limit', error_message: '429', usage: {}, elapsed_ms: 1 };
      return { ok: true, output: '{"x":1}', error_class: null, usage: {}, elapsed_ms: 1 };
    };
    const env = { runDir, context, executor: flaky, log: () => {}, receipts: {}, flushReceipts: () => {}, sources, verify: () => [] };
    const ok = await runModelJob(env, { label: 'j', outRel: 'out/j.json', buildPrompt: () => 'p', validate: () => [] });
    assert.equal(ok.status, 'EXECUTED_PASS');
    assert.equal(n, 2);

    let calls = 0;
    const denied = async () => {
      calls += 1;
      return { ok: false, output: null, error_class: 'auth', error_message: '401', usage: {}, elapsed_ms: 1 };
    };
    const blocked = await runModelJob({ ...env, executor: denied }, { label: 'k', outRel: 'out/k.json', buildPrompt: () => 'p', validate: () => [] });
    assert.equal(blocked.status, 'ENVIRONMENT_BLOCKED');
    assert.equal(calls, 1);
  }
});
