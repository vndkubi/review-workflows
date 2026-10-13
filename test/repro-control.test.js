'use strict';
// Reproduction controls through the whole review: a stable failure is
// CONFIRMED only when the finding's fix makes the test pass or the base
// commit passes it; otherwise it is REPRODUCED. Raw evidence is kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-control-runs-');

const { reviewPr } = require('../src/lib/pr-review');
const { loadContext, revisionDir } = require('../src/lib/freeze');

const BASE = 'def late_fee(days):\n    if days <= 30:\n        return 0\n    return (days - 30) * 2\n';
const HEAD = 'def late_fee(days):\n    if days < 30:\n        return 0\n    return (days - 30) * 2\n';
const BAD_LINE = '    if days < 30:';

function repo() {
  const dir = tmpDir('arw-control-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/fees.py', BASE);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'billing/fees.py', HEAD);
  sh(dir, ['commit', '-q', '-am', 'grace period']);
  return { dir, base, head: sh(dir, ['rev-parse', 'HEAD']) };
}

function inputEv(prompt, id, needle) {
  const lines = prompt.slice(prompt.indexOf(`INPUT ${id}:\n`) + `INPUT ${id}:\n`.length).split('\n');
  const i = lines.findIndex((l) => l.replace(/^\s*\d+\| /, '').includes(needle));
  return { kind: 'input', path: id, start_line: i + 1, end_line: i + 1, quote: needle };
}

function executor(fixTobe) {
  return async (opts) => {
    fs.mkdirSync(opts.attemptDir, { recursive: true });
    const p = opts.prompt;
    const ok = (o) => ({ ok: true, output: JSON.stringify(o), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 1, output_tokens: 1 }, error_class: null, model: 'fake', prompt_bytes: p.length });
    const code = (quote) => ({ kind: 'code', path: 'billing/fees.py', start_line: HEAD.split('\n').indexOf(quote) + 1, end_line: HEAD.split('\n').indexOf(quote) + 1, quote: quote.trim() });
    if (p.startsWith('You are a read-only planner')) return ok({ schema_version: '1.0', hypotheses: [], units: [{ id: 'T1', kind: 'technical', desc: 'fees', files: ['billing/fees.py'], items: [] }], gaps: [], notes: '' });
    if (p.includes('JOB: write ONE reproduction test')) {
      return ok({ language: 'python', path: 'tests/test_fee_repro.py', selector: 'tests/test_fee_repro.py::test_day_30_is_free', content: 'from billing.fees import late_fee\n\ndef test_day_30_is_free():\n    assert late_fee(30) == 0\n', fails_because: 'late_fee(30) is 0 only on base' });
    }
    if (p.includes('JOB: red-team rebuttal')) {
      const id = p.match(/^JOB: red-team rebuttal of finding (\S+)\.$/m)[1];
      return ok({ schema_version: '1.0', context_digest: 'x', finding_id: id, finding_sha256: '0'.repeat(64), role: 'red-team', verdict: 'FINDING_STANDS', defense_attempted: 'looked for a caller that pre-checks day 30', reason: 'none does', evidence: [code(BAD_LINE)] });
    }
    const unit = JSON.parse(p.match(/^UNIT: (.*)$/m)[1]);
    const role = p.match(/^JOB: .* role (business|technical)\.$/m)[1];
    const coverage = unit.covers.filter((c) => c.startsWith('file:') || c.startsWith('viewpoint:')).map((id) => (id.startsWith('file:') ? { id, disposition: 'reviewed', evidence: [code(BAD_LINE)], note: 'read it' } : { id, disposition: 'unverified', evidence: [], note: 'nothing to cite' }));
    const findings = unit.id === 'T1' ? [{
      id: 'T1-technical-F1', severity: 'P2', confidence: 'LIKELY', title: 'Day 30 is charged a late fee',
      asis: 'An invoice paid on day 30 pays 0 only because of the strict comparison change.', tobe: 'Day 30 is still within the grace period.',
      trigger: { given: 'an invoice 30 days late', when: 'late_fee(30)', then: 'it should be 0' }, impact: 'Customers are charged on the last free day.',
      evidence: [code(BAD_LINE)], fix: { kind: 'code_change', asis: BAD_LINE.trim(), tobe: fixTobe, reason: 'keep day 30 free' },
      verification: { method: 'inspected', detail: 'read late_fee', evidence: [] },
      authority: { kind: 'curated_viewpoint', id: 'CK-BZ-1', source: inputEv(p, 'policy-policies-checklist', 'CK-BZ-1: Boundary conditions match the requirement wording') }, items: [],
    }] : [];
    return ok({ schema_version: '1.0', context_digest: p.match(/context_digest: ([a-f0-9]{64})/)[1], unit_id: unit.id, role, summary: 'done', dependency_refs: [], coverage, item_verdicts: [], findings, recommendation: findings.length ? 'findings' : 'no_findings' });
  };
}

// Stands in for pytest: the test passes only on the base implementation (or,
// with baseFails, never: a defect the base has too). With linkTo, the PR
// code replaces tests/ with a link to that directory during head-2.
function runner(calls, { baseFails = false, linkTo = null, plantGit = null } = {}) {
  return async ({ cwd, logFile, phase }) => {
    if (plantGit && phase === 'head-1') plantGit(cwd);
    if (linkTo && phase === 'head-2') {
      fs.rmSync(path.join(cwd, 'tests'), { recursive: true, force: true });
      fs.symlinkSync(linkTo, path.join(cwd, 'tests'), 'junction');
    }
    const src = fs.readFileSync(path.join(cwd, 'billing/fees.py'), 'utf8').replace(/\r\n/g, '\n');
    const pass = !baseFails && src === BASE;
    calls.push([phase, pass]);
    fs.writeFileSync(path.join(cwd, '.arw-junit.xml'), `<testsuite tests="1" failures="${pass ? 0 : 1}" errors="0" skipped="0"><testcase classname="tests.test_fee_repro" name="test_day_30_is_free">${pass ? '' : '<failure message="assert 2 == 0"/>'}</testcase></testsuite>`);
    fs.writeFileSync(logFile, `pytest ${phase}: ${pass ? 'passed' : 'failed'}\n`);
    return { exit_code: pass ? 0 : 1, elapsed_ms: 1 };
  };
}

async function review(fixTobe, pr, runnerOpts) {
  const r = repo();
  const calls = [];
  const prepared = { info: { title: 'grace period', body: '', headRefName: 'g', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { validation, runDir } = await reviewPr({ repo: 'acme/fees', pr, executor: executor(fixTobe), prepared, workers: 1, skipSynthesis: true, reproRunner: runner(calls, runnerOpts), testCommand: null });
  return { validation, calls, runDir };
}

test('a wrong fix: the base passes the test, so the failure is a confirmed regression', async () => {
  const { validation, calls, runDir } = await review('if days < 31:', 1);
  const f = validation.findings.find((x) => x.id === 'T1-technical-F1');
  assert.deepEqual(calls.map((c) => c[0]), ['head-1', 'head-2', 'fix', 'base'], 'the fix did not make it pass, so the base is tried');
  assert.equal(f.repro.fix_verified, false);
  assert.deepEqual([f.label, f.evidence_level, f.repro.control], ['CONFIRMED', 'L3', 'base']);
  // Raw evidence for every run: a log ending in the process outcome, and the JUnit XML.
  const dir = path.join(revisionDir(runDir, loadContext(runDir).context_id), 'repro', 'T1-technical-F1');
  for (const phase of ['head-1', 'head-2', 'fix', 'base']) {
    assert.match(fs.readFileSync(path.join(dir, `${phase}.log`), 'utf8'), /\[arw\] exit_code=\d timed_out=false spawn_error=null\s*$/);
    assert.ok(fs.existsSync(path.join(dir, `${phase}.junit.xml`)));
  }
});

test('no control: the fix does not help and the base fails too, so the failure is only REPRODUCED', async () => {
  const { validation, calls } = await review('if days < 31:', 2, { baseFails: true });
  const f = validation.findings.find((x) => x.id === 'T1-technical-F1');
  assert.deepEqual(calls, [['head-1', false], ['head-2', false], ['fix', false], ['base', false]]);
  assert.deepEqual([f.label, f.evidence_level, f.repro.status, f.repro.control], ['REPRODUCED', 'L2', 'RED_PROVEN', null], 'a stable failure without a control does not prove the defect');
});

test('N2: PR code that turned tests/ into a link out of the worktree cannot make the harness write or delete there', async () => {
  const outside = tmpDir('arw-control-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine');
  const { validation, calls, runDir } = await review('if days < 31:', 3, { linkTo: outside });
  const f = validation.findings.find((x) => x.id === 'T1-technical-F1');
  assert.deepEqual(calls.map((c) => c[0]), ['head-1', 'head-2', 'fix'], 'the base control is not run through the link');
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt'], 'nothing written to or deleted from the link target');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'mine');
  assert.deepEqual([f.label, f.repro.control], ['REPRODUCED', null]);
  const rec = JSON.parse(fs.readFileSync(path.join(revisionDir(runDir, loadContext(runDir).context_id), 'repro', 'T1-technical-F1.json'), 'utf8'));
  assert.match(rec.notes.join(' '), /base control not run: tests is a link/);
});

// What a container can do to the worktree it is given: point .git at a
// repository of its own whose config runs a command (core.fsmonitor) when
// the harness next runs git there, on the host.
function plantEvilGit(marker) {
  return (cwd) => {
    const evil = path.join(cwd, '.evil');
    sh(cwd, ['init', '-q', evil]);
    sh(evil, ['config', 'core.fsmonitor', `echo pwned > "${marker.replace(/\\/g, '/')}"; false`]);
    fs.rmSync(path.join(cwd, '.git'), { force: true }); // hidden on Windows: replace, do not overwrite
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: .evil/.git\n');
  };
}

test('PR code that rewrites the worktree .git file cannot make the harness run a command on the host', async () => {
  const marker = path.join(tmpDir('arw-control-marker-'), 'pwned');
  const { validation, calls } = await review('if days < 31:', 4, { plantGit: plantEvilGit(marker) });
  assert.ok(!fs.existsSync(marker), 'git on the host ran a command the worktree configured');
  assert.ok(calls.length >= 1);
  assert.ok(validation.findings.find((x) => x.id === 'T1-technical-F1'));
});
