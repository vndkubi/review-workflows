'use strict';
// What a change to a file of this repository touches, without running
// anything: whether it is under the frozen hashes (older review contexts go
// stale), which modules require it, and which tests reach it. Not to be
// confused with src/lib/impact.js, which analyses the PRs ARW reviews.
//   node scripts/dev-impact.js [--json] [--all] [path...]
// With no path: the files changed in the working tree (tracked and new).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CODE_DIRS = ['src', 'scripts', 'test'];

// The rules of src/lib/freeze.js: toolDigest walks src/lib and src/cli for
// .js and .java; POLICY_GLOBS lists the policy folders (top level only);
// config/projects/<owner>/<name>/ is the reviewed repository's own policy.
function hashedAs(rel) {
  if (/^src\/(lib|cli)\/.+\.(js|java)$/.test(rel)) return 'tool';
  if (/^(agents|config\/policies)\/[^/]+\.md$/.test(rel) || /^config\/schemas\/[^/]+\.json$/.test(rel)) return 'policy';
  if (/^config\/projects\//.test(rel)) return 'project-policy';
  return null;
}

const HASH_TEXT = {
  tool: 'tool digest (src/lib, src/cli): contexts frozen before the change are refused as drift',
  policy: 'frozen policy: contexts frozen before the change are refused as drift',
  'project-policy': "the reviewed repository's frozen policy (gitignored, never committed)",
};

function notesFor(rel) {
  const out = [];
  if (/^config\/schemas\//.test(rel) || rel === 'src/lib/validate.js') out.push('skill packet-contract-change: schema, validate.js, prompts.js, fake executor and report move together');
  if (/^src\/web\//.test(rel)) out.push('skill dashboard-change-verify: not hashed; check it in a browser on a scratch ARW_RUNS_DIR');
  if (rel === 'src/lib/settings.js') out.push('a new setting goes into ENV_SETTINGS; the dashboard and README usually follow');
  if (/^agents\/[^/]+\.md$/.test(rel)) out.push('a role charter that review workers read: measure with Luna re-runs on the same PRs');
  if (/^runs\//.test(rel)) out.push('run data is evidence: never edited by hand');
  return out;
}

function codeFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(child); }
      else if (e.name.endsWith('.js')) out.push(child);
    }
  };
  for (const dir of CODE_DIRS) walk(dir);
  return out.sort();
}

function resolveRequire(root, from, spec) {
  const base = path.posix.join(path.posix.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}/index.js`]) {
    if (fs.existsSync(path.join(root, c)) && fs.statSync(path.join(root, c)).isFile()) return path.posix.normalize(c);
  }
  return null;
}

// file -> the files that require it (lazy requires inside functions too).
function requiredBy(root) {
  const map = new Map();
  for (const file of codeFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) {
      const target = resolveRequire(root, file, m[2]);
      if (!target || target === file) continue;
      if (!map.has(target)) map.set(target, new Set());
      map.get(target).add(file);
    }
  }
  return map;
}

const isTest = (f) => /^test\/.+\.test\.js$/.test(f);

// Files that are read, not required: the module that loads their folder,
// plus runtime code that names the file in quotes ('planner.md'). Tests and
// scripts are left out: their fixture repos name README.md and the like.
const READERS = [
  [/^config\/schemas\//, ['src/lib/schema.js']],
  [/^agents\//, ['src/lib/freeze.js', 'src/lib/prompts.js']],
  [/^config\/policies\//, ['src/lib/freeze.js']],
];

function readersOf(root, file) {
  const out = new Set();
  for (const [re, files] of READERS) if (re.test(file)) for (const f of files) if (fs.existsSync(path.join(root, f))) out.add(f);
  const base = path.posix.basename(file);
  for (const f of codeFiles(root).filter((x) => x.startsWith('src/'))) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    if (text.includes(`'${base}'`) || text.includes(`"${base}"`)) out.add(f);
  }
  return out;
}

function analyze(paths, { root = ROOT } = {}) {
  const graph = requiredBy(root);
  return paths.map((p) => {
    const file = path.relative(root, path.resolve(root, p)).split(path.sep).join('/');
    const direct = [...(file.endsWith('.js') ? graph.get(file) || [] : readersOf(root, file))].sort();
    // Everything that reaches the file through requires.
    const seen = new Set();
    const queue = [...direct];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const g of graph.get(f) || []) queue.push(g);
    }
    const own = `test/${path.posix.basename(file, '.js')}.test.js`;
    const directTests = direct.filter(isTest);
    // Tests that run a script instead of requiring it: path.join(..., 'arw.js').
    if (file.endsWith('.js')) {
      const quoted = `'${path.posix.basename(file)}'`;
      for (const t of codeFiles(root).filter(isTest)) if (!directTests.includes(t) && fs.readFileSync(path.join(root, t), 'utf8').includes(quoted)) directTests.push(t);
      directTests.sort();
    }
    if (isTest(file)) directTests.unshift(file);
    else if (!directTests.includes(own) && fs.existsSync(path.join(root, own)) && file.endsWith('.js')) directTests.unshift(own);
    return {
      file,
      exists: fs.existsSync(path.join(root, file)),
      hashed: hashedAs(file),
      dependents: direct.filter((f) => !isTest(f)),
      reach: [...seen].filter((f) => !isTest(f)).sort(),
      tests: {
        direct: directTests,
        transitive: [...seen].filter((f) => isTest(f) && !directTests.includes(f)).sort(),
      },
      notes: notesFor(file),
    };
  });
}

function changedFiles(root = ROOT) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return [...new Set([...git(['diff', '--name-only', '-z', 'HEAD']), ...git(['ls-files', '-z', '--others', '--exclude-standard'])])].sort();
}

function render(r, { all = false } = {}) {
  const list = (xs, n = 10) => (all || xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')}, ... (+${xs.length - n}, --all)`);
  const lines = [`${r.file}${r.exists ? '' : ' (missing)'}`];
  lines.push(`  hashed: ${r.hashed ? HASH_TEXT[r.hashed] : 'no'}`);
  if (r.dependents.length) lines.push(`  ${r.file.endsWith('.js') ? 'required' : 'read'} by (${r.dependents.length}): ${list(r.dependents)}`);
  if (r.reach.length > r.dependents.length) lines.push(`  reaches ${r.reach.length} modules through requires`);
  lines.push(`  tests: ${r.tests.direct.length ? list(r.tests.direct) : 'none direct'}`);
  if (r.tests.transitive.length) lines.push(`  tests through dependents (${r.tests.transitive.length}): ${list(r.tests.transitive)}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith('--'));
  const results = analyze(paths.length ? paths : changedFiles());
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else console.log(results.length ? results.map((r) => render(r, { all: args.includes('--all') })).join('\n\n') : 'no changed files');
}

module.exports = { analyze, changedFiles, hashedAs };
