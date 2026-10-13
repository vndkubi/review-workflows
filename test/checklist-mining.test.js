'use strict';
// Checklist mining: kept defects without a checklist item, repeated
// rejections, and checklist items that mostly produce rejected findings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-mine-runs-');
process.env.ARW_CHECKLIST_FILE = path.join(tmpDir('arw-mine-ck-'), 'checklist.md');

const { mineChecklist, acceptProposal, checklistIds } = require('../src/lib/checklist-mining');
const memory = require('../src/lib/memory');

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const ev = { kind: 'code', path: 'src/Refund.java', start_line: 3, end_line: 3, quote: 'x' };
const finding = (id, title, asis, authority = { kind: 'inferred', id: 'engineering-judgement', source: ev }) => ({ id, title, asis, severity: 'P3', evidence: [ev], authority });
const CK = { kind: 'curated_viewpoint', id: 'CK-BZ-1', source: { kind: 'input', path: 'policy-policies-checklist', start_line: 1, end_line: 1, quote: 'x' } };

function run(n, findings, verdicts) {
  const dir = path.join(process.env.ARW_RUNS_DIR, 'prs', `acme__shop__${n}`);
  put(path.join(dir, 'run.json'), { identity: { repo: 'acme/shop', pr: n } });
  put(path.join(dir, 'review', 'context.json'), { context_id: 'c1' });
  const rev = path.join(dir, 'review', 'revisions', 'c1');
  put(path.join(rev, 'validation.json'), { jobs: [{ unit_id: 'T1', role: 'technical', status: 'EXECUTED_PASS' }], findings: [] });
  put(path.join(rev, 'packets', 'technical', 'T1.json'), { findings });
  put(path.join(dir, 'feedback.json'), { context_id: 'c1', findings: Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict })) });
  return dir;
}

test('proposals: add, avoid and revise, then accept one into the checklist', () => {
  fs.writeFileSync(process.env.ARW_CHECKLIST_FILE, '# Review checklist\n\n## Business correctness\n- CK-BZ-1: Boundary conditions match the requirement wording.\n\n## Learned from reviews\n- CK-LR-1: Older learned item.\n\n## Java specifics\n- CK-JV-1: x\n');
  run(1, [
    finding('T1-technical-F1', 'Refund amount is not rounded to cents', 'The refund keeps sub-cent fractions.'),
    finding('T1-technical-F2', 'Log message built with string concatenation', 'The logger call concatenates strings.'),
    finding('T1-technical-F3', 'Boundary excludes the threshold', 'Strict comparison.', CK),
  ], { 'T1-technical-F1': 'kept', 'T1-technical-F2': 'dropped', 'T1-technical-F3': 'kept' });
  run(2, [
    finding('T1-technical-F1', 'Refund total not rounded to cents before saving', 'Fractions of a cent are stored.'),
    finding('T1-technical-F2', 'Boundary check off at the limit', 'Strict comparison.', CK),
  ], { 'T1-technical-F1': 'edited', 'T1-technical-F2': 'dropped' });
  const r3 = run(3, [
    finding('T1-technical-F1', 'Log statement uses string concatenation', 'The logger concatenates strings.'),
    finding('T1-technical-F2', 'Limit comparison is exclusive', 'Strict comparison.', CK),
  ], { 'T1-technical-F2': 'dropped' });
  memory.addRejection(JSON.parse(fs.readFileSync(path.join(r3, 'review', 'revisions', 'c1', 'packets', 'technical', 'T1.json'), 'utf8')).findings[0], { scope: 'acme/shop', reason: 'style only', source: 'dashboard', run: 'acme__shop__3' });
  run(4, [finding('T1-technical-F1', 'Threshold boundary wrong', 'Strict comparison.', CK)], { 'T1-technical-F1': 'dropped' });

  const { proposals, decided } = mineChecklist();
  assert.equal(decided, 8, "3 + 2 + 2 (one remembered from the dashboard) + 1");
  const byKind = (k) => proposals.filter((p) => p.kind === k);
  assert.equal(byKind('add').length, 1);
  assert.equal(byKind('add')[0].text, 'Refund amount is not rounded to cents');
  assert.match(byKind('add')[0].evidence, /kept in 2 reviews/);
  assert.equal(byKind('avoid').length, 1);
  assert.match(byKind('avoid')[0].text, /^Do not report: Log statement uses string concatenation \(style only\)$/);
  assert.deepEqual(byKind('revise').map((p) => p.ck), ['CK-BZ-1']);
  assert.match(byKind('revise')[0].evidence, /3 of 4 findings citing CK-BZ-1 were rejected/);

  const added = acceptProposal(byKind('add')[0].id, { text: 'Money is rounded to the currency unit before it is stored or returned.' });
  assert.equal(added.id, 'CK-LR-2');
  const avoid = acceptProposal(byKind('avoid')[0].id, {});
  assert.equal(avoid.id, 'CK-NO-1');
  const text = fs.readFileSync(process.env.ARW_CHECKLIST_FILE, 'utf8');
  assert.match(text, /## Learned from reviews\n- CK-LR-1: Older learned item\.\n- CK-LR-2: Money is rounded[^\n]*\n- CK-NO-1: Do not report: Log statement[^\n]*\n\n## Java specifics/);
  assert.equal(new Set(checklistIds(text)).size, checklistIds(text).length, 'ids stay unique');
  assert.throws(() => acceptProposal(byKind('revise')[0].id), /edit its line/);
  assert.throws(() => acceptProposal('add-nope'), /no proposal/);
});
