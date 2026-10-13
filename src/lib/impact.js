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
  for (const m of text.matchAll(/\b(class|interface|enum|record)\s+(\w+)([^{;]*)\{/g)) {
    const open = m.index + m[0].length - 1;
    // Supertypes from "extends A implements B, C" (generic arguments dropped).
    const header = m[3].replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '');
    const supers = [...header.matchAll(/\b(?:extends|implements)\s+([\w$.\s,]+)/g)].flatMap((x) => x[1].split(',').map((s) => s.trim().split('.').pop()).filter((s) => /^[A-Z]/.test(s)));
    types.push({ name: m[2], start: lineAt(text, m.index), end: lineAt(text, closeBrace(text, open)), open, supers });
  }
  // Declared types of fields, parameters and locals: name -> Set(simple type).
  // Scope-insensitive on purpose: a name's types in one file rarely collide.
  const vars = new Map();
  const addVar = (name, type) => {
    if (!vars.has(name)) vars.set(name, new Set());
    vars.get(name).add(type);
  };
  for (const m of text.matchAll(/\b([A-Z][\w$]*)(?:\s*<[^;(){}=]*?>)?(?:\s*\[\s*\])*\s+([a-z_$][\w$]*)\s*(?=[;=,):])/g)) addVar(m[2], m[1]);
  for (const m of text.matchAll(/\bvar\s+([a-z_$][\w$]*)\s*=\s*new\s+([A-Z][\w$]*)/g)) addVar(m[1], m[2]);
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
    // Parameter count (top-level commas), to tell overloads apart with javac.
    let params = 0;
    let level = 0;
    const inner = text.slice(open + 1, close);
    if (inner.trim()) {
      params = 1;
      for (const ch of inner) {
        if (ch === '<' || ch === '(') level += 1;
        else if (ch === '>' || ch === ')') level -= 1;
        else if (ch === ',' && level === 0) params += 1;
      }
    }
    methods.push({ name, owner: type ? type.name : null, start: line, end: lineAt(text, closeBrace(text, bodyOpen)), params });
  }
  return { lang: 'java', path: rel, text, pkg, imports, types, methods, vars };
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
  const classes = defs.filter((d) => d.kind === 'class').map((d) => {
    const bases = (new RegExp(`^\\s*class\\s+${d.name}\\s*\\(([^)]*)\\)`).exec(lines[d.start - 1]) || [])[1] || '';
    return { name: d.name, start: d.start, end: d.end, supers: bases.split(',').map((s) => s.trim().split('.').pop()).filter((s) => /^[A-Z]/.test(s)) };
  });
  const methods = defs.filter((d) => d.kind === 'def').map((d) => {
    const owner = classes.filter((c) => c.start < d.start && d.end <= c.end).sort((a, b) => b.start - a.start)[0];
    return { name: d.name, owner: owner ? owner.name : null, start: d.start, end: d.end };
  });
  // x = Cls(...), self.x = Cls(...), x: Cls (parameters and annotations).
  const vars = new Map();
  const addVar = (name, type) => {
    if (!vars.has(name)) vars.set(name, new Set());
    vars.get(name).add(type);
  };
  for (const m of text.matchAll(/(?:\bself\.)?\b([a-z_]\w*)\s*(?::\s*[\w.]*?\.?([A-Z]\w*)[^=\n,)]*)?=\s*(?:[\w.]*?\.)?([A-Z]\w*)\s*\(/g)) addVar(m[1], m[3]);
  for (const m of text.matchAll(/\b([a-z_]\w*)\s*:\s*(?:[\w.]*\.)?([A-Z]\w*)\b/g)) addVar(m[1], m[2]);
  return { lang: 'python', path: rel, text, module, imports, types: classes, methods, vars };
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

// Type hierarchy across all indexed files: simple name -> Set(supertypes).
function hierarchyOf(indexes) {
  const h = new Map();
  for (const idx of indexes) {
    for (const t of idx.types) {
      if (!h.has(t.name)) h.set(t.name, new Set());
      for (const s of t.supers || []) h.get(t.name).add(s);
    }
  }
  return h;
}

// Is `type` the same as, or a subtype of, `ancestor`?
function isSubtype(hierarchy, type, ancestor) {
  const seen = new Set();
  const stack = [type];
  while (stack.length) {
    const t = stack.pop();
    if (t === ancestor) return true;
    if (seen.has(t)) continue;
    seen.add(t);
    for (const s of hierarchy.get(t) || []) stack.push(s);
  }
  return false;
}

// The static type of the receiver before ".name(" when it can be told:
// a typed variable (field, parameter, local), `new T(...)` or `T(...)`.
function receiverTypes(idx, prev) {
  const ctor = idx.lang === 'java' ? /new\s+([A-Z][\w$]*)\s*(?:<[^<>()]*>)?\s*\([^()]*\)\s*\.\s*$/.exec(prev) : /\b([A-Z]\w*)\s*\([^()]*\)\s*\.\s*$/.exec(prev);
  if (ctor) return new Set([ctor[1]]);
  const r = (/([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(prev) || [])[1];
  if (!r || /^[A-Z]/.test(r) || r === 'this' || r === 'self' || r === 'super') return null;
  return idx.vars && idx.vars.get(r) ? idx.vars.get(r) : null;
}

// Call sites of `target` (a method in `target.index`) across `indexes`.
// Confidence: typed (receiver's declared type is the owner), interface (it
// is a supertype of the owner: dispatch, as with injected interfaces),
// resolved (import/package/module or same class), name-only.
function callSites(target, indexes, hierarchy = hierarchyOf(indexes), ast = null) {
  const out = [];
  const re = new RegExp(`(^|[^\\w$])(${target.name})\\s*\\(`, 'g');
  const javaAst = require('./java-ast');
  const targetFqn = ast && target.index.lang === 'java' && target.owner ? javaAst.fqnOf(ast, target.path, target.owner) : null;
  for (const idx of indexes) {
    if (idx.lang !== target.index.lang) continue;
    for (const m of idx.text.matchAll(re)) {
      const at = m.index + m[1].length;
      const line = lineAt(idx.text, at);
      if (idx.methods.some((d) => d.name === target.name && d.start === line)) continue; // a declaration, not a call
      const prev = idx.text.slice(Math.max(0, at - 200), at);
      if (/\b(def|function)\s+$/.test(prev)) continue;
      // `Type name(` is a declaration (abstract and interface methods have no
      // body, so the index does not list them); calls follow `.`, `(`, `=`...
      if (idx.lang === 'java' && /[\w$>\]]\s+$/.test(prev) && !/\b(return|new|else|throw|case|yield|await|assert)\s+$/.test(prev)) continue;
      // `Other.name(` with a type-like receiver other than the owner is a
      // different method (static call or a class of the same method name).
      const receiver = (/([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(prev) || [])[1];
      if (receiver && /^[A-Z]/.test(receiver) && receiver !== target.owner && !/^[A-Z0-9_]+$/.test(receiver)) continue;
      const caller = enclosing(idx, line);
      const site = { file: idx.path, line, caller: caller ? { name: caller.name, owner: caller.owner, start: caller.start, end: caller.end } : null };
      // javac resolved the calls on this line: it decides. The changed method
      // itself (same owner and parameter count), or a supertype's method the
      // changed one overrides (dispatch), or another method: dropped.
      if (targetFqn) {
        const resolved = (ast.calls.get(`${idx.path}:${line}`) || []).filter((c) => c.name === target.name);
        if (resolved.length) {
          const same = (c) => target.params === undefined || c.params === target.params;
          const exact = resolved.find((c) => c.owner === targetFqn && same(c));
          const dispatch = !exact && resolved.find((c) => c.owner !== targetFqn && javaAst.isSubtypeFqn(ast, targetFqn, c.owner) && same(c));
          if (exact) out.push({ ...site, confidence: 'ast' });
          else if (dispatch) out.push({ ...site, confidence: 'ast-dispatch', via: dispatch.owner.split('.').pop() });
          continue;
        }
      }
      const types = target.owner ? receiverTypes(idx, prev) : null;
      if (types) {
        if (types.has(target.owner)) out.push({ ...site, confidence: 'typed' });
        else if ([...types].some((t) => isSubtype(hierarchy, target.owner, t))) out.push({ ...site, confidence: 'interface', via: [...types].find((t) => isSubtype(hierarchy, target.owner, t)) });
        // otherwise the receiver is declared as an unrelated type: another method
        continue;
      }
      const sameScope = idx === target.index && (!target.owner || (caller && caller.owner === target.owner));
      const qualified = /\.\s*$/.test(prev);
      const ok = idx.lang === 'java' ? javaResolves(idx, target, sameScope && !qualified) : pythonResolves(idx, target, idx === target.index);
      out.push({ ...site, confidence: ok ? 'resolved' : 'name-only' });
    }
  }
  // One site per line and confidence (javac resolves by line).
  const seen = new Set();
  return out.filter((s) => { const k = `${s.file}:${s.line}:${s.confidence}`; return !seen.has(k) && seen.add(k); });
}

// Declarations named in configuration (Spring XML, MyBatis mappers, YAML,
// properties) or looked up by name (reflection, getattr). Raw text, since
// these references live in strings.
function configAndReflection(cwd, target) {
  const out = [];
  const lang = target.index.lang;
  const fqn = lang === 'java' ? [target.index.pkg, target.owner].filter(Boolean).join('.') : [target.index.module, target.owner].filter(Boolean).join('.');
  const grep = (pattern, globs) => String(git.git(cwd, ['grep', '-n', '-F', pattern, '--', ...globs], { allowFail: true }) || '').split('\n').filter(Boolean).slice(0, 20)
    .map((l) => { const m = /^(.*?):(\d+):(.*)$/.exec(l); return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null; }).filter(Boolean);
  const CONFIG = ['*.xml', '*.yml', '*.yaml', '*.properties', '*.json', '*.conf', '*.cfg', '*.ini', '*.toml'];
  if (target.owner && fqn.includes('.')) {
    for (const hit of grep(fqn, CONFIG)) {
      // A mapper/bean file for the owner: does it name this method too?
      const named = grep(`"${target.name}"`, [hit.file]).find((h) => /\bid\s*=|method|name\s*=/.test(h.text));
      out.push({ file: hit.file, line: named ? named.line : hit.line, caller: null, confidence: 'config', note: named ? `names ${target.name}` : `names ${fqn}` });
    }
  }
  if (!COMMON_NAMES.has(target.name) && target.name.length >= 4) {
    const quoted = lang === 'java' ? [`"${target.name}"`] : [`"${target.name}"`, `'${target.name}'`];
    for (const q of quoted) {
      for (const hit of grep(q, lang === 'java' ? ['*.java'] : ['*.py'])) {
        if (/getMethod|getDeclaredMethod|\.invoke\(|MethodHandles|getattr|setattr|hasattr|methodcaller|importlib/.test(hit.text)) out.push({ file: hit.file, line: hit.line, caller: null, confidence: 'reflection', note: hit.text.trim().slice(0, 120) });
      }
    }
  }
  return out;
}

// REST paths a changed handler serves (Spring mapping annotations, Flask /
// FastAPI decorators), read from the raw text above the declaration.
function endpointsOf(rawText, target) {
  const lines = String(rawText).split('\n');
  const above = lines.slice(Math.max(0, target.start - 6), target.start).join('\n');
  const paths = [];
  for (const m of above.matchAll(/@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]+)"/g)) paths.push(m[1]);
  for (const m of above.matchAll(/@\w+(?:\.\w+)*\.(?:get|post|put|delete|patch|route|api_route)\s*\(\s*["']([^"']+)["']/g)) paths.push(m[1]);
  if (!paths.length) return [];
  const prefix = target.index.lang === 'java' ? ((/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]+)"[^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*\bclass\s/.exec(rawText) || [])[1] || '') : '';
  return paths.map((p) => `${prefix.replace(/\/$/, '')}${p.startsWith('/') ? '' : '/'}${p}`.replace(/\/{2,}/g, '/'));
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

const FOLLOW = new Set(['ast', 'ast-dispatch', 'typed', 'resolved', 'interface']);

// { changed: [...], edges: [...], truncated, scanned, related }
// related: [{ name, dir }] other repositories (local checkouts) to search for
// callers by import and for clients of changed REST endpoints.
function analyzeImpact({ cwd, base, parsed, depth = 3, related = [] }) {
  const files = sourceFiles(cwd);
  const indexes = files.map((f) => readIndex(cwd, f)).filter(Boolean);
  const hierarchy = hierarchyOf(indexes);
  // javac's call graph for the Java files, when a JDK 11+ is available.
  const javaAst = require('./java-ast');
  let ast = null;
  let engine = 'structural';
  let astError = null;
  const javaFiles = indexes.filter((i) => i.lang === 'java').map((i) => i.path);
  if (javaFiles.length && javaAst.enabled()) {
    const g = javaAst.javaCallGraph(cwd, javaFiles);
    if (g.error) astError = g.error;
    else {
      ast = g;
      engine = `javac (JDK ${javaAst.javaVersion()}, ${g.ms} ms) + structural`;
    }
  }
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
      const sites = callSites(target, indexes, hierarchy, ast).filter((s) => !(COMMON_NAMES.has(target.name) && s.confidence === 'name-only'));
      for (const s of sites) {
        if (count >= MAX_EDGES_PER_LEVEL) {
          truncated = true;
          break;
        }
        count += 1;
        edges.push({ level, to: { path: target.path, symbol: label(target) }, from: { path: s.file, line: s.line, symbol: s.caller ? label(s.caller) : '(top level)' }, confidence: s.confidence, ...(s.via ? { via: s.via } : {}) });
        if (s.caller && FOLLOW.has(s.confidence)) {
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
  // References by name: configuration files and reflection.
  for (const target of changed) {
    for (const s of configAndReflection(cwd, target)) {
      edges.push({ level: 1, to: { path: target.path, symbol: label(target) }, from: { path: s.file, line: s.line, symbol: `(${s.confidence})` }, confidence: s.confidence, note: s.note });
    }
  }
  // Other repositories: callers that import the changed type or module, and
  // clients of changed REST endpoints (also in this repository's non-source
  // files, such as a front end).
  const scannedRepos = [];
  for (const r of related) {
    if (!r || !r.dir || !fs.existsSync(r.dir)) continue;
    const other = sourceFiles(r.dir).map((f) => readIndex(r.dir, f)).filter(Boolean);
    scannedRepos.push({ name: r.name, files: other.length });
    const h = hierarchyOf([...indexes, ...other]);
    for (const target of changed) {
      // Across repositories only resolvable calls count: name-only is noise there.
      for (const s of callSites(target, other, h).filter((x) => FOLLOW.has(x.confidence))) {
        edges.push({ level: 1, repo: r.name, to: { path: target.path, symbol: label(target) }, from: { path: s.file, line: s.line, symbol: s.caller ? label(s.caller) : '(top level)' }, confidence: s.confidence, ...(s.via ? { via: s.via } : {}) });
      }
    }
  }
  for (const target of changed) {
    let raw = null;
    try {
      raw = fs.readFileSync(path.join(cwd, target.path), 'utf8');
    } catch {
      continue;
    }
    for (const endpoint of endpointsOf(raw, target)) {
      const literal = endpoint.split(/[{:<]/)[0].replace(/\/$/, '');
      if (literal.length < 4) continue;
      for (const r of [{ name: null, dir: cwd }, ...related.filter((x) => x && x.dir && fs.existsSync(x.dir))]) {
        const hits = String(git.git(r.dir, ['grep', '-n', '-F', literal], { allowFail: true }) || '').split('\n').filter(Boolean).slice(0, 15);
        for (const l of hits) {
          const m = /^(.*?):(\d+):(.*)$/.exec(l);
          if (!m || (r.name === null && m[1] === target.path)) continue;
          if (r.name === null && /(^|\/)(src\/main\/java|.*\.py$)/.test(m[1]) && /Mapping|\.route|\.get\(|\.post\(/.test(m[3])) continue; // another handler, not a client
          edges.push({ level: 1, ...(r.name ? { repo: r.name } : {}), to: { path: target.path, symbol: label(target) }, from: { path: m[1], line: Number(m[2]), symbol: '(http client)' }, confidence: 'http', note: `${endpoint}: ${m[3].trim().slice(0, 100)}` });
        }
      }
    }
  }
  return {
    scanned: indexes.length,
    engine,
    ...(astError ? { ast_error: astError } : {}),
    related: scannedRepos,
    changed: changed.map((m) => ({ path: m.path, symbol: label(m), lines: [m.start, m.end] })),
    edges,
    truncated,
  };
}

function renderImpact(r) {
  const lines = ['', `## Impact: call sites of changed declarations (${r.engine || 'structural'} index of ${r.scanned} Java/Python files; comments and strings ignored)`];
  if (r.ast_error) lines.push(`(javac call graph unavailable: ${r.ast_error}; structural matching only)`);
  if (!r.changed.length) {
    lines.push('(no changed method or function found)');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Changed: ${r.changed.map((c) => `${c.symbol} (${c.path}:${c.lines[0]}-${c.lines[1]})`).join(', ')}`);
  const byName = new Set(['config', 'reflection', 'http']);
  const fmt = (e) => `- ${e.repo ? `[${e.repo}] ` : ''}${e.from.symbol} at ${e.from.path}:${e.from.line} -> ${e.to.symbol} [${e.confidence}${e.via ? ` via ${e.via}` : ''}]${e.note ? ` ${e.note}` : ''}`;
  const local = r.edges.filter((e) => !e.repo && !byName.has(e.confidence));
  for (const level of [1, 2, 3]) {
    const es = local.filter((e) => e.level === level);
    if (!es.length) continue;
    lines.push(['', 'Direct callers:', 'Callers of those callers:', 'Third level:'][level]);
    for (const e of es) lines.push(fmt(e));
  }
  const named = r.edges.filter((e) => !e.repo && byName.has(e.confidence));
  if (named.length) lines.push('Referenced by name (configuration, reflection, HTTP clients):', ...named.map(fmt));
  const other = r.edges.filter((e) => e.repo);
  if (other.length) lines.push(`Other repositories (${(r.related || []).map((x) => x.name).join(', ')}):`, ...other.map(fmt));
  else if (r.related && r.related.length) lines.push(`Other repositories searched (${r.related.map((x) => x.name).join(', ')}): no callers or clients found.`);
  if (!r.edges.length) lines.push('No call sites found (callers may live in repositories not configured as related).');
  if (r.truncated) lines.push(`(truncated at ${MAX_EDGES_PER_LEVEL} call sites per level)`);
  lines.push('Confidence: ast = javac resolved the call to the changed method itself; ast-dispatch = javac resolved it to a supertype method the changed one overrides (interface or base class, e.g. injected); typed = the receiver is declared as the changed type; interface = declared as its supertype (dispatch, e.g. an injected interface); resolved = import/package/module or same class; name-only = only the name matches. config/reflection/http = referenced by name, not by a call.');
  return `${lines.join('\n')}\n`;
}

module.exports = { analyzeImpact, renderImpact, indexFile, enclosing, indexJava, indexPython, stripJava, stripPython, callSites, changedMethods };
