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
const { loadReproRecords } = require('../src/lib/repro');

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
function executor(reproTests, reproPrompts, fixTobe = 'if days <= 30:') {
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
      evidence: [code(BAD_LINE)], fix: { kind: 'code_change', asis: BAD_LINE.trim(), tobe: fixTobe, reason: 'keep day 30 free' },
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

async function review(pr, reproTests, runnerOpts, { fixTobe } = {}) {
  const r = repo();
  const calls = [];
  const reproPrompts = [];
  const prepared = { info: { title: 'grace period', body: '', headRefName: 'g', baseRefName: 'main', url: null }, checkout: r.dir, head: r.head, base: r.base };
  const { validation, runDir } = await reviewPr({ repo: 'acme/fees', pr, executor: executor(reproTests, reproPrompts, fixTobe), prepared, workers: 1, skipSynthesis: true, reproRunner: runner(calls, runnerOpts), testCommand: null });
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

// Incident (v4: ruoyi-vue-pro #1286, P0): the fix stayed prose on every
// attempt and the packet with its finding was lost. The last attempt keeps
// the packet with the fix as not_code; the finding is still reproduced (by
// the base control).
test('packets: a prose fix on every attempt is kept as not_code instead of losing the packet', async () => {
  const { validation, rec, runDir, context } = await review(5, [javaTest('ok')], { inReactor: true }, { fixTobe: 'Keep day 30 inside the grace period' });
  const job = validation.jobs.find((j) => j.unit_id === 'T1' && j.role === 'technical');
  assert.equal(job.status, 'EXECUTED_PASS');
  const packet = JSON.parse(fs.readFileSync(path.join(revisionDir(runDir, context.context_id), 'packets', 'technical', 'T1.json'), 'utf8'));
  assert.equal(packet.findings[0].fix.kind, 'not_code');
  assert.match(packet.findings[0].fix.reason, /Proposed change: Keep day 30 inside the grace period/);
  assert.deepEqual(rec.runs.map((r) => [r.phase, r.status]), [['head-1', 'red'], ['head-2', 'red'], ['base', 'green']]);
});

// Incident (v4: spring-boot #52281, camel #27910 x2): the repro test did
// not compile (a wrong override, NullAway), head-1 was a build error and the
// finding stayed unproven. (Shopizer #1123 failed at run time with a
// NoClassDefFoundError: a classpath problem, not this one.) The compiler errors in the
// test file go back to the test writer once, as a repair, and it runs again.
test('repro: a test that does not compile goes back to its writer once with the compiler errors', async () => {
  const { validation, reproPrompts, rec, runDir, context } = await review(2, [javaTest('BROKEN'), javaTest('fixed')], { inReactor: true });
  assert.equal(reproPrompts.length, 2);
  assert.match(reproPrompts[1], /REPAIR MODE/);
  assert.match(reproPrompts[1], /core\/src\/test\/java\/a\/FeeReproTest\.java:\[5,40\] cannot find symbol/);
  assert.match(reproPrompts[1], /symbol: {3}method late_fee\(int\)/);
  assert.deepEqual(rec.runs.map((r) => [r.phase, r.status]), [['head-1', 'red'], ['head-2', 'red'], ['fix', 'green']]);
  assert.equal(rec.compile_retry.run.status, 'build_error');
  assert.match(fs.readFileSync(path.join(revisionDir(runDir, context.context_id), rec.compile_retry.test.artifact.path), 'utf8'), /BROKEN/);
  assert.match(fs.readFileSync(path.join(revisionDir(runDir, context.context_id), rec.test.artifact.path), 'utf8'), /fixed/);
  assert.deepEqual(loadReproRecords(runDir, context).errors, []);
  assert.equal(validation.findings.find((x) => x.id === 'T1-technical-F1').label, 'CONFIRMED');
});

test('repro: the compile retry happens once, and never for errors outside the test file', async () => {
  const twice = await review(3, [javaTest('BROKEN'), javaTest('BROKEN again')], { inReactor: true });
  assert.equal(twice.reproPrompts.length, 2, 'one retry only');
  assert.deepEqual(twice.rec.runs.map((r) => [r.phase, r.status]), [['head-1', 'build_error']]);
  assert.equal(twice.rec.status, 'INCONCLUSIVE');
  const other = await review(4, [javaTest('ok')], { inReactor: true, otherFileBroken: true });
  assert.equal(other.reproPrompts.length, 1, 'the PR code does not compile: nothing for the test writer to fix');
  assert.equal(other.rec.compile_retry, undefined);
});

test('compile errors: Maven and Gradle formats, only in the test file, without repeats', () => {
  const { compileErrors } = require('../src/lib/repro');
  const rel = 'module/jetty/src/test/java/a/BReproTest.java';
  const gradle = [
    '> Task :module:jetty:compileTestJava',
    String.raw`D:\r\repro-wt\module\jetty\src\test\java\a\BReproTest.java:132: error: [NullAway] field not initialized`,
    '\t\tprivate Thread first;',
    '\t\t               ^',
    String.raw`D:\r\repro-wt\module\jetty\src\main\java\a\B.java:5: error: cannot find symbol`,
    '* What went wrong:',
    String.raw`  D:\r\repro-wt\module\jetty\src\test\java\a\BReproTest.java:132: error: [NullAway] field not initialized`,
  ].join('\n');
  assert.deepEqual(compileErrors(gradle, rel), [`${rel}:132: error: [NullAway] field not initialized\n  \t\tprivate Thread first;\n  \t\t               ^`]);
  const maven = `[ERROR] /D:/r/repro-wt/${rel}:[5,40] cannot find symbol\n[ERROR]   symbol:   method late_fee(int)\n[ERROR] /D:/r/repro-wt/module/jetty/src/main/java/a/B.java:[3,5] cannot find symbol\n`;
  assert.deepEqual(compileErrors(maven, rel), [`${rel}:[5,40] cannot find symbol\n    symbol:   method late_fee(int)`]);
  assert.deepEqual(compileErrors('[ERROR] /D:/r/module/jetty/src/main/java/a/B.java:[3,5] cannot find symbol\n', rel), []);
});
