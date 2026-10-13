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
let javaCache;

// Major version of `java` on PATH if it can run a source file (11+), else null.
function javaVersion() {
  if (javaCache !== undefined) return javaCache;
  javaCache = null;
  try {
    const r = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr || ''}${r.stdout || ''}`);
    if (m) {
      const major = m[1] === '1' ? Number(m[2]) : Number(m[1]);
      if (major >= 11) javaCache = major;
    }
  } catch {
    /* no java */
  }
  return javaCache;
}

function enabled() {
  return process.env.ARW_JAVA_AST !== 'off' && javaVersion() != null;
}

// { types: Map(fqn -> { supers, file, line }), calls: Map('file:line' -> [{ name, owner, params, in }]), ms } or { error }.
function javaCallGraph(cwd, files, { classpath = process.env.ARW_JAVA_CLASSPATH || '', timeoutMs = envInt('ARW_JAVA_AST_TIMEOUT_MS', 180000) } = {}) {
  if (!files.length) return { types: new Map(), calls: new Map(), ms: 0 };
  if (files.length > envInt('ARW_JAVA_AST_MAX_FILES', 8000)) return { error: `${files.length} Java files is above ARW_JAVA_AST_MAX_FILES` };
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arw-javaidx-')), 'files.txt');
  fs.writeFileSync(list, `${files.join('\n')}\n`);
  const started = Date.now();
  const r = spawnSync('java', [INDEXER, cwd, list, classpath], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  fs.rmSync(path.dirname(list), { recursive: true, force: true });
  if (r.error || r.status !== 0) return { error: (r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || '').trim().split('\n').pop()}`).slice(0, 300) };
  const types = new Map();
  const calls = new Map();
  for (const line of String(r.stdout).split('\n')) {
    if (!line.startsWith('{')) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (x.k === 'type') types.set(x.fqn, { supers: x.supers, file: x.file, line: x.line });
    else if (x.k === 'call') {
      const key = `${x.file}:${x.line}`;
      if (!calls.has(key)) calls.set(key, []);
      calls.get(key).push({ name: x.name, owner: x.owner, params: x.params, in: x.in });
    }
  }
  return { types, calls, ms: Date.now() - started };
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
  for (const [fqn, t] of graph.types) if (t.file === file && (fqn === simpleName || fqn.endsWith(`.${simpleName}`))) return fqn;
  return null;
}

module.exports = { enabled, javaVersion, javaCallGraph, isSubtypeFqn, fqnOf, INDEXER };
