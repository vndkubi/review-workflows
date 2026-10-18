'use strict';
// Incident (luna report, 17 PRs): one plain prompt over the whole PR, read
// as a senior engineer would, found 10 defects the unit pipeline missed
// (lost product attributes, a cart of another storefront, an order id probe,
// ...), while the pipeline found others the plain prompt missed. Together
// they covered 32 of 34. The plain review now runs inside the pipeline as
// unit P0: its prose is kept, then turned into findings that are
// quote-checked, red-teamed and reproduced like every other finding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeRepo } = require('./helpers');
const { huntUnits } = require('../src/lib/plan');
const { validatePlain } = require('../src/lib/validate');

process.env.ARW_RUNS_DIR = tmpDir('arw-plain-runs-');

test('plan: the plain review P0 reads the whole PR, on unless ARW_PLAIN_REVIEW=off', () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/F${i}.java`);
  const units = huntUnits(files, {});
  const p0 = units.find((u) => u.id === 'P0');
  assert.ok(p0, units.map((u) => u.id).join(','));
  assert.deepEqual([p0.kind, p0.hunt, p0.plain, p0.lens, p0.roles], ['viewpoint', true, true, 'plain', ['technical']]);
  assert.deepEqual(p0.covers, ['viewpoint:P0', ...files.map((f) => `file:${f}`)], 'one unit over every file, never split into parts');
  assert.equal(huntUnits(files, { ARW_PLAIN_REVIEW: 'off' }).some((u) => u.plain), false);
});

test('validatePlain: prose that ends with a verdict', () => {
  assert.deepEqual(validatePlain({ text: '- **P2 — a.java:3**: wrong\n\nrequest changes' }), []);
  assert.deepEqual(validatePlain({ text: 'No issues found.\n\nApprove' }), []);
  assert.match(validatePlain({ text: 'looks fine' }).join('\n'), /end with a one-line verdict/);
  assert.match(validatePlain({ text: '' }).join('\n'), /empty/);
});

const ORDER = 'src/main/java/com/acme/OrderService.java';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';
const PLAIN = `- **P2 — ${ORDER}:9**: the discount starts above 1,000,000, but the ticket says from 1,000,000; a member with exactly 1,000,000 gets nothing. Use >= 0.

request changes`;

test('a review runs the plain review first, keeps its prose and turns it into checked findings', async () => {
  const repo = makeRepo();
  const { reviewPr } = require('../src/lib/pr-review');
  const fake = require('./fixtures/fake-review-executor');
  const plainCalls = [];
  const convertCalls = [];
  const executor = async (opts) => {
    if (opts.prompt.startsWith('You are reviewing a pull request in this repository.')) {
      plainCalls.push(opts);
      fs.mkdirSync(opts.attemptDir, { recursive: true });
      // The first answer has no verdict: the validator sends it back once.
      const output = plainCalls.length === 1 ? 'I looked at it.' : PLAIN;
      return { ok: true, output, exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 }, turns: 1, commands: 3, error_class: null, error_message: null, model: 'fake', prompt_bytes: opts.prompt.length };
    }
    const res = await fake(opts);
    if (/^UNIT: \{"id":"P0"/m.test(opts.prompt)) {
      convertCalls.push(opts);
      const packet = JSON.parse(res.output);
      const ev = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE };
      packet.findings = [{
        id: 'P0-technical-F1', severity: 'P2', confidence: 'LIKELY', category: 'defect', title: 'Discount misses the 1,000,000 boundary',
        asis: 'A member with exactly 1,000,000 gets no discount.', tobe: 'The discount applies from 1,000,000.',
        trigger: { given: 'a member', when: 'the total is exactly 1,000,000', then: 'no discount is given' }, impact: 'Members are overcharged.',
        evidence: [ev], fix: { kind: 'code_change', asis: IF_LINE, tobe: 'if (member && total.compareTo(THRESHOLD) >= 0) {', reason: 'include the boundary' },
        verification: { method: 'inspected', detail: 'read the comparison', evidence: [] },
        authority: { kind: 'inferred', id: 'engineering-judgement', source: ev }, items: [],
      }];
      packet.recommendation = 'findings';
      res.output = JSON.stringify(packet);
    }
    return res;
  };
  const prepared = { info: { title: 'ACME-7 member discount', body: 'Members get 10% off from 1,000,000.', headRefName: 'feature', baseRefName: 'main', url: null }, checkout: repo.dir, head: repo.head, base: repo.base };
  process.env.ARW_PLAIN_REVIEW = 'on';
  let out;
  try {
    out = await reviewPr({ repo: 'acme/plain', pr: 1, executor, prepared, workers: 2, noRepro: true, skipRebuttals: true, skipSynthesis: true });
  } finally {
    delete process.env.ARW_PLAIN_REVIEW;
  }
  const { validation } = out;
  assert.equal(validation.status, 'EXECUTED_PASS', JSON.stringify(validation.jobs.filter((j) => j.errors.length), null, 1));

  // The plain prompt: the PR as a reviewer sees it, no schema, no checklist.
  assert.equal(plainCalls.length, 2);
  const first = plainCalls[0].prompt;
  assert.match(first, /PR title: ACME-7 member discount/);
  assert.match(first, /Members get 10% off from 1,000,000\./);
  assert.match(first, new RegExp(`git diff ${repo.base} ${repo.head}`));
  assert.match(first, /Do not modify any file\./);
  assert.doesNotMatch(first, /JSON SCHEMA|VIEWPOINT CHECKS|COVERAGE IDS/);
  assert.equal(plainCalls[0].effort, 'max');
  assert.equal(plainCalls[0].sandbox, 'read-only');
  assert.match(plainCalls[1].prompt, /REJECTED[\s\S]*end with a one-line verdict/);

  // Its prose is kept with the revision, then converted with quotes.
  const ctx = JSON.parse(fs.readFileSync(path.join(require('../src/lib/runs').prDir('acme/plain', 1), 'review', 'context.json'), 'utf8')).context_id;
  const kept = JSON.parse(fs.readFileSync(path.join(require('../src/lib/runs').prDir('acme/plain', 1), 'review', 'revisions', ctx, 'plain', 'P0.json'), 'utf8'));
  assert.equal(kept.text, PLAIN);
  assert.equal(convertCalls.length, 1);
  assert.match(convertCalls[0].prompt, /^PLAIN REVIEW P0:/m);
  assert.ok(convertCalls[0].prompt.includes(PLAIN), 'the prose is given to the conversion');
  assert.match(convertCalls[0].prompt, /^COVERAGE IDS: \["viewpoint:P0"\]$/m);

  const f = validation.findings.find((x) => x.id === 'P0-technical-F1');
  assert.ok(f, validation.findings.map((x) => x.id).join(','));
  assert.equal(f.severity, 'P2');
  assert.equal(validation.recommendation, 'changes_requested');
});
