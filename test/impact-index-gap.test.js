'use strict';
// Incident (2026-11-24): impact indexed at most 6000 Java/Python files, the
// first ones `git ls-files` lists, and said only "index of 5999 files".
// keycloak (6711 files) lost about 700, most under testsuite/; sentry (6619)
// lost about 620 under tests/. Callers there were never asked, silently.
// Now every file is indexed unless ARW_IMPACT_MAX_FILES caps it, and any file
// not indexed (cap, too large, unreadable) is counted, named by directory,
// and shown in the impact section and the brief as a gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, sh, write } = require('./helpers');
const git = require('../src/lib/git');
const { parsePatch } = require('../src/lib/patch');
const { analyzeImpact, renderImpact } = require('../src/lib/impact');
const brief = require('../src/lib/brief');

const SVC = 'src/main/java/com/acme/Svc.java';
const svc = (body) => `package com.acme;\n\npublic class Svc {\n    public int rate(int x) {\n        return ${body};\n    }\n}\n`;
const caller = (n) => `package com.acme;\n\npublic class Caller${n} {\n    private final Svc svc = new Svc();\n\n    public int run() {\n        return svc.rate(${n});\n    }\n}\n`;

function repo() {
  const dir = tmpDir('arw-gap-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, SVC, svc('x'));
  write(dir, 'src/main/java/com/acme/Caller1.java', caller(1));
  write(dir, 'zz/later/Caller2.java', caller(2));
  write(dir, 'zz/later/Huge.py', `# big\n${'x = 1\n'.repeat(80000)}`);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = git.revParse(dir, 'HEAD');
  write(dir, SVC, svc('x * 2'));
  sh(dir, ['commit', '-q', '-am', 'head']);
  return { dir, base, head: git.revParse(dir, 'HEAD') };
}

const r = repo();
const parsed = parsePatch(git.diffPatch(r.dir, r.base, r.head));

function withEnv(name, value, fn) {
  const old = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (old == null) delete process.env[name];
    else process.env[name] = old;
  }
}

test('every source file is indexed by default; one too large to read is a named gap', () => {
  const res = withEnv('ARW_IMPACT_MAX_FILES', null, () => analyzeImpact({ cwd: r.dir, base: r.base, parsed }));
  assert.ok(res.edges.some((e) => e.from.path === 'zz/later/Caller2.java'), 'a caller listed late is still found');
  assert.deepEqual(res.index, { total: 4, indexed: 3, skipped: { count: 1, too_large: 1, cap: 0, unreadable: 0, by_dir: [{ dir: 'zz/later', n: 1 }] } });
  assert.match(renderImpact(res), /index of 3 of 4 Java\/Python files/);
  assert.match(renderImpact(res), /Not indexed: 1 file\(s\) \(larger than 400 KB: 1\), in zz\/later \(1\): callers there are not searched\./);
});

test('a cap is opt-in, and what it drops is said, not silent', () => {
  const res = withEnv('ARW_IMPACT_MAX_FILES', '2', () => analyzeImpact({ cwd: r.dir, base: r.base, parsed }));
  assert.equal(res.edges.some((e) => e.from.path === 'zz/later/Caller2.java'), false);
  assert.equal(res.index.skipped.cap, 2);
  assert.match(renderImpact(res), /Not indexed: 2 file\(s\) \(ARW_IMPACT_MAX_FILES=2: 2\), in zz\/later \(2\)/);
});

test('the brief names the files impact did not search', () => {
  const b = brief.buildBrief({ identity: { repo: 'o/n', pr: 1, title: 't' }, validation: { recommendation: 'no_findings', complete: true, gaps: [], jobs: [], items: [], impacts: [] }, impactIndex: { total: 4, indexed: 3, skipped: { count: 1, too_large: 1, cap: 0, unreadable: 0, by_dir: [{ dir: 'zz/later', n: 1 }] } } });
  assert.match(b.affected.index_gap, /1 of 4 Java\/Python files were not searched for callers \(zz\/later 1\)/);
  assert.match(brief.renderBrief(b), /`impact` 1 of 4 Java\/Python files were not searched/);
  const clean = brief.buildBrief({ identity: { repo: 'o/n', pr: 1, title: 't' }, validation: { recommendation: 'no_findings', complete: true, gaps: [], jobs: [], items: [], impacts: [] }, impactIndex: { total: 4, indexed: 4, skipped: { count: 0 } } });
  assert.equal(clean.affected.index_gap, null);
});
