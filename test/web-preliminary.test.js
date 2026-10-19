'use strict';
// Incident (user report): while a review was running, the PR page showed no
// findings at all until the whole run was validated, although accepted
// packets already held them. They are shown as preliminary: validated as
// packets, not yet clustered, red-teamed or reproduced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-web-pre-');
const data = require('../src/web/data');
const { prDir } = require('../src/lib/runs');
const { revisionDir } = require('../src/lib/freeze');

const finding = (id, severity, title, category = 'defect') => ({ id, severity, title, category, confidence: 'LIKELY', asis: 'a', tobe: 'b', trigger: { given: 'g', when: 'w', then: 't' }, impact: 'i', evidence: [], fix: { kind: 'not_code', asis: '', tobe: '', reason: 'r' }, verification: { method: 'inspected', detail: 'd', evidence: [] }, authority: { kind: 'inferred', id: 'engineering-judgement', source: null }, items: [] });

test('a run still going shows the findings of its accepted packets as preliminary', () => {
  const dir = prDir('acme/shop', 41);
  fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ identity: { repo: 'acme/shop', pr: 41, title: 't' }, phases: { batch: { status: 'RUNNING' } }, review: { units: [{ id: 'T1' }, { id: 'P0' }] } }));
  fs.writeFileSync(path.join(dir, 'review', 'context.json'), JSON.stringify({ context_id: 'c41' }));
  const rdir = revisionDir(dir, 'c41');
  fs.mkdirSync(path.join(rdir, 'packets', 'technical'), { recursive: true });
  fs.writeFileSync(path.join(rdir, 'packets', 'technical', 'T1.json'), JSON.stringify({ unit_id: 'T1', role: 'technical', findings: [finding('T1-technical-F1', 'P2', 'Partial cart'), finding('T1-technical-F2', 'P4', 'No test', 'test_gap')] }));
  fs.writeFileSync(path.join(rdir, 'packets', 'technical', 'P0.json'), JSON.stringify({ unit_id: 'P0', role: 'technical', findings: [finding('P0-technical-F1', 'P1', 'Lost attributes')] }));

  const d = data.prDetail('acme__shop__41');
  assert.equal(d.validation, null);
  assert.deepEqual(d.findings, [], 'validated findings stay empty until the run is validated');
  assert.equal(d.preliminary.packets, 2);
  assert.deepEqual(d.preliminary.findings.map((f) => [f.id, f.severity, f.state, f.unit_id]), [
    ['P0-technical-F1', 'P1', 'preliminary', 'P0'],
    ['T1-technical-F1', 'P2', 'preliminary', 'T1'],
    ['T1-technical-F2', 'P4', 'preliminary', 'T1'],
  ]);
  assert.equal(d.preliminary.findings[0].detail.title, 'Lost attributes');

  // Once validated, the validated findings replace them.
  fs.writeFileSync(path.join(rdir, 'validation.json'), JSON.stringify({ context_id: 'c41', jobs: [], findings: [], counts: {}, gaps: [] }));
  assert.equal(data.prDetail('acme__shop__41').preliminary, null);
});
