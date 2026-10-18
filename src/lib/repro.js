'use strict';
// Reproduction: a model proposes a test for a blocking finding; the harness
// writes it into a separate worktree, runs it twice on the reviewed head and
// once with the finding's fix applied, and judges from JUnit XML. Only an
// executed, repeated assertion failure makes a finding CONFIRMED (L3).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { sha256, writeJsonAtomic, readJson, readJsonIfExists, nowIso, ensureDir, envInt } = require('./util');
const git = require('./git');
const { loadContext, verifyContext, revisionDir, readInput } = require('./freeze');
const { validateAgainst, outputSchema } = require('./schema');
const { collapse } = require('./validate');
const confine = require('./confine');

const FINAL = new Set(['RED_PROVEN', 'GREEN_NOT_PROVEN', 'FLAKY', 'INCONCLUSIVE', 'ENVIRONMENT_BLOCKED']);
// With retry, a reproduction that never got to run its test is tried again
// (after the environment was fixed); a decided one is kept.
const RETRYABLE = new Set(['INCONCLUSIVE', 'ENVIRONMENT_BLOCKED']);
function reproDone(prior, { retry = false } = {}) {
  if (!prior || !FINAL.has(prior.status)) return false;
  return !(retry && RETRYABLE.has(prior.status));
}
const BLOCKING = new Set(['P1', 'P2']);

// ---------- toolchains ----------
function detectToolchain(dir, language) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (language === 'java') {
    if (has('pom.xml')) return 'maven';
    if (has('build.gradle') || has('build.gradle.kts') || has('gradlew')) return 'gradle';
    return null;
  }
  if (language === 'python') return 'pytest';
  return null;
}

function javaClass(selector) {
  return selector.split('#')[0];
}

// The Python that has pytest: ARW_PYTHON, else the first of python, python3,
// py (Windows launcher) that can import it. On some machines `python` is
// another tool's virtualenv without pytest.
let pythonCache = null;
function pythonCommand() {
  if (process.env.ARW_PYTHON) return process.env.ARW_PYTHON;
  if (pythonCache) return pythonCache;
  for (const cand of ['python', 'python3', 'py']) {
    try {
      execFileSync(cand, ['-c', 'import pytest'], { stdio: 'ignore', timeout: 20000, windowsHide: true });
      pythonCache = cand;
      return cand;
    } catch {
      /* next */
    }
  }
  pythonCache = 'python';
  return pythonCache;
}

// Inside the sandbox the command runs in a Linux image: its python and the
// POSIX Gradle wrapper, whatever the host is.
function sandboxPython() {
  return require('./sandbox').enabled() ? process.env.ARW_PYTHON || 'python' : pythonCommand();
}

function gradleWrapper() {
  return process.platform === 'win32' && !require('./sandbox').enabled() ? 'gradlew.bat' : './gradlew';
}

// The runner for PR code: with ARW_SANDBOX=bootstrap the review's prepared
// environment (runDir/sandbox-env.json; blocked when there is none), with
// ARW_SANDBOX=docker a container, else the host shell.
function defaultRunner(runDir = null, log = () => {}) {
  const sandbox = require('./sandbox');
  const choice = require('./host-env').runnerChoice({ mode: sandbox.mode(), daemonError: sandbox.mode() === 'host' ? null : sandbox.daemonError() });
  if (choice === 'host' && sandbox.mode() !== 'host') {
    log(`repro: the ${sandbox.mode()} sandbox is unavailable (${sandbox.daemonError()}); running on the host (ARW_SANDBOX_FALLBACK=off to refuse)`);
    return shellRunner;
  }
  if (sandbox.mode() === 'bootstrap') {
    const b = require('./bootstrap');
    return b.environmentRunner(runDir ? b.loadReviewEnvironment(runDir) : null);
  }
  return sandbox.enabled() ? sandbox.dockerRunner : shellRunner;
}

// What may be put into a shell command line from a test: a path or a
// selector, never shell syntax (; & | $ ` quotes spaces < > globs), never
// an option (leading -). Commands run through a shell (sh -c, cmd.exe).
const SHELL_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_./#:-]*$/;

function assertShellSafe(values) {
  for (const [name, v] of Object.entries(values)) {
    if (v != null && v !== '' && !SHELL_SAFE.test(String(v))) throw new Error(`unsafe ${name} for a shell command: ${JSON.stringify(v)}`);
  }
}

// The build module a test belongs to: the nearest directory above it, inside
// the worktree, with a build file. Maven and Gradle write a module's reports
// under that module, even when the build runs from the root.
const BUILD_FILES = { maven: ['pom.xml'], gradle: ['build.gradle', 'build.gradle.kts'] };
function moduleDir(toolchain, wt, testPath) {
  const root = path.resolve(wt);
  let dir = path.dirname(path.resolve(root, String(testPath || '')));
  if (dir !== root && !dir.startsWith(root + path.sep)) return root;
  for (; dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
    if ((BUILD_FILES[toolchain] || []).some((f) => fs.existsSync(path.join(dir, f)))) return dir;
  }
  return root;
}

// Returns { command, junit: absolute JUnit XML path }.
function commandFor(toolchain, test, wt, override, { offline: forceOffline = false, tool = null } = {}) {
  const cls = test.language === 'java' ? javaClass(test.selector) : null;
  const simple = cls ? cls.split('.').pop() : null;
  // Validation already allows only plain values; checked again here, where
  // model text meets the shell.
  assertShellSafe({ selector: test.selector, path: test.path, class: cls });
  const junitPytest = path.join(wt, '.arw-junit.xml');
  // A custom command without a known toolchain must write JUnit XML to {junit}.
  const mod = moduleDir(toolchain, wt, test.path);
  const junit = { maven: path.join(mod, 'target', 'surefire-reports', `TEST-${cls}.xml`), gradle: path.join(mod, 'build', 'test-results', 'test', `TEST-${cls}.xml`), pytest: junitPytest }[toolchain] || junitPytest;
  if (override) {
    // The report is read where the command was told to write it ({junit});
    // without {junit}, from the toolchain's usual place.
    return {
      command: override.replace(/\{selector\}/g, test.selector).replace(/\{class\}/g, cls || '').replace(/\{simple\}/g, simple || '').replace(/\{path\}/g, test.path).replace(/\{junit\}/g, junitPytest),
      junit: override.includes('{junit}') ? junitPytest : junit,
    };
  }
  // A program and its arguments: the sandbox runs it without a shell; the
  // host shell gets the same words joined (each one is shell-safe).
  const off = forceOffline || process.env.REPRO_MAVEN_OFFLINE === '1';
  const offline = off ? ['-o'] : [];
  const argvs = {
    maven: [tool || 'mvn', '-B', '-q', ...offline, 'test', `-Dtest=${test.selector}`, '-DfailIfNoTests=false', '-Dsurefire.failIfNoSpecifiedTests=false'],
    gradle: [tool || gradleWrapper(), 'test', '--tests', cls, ...(forceOffline ? ['--offline'] : [])],
    pytest: [sandboxPython(), '-m', 'pytest', '-q', '-p', 'no:cacheprovider', test.selector, `--junitxml=${junitPytest}`],
  };
  const argv = argvs[toolchain];
  return { command: argv && argv.join(' '), argv, junit };
}

// ---------- JUnit XML ----------
function decodeXml(s) {
  // Numeric references too: pytest writes newlines in messages as &#10;.
  return String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseJunit(xml) {
  const suites = [...String(xml).matchAll(/<testsuite\b([^>]*)>/g)].map((m) => m[1]);
  if (!suites.length) return null;
  const attr = (s, name) => Number((s.match(new RegExp(`\\b${name}="(\\d+)"`)) || [])[1] || 0);
  const out = { tests: 0, failures: 0, errors: 0, skipped: 0, message: null };
  for (const s of suites) {
    out.tests += attr(s, 'tests');
    out.failures += attr(s, 'failures');
    out.errors += attr(s, 'errors');
    out.skipped += attr(s, 'skipped');
  }
  const first = String(xml).match(/<(failure|error)\b([^>]*)>/);
  if (first) {
    const msg = (first[2].match(/\bmessage="([^"]*)"/) || [])[1] || '';
    out.message = `${first[1]}: ${decodeXml(msg).slice(0, 400)}`;
  }
  return out;
}

function classify(run) {
  if (run.spawn_error) return 'environment';
  if (run.timed_out) return 'timeout';
  if (!run.junit) return run.exit_code === 0 ? 'no_report' : 'build_error';
  if (run.junit.tests === 0) return 'no_tests';
  if (run.junit.failures > 0) return 'red';
  if (run.junit.errors > 0) return 'error';
  if (run.junit.skipped >= run.junit.tests) return 'skipped';
  // GREEN needs the test to pass AND the command to succeed: a passing report
  // next to a failed build step (another task, a plugin) is not a clean pass.
  if (run.exit_code !== 0 && run.exit_code != null) return 'command_failed';
  return 'green';
}

// ---------- running ----------
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|_PAT$|API_KEY|^GH_|^GITHUB_|^JIRA_|^CONFLUENCE_|^CODEX_|^OPENAI|^ANTHROPIC/i;

function scrubbedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
}

// Merges extra variables, matching an existing key case-insensitively
// (Windows spells it "Path").
function withEnv(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const existing = Object.keys(out).find((x) => x.toUpperCase() === k.toUpperCase());
    if (existing && existing !== k) delete out[existing];
    out[k] = v;
  }
  return out;
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

// Default runner: the command runs in the repro worktree with secrets removed
// from the environment. Model-written tests execute PR code, as any build of
// the PR would; keep REPRO off for repositories you do not trust.
function shellRunner({ command, cwd, logFile, timeoutMs, env: extraEnv = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `$ ${command}\n`);
    let timedOut = false;
    let child;
    try {
      child = spawn(command, { cwd, shell: true, env: withEnv(scrubbedEnv(), extraEnv), stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (err) {
      fs.closeSync(out);
      resolve({ exit_code: null, spawn_error: err.message, elapsed_ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ exit_code: null, spawn_error: err.message, elapsed_ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.closeSync(out);
      } catch {
        /* closed */
      }
      // 127 (sh) / 9009 (cmd): the tool is not installed.
      const missing = code === 127 || code === 9009;
      resolve({ exit_code: code, timed_out: timedOut, spawn_error: missing ? 'command not found' : null, elapsed_ms: Date.now() - started });
    });
  });
}

// ---------- worktree ----------
function ensureReproWorktree(runDir, context) {
  const wt = path.join(runDir, 'repro-wt');
  const { checkout, head_sha: head } = context.source;
  if (fs.existsSync(wt)) {
    const current = git.worktreeGit(checkout, wt, ['rev-parse', 'HEAD'], { allowFail: true });
    if (current && current.trim() === head) {
      git.worktreeGit(checkout, wt, ['checkout', '--', '.'], { allowFail: true });
      return wt;
    }
    git.git(checkout, ['worktree', 'remove', '--force', wt], { allowFail: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
  git.git(checkout, ['worktree', 'prune'], { allowFail: true });
  git.git(checkout, ['worktree', 'add', '--detach', wt, head]);
  return wt;
}

function trackedClean(checkout, wt) {
  return git.worktreeGit(checkout, wt, ['diff', '--quiet', 'HEAD'], { allowFail: true }) !== null;
}

// ---------- fix application ----------
// Apply fix.asis -> fix.tobe to the cited file: exact text first, then a
// unique match of the trimmed lines, re-indented to the matched block.
function applyFix(wt, finding) {
  if (finding.fix.kind !== 'code_change') return { applied: false, reason: 'not a code change' };
  const files = [...new Set(finding.evidence.filter((e) => e.kind === 'code' && e.revision !== 'base').map((e) => e.path))];
  for (const rel of files) {
    const file = path.join(wt, rel);
    // PR code has run in this worktree: the file may now be a link out of it.
    if (!confine.isConfinedFile(wt, file)) continue;
    const text = confine.readConfined(wt, file);
    const asis = finding.fix.asis.replace(/\r\n/g, '\n');
    const tobe = finding.fix.tobe.replace(/\r\n/g, '\n');
    const at = text.indexOf(asis);
    if (at >= 0 && text.indexOf(asis, at + 1) < 0) {
      confine.rewriteFile(wt, file, text.slice(0, at) + tobe + text.slice(at + asis.length));
      return { applied: true, file: rel, how: 'exact' };
    }
    const lines = text.split('\n');
    const want = asis.split('\n').map((l) => l.trim()).filter(Boolean);
    const hits = [];
    for (let i = 0; i + want.length <= lines.length; i += 1) {
      if (want.every((w, k) => lines[i + k].trim() === w)) hits.push(i);
    }
    if (hits.length === 1) {
      const i = hits[0];
      const indent = lines[i].match(/^\s*/)[0];
      const tl = tobe.split('\n');
      const minIndent = Math.min(...tl.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
      const replaced = tl.map((l) => (l.trim() ? indent + l.slice(minIndent) : l));
      lines.splice(i, want.length, ...replaced);
      confine.rewriteFile(wt, file, lines.join('\n'));
      return { applied: true, file: rel, how: 'lines' };
    }
  }
  return { applied: false, reason: 'fix.asis not found exactly once in the cited files' };
}

// ---------- test validation ----------
// Names a reproduction test must call: functions/methods named in the
// finding's code evidence and fix, and the declaration enclosing that code.
const NOT_TARGETS = new Set(['if', 'for', 'while', 'switch', 'return', 'print', 'assert', 'len', 'int', 'str', 'float', 'range', 'def', 'new', 'catch', 'super', 'this', 'self', 'list', 'dict', 'set', 'min', 'max', 'sum', 'abs', 'round', 'isinstance', 'Exception', 'BigDecimal', 'String', 'Integer', 'Decimal', 'equals', 'valueOf', 'compareTo', 'add', 'get']);
function reproTargetNames(finding, context) {
  const names = new Set();
  const code = (finding.evidence || []).filter((e) => e.kind === 'code');
  const texts = [...code.map((e) => e.quote), finding.fix && finding.fix.kind === 'code_change' ? finding.fix.asis : ''];
  for (const t of texts) for (const m of String(t || '').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (m[1].length >= 3 && !NOT_TARGETS.has(m[1])) names.add(m[1]);
  if (context && context.source) {
    const { indexFile, enclosing } = require('./impact');
    for (const e of code) {
      const text = git.showFile(context.source.checkout, e.revision === 'base' ? context.source.base_sha : context.source.head_sha, e.path);
      const idx = text == null ? null : indexFile(e.path, text);
      const m = idx && enclosing(idx, e.start_line);
      if (m && !NOT_TARGETS.has(m.name)) names.add(m.name);
    }
  }
  return [...names];
}

const ALWAYS_FAILS = /^\s*assert\s+(False|0|None)\s*(,|$)|\bassert(True|That)\s*\(\s*false\s*\)|\bfail\s*\(\s*(["'][^"']*["'])?\s*\)\s*;|\bpytest\.fail\s*\(|^\s*raise\s+AssertionError\b/m;

function validateReproTest(candidate, { context, finding = null }) {
  const errors = validateAgainst('repro', candidate, 'reproTest');
  if (errors.length) return errors;
  // A test that fails whatever the code does proves nothing about the defect.
  if (ALWAYS_FAILS.test(candidate.content)) errors.push('$.content: the test always fails (assert False, fail(), raise AssertionError): it must assert the expected result of the code under test');
  if (finding) {
    const targets = reproTargetNames(finding, context);
    const calls = (n) => new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(candidate.content);
    if (targets.length && !targets.some(calls)) errors.push(`$.content: the test does not call the code the finding is about (one of: ${targets.join(', ')})`);
  }
  const p = candidate.path.replace(/\\/g, '/');
  // The path and selector reach a shell command line and the host
  // filesystem: plain characters only.
  if (p !== candidate.path || path.isAbsolute(p) || !confine.isPlainRel(p)) return ['$.path: repository-relative, forward slashes, no "..", each part only letters, digits, _ . - (not starting with . or -)'];
  if (git.showFile(context.source.checkout, context.source.head_sha, p) != null) errors.push(`$.path: ${p} already exists; write a NEW test file`);
  if (candidate.language === 'java') {
    const m = p.match(/(^|\/)src\/test\/java\/(.+)\/([A-Za-z_]\w*)\.java$/);
    if (!m) errors.push('$.path: a Java test lives under src/test/java/<package path>/<ClassName>.java');
    else {
      const pkg = m[2].replace(/\//g, '.');
      const cls = `${pkg}.${m[3]}`;
      if (javaClass(candidate.selector) !== cls || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*(#[A-Za-z_]\w*)?$/.test(candidate.selector)) errors.push(`$.selector: must be "${cls}" (optionally "#method")`);
      if (!new RegExp(`^\\s*package\\s+${pkg.replace(/\./g, '\\.')}\\s*;`, 'm').test(candidate.content)) errors.push(`$.content: must declare "package ${pkg};"`);
      if (!new RegExp(`\\bclass\\s+${m[3]}\\b`).test(candidate.content)) errors.push(`$.content: must declare class ${m[3]}`);
    }
  } else {
    if (!/(^|\/)(test_\w+|\w+_test)\.py$/.test(p)) errors.push('$.path: a pytest file is named test_<name>.py or <name>_test.py');
    if (!(candidate.selector === p || /^(::[A-Za-z_]\w*)+$/.test(candidate.selector.startsWith(p) ? candidate.selector.slice(p.length) : '!'))) errors.push(`$.selector: the path, optionally with ::names, e.g. "${p}::test_name"`);
  }
  if (!/assert/i.test(candidate.content)) errors.push('$.content: the test must assert the expected behaviour');
  return errors;
}

// ---------- records ----------
function reproDir(runDir, context) {
  return path.join(revisionDir(runDir, context.context_id), 'repro');
}

// Status from the runs, recomputed by the validator, never trusted from disk.
// The process outcome, written as the last line of a run's log.
function trailer(res) {
  return `[arw] exit_code=${res.exit_code == null ? 'null' : res.exit_code} timed_out=${Boolean(res.timed_out)} spawn_error=${JSON.stringify(res.spawn_error || null)}`;
}

function parseTrailer(text) {
  const m = /\[arw\] exit_code=(-?\d+|null) timed_out=(true|false) spawn_error=(.*)\s*$/.exec(String(text));
  if (!m) return null;
  let spawnError = null;
  try {
    spawnError = JSON.parse(m[3]);
  } catch {
    return null;
  }
  return { exit_code: m[1] === 'null' ? null : Number(m[1]), timed_out: m[2] === 'true', spawn_error: spawnError };
}

// What shows the test fails because of THIS defect: the finding's fix makes
// it pass ('fix'), or it passes on the base commit ('base', a regression).
// Without either, a stable failure is only REPRODUCED.
function controlOf(runs, fix) {
  if (fix && fix.verified === true && (runs || []).some((r) => r.phase === 'fix' && r.status === 'green')) return 'fix';
  if ((runs || []).some((r) => r.phase === 'base' && r.status === 'green')) return 'base';
  return null;
}

function statusFromRuns(runs) {
  const head = runs.filter((r) => r.phase.startsWith('head'));
  if (!head.length) return 'INCONCLUSIVE';
  if (head.some((r) => r.status === 'environment')) return 'ENVIRONMENT_BLOCKED';
  const s = head.map((r) => r.status);
  if (s.every((x) => x === 'red')) return s.length >= 2 ? 'RED_PROVEN' : 'INCONCLUSIVE';
  if (s.every((x) => x === 'green')) return 'GREEN_NOT_PROVEN';
  if (s.includes('red') && s.includes('green')) return 'FLAKY';
  return 'INCONCLUSIVE';
}

// Model-free check of every repro record bound to this context: artifacts
// must exist with their recorded hashes, and the status must follow from the
// recorded runs. Returns { records: Map(finding_id -> record), errors }.
function loadReproRecords(runDir, context) {
  const dir = reproDir(runDir, context);
  const records = new Map();
  const errors = [];
  if (!fs.existsSync(dir)) return { records, errors };
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const rec = readJsonIfExists(path.join(dir, name));
    if (!rec || !rec.finding_id) continue;
    const bad = (msg) => errors.push(`repro ${rec.finding_id}: ${msg}`);
    if (rec.context_digest !== context.context_digest) {
      bad('bound to another context');
      continue;
    }
    const artifacts = [rec.test && rec.test.artifact, ...(rec.runs || []).flatMap((r) => [r.log, r.junit_xml])].filter(Boolean);
    const broken = artifacts.find((a) => {
      const f = path.join(revisionDir(runDir, context.context_id), a.path);
      return !fs.existsSync(f) || sha256(fs.readFileSync(f)) !== a.sha256;
    });
    if (broken) {
      bad(`artifact ${broken.path} is missing or changed`);
      continue;
    }
    // Re-derive every run's status from the raw evidence (log trailer and
    // JUnit XML), then the record's verdict and control from those.
    const rdir = revisionDir(runDir, context.context_id);
    let raw = true;
    const derived = (rec.runs || []).map((r) => {
      const outcome = parseTrailer(fs.readFileSync(path.join(rdir, r.log.path), 'utf8'));
      if (!outcome) {
        raw = false;
        return r;
      }
      if (r.junit_xml) {
        const f = path.join(rdir, r.junit_xml.path);
        if (!fs.existsSync(f) || sha256(fs.readFileSync(f)) !== r.junit_xml.sha256) {
          raw = false;
          return r;
        }
      }
      const junit = r.junit_xml ? parseJunit(fs.readFileSync(path.join(rdir, r.junit_xml.path), 'utf8')) : null;
      return { ...r, status: classify({ ...outcome, junit }) };
    });
    if (!raw) {
      bad('a run has no raw evidence (log trailer or JUnit XML); run the reproduction again');
      continue;
    }
    const mismatch = derived.find((d, i) => d.status !== rec.runs[i].status);
    if (mismatch) {
      bad(`run ${mismatch.phase} does not follow from its raw evidence (${rec.runs.find((r) => r.phase === mismatch.phase).status} recorded, ${mismatch.status} in the artifacts)`);
      continue;
    }
    const expected = rec.status === 'ENVIRONMENT_BLOCKED' && !(rec.runs || []).length ? 'ENVIRONMENT_BLOCKED' : statusFromRuns(derived);
    if (rec.status !== expected) {
      bad(`status ${rec.status} does not follow from its runs (${expected})`);
      continue;
    }
    const fixRun = derived.find((r) => r.phase === 'fix');
    if (rec.fix && rec.fix.verified !== null && rec.fix.verified !== Boolean(fixRun && fixRun.status === 'green')) {
      bad('fix.verified does not follow from the fix run');
      continue;
    }
    records.set(rec.finding_id, { ...rec, control: controlOf(derived, rec.fix) });
  }
  return { records, errors };
}

// ---------- orchestration ----------
// targets: [{ finding, cluster_id }] — blocking, one per cluster. Withdrawn
// findings are included: a model's withdrawal must not decide that the
// harness never runs the test that could prove it wrong.
function reproTargets(validation, findingsById) {
  const done = new Set();
  const targets = [];
  const metas = [...validation.findings].filter((m) => BLOCKING.has(m.severity)).sort((a, b) => (a.canonical === b.canonical ? 0 : a.canonical ? -1 : 1));
  for (const m of metas) {
    const key = m.cluster_id || m.id;
    if (done.has(key)) continue;
    const finding = findingsById.get(m.id);
    if (!finding) continue;
    done.add(key);
    targets.push({ finding, cluster_id: m.cluster_id });
  }
  return targets;
}

async function runRepro({ runDir, executor, models = {}, runner = null, log = () => {}, testCommand, prompts, runModelJob, makeSources, retry = false }) {
  const execRun = runner || defaultRunner(runDir, log);
  // The host runs PR code itself: prepare it (JDK, dependencies at base).
  const onHost = !runner && execRun === shellRunner && process.env.ARW_HOST_PREP !== 'off';
  const hostEnv = require('./host-env');
  const hostReady = new Map();
  const context = loadContext(runDir);
  const drift = verifyContext(runDir, context);
  if (drift.length) throw new Error(`context no longer holds: ${drift.join('; ')}`);
  const rdir = revisionDir(runDir, context.context_id);
  const validation = readJson(path.join(rdir, 'validation.json'));
  const findingsById = new Map();
  for (const job of validation.jobs) {
    if (job.status !== 'EXECUTED_PASS') continue;
    const packet = readJsonIfExists(path.join(rdir, 'packets', job.role, `${job.unit_id}.json`));
    if (packet) for (const f of packet.findings) findingsById.set(f.id, f);
  }
  const targets = reproTargets(validation, findingsById);
  const outDir = ensureDir(reproDir(runDir, context));
  const existing = loadReproRecords(runDir, context).records;
  const reviewItems = JSON.parse(readInput(runDir, context, 'review-items') || '[]');
  const timeoutMs = envInt('REPRO_TIMEOUT_MS', 15 * 60 * 1000);
  const receiptsFile = path.join(rdir, 'receipts.json');
  const receipts = readJsonIfExists(receiptsFile, {});
  const env = { runDir, context, executor, log, receipts, flushReceipts: () => writeJsonAtomic(receiptsFile, receipts), sources: makeSources(runDir, context) };
  const results = [];
  if (!targets.length) log('repro: no blocking finding to reproduce');
  let wt = null;

  for (const { finding, cluster_id } of targets) {
    const prior = existing.get(finding.id);
    if (reproDone(prior, { retry })) {
      results.push(prior);
      continue;
    }
    const recordFile = path.join(outDir, `${finding.id}.json`);
    const base = { schema_version: '1.0', context_digest: context.context_digest, finding_id: finding.id, cluster_id: cluster_id || null, at: nowIso() };
    const items = reviewItems.filter((i) => (finding.items || []).includes(i.id));
    log(`repro ${finding.id}: writing a test`);
    const gen = await runModelJob(env, {
      label: `repro-${finding.id}`,
      outRel: `repro/${finding.id}.test.json`,
      model: models.repro || models.review,
      effort: models.effort,
      outputSchema: outputSchema('repro', 'reproTest'),
      buildPrompt: (repair) => prompts.reproPrompt(runDir, context, { finding, items, repair }),
      validate: (c) => validateReproTest(c, { context, finding }),
    });
    if (gen.status !== 'EXECUTED_PASS') {
      const rec = { ...base, status: gen.status === 'ENVIRONMENT_BLOCKED' ? 'ENVIRONMENT_BLOCKED' : 'INCONCLUSIVE', reason: `no valid test: ${(gen.errors || [])[0] || gen.status}`, runs: [] };
      writeJsonAtomic(recordFile, rec);
      results.push(rec);
      continue;
    }
    const test = gen.value;
    if (!wt) wt = ensureReproWorktree(runDir, context);
    const toolchain = detectToolchain(wt, test.language);
    if (!toolchain && !testCommand) {
      const rec = { ...base, status: 'ENVIRONMENT_BLOCKED', reason: `no ${test.language} build tool detected (pom.xml, build.gradle) and no test_command configured`, runs: [] };
      writeJsonAtomic(recordFile, rec);
      results.push(rec);
      continue;
    }
    // Keep a hash-bound copy of the test the harness ran.
    ensureDir(path.join(outDir, finding.id));
    const artifactRel = `repro/${finding.id}/${path.basename(test.path)}`;
    fs.writeFileSync(path.join(rdir, artifactRel), test.content);
    const testInfo = { language: test.language, path: test.path, selector: test.selector, fails_because: test.fails_because, artifact: { path: artifactRel, sha256: sha256(test.content) } };
    // Host-side file access in the worktree goes through confine: PR code
    // (a tracked symlink, or one a build made) can point a path out of it.
    const target = path.join(wt, test.path);
    let hostRun = null;
    if (onHost && !testCommand && (toolchain === 'maven' || toolchain === 'gradle')) {
      if (!hostReady.has(toolchain)) {
        const plan = hostEnv.hostPlan({ wt, toolchain });
        let ready = plan.ok ? null : plan.reason;
        if (!ready) {
          log(`repro: preparing the host (Java ${plan.java}, dependencies at base)`);
          const deps = await hostEnv.prepareDependencies({ checkout: context.source.checkout, base: context.source.base_sha, toolchain, plan, runner: shellRunner, logDir: outDir });
          if (!deps.ok) ready = deps.reason;
        }
        hostReady.set(toolchain, ready ? { ok: false, reason: ready } : { ok: true, plan });
      }
      const state = hostReady.get(toolchain);
      if (!state.ok) {
        const rec = { ...base, status: 'ENVIRONMENT_BLOCKED', reason: `host: ${state.reason}`, runs: [] };
        writeJsonAtomic(recordFile, rec);
        results.push(rec);
        continue;
      }
      hostRun = state.plan;
    }
    const { command, argv, junit } = commandFor(toolchain, test, wt, testCommand, { offline: Boolean(hostRun), tool: hostRun ? hostRun.tool : null });
    const runs = [];
    let runtimeFetched = false;
    const runPhase = async (phase) => {
      confine.removeConfined(wt, junit);
      const logRel = `repro/${finding.id}/${phase}.log`;
      const logFile = path.join(rdir, logRel);
      let res = await execRun({ command, argv, cwd: wt, logFile, timeoutMs, test, phase, toolchain: toolchain || 'custom', ...(hostRun ? { env: hostRun.env } : {}) });
      // On a prepared host, a test runtime the base never needed (the PR
      // added JUnit 5 tests to a JUnit 4 module) is fetched outside the
      // project, then the phase runs once more.
      if (hostRun && toolchain === 'maven' && res.exit_code !== 0 && !runtimeFetched) {
        const missing = hostEnv.testRuntimeArtifacts(fs.readFileSync(logFile, 'utf8'));
        if (missing.length) {
          runtimeFetched = true;
          log(`repro ${finding.id}: fetching the test runtime ${missing.join(', ')}`);
          const got = await hostEnv.fetchArtifacts({ artifacts: missing, plan: hostRun, runner: shellRunner, dir: path.join(os.tmpdir(), `arw-fetch-${process.pid}`) });
          if (got.ok) {
            notes.push(`fetched the test runtime ${missing.join(', ')} before ${phase}`);
            res = await execRun({ command, argv, cwd: wt, logFile, timeoutMs, test, phase, toolchain: toolchain || 'custom', env: hostRun.env });
          } else notes.push(got.reason);
        }
      }
      // Raw evidence, hash-bound: the log ends with the process outcome and
      // the JUnit XML is kept as written. Validation re-derives the status
      // from these, never from the record's own fields.
      fs.appendFileSync(logFile, `\n${trailer(res)}\n`);
      const xml = confine.readConfined(wt, junit);
      const junitData = xml ? parseJunit(xml) : null;
      const run = { phase, command, exit_code: res.exit_code, elapsed_ms: res.elapsed_ms, timed_out: Boolean(res.timed_out), spawn_error: res.spawn_error || null, junit: junitData, environment: res.environment || null };
      run.status = classify(run);
      run.log = { path: logRel, sha256: sha256(fs.readFileSync(logFile)) };
      if (xml) {
        const xmlRel = `repro/${finding.id}/${phase}.junit.xml`;
        fs.writeFileSync(path.join(rdir, xmlRel), xml);
        run.junit_xml = { path: xmlRel, sha256: sha256(xml) };
      }
      runs.push(run);
      log(`repro ${finding.id}: ${phase} -> ${run.status}${junitData && junitData.message ? ` (${junitData.message.slice(0, 120)})` : ''}`);
      return run;
    };
    let fix = null;
    const notes = [];
    try {
      if (!trackedClean(context.source.checkout, wt)) throw new Error('repro worktree has modified tracked files');
      try {
        confine.writeNewFile(wt, test.path, test.content);
      } catch (err) {
        if (!(err instanceof confine.ConfinementError)) throw err;
        const rec = { ...base, test: testInfo, status: 'ENVIRONMENT_BLOCKED', reason: `cannot place the test in the worktree: ${err.message}`, runs: [] };
        writeJsonAtomic(recordFile, rec);
        results.push(rec);
        continue;
      }
      const first = await runPhase('head-1');
      // An assertion failure must repeat before it counts; one run proves little.
      if (first.status === 'red') await runPhase('head-2');
      const status = statusFromRuns(runs);
      if (status === 'RED_PROVEN') {
        // Control 1, broken/fixed: the finding's own fix makes the test pass.
        const applied = applyFix(wt, finding);
        fix = { ...applied, status: null, verified: null };
        if (applied.applied) {
          const fixed = await runPhase('fix');
          fix.status = fixed.status;
          fix.verified = fixed.status === 'green';
        }
        // Control 2, regression: the same test passes on the base commit.
        if (!fix.verified) {
          git.worktreeGit(context.source.checkout, wt, ['checkout', '--', '.'], { allowFail: true });
          confine.removeConfined(wt, target);
          git.worktreeGit(context.source.checkout, wt, ['checkout', '--detach', '--force', context.source.base_sha]);
          let placed = true;
          try {
            confine.writeNewFile(wt, test.path, test.content);
          } catch (err) {
            if (!(err instanceof confine.ConfinementError)) throw err;
            placed = false;
            notes.push(`base control not run: ${err.message}`);
            log(`repro ${finding.id}: base control not run: ${err.message}`);
          }
          if (placed) await runPhase('base');
        }
      }
    } finally {
      confine.removeConfined(wt, target);
      git.worktreeGit(context.source.checkout, wt, ['checkout', '--', '.'], { allowFail: true });
      git.worktreeGit(context.source.checkout, wt, ['checkout', '--detach', '--force', context.source.head_sha], { allowFail: true });
    }
    const rec = { ...base, test: testInfo, toolchain: toolchain || 'custom', runs, status: statusFromRuns(runs), fix, control: controlOf(runs, fix), ...(notes.length ? { notes } : {}) };
    writeJsonAtomic(recordFile, rec);
    results.push(rec);
  }
  return results;
}

module.exports = { reproDone, runRepro, loadReproRecords, validateReproTest, reproTargetNames, applyFix, parseJunit, classify, statusFromRuns, controlOf, trailer, parseTrailer, detectToolchain, commandFor, shellRunner, scrubbedEnv, reproTargets, pythonCommand, sandboxPython, gradleWrapper, defaultRunner };
