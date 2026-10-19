'use strict';
// Reproductions that failed for a reason the runtime can settle itself: a
// Maven module outside the reactor, and a repro test that did not compile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, viewpointVerdicts, impactVerdicts, coverageIdsOf } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-retry-runs-');

const { reviewPr } = require('../src/lib/pr-review');
const { loadContext, revisionDir } = require('../src/lib/freeze');

const BASE = 'def late_fee(days):\n    if days <= 30:\n        return 0\n    return (days - 30) * 2\n';
const HEAD = 'def late_fee(days):\n    if days < 30:\n        return 0\n    return (days - 30) * 2\n';
const BAD_LINE = '    if days < 30:';
const TEST_PATH = 'core/src/test/java/a/FeeReproTest.java';
const javaTest = (marker) => `package a;\n\nclass FeeReproTest {\n    // ${marker}\n    void dayThirtyIsFree() { assert late_fee(30) == 0; }\n}\n`;

function repo() {
  const dir = tmpDir('arw-retry-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'billing/fees.py', BASE);
  // The root reactor does not list core (ruoyi-vue-pro comments its modules out).
  write(dir, 'pom.xml', '<project><modules><!-- <module>core</module> --></modules></project>\n');
  write(dir, 'core/pom.xml', '<project/>\n');
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

// reproTests: the test content returned by each successive repro call.
function executor(reproTests, reproPrompts) {
  return async (opts) => {
    fs.mkdirSync(opts.attemptDir, { recursive: true });
    const p = opts.prompt;
    const ok = (o) => ({ ok: true, output: JSON.stringify(o), exit_code: 0, elapsed_ms: 1, usage: { input_tokens: 1, output_tokens: 1 }, error_class: null, model: 'fake', prompt_bytes: p.length });
    const code = (quote) => ({ kind: 'code', path: 'billing/fees.py', start_line: HEAD.split('\n').indexOf(quote) + 1, end_line: HEAD.split('\n').indexOf(quote) + 1, quote: quote.trim() });
    if (p.startsWith('You are a read-only planner')) return ok({ schema_version: '1.0', hypotheses: [], units: [{ id: 'T1', kind: 'technical', desc: 'fees', files: ['billing/fees.py'], items: [] }], gaps: [], notes: '' });
    if (p.includes('JOB: write ONE reproduction test')) {
      reproPrompts.push(p);
      const content = reproTests[Math.min(reproPrompts.length, reproTests.length) - 1];
      return ok({ language: 'java', path: TEST_PATH, selector: 'a.FeeReproTest', content, fails_because: 'late_fee(30) is 0 only on base' });
    }
    if (p.includes('JOB: red-team rebuttal')) {
      const id = p.match(/^JOB: red-team rebuttal of finding (\S+)\.$/m)[1];
      return ok({ schema_version: '1.0', context_digest: 'x', finding_id: id, finding_sha256: '0'.repeat(64), role: 'red-team', verdict: 'FINDING_STANDS', defense_attempted: 'looked for a caller that pre-checks day 30', reason: 'none does', evidence: [code(BAD_LINE)] });
    }
    const unit = JSON.parse(p.match(/^UNIT: (.*)$/m)[1]);
    const role = p.match(/^JOB: .* role (business|technical)\.$/m)[1];
    const coverage = coverageIdsOf(p).map((id) => (id.startsWith('file:') ? { id, disposition: 'reviewed', evidence: [code(BAD_LINE)], note: 'read it' } : { id, disposition: 'unverified', evidence: [], note: 'nothing to cite' }));
    const findings = unit.id === 'T1' ? [{
      id: 'T1-technical-F1', severity: 'P2', confidence: 'LIKELY', title: 'Day 30 is charged a late fee',
      asis: 'An invoice paid on day 30 pays 0 only because of the strict comparison change.', tobe: 'Day 30 is still within the grace period.',
      trigger: { given: 'an invoice 30 days late', when: 'late_fee(30)', then: 'it should be 0' }, impact: 'Customers are charged on the last free day.',
      evidence: [code(BAD_LINE)], fix: { kind: 'code_change', asis: BAD_LINE.trim(), tobe: 'if days <= 30:', reason: 'keep day 30 free' },
      verification: { method: 'inspected', detail: 'read late_fee', evidence: [] },
      authority: { kind: 'curated_viewpoint', id: 'CK-BZ-1', source: inputEv(p, 'policy-policies-checklist', 'CK-BZ-1: Boundary conditions match the requirement wording') }, items: [],
    }] : [];
    return ok({ schema_version: '1.0', context_digest: p.match(/context_digest: ([a-f0-9]{64})/)[1], unit_id: unit.id, role, summary: 'done', dependency_refs: [], coverage, item_verdicts: [], viewpoint_verdicts: viewpointVerdicts(p, findings), impact_verdicts: impactVerdicts(p), findings, recommendation: findings.length ? 'findings' : 'no_findings' });
  };
}

// Stands in for Maven. "-pl core" fails as Maven does for a module the
// reactor does not list (unless inReactor); a test containing BROKEN does
// not compile; otherwise the test passes only on the base implementation.
function runner(calls, { inReactor = false, otherFileBroken = false } = {}) {
  return async ({ command, cwd, logFile, phase }) => {
    calls.push([phase, command]);
    const fail = (text) => {
      fs.writeFileSync(logFile, text);
      return { exit_code: 1, elapsed_ms: 1 };
    };
    if (!inReactor && / -pl core /.test(command)) return fail('[ERROR] Could not find the selected project in the reactor: core @ \n[ERROR] -> [Help 1]\n');
    const testFile = path.join(cwd, TEST_PATH);
    const abs = `/${testFile.replace(/\\/g, '/')}`;
    if (otherFileBroken) return fail(`[ERROR] COMPILATION ERROR : \n[ERROR] /${path.join(cwd, 'core/src/main/java/a/Fees.java').replace(/\\/g, '/')}:[3,5] cannot find symbol\n`);
    if (fs.readFileSync(testFile, 'utf8').includes('BROKEN')) {
      return fail(`[ERROR] COMPILATION ERROR : \n[ERROR] ${abs}:[5,40] cannot find symbol\n[ERROR]   symbol:   method late_fee(int)\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:testCompile (default-testCompile) on project core: Compilation failure\n`);
    }
    const pass = fs.readFileSync(path.join(cwd, 'billing/fees.py'), 'utf8').replace(/\r\n/g, '\n') === BASE;
    write(cwd, 'core/target/surefire-reports/TEST-a.FeeReproTest.xml', `<testsuite tests="1" failures="${pass ? 0 : 1}" errors="0" skipped="0"><testcase classname="a.FeeReproTest" name="dayThirtyIsFree">${pass ? '' : '<failure message="expected 0 but was 2"/>'}</testcase></testsuite>`);
    fs.writeFileSync(logFile, `mvn ${phase}: ${pass ? 'passed' : 'failed'}\n`);
    return { exit_code: pass ? 0 : 1, elapsed_ms: 1 };
  };
}

async function review(pr, reproTests, runnerOpts) {
  const r = repo();
  const calls = [];
  const reproPrompts = [];
  const prepared = { info: { title: 'grace period', body: '', headRefName: 'g', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { validation, runDir } = await reviewPr({ repo: 'acme/fees', pr, executor: executor(reproTests, reproPrompts), prepared, workers: 1, skipSynthesis: true, reproRunner: runner(calls, runnerOpts), testCommand: null });
  const context = loadContext(runDir);
  const rec = JSON.parse(fs.readFileSync(path.join(revisionDir(runDir, context.context_id), 'repro', 'T1-technical-F1.json'), 'utf8'));
  return { validation, calls, reproPrompts, rec, runDir, context };
}

// Incident (v4: ruoyi-vue-pro #1286): yudao-module-mall is commented out of
// the root <modules>, so "-pl <module> -am" failed with "Could not find the
// selected project in the reactor" and the finding never ran. The head run
// falls back to the module's own pom (-f <module>/pom.xml) and keeps it.
test('maven: a module outside the reactor is run with -f <module>/pom.xml', async () => {
  const { validation, calls, rec } = await review(1, [javaTest('ok')]);
  assert.match(calls[0][1], / -pl core -am test /);
  assert.ok(calls.slice(1).every(([, c]) => / -f core\/pom\.xml test /.test(c) && !/ -pl /.test(c)), JSON.stringify(calls));
  assert.deepEqual(rec.runs.map((r) => [r.phase, r.status]), [['head-1', 'red'], ['head-2', 'red'], ['fix', 'green']]);
  assert.ok(rec.notes.some((n) => /not in the reactor.*-f core\/pom\.xml/.test(n)), JSON.stringify(rec.notes));
  const f = validation.findings.find((x) => x.id === 'T1-technical-F1');
  assert.deepEqual([f.label, f.repro.status], ['CONFIRMED', 'RED_PROVEN']);
});
