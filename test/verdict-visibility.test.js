'use strict';
// A withdrawn blocking finding and a downgraded test_gap are never silently
// absent from the report or the pending review: the runtime still decides the
// verdict, but the person can see what it did not publish inline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { renderReport, writeReport } = require('../src/lib/report');
const { buildReview } = require('../src/lib/publish');
const { validationDigest, packetHashes } = require('../src/lib/artifacts');
const { sha256Value } = require('../src/lib/util');
const { revisionDir, reviewDir } = require('../src/lib/freeze');
const { writeJsonAtomic } = require('../src/lib/util');

function fixture() {
  const runDir = tmpDir('arw-verdict-');
  const contextId = '0123456789abcdef';
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const contextBody = {
    schema_version: '1.0',
    project: null,
    source: { checkout: runDir, base_sha: base, head_sha: head, patch_sha256: 'c'.repeat(64), changed_files: ['shop.py'], reviewable: ['shop.py'] },
    plan_sha256: 'd'.repeat(64),
    tool_sha256: 'e'.repeat(64),
    execution: {},
    inputs: [],
  };
  const contextDigest = sha256Value(contextBody);
  const context = { ...contextBody, context_id: contextId, context_digest: contextDigest, frozen_at: '2026-11-04T00:00:00.000Z' };
  const dir = revisionDir(runDir, contextId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(reviewDir(runDir), { recursive: true });
  writeJsonAtomic(path.join(reviewDir(runDir), 'context.json'), { context_id: contextId, context_digest: contextDigest });
  writeJsonAtomic(path.join(dir, 'context.json'), context);
  fs.writeFileSync(path.join(dir, 'review.patch'), 'diff --git a/shop.py b/shop.py\n--- a/shop.py\n+++ b/shop.py\n@@ -1,1 +1,2 @@\n x = 1\n+y = 2\n');

  const withdrawn = {
    id: 'B1-business-F1', severity: 'P2', title: 'Refund at the exact limit is accepted',
    asis: 'the limit is strict', tobe: 'the limit is inclusive', impact: 'a refund is rejected',
    confidence: 'LIKELY', category: 'defect',
    evidence: [{ kind: 'code', path: 'shop.py', start_line: 1, end_line: 1, quote: 'x = 1' }],
    fix: { kind: 'not_code', reason: 'decide the boundary' },
    authority: { kind: 'requirement', id: 'I1' },
    trigger: { given: 'a refund at the limit', when: 'it is submitted', then: 'it is accepted' },
  };
  const suggestion = {
    id: 'T1-technical-F2', severity: 'P4', title: 'Add a test for the inclusive boundary',
    asis: 'no test at the boundary', tobe: 'a boundary test', impact: 'a regression can pass',
    confidence: 'LIKELY', category: 'test_gap',
    evidence: [{ kind: 'code', path: 'shop.py', start_line: 1, end_line: 1, quote: 'x = 1' }],
    fix: { kind: 'not_code', reason: 'add the test' },
    authority: { kind: 'curated_viewpoint', id: 'CK-BZ-1' },
    trigger: { given: 'the boundary', when: 'a test runs', then: 'it fails first' },
  };
  const packet = {
    schema_version: '1.0', context_digest: contextDigest, unit_id: 'B1', role: 'business',
    summary: 'fixture', dependency_refs: [], coverage: [], item_verdicts: [],
    findings: [withdrawn, suggestion], recommendation: 'findings',
  };
  fs.mkdirSync(path.join(dir, 'packets', 'business'), { recursive: true });
  writeJsonAtomic(path.join(dir, 'packets', 'business', 'B1.json'), packet);
  writeJsonAtomic(path.join(dir, 'rebuttals', 'B1-business-F1.json'), {
    schema_version: '1.0', context_digest: contextDigest, finding_id: 'B1-business-F1',
    finding_sha256: sha256Value(withdrawn), verdict: 'FINDING_WITHDRAWN',
    defense_attempted: 'read the caller', reason: 'the caller rejects a negative amount, not the exact limit',
  });
  writeJsonAtomic(path.join(dir, 'synthesis.json'), { overview: [], unverified: [], aliases: [] });

  const jobs = [{ unit_id: 'B1', role: 'business', status: 'EXECUTED_PASS', errors: [] }];
  const validation = {
    context_id: contextId, context_digest: contextDigest,
    status: 'EXECUTED_PASS', complete: true, recommendation: 'no_blocking_findings',
    human_gate: { recorded: 'NOT_RECORDED', bound_to_current_context: false },
    findings: [
      { ...withdrawn, state: 'withdrawn', label: 'SUSPECTED', evidence_level: 'L1', votes: 1, canonical: true, suggestion: false, rebuttal_from: 'B1-business-F1' },
      { ...suggestion, state: 'not_challenged', label: 'SUSPECTED', evidence_level: 'L1', votes: 1, canonical: true, suggestion: true },
    ],
    jobs, gaps: [], items: [], checks: [], impacts: [], warnings: [], size: null, opt_outs: [], carried_over: null,
    synthesis: { present: true, valid: true, errors: [] },
    usage: { calls: 1, repair_calls: 0, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, elapsed_ms: 1, plan: { calls: 0, input_tokens: 0, output_tokens: 0 } },
  };
  validation.artifacts = { packets: packetHashes(runDir, contextId, jobs) };
  const run = {
    identity: { repo: 'acme/shop', pr: 9, head_sha: head, base_sha: base, title: 'fixture' },
    phases: { repro: { status: 'SKIPPED', reason: 'disabled (--no-repro)' } },
    validation_sha256: validationDigest(validation),
  };
  writeJsonAtomic(path.join(runDir, 'run.json'), run);
  writeJsonAtomic(path.join(dir, 'validation.json'), validation);
  return { runDir, validation, identity: run.identity };
}

test('a withdrawn P2 is listed with its reason in report and publish body', () => {
  const { runDir, validation, identity } = fixture();
  const report = renderReport(runDir, validation, identity);
  assert.match(report, /## Withdrawn \/ not proven/);
  assert.match(report, /B1-business-F1[\s\S]{0,200}withdrawn by the red team[\s\S]{0,200}caller rejects a negative amount/);

  const review = buildReview(runDir);
  assert.match(review.body, /## Withdrawn \/ not proven/);
  assert.match(review.body, /B1-business-F1[\s\S]{0,200}withdrawn by the red team[\s\S]{0,200}caller rejects a negative amount/);
});

test('a test_gap is listed under Suggestions and the publish header counts what is not inline', () => {
  const { runDir, validation, identity } = fixture();
  const report = renderReport(runDir, validation, identity);
  assert.match(report, /## Suggestions \(tests and process, not in the verdict\)/);
  assert.match(report, /T1-technical-F2[\s\S]{0,160}test_gap/);

  const review = buildReview(runDir);
  assert.match(review.body, /## Suggestions \(not in the verdict\)/);
  assert.match(review.body, /T1-technical-F2[\s\S]{0,160}test_gap/);
  assert.match(review.body.split('##')[0], /not posted inline/i);
  assert.match(review.body.split('##')[0], /1 withdrawn \/ not proven/);
  assert.match(review.body.split('##')[0], /1 suggestions \(not in the verdict\)/);

  const file = writeReport(runDir, validation, identity);
  assert.match(fs.readFileSync(file, 'utf8'), /## Withdrawn \/ not proven/);
});

test('a withdrawn suggestion is counted once, under Withdrawn', () => {
  const { runDir, validation } = fixture();
  validation.findings[1].state = 'withdrawn';
  const dir = revisionDir(runDir, validation.context_id);
  writeJsonAtomic(path.join(dir, 'validation.json'), validation);
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  writeJsonAtomic(path.join(runDir, 'run.json'), { ...run, validation_sha256: validationDigest(validation) });

  const review = buildReview(runDir);
  const header = review.body.split('##')[0];
  assert.match(header, /2 not posted inline/);
  assert.match(header, /2 withdrawn \/ not proven; 0 suggestions/);
  assert.equal(review.suggestions.length, 0);
  const report = renderReport(runDir, validation, run.identity);
  assert.equal(report.split('T1-technical-F2').length - 1, 1, 'listed once in the report');
});
