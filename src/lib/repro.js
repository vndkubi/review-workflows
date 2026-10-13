'use strict';
// Reproduction: a model proposes a test for a blocking finding; the harness
// writes it into a separate worktree, runs it twice on the reviewed head and
// once with the finding's fix applied, and judges from JUnit XML. Only an
// executed, repeated assertion failure makes a finding CONFIRMED (L3).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { sha256, writeJsonAtomic, readJson, readJsonIfExists, nowIso, ensureDir, envInt } = require('./util');
const git = require('./git');
const { loadContext, verifyContext, revisionDir, readInput } = require('./freeze');
const { validateAgainst, outputSchema } = require('./schema');
const { collapse } = require('./validate');

const FINAL = new Set(['RED_PROVEN', 'GREEN_NOT_PROVEN', 'FLAKY', 'INCONCLUSIVE', 'ENVIRONMENT_BLOCKED']);
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

// Returns { command, junit: absolute JUnit XML path }.
function commandFor(toolchain, test, wt, override) {
  const cls = test.language === 'java' ? javaClass(test.selector) : null;
  const simple = cls ? cls.split('.').pop() : null;
  const junitPytest = path.join(wt, '.arw-junit.xml');
  // A custom command without a known toolchain must write JUnit XML to {junit}.
  const junit = { maven: path.join(wt, 'target', 'surefire-reports', `TEST-${cls}.xml`), gradle: path.join(wt, 'build', 'test-results', 'test', `TEST-${cls}.xml`), pytest: junitPytest }[toolchain] || junitPytest;
  if (override) {
    return {
      command: override.replace(/\{selector\}/g, test.selector).replace(/\{class\}/g, cls || '').replace(/\{simple\}/g, simple || '').replace(/\{path\}/g, test.path).replace(/\{junit\}/g, junitPytest),
      junit,
    };
  }
  const offline = process.env.REPRO_MAVEN_OFFLINE === '1' ? ' -o' : '';
  const commands = {
    maven: `mvn -B -q${offline} test -Dtest=${test.selector} -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`,
    gradle: `${process.platform === 'win32' ? 'gradlew.bat' : './gradlew'} test --tests ${cls}`,
    pytest: `${pythonCommand()} -m pytest -q -p no:cacheprovider ${test.selector} --junitxml=${junitPytest}`,
  };
  return { command: commands[toolchain], junit };
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
  return 'green';
}

// ---------- running ----------
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|_PAT$|API_KEY|^GH_|^GITHUB_|^JIRA_|^CONFLUENCE_|^CODEX_|^OPENAI|^ANTHROPIC/i;

function scrubbedEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
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
function shellRunner({ command, cwd, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `$ ${command}\n`);
    let timedOut = false;
    let child;
    try {
      child = spawn(command, { cwd, shell: true, env: scrubbedEnv(), stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
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
    const current = git.git(wt, ['rev-parse', 'HEAD'], { allowFail: true });
    if (current && current.trim() === head) {
      git.git(wt, ['checkout', '--', '.'], { allowFail: true });
      return wt;
    }
    git.git(checkout, ['worktree', 'remove', '--force', wt], { allowFail: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
  git.git(checkout, ['worktree', 'prune'], { allowFail: true });
  git.git(checkout, ['worktree', 'add', '--detach', wt, head]);
  return wt;
}

function trackedClean(wt) {
  return git.git(wt, ['diff', '--quiet', 'HEAD'], { allowFail: true }) !== null;
}

// ---------- fix application ----------
// Apply fix.asis -> fix.tobe to the cited file: exact text first, then a
// unique match of the trimmed lines, re-indented to the matched block.
function applyFix(wt, finding) {
  if (finding.fix.kind !== 'code_change') return { applied: false, reason: 'not a code change' };
  const files = [...new Set(finding.evidence.filter((e) => e.kind === 'code' && e.revision !== 'base').map((e) => e.path))];
  for (const rel of files) {
    const file = path.join(wt, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const asis = finding.fix.asis.replace(/\r\n/g, '\n');
    const tobe = finding.fix.tobe.replace(/\r\n/g, '\n');
    const at = text.indexOf(asis);
    if (at >= 0 && text.indexOf(asis, at + 1) < 0) {
      fs.writeFileSync(file, text.slice(0, at) + tobe + text.slice(at + asis.length));
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
      fs.writeFileSync(file, lines.join('\n'));
      return { applied: true, file: rel, how: 'lines' };
    }
  }
  return { applied: false, reason: 'fix.asis not found exactly once in the cited files' };
}

// ---------- test validation ----------
function validateReproTest(candidate, { context }) {
  const errors = validateAgainst('repro', candidate, 'reproTest');
  if (errors.length) return errors;
  const p = candidate.path.replace(/\\/g, '/');
  if (p !== candidate.path || path.isAbsolute(p) || p.split('/').includes('..')) return ['$.path: repository-relative, forward slashes, no ".."'];
  if (git.showFile(context.source.checkout, context.source.head_sha, p) != null) errors.push(`$.path: ${p} already exists; write a NEW test file`);
  if (candidate.language === 'java') {
    const m = p.match(/(^|\/)src\/test\/java\/(.+)\/([A-Za-z_]\w*)\.java$/);
    if (!m) errors.push('$.path: a Java test lives under src/test/java/<package path>/<ClassName>.java');
    else {
      const pkg = m[2].replace(/\//g, '.');
      const cls = `${pkg}.${m[3]}`;
      if (javaClass(candidate.selector) !== cls) errors.push(`$.selector: must be "${cls}" (optionally "#method")`);
      if (!new RegExp(`^\\s*package\\s+${pkg.replace(/\./g, '\\.')}\\s*;`, 'm').test(candidate.content)) errors.push(`$.content: must declare "package ${pkg};"`);
      if (!new RegExp(`\\bclass\\s+${m[3]}\\b`).test(candidate.content)) errors.push(`$.content: must declare class ${m[3]}`);
    }
  } else {
    if (!/(^|\/)(test_\w+|\w+_test)\.py$/.test(p)) errors.push('$.path: a pytest file is named test_<name>.py or <name>_test.py');
    if (!candidate.selector.startsWith(p)) errors.push(`$.selector: must start with the path, e.g. "${p}::test_name"`);
  }
  if (!/assert/i.test(candidate.content)) errors.push('$.content: the test must assert the expected behaviour');
  return errors;
}

// ---------- records ----------
function reproDir(runDir, context) {
  return path.join(revisionDir(runDir, context.context_id), 'repro');
}

// Status from the runs, recomputed by the validator, never trusted from disk.
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
    const artifacts = [rec.test && rec.test.artifact, ...(rec.runs || []).map((r) => r.log)].filter(Boolean);
    const broken = artifacts.find((a) => {
      const f = path.join(revisionDir(runDir, context.context_id), a.path);
      return !fs.existsSync(f) || sha256(fs.readFileSync(f)) !== a.sha256;
    });
    if (broken) {
      bad(`artifact ${broken.path} is missing or changed`);
      continue;
    }
    const expected = rec.status === 'ENVIRONMENT_BLOCKED' && !(rec.runs || []).length ? 'ENVIRONMENT_BLOCKED' : statusFromRuns(rec.runs || []);
    if (rec.status !== expected) {
      bad(`status ${rec.status} does not follow from its runs (${expected})`);
      continue;
    }
    records.set(rec.finding_id, rec);
  }
  return { records, errors };
}

// ---------- orchestration ----------
// targets: [{ finding, cluster_id }] — blocking, not withdrawn, one per cluster.
function reproTargets(validation, findingsById) {
  const done = new Set();
  const targets = [];
  const metas = [...validation.findings].filter((m) => BLOCKING.has(m.severity) && m.state !== 'withdrawn').sort((a, b) => (a.canonical === b.canonical ? 0 : a.canonical ? -1 : 1));
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

async function runRepro({ runDir, executor, models = {}, runner = shellRunner, log = () => {}, testCommand, prompts, runModelJob, makeSources }) {
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
    if (prior && FINAL.has(prior.status)) {
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
      validate: (c) => validateReproTest(c, { context }),
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
    const target = path.join(wt, test.path);
    ensureDir(path.dirname(target));
    const { command, junit } = commandFor(toolchain, test, wt, testCommand);
    const runs = [];
    const runPhase = async (phase) => {
      if (fs.existsSync(junit)) fs.rmSync(junit);
      const logRel = `repro/${finding.id}/${phase}.log`;
      const res = await runner({ command, cwd: wt, logFile: path.join(rdir, logRel), timeoutMs, test, phase });
      const junitData = fs.existsSync(junit) ? parseJunit(fs.readFileSync(junit, 'utf8')) : null;
      const run = { phase, command, exit_code: res.exit_code, elapsed_ms: res.elapsed_ms, timed_out: Boolean(res.timed_out), spawn_error: res.spawn_error || null, junit: junitData };
      run.status = classify(run);
      run.log = { path: logRel, sha256: sha256(fs.readFileSync(path.join(rdir, logRel))) };
      runs.push(run);
      log(`repro ${finding.id}: ${phase} -> ${run.status}${junitData && junitData.message ? ` (${junitData.message.slice(0, 120)})` : ''}`);
      return run;
    };
    let fix = null;
    try {
      if (!trackedClean(wt)) throw new Error('repro worktree has modified tracked files');
      fs.writeFileSync(target, test.content);
      const first = await runPhase('head-1');
      // An assertion failure must repeat before it counts; one run proves little.
      if (first.status === 'red') await runPhase('head-2');
      const status = statusFromRuns(runs);
      if (status === 'RED_PROVEN') {
        const applied = applyFix(wt, finding);
        fix = { ...applied, status: null, verified: null };
        if (applied.applied) {
          const fixed = await runPhase('fix');
          fix.status = fixed.status;
          fix.verified = fixed.status === 'green';
        }
      }
    } finally {
      fs.rmSync(target, { force: true });
      git.git(wt, ['checkout', '--', '.'], { allowFail: true });
    }
    const rec = { ...base, test: testInfo, toolchain: toolchain || 'custom', runs, status: statusFromRuns(runs), fix };
    writeJsonAtomic(recordFile, rec);
    results.push(rec);
  }
  return results;
}

module.exports = { runRepro, loadReproRecords, validateReproTest, applyFix, parseJunit, classify, statusFromRuns, detectToolchain, commandFor, shellRunner, scrubbedEnv, reproTargets, pythonCommand };
