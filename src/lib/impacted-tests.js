'use strict';
// Runs the existing tests that cover the changed sources, at the base and at
// the head of the PR, and compares: a test that passes on base and fails on
// head was broken by this change. Results join the machine evidence.
//
// This executes PR code (a build and its tests), like repro does: it is off
// unless enabled (ARW_RUN_IMPACTED_TESTS=on, or "run_impacted_tests": true on
// the repository). It runs in its own worktree with secrets removed from the
// environment, never in the frozen review checkout.
const fs = require('node:fs');
const path = require('node:path');
const { envInt, ensureDir } = require('./util');
const git = require('./git');
const { sandboxPython, gradleWrapper, defaultRunner } = require('./repro');
const confine = require('./confine');

function enabled(repoCfg) {
  return process.env.ARW_RUN_IMPACTED_TESTS === 'on' || Boolean(repoCfg && repoCfg.run_impacted_tests);
}

// The nearest directory at or above `rel` (inside the checkout) holding one
// of the build files; '' for the repository root.
function moduleOf(root, rel, buildFiles) {
  let dir = path.posix.dirname(rel);
  for (;;) {
    if (buildFiles.some((b) => fs.existsSync(path.join(root, dir === '.' ? '' : dir, b)))) return dir === '.' ? '' : dir;
    if (dir === '.' || dir === '' || dir === '/') return null;
    dir = path.posix.dirname(dir);
  }
}

function javaFqn(rel) {
  const m = /(?:^|\/)src\/test\/java\/(.+)\.java$/.exec(rel);
  return m ? m[1].replace(/\//g, '.') : null;
}

// Groups of tests that run with one command: { toolchain, module, tests: [{ path, selector }] }.
function planRuns(root, testPaths) {
  const groups = new Map();
  for (const rel of testPaths) {
    // File names come from the PR and become part of a shell command.
    if (!confine.isPlainRel(rel)) continue;
    let toolchain;
    let module;
    let selector;
    if (rel.endsWith('.java')) {
      selector = javaFqn(rel);
      if (!selector) continue;
      module = moduleOf(root, rel, ['pom.xml']);
      toolchain = 'maven';
      if (module === null) {
        module = moduleOf(root, rel, ['build.gradle', 'build.gradle.kts']);
        toolchain = 'gradle';
      }
      if (module === null) continue;
    } else if (rel.endsWith('.py')) {
      toolchain = 'pytest';
      module = '';
      selector = rel;
    } else continue;
    const key = `${toolchain}\0${module}`;
    if (!groups.has(key)) groups.set(key, { toolchain, module, tests: [] });
    groups.get(key).tests.push({ path: rel, selector });
  }
  return [...groups.values()];
}

function commandFor(group, junitFile) {
  const sel = group.tests.map((t) => t.selector);
  const offline = process.env.REPRO_MAVEN_OFFLINE === '1' ? ' -o' : '';
  if (group.toolchain === 'maven') return `mvn -B -q${offline} test -Dtest=${sel.join(',')} -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`;
  if (group.toolchain === 'gradle') return `${gradleWrapper()} test ${sel.map((s) => `--tests ${s}`).join(' ')}`;
  return `${sandboxPython()} -m pytest -q -p no:cacheprovider ${sel.join(' ')} --junitxml=${junitFile}`;
}

// Report files the build wrote, reached without links (the build is PR
// code: a report that is a link would make the host read another file).
function reportFiles(wt, cwd, group, junitFile) {
  const dir = { maven: path.join(cwd, 'target', 'surefire-reports'), gradle: path.join(cwd, 'build', 'test-results', 'test') }[group.toolchain];
  const files = dir ? confine.listConfined(wt, dir).filter((f) => /^TEST-.*\.xml$/.test(f)).map((f) => path.join(dir, f)) : [junitFile];
  return files.filter((f) => confine.isConfinedFile(wt, f));
}

function decode(s) {
  // Numeric references too: pytest writes newlines in messages as &#10;.
  return String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Per test case: { classname, name, status: pass|fail|error|skipped, message }.
function parseCases(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1];
    const inner = m[3] || '';
    const get = (n) => decode((attrs.match(new RegExp(`\\b${n}="([^"]*)"`)) || [])[1] || '');
    const bad = /<(failure|error)\b([^>]*)/.exec(inner);
    const status = bad ? (bad[1] === 'failure' ? 'fail' : 'error') : /<skipped\b/.test(inner) ? 'skipped' : 'pass';
    const message = bad ? decode((bad[2].match(/\bmessage="([^"]*)"/) || [])[1] || '').slice(0, 300) : null;
    out.push({ classname: get('classname'), name: get('name'), status, message });
  }
  return out;
}

// The worktree the tests run in, moved to `rev`; build output is kept
// between base and head (it is untracked and ignored by checkout).
function prepareWorktree(source, wt, rev) {
  if (!fs.existsSync(wt)) {
    git.git(source, ['worktree', 'prune'], { allowFail: true });
    git.git(source, ['worktree', 'add', '--detach', wt, rev]);
  } else {
    git.worktreeGit(source, wt, ['checkout', '--', '.'], { allowFail: true });
    git.worktreeGit(source, wt, ['checkout', '--detach', '--force', rev]);
  }
  return wt;
}

// One group at one revision: per test file, the cases that ran.
async function runGroup({ wt, group, rev, runner, logDir, label, timeoutMs }) {
  const cwd = path.join(wt, group.module);
  const present = group.tests.filter((t) => fs.existsSync(path.join(wt, t.path)));
  if (!present.length) return { ran: false, why: 'no test exists at this revision', byTest: {} };
  const junit = path.join(wt, '.arw-impacted-junit.xml');
  for (const f of reportFiles(wt, cwd, group, junit)) confine.removeConfined(wt, f);
  const command = commandFor({ ...group, tests: present }, junit);
  const res = await runner({ command, cwd, logFile: path.join(logDir, `${label}.log`), timeoutMs, toolchain: group.toolchain });
  const cases = reportFiles(wt, cwd, group, junit).flatMap((f) => parseCases(confine.readConfined(wt, f) || ''));
  // A case's result and the run's: passing cases count only when the run
  // completed and either succeeded or has a failing case explaining its
  // exit code. A timeout or a failed build step leaves passes unproven.
  const groupFailed = cases.some((c) => c.status === 'fail' || c.status === 'error');
  const runProblem = res.timed_out ? 'timeout' : res.spawn_error ? 'not_run' : res.exit_code !== 0 && !groupFailed ? 'command_failed' : null;
  const byTest = {};
  for (const t of present) {
    // pytest: classname is the dotted module (plus a class); JUnit: the class (nested ones add $Name).
    const id = group.toolchain === 'pytest' ? t.path.replace(/\.py$/, '').replace(/\//g, '.') : t.selector;
    const mine = cases.filter((c) => c.classname === id || c.classname.startsWith(`${id}.`) || c.classname.startsWith(`${id}$`));
    if (!mine.length) {
      byTest[t.path] = { status: runProblem || 'no_result', cases: 0, failing: [] };
      continue;
    }
    const caseStatus = mine.some((c) => c.status === 'fail' || c.status === 'error') ? 'fail' : mine.every((c) => c.status === 'skipped') ? 'skipped' : 'pass';
    byTest[t.path] = { status: caseStatus === 'pass' && runProblem ? runProblem : caseStatus, case_status: caseStatus, cases: mine.length, failing: mine.filter((c) => c.status === 'fail' || c.status === 'error').map((c) => ({ name: c.name, message: c.message })).slice(0, 5) };
  }
  return { ran: true, command, exit_code: res.exit_code, timed_out: Boolean(res.timed_out), spawn_error: res.spawn_error || null, elapsed_ms: res.elapsed_ms, byTest };
}

function verdict(base, head) {
  const b = base ? base.status : 'absent';
  const h = head ? head.status : 'absent';
  if (h === 'fail') return b === 'pass' ? 'newly_failing' : b === 'absent' ? 'new_test_failing' : b === 'fail' ? 'still_failing' : 'failing';
  if (h === 'pass') return b === 'fail' ? 'fixed' : b === 'absent' ? 'new_test_passing' : 'passing';
  return h;
}

async function runImpactedTests({ runDir, checkout, base, head, impact, repoCfg, runner = null, log = () => {} }) {
  runner = runner || defaultRunner();
  if (!enabled(repoCfg)) return null;
  const tests = [...new Set([...impact.sources.flatMap((s) => s.tests.map((t) => t.path)), ...impact.tests_changed])].slice(0, envInt('ARW_IMPACTED_TESTS_MAX', 10));
  if (!tests.length) return { ran: [], results: [], note: 'no impacted tests found' };
  const wt = path.join(runDir, 'tests-wt');
  const logDir = ensureDir(path.join(runDir, 'impacted-tests'));
  const timeoutMs = envInt('ARW_IMPACTED_TESTS_TIMEOUT_MS', 900000);
  const groups = planRuns(checkout, tests);
  const results = [];
  const ran = [];
  for (const rev of [['base', base], ['head', head]]) {
    prepareWorktree(checkout, wt, rev[1]);
    for (const [i, group] of groups.entries()) {
      log(`impacted tests: ${group.toolchain}${group.module ? ` in ${group.module}` : ''} at ${rev[0]} (${group.tests.length})`);
      const r = await runGroup({ wt, group, rev: rev[0], runner, logDir, label: `${rev[0]}-${i + 1}`, timeoutMs });
      ran.push({ rev: rev[0], toolchain: group.toolchain, module: group.module, ...r });
    }
  }
  for (const t of tests) {
    const at = (rev) => {
      const r = ran.find((x) => x.rev === rev && x.byTest && x.byTest[t]);
      return r ? r.byTest[t] : null;
    };
    results.push({ test: t, base: at('base'), head: at('head'), verdict: verdict(at('base'), at('head')) });
  }
  git.git(checkout, ['worktree', 'remove', '--force', wt], { allowFail: true });
  return { ran: ran.map(({ byTest, ...r }) => r), results };
}

function renderImpacted(r) {
  if (!r) return '';
  const lines = ['', '### Impacted tests run at base and head'];
  if (r.note) lines.push(`- ${r.note}`);
  const word = { newly_failing: 'FAILS ON HEAD, passed on base (broken by this change)', still_failing: 'fails on base and head', fixed: 'failed on base, passes on head', passing: 'passes on base and head', new_test_passing: 'new test, passes', new_test_failing: 'new test, FAILS', failing: 'fails on head' };
  for (const x of r.results) {
    lines.push(`- ${x.test}: ${word[x.verdict] || x.verdict}`);
    for (const f of (x.head && x.head.failing) || []) lines.push(`  - ${f.name}: ${String(f.message || '').replace(/\s+/g, ' ')}`);
  }
  for (const g of r.ran.filter((x) => x.ran && (x.timed_out || x.spawn_error))) lines.push(`- ${g.toolchain} at ${g.rev}: ${g.timed_out ? 'timed out' : g.spawn_error}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { runImpactedTests, renderImpacted, planRuns, parseCases, verdict, enabled };
