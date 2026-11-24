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

// Seen with the same change: the 40-site cap took sites in scan order, so
// name-only matches (never asked) crowded out resolved callers. On the eval
// diffs the caller checks asked went from 2 to 33 (sentry-5), 6 to 34
// (keycloak-36880) and 11 to 39 (mindustry-bfa31bf1) once the cap keeps the
// surest sites first.
test('the call-site cap keeps resolved callers before name-only matches, and counts what it drops', () => {
  const dir = tmpDir('arw-rank-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, SVC, svc('x'));
  for (const n of [1, 2, 3]) write(dir, `aa/noise/Noise${n}.java`, `package org.other;\n\npublic class Noise${n} {\n    public int go() {\n        return helper().rate(${n});\n    }\n}\n`);
  write(dir, 'zz/later/Caller2.java', caller(2));
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = git.revParse(dir, 'HEAD');
  write(dir, SVC, svc('x * 2'));
  sh(dir, ['commit', '-q', '-am', 'head']);
  const p = parsePatch(git.diffPatch(dir, base, git.revParse(dir, 'HEAD')));
  // The structural index, where name-only matches exist (javac rules them out).
  const res = withEnv('ARW_JAVA_AST', 'off', () => withEnv('ARW_IMPACT_MAX_EDGES', '1', () => analyzeImpact({ cwd: dir, base, parsed: p })));
  const level1 = res.edges.filter((e) => e.level === 1);
  assert.deepEqual(level1.map((e) => e.from.path), ['zz/later/Caller2.java']);
  assert.notEqual(level1[0].confidence, 'name-only', 'resolved by imports, or by javac when a JDK is present');
  assert.equal(res.dropped_edges, 3);
  assert.equal(res.dropped_resolved, 0);
  assert.match(renderImpact(res), /Not listed: 3 call site\(s\) beyond 1 per level \(ARW_IMPACT_MAX_EDGES; 0 = all\), 0 of them resolved calls/);
  const all = withEnv('ARW_JAVA_AST', 'off', () => withEnv('ARW_IMPACT_MAX_EDGES', '0', () => analyzeImpact({ cwd: dir, base, parsed: p })));
  assert.equal(all.edges.filter((e) => e.level === 1).length, 4);
  assert.equal(all.truncated, false);
});

test('impacted tests left out by ARW_IMPACTED_TESTS_MAX are named, not dropped silently', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { runImpactedTests, renderImpacted } = require('../src/lib/impacted-tests');
  const dir = tmpDir('arw-itmax-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'pom.xml', '<project/>');
  for (const n of ['A', 'B', 'C']) write(dir, `src/test/java/com/acme/${n}Test.java`, `class ${n}Test { }\n`);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = git.revParse(dir, 'HEAD');
  for (const n of ['A', 'B', 'C']) write(dir, `src/test/java/com/acme/${n}Test.java`, `class ${n}Test { int x; }\n`);
  sh(dir, ['commit', '-q', '-am', 'head']);
  const head = git.revParse(dir, 'HEAD');
  const impact = { sources: [], tests_changed: ['A', 'B', 'C'].map((n) => `src/test/java/com/acme/${n}Test.java`) };
  const runner = async ({ cwd, logFile }) => {
    fs.writeFileSync(logFile, 'x');
    fs.mkdirSync(path.join(cwd, 'target', 'surefire-reports'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'target', 'surefire-reports', 'TEST-com.acme.ATest.xml'), '<testsuite><testcase classname="com.acme.ATest" name="a"/></testsuite>');
    return { exit_code: 0, elapsed_ms: 1 };
  };
  const r = await withEnv('ARW_IMPACTED_TESTS_MAX', '1', () => runImpactedTests({ runDir: tmpDir('arw-itmax-run-'), checkout: dir, base, head, impact, repoCfg: { run_impacted_tests: true }, runner }));
  assert.equal(r.results.length, 1);
  assert.deepEqual(r.not_run, ['src/test/java/com/acme/BTest.java', 'src/test/java/com/acme/CTest.java']);
  assert.match(renderImpacted(r), /NOT RUN: 2 more impacted test file\(s\) beyond ARW_IMPACTED_TESTS_MAX=1: src\/test\/java\/com\/acme\/BTest\.java, src\/test\/java\/com\/acme\/CTest\.java/);
});
