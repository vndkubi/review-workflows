'use strict';
// The agent instructions (AGENTS.md and the module notes it indexes) must say
// what the code does. Incident: AGENTS.md said "human gates are written only
// by arw gate" while the dashboard and an opt-in policy also called
// recordGate, and it put config/** under the frozen hashes when only three
// config directories are hashed. Each check below ties a claim to the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// Cited on purpose although they are never committed: private files, and
// branches or files outside this checkout.
const NOT_IN_REPO = new Set(['.claude/', 'arw-smoke/readback', 'auth.json', 'runs/.codex-home']);

function moduleNotes() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name === 'AGENTS.md') out.push(child);
    }
  };
  walk('src');
  return out.sort();
}

const DOCS = ['AGENTS.md', ...moduleNotes()];

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `no "## ${heading}" section`);
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next < 0 ? text.length : next);
}

function citedPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/[:,]$/, '');
    if (/[<>*#@()'"~]|\.com\/|^-|^\.\w+$/.test(p)) continue;
    if (/\//.test(p) || /\.(js|md|json|java)$/.test(p)) out.add(p);
  }
  return [...out];
}

function tracked() {
  return new Set(git(['ls-files', '-z']).split('\0').filter(Boolean));
}

function ignored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('the root AGENTS.md stays short and the module notes shorter', () => {
  assert.ok(read('AGENTS.md').split('\n').length <= 150, 'AGENTS.md over 150 lines');
  for (const note of moduleNotes()) assert.ok(read(note).split('\n').length <= 80, `${note} over 80 lines`);
  assert.match(read('CLAUDE.md'), /^@AGENTS\.md$/m, 'CLAUDE.md must import AGENTS.md (Claude does not read it otherwise)');
});

test('every module note is indexed in the root AGENTS.md, and every indexed note exists', () => {
  const index = section(read('AGENTS.md'), 'Module notes');
  const listed = [...index.matchAll(/`([\w/.-]+\/AGENTS\.md)`/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(listed)], moduleNotes());
});

test('every path the instructions cite is committed, or gitignored on purpose', () => {
  const files = tracked();
  const dirs = new Set([...files].flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))));
  const problems = [];
  for (const doc of DOCS) {
    const base = path.posix.dirname(doc);
    for (const p of citedPaths(read(doc))) {
      if (NOT_IN_REPO.has(p)) continue;
      const bare = p.replace(/\/$/, '');
      const candidates = [bare, path.posix.join(base, bare), path.posix.join(base, 'public', bare)];
      if (candidates.some((c) => files.has(c) || dirs.has(c))) continue;
      if (ignored(bare) || ignored(`${bare}/`)) continue;
      problems.push(`${doc}: \`${p}\` is neither committed nor gitignored`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every arw subcommand and npm script the instructions name exists', () => {
  const help = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli', 'arw.js'), '--help'], { encoding: 'utf8' });
  const usage = `${help.stdout}${help.stderr}`;
  const scripts = JSON.parse(read('package.json')).scripts;
  const problems = [];
  for (const doc of DOCS) {
    const text = read(doc);
    for (const m of text.matchAll(/`(?:node src\/cli\/arw\.js|arw) ([a-z][a-z-]*)/g)) {
      if (!new RegExp(`\\barw ${m[1]}\\b`).test(usage)) problems.push(`${doc}: arw ${m[1]} is not in --help`);
    }
    for (const m of text.matchAll(/`npm (?:run )?([a-z-]+)`/g)) {
      if (!(m[1] in scripts)) problems.push(`${doc}: npm ${m[1]} is not a package.json script`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every environment variable the instructions name is read somewhere in the code', () => {
  const code = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.js')) code.push(read(child));
    }
  };
  walk('src');
  walk('scripts');
  walk('test');
  const all = code.join('\n');
  const problems = [];
  for (const doc of DOCS) {
    for (const m of read(doc).matchAll(/`((?:ARW|CODEX|COPILOT)_[A-Z0-9_]+)/g)) {
      if (!all.includes(m[1])) problems.push(`${doc}: ${m[1]} is not read by src/, scripts/ or test/`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the frozen policy list in AGENTS.md is the one freeze.js hashes', () => {
  const { policyFiles } = require('../src/lib/freeze');
  const hashed = new Set(policyFiles().map((f) => {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    return `${path.posix.dirname(rel)}/*${path.posix.extname(rel)}`;
  }));
  const line = read('AGENTS.md').match(/Frozen hashes cover[\s\S]*?\n- /)[0];
  const documented = new Set([...line.matchAll(/`([\w/]+\/\*\.\w+)`/g)].map((m) => m[1]));
  assert.deepEqual([...documented].sort(), [...hashed].sort());
  assert.match(line, /`src\/lib\/\*\*`, `src\/cli\/\*\*`: `\.js` and `\.java`/);
});

test('every caller of recordGate is named where the instructions describe the gates', () => {
  const callers = [];
  for (const rel of ['src/cli/arw.js', ...fs.readdirSync(path.join(ROOT, 'src', 'web')).filter((f) => f.endsWith('.js')).map((f) => `src/web/${f}`), ...fs.readdirSync(path.join(ROOT, 'src', 'lib')).filter((f) => f.endsWith('.js')).map((f) => `src/lib/${f}`)]) {
    if (rel === 'src/lib/runs.js') continue; // the definition
    if (/\brecordGate\(/.test(read(rel))) callers.push(rel);
  }
  assert.ok(callers.length >= 1);
  const gates = section(read('src/lib/AGENTS.md'), 'Gates');
  for (const c of callers) {
    const named = c === 'src/cli/arw.js' ? /`arw gate`/ : new RegExp(path.basename(c).replace('.', '\\.'));
    assert.match(gates, named, `${c} calls recordGate but src/lib/AGENTS.md does not name it`);
  }
});

test('the lazy requires that keep the require cycle working are still inside functions', () => {
  const load = section(read('src/lib/AGENTS.md'), 'Load order');
  const pairs = [...load.matchAll(/`([\w-]+\.js)`\s+\(`require\('\.\/([\w-]+)'\)`/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 4, 'the Load order section lists the lazy requires');
  for (const [file, mod] of pairs) {
    const lines = read(`src/lib/${file}`).split('\n').filter((l) => l.includes(`require('./${mod}')`));
    assert.ok(lines.length, `${file} no longer requires ./${mod}: update src/lib/AGENTS.md`);
    for (const l of lines) assert.match(l, /^\s+/, `${file}: require('./${mod}') moved to the top level: ${l.trim()}`);
  }
});
