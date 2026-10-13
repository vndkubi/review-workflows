'use strict';
// Java call graph from javac (src/lib/JavaIndex.java), when a JDK 11+ is on
// PATH. It resolves what text cannot: the declared type of any receiver,
// overloads, inheritance, `var`, chained and multi-line calls, method
// references. Annotation processing is off and nothing is executed. Without a
// JDK (or with ARW_JAVA_AST=off) impact analysis keeps its structural index.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { envInt } = require('./util');

const INDEXER = path.join(__dirname, 'JavaIndex.java');
const infoCache = new Map();

// The java launcher to use: ARW_JAVA_HOME/bin/java, else `java` on PATH.
function javaBin() {
  const home = process.env.ARW_JAVA_HOME;
  return home ? path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
}

// { bin, version (major) | null, compiler (has jdk.compiler) , error }.
function javaInfo() {
  const bin = javaBin();
  if (infoCache.has(bin)) return infoCache.get(bin);
  const info = { bin, version: null, compiler: false, error: null };
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.error) throw r.error;
    const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr || ''}${r.stdout || ''}`);
    if (m) info.version = m[1] === '1' ? Number(m[2]) : Number(m[1]);
    if (info.version >= 9) {
      const mods = spawnSync(bin, ['--list-modules'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      info.compiler = /^jdk\.compiler@/m.test(mods.stdout || '');
    }
  } catch (err) {
    info.error = err.code === 'ENOENT' ? `${bin} not found` : err.message;
  }
  infoCache.set(bin, info);
  return info;
}

// Major version if this JDK can run the indexer (11+ with javac), else null.
function javaVersion() {
  const i = javaInfo();
  return i.version >= 11 && i.compiler ? i.version : null;
}

function enabled() {
  return process.env.ARW_JAVA_AST !== 'off' && javaVersion() != null;
}

// The Java language level a project builds with, from pom.xml or Gradle
// files (maven.compiler.release/source, <release>, sourceCompatibility,
// toolchain languageVersion). null when it cannot be told.
function projectJavaLevel(dir) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  const num = (v) => {
    const m = /^(?:1\.)?(\d+)/.exec(String(v).trim());
    return m ? Number(m[1]) : null;
  };
  const pom = read('pom.xml');
  for (const re of [/<maven\.compiler\.release>\s*([\d.]+)/, /<release>\s*([\d.]+)\s*<\/release>/, /<maven\.compiler\.source>\s*([\d.]+)/, /<source>\s*([\d.]+)\s*<\/source>/, /<java\.version>\s*([\d.]+)/]) {
    const m = re.exec(pom);
    if (m) return num(m[1]);
  }
  const gradle = read('build.gradle') + read('build.gradle.kts');
  for (const re of [/languageVersion\s*(?:=|\.set\()\s*JavaLanguageVersion\.of\(\s*(\d+)/, /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)/]) {
    const m = re.exec(gradle);
    if (m) return num(m[1].replace(/_/g, '.'));
  }
  return null;
}

// { types: Map(fqn -> { supers, file, line }), calls: Map('file:line' -> [{ name, owner, params, in }]), ms } or { error }.
function javaCallGraph(cwd, files, { classpath = process.env.ARW_JAVA_CLASSPATH || '', timeoutMs = envInt('ARW_JAVA_AST_TIMEOUT_MS', 180000) } = {}) {
  if (!files.length) return { types: new Map(), calls: new Map(), ms: 0 };
  if (files.length > envInt('ARW_JAVA_AST_MAX_FILES', 8000)) return { error: `${files.length} Java files is above ARW_JAVA_AST_MAX_FILES` };
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arw-javaidx-')), 'files.txt');
  fs.writeFileSync(list, `${files.join('\n')}\n`);
  const started = Date.now();
  const r = spawnSync(javaBin(), [INDEXER, cwd, list, classpath], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  fs.rmSync(path.dirname(list), { recursive: true, force: true });
  if (r.error || r.status !== 0) return { error: (r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || '').trim().split('\n').pop()}`).slice(0, 300) };
  const types = new Map();
  const calls = new Map();
  const parseErrors = [];
  // A fully qualified name declared in two files (two modules, or Java 8 and
  // 11 variants of one API): javac kept one of them, so its answers for that
  // name cannot be trusted.
  const ambiguous = new Set();
  for (const line of String(r.stdout).split('\n')) {
    if (!line.startsWith('{')) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (x.k === 'parse_error') parseErrors.push({ file: x.file, line: x.line, msg: x.msg });
    else if (x.k === 'type') {
      if (types.has(x.fqn) && types.get(x.fqn).file !== x.file) ambiguous.add(x.fqn);
      types.set(x.fqn, { supers: x.supers, file: x.file, line: x.line });
    } else if (x.k === 'call') {
      const key = `${x.file}:${x.line}`;
      if (!calls.has(key)) calls.set(key, []);
      calls.get(key).push({ name: x.name, owner: x.owner, params: x.params, in: x.in });
    }
  }
  return { types, calls, parseErrors, ambiguous, ms: Date.now() - started };
}

// Is `fqn` the same as, or a subtype of, `ancestor` in the javac hierarchy?
function isSubtypeFqn(graph, fqn, ancestor) {
  const seen = new Set();
  const stack = [fqn];
  while (stack.length) {
    const t = stack.pop();
    if (t === ancestor) return true;
    if (seen.has(t)) continue;
    seen.add(t);
    for (const s of (graph.types.get(t) || { supers: [] }).supers) stack.push(s);
  }
  return false;
}

// The javac name of a type the structural index knows by simple name in a file.
function fqnOf(graph, file, simpleName) {
  for (const [fqn, t] of graph.types) if (t.file === file && (fqn === simpleName || fqn.endsWith(`.${simpleName}`))) return graph.ambiguous && graph.ambiguous.has(fqn) ? null : fqn;
  return null;
}

module.exports = { enabled, javaBin, javaInfo, javaVersion, projectJavaLevel, javaCallGraph, isSubtypeFqn, fqnOf, INDEXER };
