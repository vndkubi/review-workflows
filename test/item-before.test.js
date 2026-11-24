'use strict';
// UX1: an item verdict may say what the code did for the same situation at
// base ("before"), so the brief can show before -> after. A changed or
// unchanged behaviour is shown in base code: a quote at revision "base".
// Behaviour that did not exist at base says so ("new") and needs no quote.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');
const git = require('../src/lib/git');
const { validatePacket, splitLines } = require('../src/lib/validate');
const brief = require('../src/lib/brief');

const repo = makeRepo();
const ORDER = 'src/main/java/com/acme/OrderService.java';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';
const DIGEST = 'b'.repeat(64);
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
const headEv = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE };
const baseEv = { kind: 'code', path: ORDER, revision: 'base', start_line: 8, end_line: 8, quote: 'return BigDecimal.ZERO;' };
const unit = { id: 'B1', kind: 'business', covers: [`file:${ORDER}`, 'I1'], depends_on: [], roles: ['business'], checks: [], impacts: [] };
const items = [{ id: 'I1', kind: 'rule', expected: '10% off above 1,000,000', text: 'R1: when member and total > 1,000,000 -> 10% off' }];

function packet(verdict) {
  return {
    schema_version: '1.0', context_digest: DIGEST, unit_id: 'B1', role: 'business', summary: 's', dependency_refs: [],
    coverage: [{ id: `file:${ORDER}`, disposition: 'reviewed', evidence: [headEv], note: 'n' }],
    item_verdicts: [{ item: 'I1', verdict: 'pass', evidence: [headEv], note: 'members above the threshold get 10% off', ...verdict }],
    viewpoint_verdicts: [], impact_verdicts: [], findings: [], recommendation: 'no_findings',
  };
}
const check = (p) => validatePacket(p, { sources, unit, role: 'business', items, expectedDependencyRefs: [] });
const has = (errors, re) => assert.ok(errors.some((e) => re.test(e)), `expected ${re} in:\n${errors.join('\n')}`);

test('a verdict without "before" stays valid: the field is optional', () => {
  assert.deepEqual(check(packet({})), []);
});

test('"changed" and "unchanged" need a quote of the base code', () => {
  const changed = { before: { status: 'changed', text: 'every order got no discount' } };
  has(check(packet(changed)), /item_verdicts\[0\]\.before: "changed" needs a code quote at base/);
  assert.deepEqual(check(packet({ ...changed, evidence: [headEv, baseEv] })), []);
  has(check(packet({ before: { status: 'unchanged', text: 'same' } })), /"unchanged" needs a code quote at base/);
});

test('"new" behaviour needs no base quote; a base quote that is not in the file is rejected', () => {
  assert.deepEqual(check(packet({ before: { status: 'new', text: 'no discount logic existed' } })), []);
  const wrong = { ...baseEv, quote: 'return total;' };
  has(check(packet({ before: { status: 'changed', text: 'x' }, evidence: [headEv, wrong] })), /evidence\[1\]/);
});

test('an unknown status or empty text is a schema error', () => {
  has(check(packet({ before: { status: 'maybe', text: 'x' } })), /before\.status|must be equal to one of/);
  has(check(packet({ before: { status: 'new', text: '' } })), /before\.text|must NOT have fewer than/);
});

test('the brief shows before -> after when reviewers recorded it', () => {
  const b = brief.buildBrief({
    identity: { repo: 'acme/shop', pr: 1, title: 't', ticket: 'ACME-7' },
    validation: {
      context_id: 'c', recommendation: 'no_blocking_findings', complete: true, gaps: [], jobs: [], findings: [], impacts: [],
      human_gate: { recorded: 'APPROVED', bound_to_current_context: true },
      items: [
        { id: 'I1', kind: 'rule', risk: 'money', result: 'pass', verdicts: [{ unit_id: 'B1', role: 'business', verdict: 'pass', note: 'members above the threshold get 10% off', before: { status: 'changed', text: 'every order got no discount' } }] },
        { id: 'I2', kind: 'rule', risk: 'normal', result: 'pass', verdicts: [{ unit_id: 'B1', role: 'business', verdict: 'pass', note: 'late fee is 0.5 per day' }] },
      ],
    },
    plan: null, items: [{ id: 'I1', text: 'R1', expected: '10% off' }, { id: 'I2', text: 'R2', expected: '0.5/day' }],
  });
  const row = (id) => b.behaviour.rows.find((r) => r.source === id);
  assert.deepEqual(row('I1').before, { status: 'changed', text: 'every order got no discount' });
  assert.equal(row('I2').before, null);
  assert.equal(b.behaviour.base_recorded, true);
  const md = brief.renderBrief(b);
  assert.match(md, /\| Situation \| Before \(base\) \| Spec expects \| Code at head \(reviewers\) \| Result \|/);
  assert.match(md, /changed: every order got no discount/);
  assert.match(md, /_not recorded_/);
  assert.doesNotMatch(md, /Behaviour at base is not recorded/);
});
