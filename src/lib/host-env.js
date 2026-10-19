'use strict';
// Running a reproduction on the host when there is no sandbox (or the
// docker daemon is down): the host is prepared the way the bootstrap
// prepares a container. A JDK the project needs is picked from those
// installed; the project's dependencies are resolved once at the trusted
// base (the only step with network); the PR's test then runs offline in its
// own worktree with secrets removed from the environment. When the host
// cannot do it, the reason is recorded instead of a bare build error.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sha256, ensureDir } = require('./util');
const { projectJavaLevel } = require('./java-ast');

const EXE = process.platform === 'win32' ? '.exe' : '';

function defaultRoots(env = process.env) {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const pf = [env.ProgramFiles || 'C:/Program Files', env['ProgramFiles(x86)']].filter(Boolean);
    return [...pf.flatMap((p) => ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft'].map((v) => path.join(p, v))), path.join(home, '.jdks')];
  }
  return ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', path.join(home, '.sdkman', 'candidates', 'java'), path.join(home, '.jdks')];
}

// A JDK home: a release file naming the version and a javac.
function jdkAt(home) {
  for (const h of [home, path.join(home, 'Contents', 'Home')]) {
    try {
      const release = fs.readFileSync(path.join(h, 'release'), 'utf8');
      const m = /JAVA_VERSION="?(?:1\.)?(\d+)/.exec(release);
      if (m && fs.existsSync(path.join(h, 'bin', `javac${EXE}`))) return { home: h, version: Number(m[1]) };
    } catch {
      /* not a JDK */
    }
  }
  return null;
}

function findJdks({ roots = defaultRoots(), env = process.env } = {}) {
  const homes = [env.ARW_JAVA_HOME, env.JAVA_HOME].filter(Boolean);
  for (const r of roots) {
    try {
      for (const name of fs.readdirSync(r)) homes.push(path.join(r, name));
    } catch {
      /* no such root */
    }
  }
  const seen = new Set();
  const out = [];
  for (const h of homes) {
    const j = jdkAt(h);
    if (j && !seen.has(path.resolve(j.home))) {
      seen.add(path.resolve(j.home));
      out.push(j);
    }
  }
  return out.sort((a, b) => a.version - b.version);
}

// The smallest JDK at or above the project's level (the newest when the
// project declares none).
function pickJdk(level, jdks) {
  if (!jdks.length) return null;
  if (!level) return jdks[jdks.length - 1];
  return jdks.find((j) => j.version >= level) || null;
}

function whichOnPath(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

// What the host needs for this toolchain: the build tool and a JDK. Returns
// { ok, java, env, tool } or { ok: false, reason }.
function hostPlan({ wt, toolchain, jdks = findJdks(), which = whichOnPath }) {
  if (toolchain !== 'maven' && toolchain !== 'gradle') return { ok: true, env: {}, java: null, tool: null };
  let tool;
  if (toolchain === 'maven') {
    const wrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
    tool = fs.existsSync(path.join(wt, wrapper)) ? (process.platform === 'win32' ? `.\\${wrapper}` : `./${wrapper}`) : which('mvn') ? 'mvn' : null;
    if (!tool) return { ok: false, reason: 'Maven is not installed on this host and the repository has no mvnw' };
  } else {
    const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    tool = fs.existsSync(path.join(wt, wrapper)) ? (process.platform === 'win32' ? `.\\${wrapper}` : `./${wrapper}`) : which('gradle') ? 'gradle' : null;
    if (!tool) return { ok: false, reason: 'Gradle is not installed on this host and the repository has no gradlew' };
  }
  const level = projectJavaLevel(wt);
  const jdk = pickJdk(level, jdks);
  if (!jdk) {
    const have = jdks.length ? `Java ${[...new Set(jdks.map((j) => j.version))].join(', ')}` : 'no JDK';
    return { ok: false, reason: `the project needs Java ${level}; this host has ${have} (install a JDK ${level}+ or set ARW_JAVA_HOME)` };
  }
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = { JAVA_HOME: jdk.home, [pathKey]: `${path.join(jdk.home, 'bin')}${path.delimiter}${process.env[pathKey] || ''}` };
  if (pathKey !== 'PATH') env.PATH = env[pathKey];
  return { ok: true, java: jdk.version, env, tool };
}

// Whether dir holds a build file that marks a module. Gradle modules may name
// theirs after the module (spring-security: web/spring-security-web.gradle);
// a settings file marks a build, not a module.
function hasBuildFile(toolchain, dir) {
  if (toolchain === 'maven') return fs.existsSync(path.join(dir, 'pom.xml'));
  if (toolchain !== 'gradle') return false;
  try {
    return fs.readdirSync(dir).some((f) => /\.gradle(\.kts)?$/.test(f) && !/^settings\.gradle(\.kts)?$/.test(f) && fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return false;
  }
}

// The arguments that scope a build, run from the worktree root, to a module
// (relative "/"-separated, or null for the root). Gradle finds the settings
// above -p itself. Maven runs the reactor, the topmost pom on the module's
// path, with -f when that is not the root (metasfresh keeps it in backend/).
// standalone: the module is outside the reactor, so its own pom is the build.
function scopeArgs(toolchain, wt, module, { standalone = false } = {}) {
  if (toolchain === 'gradle') return module ? ['-p', module] : [];
  if (toolchain !== 'maven' || !module) return [];
  if (standalone) return ['-f', `${module}/pom.xml`];
  const parts = module.split('/');
  let top = 0;
  while (top <= parts.length && !fs.existsSync(path.join(wt, ...parts.slice(0, top), 'pom.xml'))) top += 1;
  if (top === 0 || top > parts.length) return ['-pl', module, '-am'];
  const rest = parts.slice(top).join('/');
  return ['-f', `${parts.slice(0, top).join('/')}/pom.xml`, ...(rest ? ['-pl', rest, '-am'] : [])];
}

// Maven's answer to "-pl <module>" for a module the reactor does not list.
function notInReactor(log) {
  return /Could not find the selected project in the reactor/.test(String(log));
}

function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Gradle fails a test task whose --tests filter matches nothing; prep runs
// one on purpose, so that what only the test task resolves (the jacoco
// agent, test runtimes) is cached before the offline head run.
const NO_TEST_INIT = 'gradle.allprojects { p -> p.tasks.withType(Test).configureEach { t -> t.filter.failOnNoMatchingTests = false } }\n';

// Resolves the project's dependencies once per repository and base, online,
// by building the trusted base (no tests run) in its own worktree.
// module: the test's module directory (relative, "/"-separated) or null for
// the root. Only that module and what it depends on is resolved, so a
// framework repository is not built whole; a module the base does not have
// yet (the PR adds it) falls back to the whole build.
async function prepareDependencies({ checkout, base, toolchain, plan, runner, cacheDir = path.join(os.homedir(), '.arw', 'host-deps'), logDir, module = null, env = process.env, timeoutMs = Number(env.ARW_HOST_PREP_TIMEOUT_MS) || 45 * 60 * 1000 }) {
  if (toolchain !== 'maven' && toolchain !== 'gradle') return { ok: true, prepared: false };
  ensureDir(cacheDir);
  const repoKey = `${sha256(path.resolve(checkout)).slice(0, 12)}-${String(base).slice(0, 12)}-${toolchain}-java${plan.java || 'x'}-p2`;
  const wt = path.join(cacheDir, 'wt', repoKey);
  if (!fs.existsSync(wt)) {
    ensureDir(path.dirname(wt));
    execFileSync('git', ['-C', checkout, 'worktree', 'add', '--detach', '--force', wt, base], { stdio: 'ignore' });
  }
  if (module && (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(module) || !fs.existsSync(path.join(wt, module)))) module = null;
  // Gradle markers from the testClasses-only prep (-t) do not count.
  const key = `${module ? `${repoKey}-${sha256(module).slice(0, 8)}` : repoKey}${toolchain === 'gradle' ? '-t' : ''}`;
  const marker = path.join(cacheDir, `${key}.ok`);
  if (fs.existsSync(marker)) return { ok: true, prepared: false, standalone: /^standalone$/m.test(fs.readFileSync(marker, 'utf8')) };
  const tool = plan.tool || (toolchain === 'maven' ? 'mvn' : 'gradle');
  const commandOf = (standalone) => {
    const scope = scopeArgs(toolchain, wt, module, { standalone }).map((a) => ` ${a}`).join('');
    if (toolchain === 'maven') return `${tool} -B -q${scope} test -Dtest=ArwNoSuchTest -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`;
    const init = path.join(cacheDir, 'arw-no-test.init.gradle');
    fs.writeFileSync(init, NO_TEST_INIT);
    return `${tool}${scope} test --tests ArwNoSuchTest --init-script "${init}"`;
  };
  const logFile = path.join(ensureDir(logDir || cacheDir), `host-deps-${key}.log`);
  let command = commandOf(false);
  let res = await runner({ command, cwd: wt, logFile, timeoutMs, env: plan.env });
  // A module the root reactor does not list (ruoyi-vue-pro comments most
  // out) is built from its own pom.
  let standalone = false;
  if (res.exit_code !== 0 && toolchain === 'maven' && module && notInReactor(readLog(logFile))) {
    standalone = true;
    command = commandOf(true);
    res = await runner({ command, cwd: wt, logFile, timeoutMs, env: plan.env });
  }
  if (res.exit_code === 0) {
    fs.writeFileSync(marker, `${new Date().toISOString()} ${command}\n${standalone ? 'standalone\n' : ''}`);
    return { ok: true, prepared: true, logFile, standalone };
  }
  return { ok: false, reason: `dependencies could not be resolved at base ${String(base).slice(0, 12)} with "${command}" (exit ${res.exit_code}${res.timed_out ? ', timed out' : ''}; log ${logFile})`, logFile };
}

// The artifacts an offline Maven run reports missing ("Missing:" lists,
// "Could not find artifact"), as group:artifact:version.
function missingArtifacts(log) {
  const out = [];
  const add = (g, a, v) => { const c = `${g}:${a}:${v}`; if (!out.includes(c)) out.push(c); };
  for (const m of String(log).matchAll(/^\[ERROR\]\s+\d+\)\s+([\w.-]+(?::[\w.+-]+){3,4})\s*$/gm)) {
    // group:artifact:type:version or group:artifact:type:classifier:version
    const parts = m[1].split(':');
    add(parts[0], parts[1], parts[parts.length - 1]);
  }
  for (const m of String(log).matchAll(/Could not find artifact ([\w.-]+):([\w.-]+):[\w-]+:(?:[\w-]+:)?([\w.+-]+)/g)) add(m[1], m[2], m[3]);
  return out;
}

// Only the test runtime is fetched on the fly: the runner and its providers,
// never a library the PR's code links against (that one must come from the
// base resolution, or the record says it is missing).
const TEST_RUNTIME = /^(org\.apache\.maven\.surefire|org\.junit\.platform|org\.junit\.jupiter|org\.junit\.vintage|junit|org\.opentest4j|org\.apiguardian):/;
function testRuntimeArtifacts(log) {
  return missingArtifacts(log).filter((c) => TEST_RUNTIME.test(c));
}

// Fetches artifacts with the dependency plugin in an empty directory: no
// project, so no code of the PR runs while the network is on.
async function fetchArtifacts({ artifacts, plan, runner, dir, timeoutMs = 10 * 60 * 1000 }) {
  ensureDir(dir);
  for (const a of artifacts) {
    if (!/^[\w.-]+:[\w.-]+:[\w.+-]+$/.test(a)) return { ok: false, reason: `refused artifact coordinates ${JSON.stringify(a)}` };
    const command = `mvn -B -q org.apache.maven.plugins:maven-dependency-plugin:3.6.1:get -Dartifact=${a}`;
    const res = await runner({ command, cwd: dir, logFile: path.join(dir, 'fetch.log'), timeoutMs, env: plan.env });
    if (res.exit_code !== 0) return { ok: false, reason: `could not fetch the test runtime ${a} (exit ${res.exit_code})` };
  }
  return { ok: true };
}

// Where PR code runs: the sandbox when it is configured and its daemon is
// up; else the host, unless ARW_SANDBOX_FALLBACK=off.
function runnerChoice({ mode, daemonError, env = process.env }) {
  if (mode === 'host') return 'host';
  if (!daemonError) return 'sandbox';
  return env.ARW_SANDBOX_FALLBACK === 'off' ? 'blocked' : 'host';
}

module.exports = { findJdks, pickJdk, hostPlan, prepareDependencies, hasBuildFile, scopeArgs, notInReactor, runnerChoice, defaultRoots, jdkAt, missingArtifacts, testRuntimeArtifacts, fetchArtifacts };
