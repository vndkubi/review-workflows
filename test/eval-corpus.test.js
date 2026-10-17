'use strict';
// Building the eval corpus without a model: fix commits mined back to the
// change that introduced the bug (candidates a person confirms), and the
// Martian offline benchmark's prose comments as path-scoped keyword labels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write } = require('./helpers');

process.env.ARW_EVAL_DIR = tmpDir('arw-corpus-');

const evals = require('../src/lib/eval');
const corpus = require('../src/lib/eval-corpus');

const finding = (p, text, lines = [3, 3]) => ({ id: 'F1', title: text, asis: '', tobe: '', evidence: [{ kind: 'code', path: p, start_line: lines[0], end_line: lines[1] }] });

test('prose labels: matched by path scope and keywords, never by prose alone', () => {
  const r = tmpDir('arw-corpus-v-');
  sh(r, ['init', '-q', '-b', 'main']);
  write(r, 'a.py', 'x = 1\n');
  sh(r, ['add', '-A']);
  sh(r, ['commit', '-q', '-m', 'a']);
  const head = sh(r, ['rev-parse', 'HEAD']);
  const label = { id: 'M1', prose: 'get_item_key assumes a numeric key', paths: ['src/paginator.py', 'src/views.py'], keywords: ['get_item_key', 'numeric'], min_keywords: 1, approx: true };
  assert.deepEqual(evals.validateCase({ id: 'p', repo: r, base: head, head, expected: [label] }), []);
  assert.ok(evals.matches(finding('src/views.py', 'get_item_key calls math.floor on a datetime'), label));
  assert.ok(!evals.matches(finding('src/other.py', 'get_item_key calls math.floor on a datetime'), label), 'outside the path scope');
  assert.ok(!evals.matches(finding('src/views.py', 'unrelated naming nit'), label), 'no keyword');
  assert.ok(evals.matches(finding('src/views.py', 'NUMERIC keys only'), { ...label, keywords: ['numeric', 'datetime'], min_keywords: 1 }), 'case-insensitive');
  assert.ok(!evals.matches(finding('src/views.py', 'numeric keys only'), { ...label, keywords: ['numeric', 'datetime'], min_keywords: 2 }), 'needs two keywords');
  const errs = evals.validateCase({ id: 'p', repo: r, base: head, head, expected: [{ id: 'M2', prose: 'something is wrong' }] });
  assert.match(errs.join(';'), /expected\[0\]: a prose label needs keywords/);
  assert.match(evals.validateCase({ id: 'p', repo: r, base: head, head, expected: [{ id: 'M3', keywords: ['x'] }] }).join(';'), /expected\[0\]\.path/);
});

// Incident (martian-sentry-1): one finding about math.floor on datetimes was
// counted for three comments because all of them name the PR's main class.
test('prose labels: a shared identifier is not enough, and one finding meets one label', () => {
  const p = 'src/sentry/api/paginator.py';
  const labels = [
    { id: 'M1', prose: 'negative slicing', paths: [p], keywords: ['optimizedcursorpaginator', 'organization_auditlogs', 'assertionerror'], min_keywords: 1, approx: true },
    { id: 'M3', prose: 'math.floor on datetime', paths: [p], keywords: ['get_item_key', 'order_by', 'math.floor', 'typeerror'], min_keywords: 1, approx: true },
    { id: 'M4', prose: 'missing import', paths: [p], keywords: ['optimizedcursorpaginator'], min_keywords: 1, approx: true },
  ];
  const f1 = finding(p, 'OptimizedCursorPaginator passes the datetime to math.floor');
  assert.deepEqual(evals.assignProse([f1], labels), { M3: ['F1'] });
  const f2 = { ...finding(p, 'OptimizedCursorPaginator is imported but never defined'), id: 'F2' };
  assert.deepEqual(evals.assignProse([f1, f2], labels), { M3: ['F1'], M4: ['F2'] }, 'a label of shared keywords only can still be met by another finding');
  // A person linked a finding in other words to M1: its code anchor counts from then on.
  const f3 = { ...finding(p, 'Negative cursor offsets break pagination', [240, 244]), id: 'F3' };
  assert.deepEqual(evals.assignProse([f3], labels), {});
  const linked = labels.map((l) => (l.id === 'M1' ? { ...l, anchors: [{ path: p, lines: [242, 242] }] } : l));
  assert.deepEqual(evals.assignProse([f1, f3], linked), { M3: ['F1'], M1: ['F3'] });
  assert.deepEqual(evals.assignProse([{ ...f3, evidence: [{ kind: 'code', path: p, start_line: 300, end_line: 301 }] }], linked), {}, 'anchors are line-precise');
});

function repoWithFix({ merge = true } = {}) {
  const dir = tmpDir('arw-corpus-repo-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'src/Total.java', 'class Total {\n  int total(int[] xs) {\n    int s = 0;\n    for (int i = 0; i < xs.length; i++) s += xs[i];\n    return s;\n  }\n}\n');
  write(dir, 'README.md', 'totals\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'initial totals']);
  sh(dir, ['checkout', '-q', '-b', 'feature']);
  write(dir, 'src/Total.java', 'class Total {\n  int total(int[] xs) {\n    int s = 0;\n    for (int i = 0; i < xs.length - 1; i++) s += xs[i];\n    return s;\n  }\n  int count(int[] xs) { return xs.length; }\n}\n');
  sh(dir, ['commit', '-q', '-am', 'Skip the trailer item and add count']);
  const introducer = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['checkout', '-q', 'main']);
  if (merge) sh(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from feature', 'feature']);
  else sh(dir, ['merge', '-q', '--ff-only', 'feature']);
  const mergeSha = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'README.md', 'totals of items\n');
  sh(dir, ['commit', '-q', '-am', 'fix typo in readme']);
  write(dir, 'src/Total.java', 'class Total {\n  int total(int[] xs) {\n    int s = 0;\n    for (int i = 0; i < xs.length; i++) s += xs[i];\n    return s;\n  }\n  int count(int[] xs) { return xs.length; }\n}\n');
  write(dir, 'src/test/TotalTest.java', 'class TotalTest {}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'Fix off-by-one: total dropped the last item (#9)']);
  const fix = sh(dir, ['rev-parse', 'HEAD']);
  return { dir, introducer, mergeSha, fix };
}

test('mining: a fix commit is blamed back to the PR that introduced it', () => {
  const r = repoWithFix();
  const res = corpus.mineFixes({ repo: r.dir, prefix: 'shop' });
  assert.equal(res.candidates.length, 1, JSON.stringify(res, null, 1));
  const c = res.candidates[0];
  assert.equal(c.status, 'candidate');
  assert.equal(c.id, `shop-${r.fix.slice(0, 8)}`);
  assert.equal(c.head, sh(r.dir, ['rev-parse', `${r.mergeSha}^2`]), 'the PR head, not one commit');
  assert.equal(c.base, sh(r.dir, ['rev-parse', `${r.mergeSha}^1`]));
  assert.deepEqual(c.expected.map((e) => [e.path, e.lines]), [['src/Total.java', [4, 4]]]);
  // Lines, not the fix subject's words: a finding may describe the same bug differently.
  assert.equal(c.expected[0].keywords, undefined);
  assert.equal(c.expected[0].fix_subject, 'Fix off-by-one: total dropped the last item (#9)');
  assert.equal(c.evidence.fix.sha, r.fix);
  assert.equal(c.evidence.introduced_by, r.introducer);
  assert.match(c.evidence.fix.diff, /-    for \(int i = 0; i < xs.length - 1/);
  assert.ok(res.skipped.some((s) => /fix typo in readme/.test(s.subject) && /no source lines/.test(s.reason)), JSON.stringify(res.skipped));
  assert.ok(fs.existsSync(path.join(evals.evalDir(), 'candidates', `${c.id}.json`)));

  // Mining again does not duplicate; a person confirms or rejects.
  assert.equal(corpus.mineFixes({ repo: r.dir, prefix: 'shop' }).candidates.length, 0);
  assert.equal(corpus.listCandidates().length, 1);
  const { file } = corpus.decideCandidate(c.id, { decision: 'confirm', by: 'owner', note: 'yes, that loop was the bug' });
  const confirmed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(evals.validateCase(confirmed), []);
  assert.equal(confirmed.confirmed.by, 'owner');
  assert.equal(confirmed.confirmed.candidate_sha256.length, 64);
  assert.ok(!('status' in confirmed) && !('evidence' in confirmed) && confirmed.source.fix === r.fix);
  assert.equal(corpus.listCandidates()[0].status, 'confirmed');
  assert.throws(() => corpus.decideCandidate(c.id, { decision: 'reject' }), /already confirmed/);
});

test('mining: without a merge commit the introducing commit itself is the case', () => {
  fs.rmSync(path.join(evals.evalDir(), 'candidates'), { recursive: true, force: true });
  const r = repoWithFix({ merge: false });
  const c = corpus.mineFixes({ repo: r.dir, prefix: 'ff' }).candidates[0];
  assert.equal(c.head, r.introducer);
  assert.equal(c.base, sh(r.dir, ['rev-parse', `${r.introducer}^`]));
  corpus.decideCandidate(c.id, { decision: 'reject', by: 'owner', note: 'intended' });
  assert.equal(corpus.listCandidates().find((x) => x.id === c.id).status, 'rejected');
  assert.ok(!fs.existsSync(path.join(evals.evalDir(), 'cases', `${c.id}.json`)));
});

// Incident (Mindustry #12659): a squash-merged PR is one commit on main. A
// later merge of main into another branch also "brings it in" from that
// branch's point of view; taking that merge made the case range wider than the PR.
test('mining: a commit on the main line is its own PR, whatever merges follow', () => {
  fs.rmSync(path.join(evals.evalDir(), 'candidates'), { recursive: true, force: true });
  const dir = tmpDir('arw-corpus-sq-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'src/A.java', 'class A {\n  int f() { return 1; }\n}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  sh(dir, ['checkout', '-q', '-b', 'other']);
  write(dir, 'src/B.java', 'class B {}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'other work']);
  sh(dir, ['checkout', '-q', 'main']);
  write(dir, 'src/A.java', 'class A {\n  int f() { return 2; }\n}\n');
  sh(dir, ['commit', '-q', '-am', 'Change f (#12)']);
  const intro = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['checkout', '-q', 'other']);
  sh(dir, ['merge', '-q', '--no-ff', '-m', 'Merge main into other', 'main']);
  sh(dir, ['checkout', '-q', 'main']);
  sh(dir, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #13 from other', 'other']);
  write(dir, 'src/A.java', 'class A {\n  int f() { return 1; }\n}\n');
  sh(dir, ['commit', '-q', '-am', 'Fix f regression']);
  const c = corpus.mineFixes({ repo: dir, prefix: 'sq' }).candidates[0];
  assert.equal(c.source.range, 'commit');
  assert.deepEqual([c.base, c.head], [sh(dir, ['rev-parse', `${intro}^`]), intro]);
  assert.equal(c.source.pr, 12);
});

test('martian import: prose comments become path-scoped keyword labels on the PR range', () => {
  const dir = tmpDir('arw-corpus-m-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, 'src/sentry/api/paginator.py', 'class Paginator:\n    pass\n');
  write(dir, 'src/sentry/api/endpoints/organization_auditlogs.py', 'x = 1\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  write(dir, 'src/sentry/api/paginator.py', 'class OptimizedCursorPaginator:\n    def get_item_key(self, item):\n        return math.floor(item)\n');
  write(dir, 'src/sentry/api/endpoints/organization_auditlogs.py', 'paginator_cls = OptimizedCursorPaginator\nmember = organization_context.member.has_global_access\n');
  sh(dir, ['commit', '-q', '-am', 'head']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  const golden = [{
    pr_title: 'Enhanced Pagination',
    url: 'https://github.com/ai-code-review-evaluation/sentry-greptile/pull/1',
    comments: [
      { comment: 'The OptimizedCursorPaginator in organization_auditlogs.py uses negative slice offsets.', severity: 'High', category: 'bug' },
      { comment: 'get_item_key assumes a numeric key; calling math.floor on a datetime will raise a TypeError.', severity: 'High', category: 'bug' },
      { comment: 'Line 71 reads organization_context.member.has_global_access without checking if member is None.', severity: 'Critical', category: 'bug' },
      { comment: 'Consider documenting this behaviour.', severity: 'Low', category: 'style' },
    ],
  }];
  const file = path.join(dir, 'sentry.json');
  fs.writeFileSync(file, JSON.stringify(golden));
  const seen = [];
  const res = corpus.importMartian({ file, repoDir: dir, name: 'sentry', prInfo: (repo, pr) => (seen.push([repo, pr]), { base, head }) });
  assert.deepEqual(seen, [['ai-code-review-evaluation/sentry-greptile', 1]]);
  const c = res.cases[0];
  assert.equal(c.id, 'martian-sentry-1');
  assert.deepEqual([c.base, c.head], [base, head]);
  assert.deepEqual(evals.validateCase(c), []);
  const [m1, m2, m3, m4] = c.expected;
  assert.deepEqual(m1.paths, ['src/sentry/api/endpoints/organization_auditlogs.py'], 'the file it names');
  assert.ok(m1.keywords.includes('optimizedcursorpaginator'));
  assert.deepEqual(m2.paths, ['src/sentry/api/paginator.py'], 'the diff file whose changed lines hold its identifiers');
  assert.ok(m2.keywords.includes('get_item_key') && m2.keywords.includes('math.floor'));
  assert.ok(m3.keywords.includes('has_global_access'));
  assert.equal(m3.source_severity, 'Critical');
  assert.ok(m1.approx && m1.prose.startsWith('The OptimizedCursorPaginator'));
  assert.ok(!m4, 'a comment with nothing to anchor on is left out, not guessed');
  assert.deepEqual(res.unanchored, [{ case: 'martian-sentry-1', comment: 'Consider documenting this behaviour.' }]);
  assert.ok(evals.matches(finding('src/sentry/api/paginator.py', 'get_item_key breaks on datetime keys'), m2));
  // Seen on Keycloak: acronyms inside PascalCase, and quoted code strings.
  assert.ok(corpus.identifiers('Dead code where ASN1Encoder instances are discarded').includes('asn1encoder'));
  assert.deepEqual(corpus.identifiers("should be 'idp-alias-' + i instead of 'alias'"), ['idp-alias-']);
  assert.deepEqual(corpus.identifiers('The HTML page is a JSON blob; Javadoc says so'), [], 'all-caps words and ordinary capitalised words are not code');
  assert.ok(fs.existsSync(path.join(evals.evalDir(), 'cases', 'martian-sentry-1.json')));
});
