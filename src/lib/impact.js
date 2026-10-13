'use strict';
// Impact analysis without a parser dependency: a light structural index of
// Java and Python sources (declarations with line ranges, imports), built on
// text with comments and string literals blanked out, so a mention in a
// comment or a log message is not a call. From the declarations a PR
// changes, it finds call sites and the method that contains each, two levels
// up, and says how sure it is:
//   resolved   the caller imports (or shares the package of) the declaring
//              type or module, or calls within the same class/file
//   name-only  only the name matches; another type may own a method of that name
// Dynamic dispatch, reflection, DI wiring and other repositories stay unknown.
const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

const MAX_FILES = 6000;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_EDGES_PER_LEVEL = 40;
const COMMON_NAMES = new Set(['get', 'set', 'add', 'put', 'run', 'call', 'apply', 'accept', 'test', 'main', 'init', 'equals', 'hashCode', 'toString', 'compareTo', 'close', 'build', 'of', 'size', 'isEmpty', 'contains', 'remove', 'clear', 'update', 'save', 'find', 'execute', 'handle', 'process', 'create', 'delete', 'read', 'write', 'start', 'stop', '__init__', '__str__', '__repr__', '__eq__', 'setUp', 'tearDown']);
const JAVA_NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'synchronized', 'else', 'do', 'try', 'super', 'this', 'assert']);

// ---------- blanking comments and literals (positions and newlines kept) ----------
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

function stripJava(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const j = text.indexOf('\n', i);
      const end = j === -1 ? n : j;
      out += blank(text.slice(i, end));
      i = end;
    } else if (c === '/' && d === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      out += blank(text.slice(i, end));
      i = end;
    } else if (c === '"' && text.startsWith('"""', i)) {
      const j = text.indexOf('"""', i + 3);
      const end = j === -1 ? n : j + 3;
      out += `"${blank(text.slice(i + 1, end - 1))}"`;
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const closed = j < n && text[j] === c;
      const end = closed ? j + 1 : Math.min(j, n);
      out += c + blank(text.slice(i + 1, closed ? j : end)) + (closed ? c : '');
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function stripPython(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      const j = text.indexOf('\n', i);
      const end = j === -1 ? n : j;
      out += blank(text.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < n && !text.startsWith(q, j) && (triple || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      const closed = j < n && text.startsWith(q, j);
      const end = closed ? j + q.length : Math.min(j, n);
      out += q + blank(text.slice(i + q.length, closed ? j : end)) + (closed ? q : '');
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

// index -> 1-based line, by binary search over line starts (cached per text).
const lineStarts = new Map();
function lineAt(text, index) {
  let starts = lineStarts.get(text);
  if (!starts) {
    starts = [0];
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    if (lineStarts.size > 256) lineStarts.clear();
    lineStarts.set(text, starts);
  }
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// Index of the brace that closes the one at `open`, in stripped text.
function closeBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

// ---------- Java ----------
function indexJava(rel, raw) {
  const text = stripJava(raw);
  const pkg = (/\bpackage\s+([\w.]+)\s*;/.exec(text) || [])[1] || '';
  const imports = [...text.matchAll(/\bimport\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/g)].map((m) => m[1]);
  const types = [];
  for (const m of text.matchAll(/\b(class|interface|enum|record)\s+(\w+)[^{;]*\{/g)) {
    const open = m.index + m[0].length - 1;
    types.push({ name: m[2], start: lineAt(text, m.index), end: lineAt(text, closeBrace(text, open)), open });
  }
  const typeAt = (line) => types.filter((t) => t.start <= line && line <= t.end).sort((a, b) => b.start - a.start)[0];
  // A declaration is `name(...)` followed by an optional throws clause and a
  // body, and preceded by a return type or modifier (a word, `>` or `]`); a
  // constructor is preceded by a modifier or a statement boundary and named
  // like its type. Calls never have both.
  const methods = [];
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (JAVA_NOT_METHODS.has(name)) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length && i < open + 4000; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    const after = /^\s*(?:throws\s+[\w$.,\s]+?)?\s*\{/.exec(text.slice(close + 1, close + 400));
    if (!after) continue;
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const prevWord = (/([\w$]+)\s*$/.exec(before) || [])[1];
    const prevChar = (/(\S)\s*$/.exec(before) || [])[1] || '';
    const line = lineAt(text, m.index);
    const type = typeAt(line);
    const isCtor = type && type.name === name && (/[{};]/.test(prevChar) || /^(public|protected|private)$/.test(prevWord || ''));
    const hasType = (/[\w$>\]]/.test(prevChar)) && !/^(new|return|else|throw|case|yield|await)$/.test(prevWord || '') && prevChar !== '.';
    if (!isCtor && !hasType) continue;
    const bodyOpen = close + 1 + after[0].length - 1;
    methods.push({ name, owner: type ? type.name : null, start: line, end: lineAt(text, closeBrace(text, bodyOpen)) });
  }
  return { lang: 'java', path: rel, text, pkg, imports, types, methods };
}

// ---------- Python ----------
function indexPython(rel, raw) {
  const text = stripPython(raw);
  const lines = text.split('\n');
  const module = rel.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
  const imports = [];
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n]+)/gm)) imports.push({ from: m[1], names: m[2].replace(/[()\\]/g, ' ').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) });
  for (const m of text.matchAll(/^\s*import\s+([^\n]+)/gm)) for (const x of m[1].split(',')) imports.push({ module: x.trim().split(/\s+as\s+/)[0] });
  const defs = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/.exec(l);
    if (!m) return;
    const indent = m[1].length;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      if (lines[j].length - lines[j].trimStart().length <= indent) break;
      end = j;
    }
    defs.push({ kind: m[2], name: m[3], indent, start: i + 1, end: end + 1 });
  });
  const classes = defs.filter((d) => d.kind === 'class').map((d) => ({ name: d.name, start: d.start, end: d.end }));
  const methods = defs.filter((d) => d.kind === 'def').map((d) => {
    const owner = classes.filter((c) => c.start < d.start && d.end <= c.end).sort((a, b) => b.start - a.start)[0];
    return { name: d.name, owner: owner ? owner.name : null, start: d.start, end: d.end };
  });
  return { lang: 'python', path: rel, text, module, imports, types: classes, methods };
}

function indexFile(rel, raw) {
  if (rel.endsWith('.java')) return indexJava(rel, raw);
  if (rel.endsWith('.py')) return indexPython(rel, raw);
  return null;
}

// ---------- resolution ----------
function enclosing(index, line) {
  return index.methods.filter((m) => m.start <= line && line <= m.end).sort((a, b) => b.start - a.start)[0] || null;
}

function javaResolves(caller, callee, sameType) {
  if (sameType) return true;
  const owner = callee.owner;
  if (!owner) return false;
  const fqn = callee.index.pkg ? `${callee.index.pkg}.${owner}` : owner;
  if (caller.pkg === callee.index.pkg) return new RegExp(`\\b${owner}\\b`).test(caller.text);
  return caller.imports.some((i) => i === fqn || i === `${callee.index.pkg}.*` || i === `${fqn}.*` || i.startsWith(`${fqn}.`));
}

function pythonResolves(caller, callee, sameFile) {
  if (sameFile) return true;
  const mod = callee.index.module;
  const parent = mod.includes('.') ? mod.slice(0, mod.lastIndexOf('.')) : '';
  const leaf = mod.split('.').pop();
  return caller.imports.some((i) => (i.module && (i.module === mod || mod.startsWith(`${i.module}.`)))
    || (i.from === mod && (i.names.includes(callee.name) || i.names.includes('*') || (callee.owner && i.names.includes(callee.owner))))
    || (i.from === parent && i.names.includes(leaf))
    || (i.from && i.from.startsWith('.') && mod.endsWith(i.from.replace(/^\.+/, '')) && (i.names.includes(callee.name) || (callee.owner && i.names.includes(callee.owner)))));
}

// Call sites of `target` (a method in `target.index`) across `indexes`.
function callSites(target, indexes) {
  const out = [];
  const re = new RegExp(`(^|[^\\w$])(${target.name})\\s*\\(`, 'g');
  for (const idx of indexes) {
    if (idx.lang !== target.index.lang) continue;
    for (const m of idx.text.matchAll(re)) {
      const at = m.index + m[1].length;
      const line = lineAt(idx.text, at);
      if (idx.methods.some((d) => d.name === target.name && d.start === line)) continue; // a declaration, not a call
      const prev = idx.text.slice(Math.max(0, at - 40), at);
      if (/\b(def|function)\s+$/.test(prev)) continue;
      // `Other.name(` with a type-like receiver other than the owner is a
      // different method (static call or a class of the same method name).
      const receiver = (/([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(prev) || [])[1];
      if (receiver && /^[A-Z]/.test(receiver) && receiver !== target.owner && !/^[A-Z0-9_]+$/.test(receiver)) continue;
      const caller = enclosing(idx, line);
      const sameScope = idx === target.index && (!target.owner || (caller && caller.owner === target.owner));
      const qualified = /\.\s*$/.test(prev);
      const ok = idx.lang === 'java' ? javaResolves(idx, target, sameScope && !qualified) : pythonResolves(idx, target, idx === target.index);
      out.push({ file: idx.path, line, caller: caller ? { name: caller.name, owner: caller.owner, start: caller.start, end: caller.end } : null, confidence: ok ? 'resolved' : 'name-only' });
    }
  }
  return out;
}

// Changed declarations: methods whose head range holds an added line, or
// whose base range held a removed line (looked up by name at head).
function changedMethods(indexes, parsed, baseIndexes) {
  const byPath = new Map(indexes.map((i) => [i.path, i]));
  const out = [];
  const seen = new Set();
  const add = (idx, m) => {
    const key = `${idx.path}#${m.owner || ''}.${m.name}#${m.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...m, index: idx, path: idx.path });
  };
  for (const f of parsed) {
    const idx = byPath.get(f.path);
    if (!idx) continue;
    const added = f.hunks.flatMap((h) => h.lines.filter((l) => l.type === '+').map((l) => l.new_line));
    for (const line of added) {
      const m = enclosing(idx, line);
      if (m) add(idx, m);
    }
    const base = baseIndexes.get(f.old_path || f.path);
    if (base) {
      const removed = f.hunks.flatMap((h) => h.lines.filter((l) => l.type === '-').map((l) => l.old_line));
      for (const line of removed) {
        const bm = enclosing(base, line);
        const hm = bm && idx.methods.find((x) => x.name === bm.name && x.owner === bm.owner);
        if (hm) add(idx, hm);
      }
    }
  }
  return out;
}

function sourceFiles(cwd) {
  const all = String(git.git(cwd, ['ls-files', '--', '*.java', '*.py'], { allowFail: true }) || '').split('\n').filter(Boolean);
  return all.slice(0, MAX_FILES);
}

function readIndex(cwd, rel) {
  const file = path.join(cwd, rel);
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) return null;
    return indexFile(rel, fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const label = (m) => `${m.owner ? `${m.owner}.` : ''}${m.name}`;

// { changed: [...], edges: [...], truncated, scanned }
function analyzeImpact({ cwd, base, parsed, depth = 3 }) {
  const files = sourceFiles(cwd);
  const indexes = files.map((f) => readIndex(cwd, f)).filter(Boolean);
  const baseIndexes = new Map();
  for (const f of parsed) {
    const rel = f.old_path || f.path;
    if (!/\.(java|py)$/.test(rel || '')) continue;
    const text = git.showFile(cwd, base, rel);
    if (text != null) baseIndexes.set(rel, indexFile(rel, text));
  }
  const changed = changedMethods(indexes, parsed, baseIndexes);
  const edges = [];
  let truncated = false;
  let frontier = changed;
  const visited = new Set(changed.map((m) => `${m.path}#${label(m)}`));
  for (let level = 1; level <= depth && frontier.length; level += 1) {
    const next = [];
    let count = 0;
    for (const target of frontier) {
      const sites = callSites(target, indexes).filter((s) => !(COMMON_NAMES.has(target.name) && s.confidence === 'name-only'));
      for (const s of sites) {
        if (count >= MAX_EDGES_PER_LEVEL) {
          truncated = true;
          break;
        }
        count += 1;
        edges.push({ level, to: { path: target.path, symbol: label(target) }, from: { path: s.file, line: s.line, symbol: s.caller ? label(s.caller) : '(top level)' }, confidence: s.confidence });
        if (s.caller && s.confidence === 'resolved') {
          const key = `${s.file}#${label(s.caller)}`;
          if (!visited.has(key)) {
            visited.add(key);
            const idx = indexes.find((i) => i.path === s.file);
            next.push({ ...s.caller, index: idx, path: s.file });
          }
        }
      }
    }
    frontier = next;
  }
  return {
    scanned: indexes.length,
    changed: changed.map((m) => ({ path: m.path, symbol: label(m), lines: [m.start, m.end] })),
    edges,
    truncated,
  };
}

function renderImpact(r) {
  const lines = ['', `## Impact: call sites of changed declarations (structural index of ${r.scanned} Java/Python files; comments and strings ignored)`];
  if (!r.changed.length) {
    lines.push('(no changed method or function found)');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Changed: ${r.changed.map((c) => `${c.symbol} (${c.path}:${c.lines[0]}-${c.lines[1]})`).join(', ')}`);
  for (const level of [1, 2, 3]) {
    const es = r.edges.filter((e) => e.level === level);
    if (!es.length) continue;
    lines.push(['', 'Direct callers:', 'Callers of those callers:', 'Third level:'][level]);
    for (const e of es) lines.push(`- ${e.from.symbol} at ${e.from.path}:${e.from.line} -> ${e.to.symbol} [${e.confidence}]`);
  }
  if (!r.edges.length) lines.push('No call sites found in this repository (callers may be in other services, or use reflection/DI).');
  if (r.truncated) lines.push(`(truncated at ${MAX_EDGES_PER_LEVEL} call sites per level)`);
  lines.push('name-only: the name matches but the caller does not import the declaring type/module; it may call another method of the same name.');
  return `${lines.join('\n')}\n`;
}

module.exports = { analyzeImpact, renderImpact, indexJava, indexPython, stripJava, stripPython, callSites, changedMethods };
