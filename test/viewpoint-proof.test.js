'use strict';
// Incident: 20261124-072023Z-implicit-luna-multi, martian-sentry-5. CK-OR-1
// was asked because the change pairs `zip(error_ids, events.values())`, and
// it was answered "pass" six times, once quoting `filter_params = ...` (line
// 67) and claiming "the caller pairs IDs with the returned mapping's values".
// The zip line was never quoted and the order guarantee never shown; that
// zip was the labelled defect (M3). A viewpoint whose rule names the changed
// lines that raised it now records them, and "pass" or "not_applicable" must
// quote each of them; for order, missing values and keys "pass" must also
// quote the code that guarantees it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, sh, write } = require('./helpers');
const git = require('../src/lib/git');
const { parsePatch } = require('../src/lib/patch');
const { assignChecks, renderSites } = require('../src/lib/viewpoint-checks');
const { makeSources, validatePacket, canonicalizeCandidate } = require('../src/lib/validate');
const { hunkAnchors } = require('../src/lib/anchors');
const { revisionDir } = require('../src/lib/freeze');

const P = 'src/replays/summarize.py';
const BASE = `def summarize(error_ids, nodestore):
    events = nodestore.get_multi(error_ids)
    return [events[i] for i in error_ids]
`;
const HEAD = `def summarize(error_ids, nodestore):
    events = nodestore.get_multi(error_ids)
    out = []
    for error_id, event in zip(error_ids, events.values()):
        out.append((error_id, event))
    return out
`;
const CHECKLIST = '- CK-OR-1: order.\n- CK-PF-1: regex.\n- CK-TS-1: tests.\n';

function repo() {
  const dir = tmpDir('arw-proof-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, P, BASE);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = git.revParse(dir, 'HEAD');
  write(dir, P, HEAD);
  sh(dir, ['commit', '-q', '-am', 'head']);
  return { dir, base, head: git.revParse(dir, 'HEAD') };
}

const r = repo();
const parsed = parsePatch(git.diffPatch(r.dir, r.base, r.head));
const unit = () => assignChecks([{ id: 'T1', kind: 'technical', covers: [`file:${P}`], depends_on: [], roles: ['technical'] }], parsed, CHECKLIST)[0];
const ZIP = '    for error_id, event in zip(error_ids, events.values()):';
const GET = '    events = nodestore.get_multi(error_ids)';
const code = (line, quote) => ({ kind: 'code', path: P, start_line: line, end_line: line, quote });

test('the runtime records the changed lines that raised a viewpoint', () => {
  const u = unit();
  assert.ok(u.checks.includes('CK-OR-1'), u.checks.join(','));
  assert.deepEqual(u.check_sites['CK-OR-1'], [{ path: P, line: 4, text: ZIP.trim() }]);
  assert.equal(u.check_sites['CK-TS-1'], undefined, 'a rule without a site pattern asks no lines');
});

function check(verdict, evidence) {
  const DIGEST = 'd'.repeat(64);
  const sources = makeSources(tmpDir('arw-proof-run-'), { context_id: 'ctx', source: { checkout: r.dir, base_sha: r.base, head_sha: r.head }, inputs: [] });
  sources.context = { context_digest: DIGEST };
  const u = unit();
  const answers = u.checks.map((id) => (id === 'CK-OR-1' ? { viewpoint: id, verdict, evidence, note: 'n' } : { viewpoint: id, verdict: 'cannot_determine', evidence: [], note: 'n' }));
  const packet = { schema_version: '1.0', context_digest: DIGEST, unit_id: 'T1', role: 'technical', summary: 's', dependency_refs: [],
    coverage: [{ id: `file:${P}`, disposition: 'reviewed', evidence: [code(4, ZIP)], note: 'n' }],
    item_verdicts: [], viewpoint_verdicts: answers, impact_verdicts: [], findings: [], recommendation: 'no_findings' };
  return validatePacket(packet, { sources, unit: u, role: 'technical', items: [], expectedDependencyRefs: [] });
}

test('"pass" that never quotes the line it was asked about is refused', () => {
  const errors = check('pass', [code(2, GET)]);
  assert.ok(errors.some((e) => /"pass" for CK-OR-1 must quote each changed line it was asked about; not quoted: src\/replays\/summarize\.py:4/.test(e)), errors.join('\n'));
  const na = check('not_applicable', [code(2, GET)]);
  assert.ok(na.some((e) => /"not_applicable" for CK-OR-1 must quote each changed line/.test(e)), na.join('\n'));
});

test('"pass" on order also shows what guarantees it', () => {
  const onlySite = check('pass', [code(4, ZIP)]);
  assert.ok(onlySite.some((e) => /"pass" for CK-OR-1 also needs the code that guarantees it/.test(e)), onlySite.join('\n'));
  assert.deepEqual(check('pass', [code(4, ZIP), code(2, GET)]), []);
  assert.deepEqual(check('cannot_determine', []), [], 'an honest gap needs no quote');
});

test('the prompt names the lines each viewpoint was asked about, with the anchor that cites each', () => {
  const anchors = hunkAnchors(git.diffPatch(r.dir, r.base, r.head));
  const text = renderSites(unit(), anchors);
  assert.match(text, /CK-OR-1 was asked because of: H1:4 \(src\/replays\/summarize\.py:4 `for error_id, event in zip\(error_ids, events\.values\(\)\):`\)/);
  assert.doesNotMatch(text, /hunk anchor such as H3:47 is enough/, 'a bare hunk id is not enough, and the prompt does not say it is');
  assert.match(text, /a bare hunk id such as H3 stands for its first changed line only/);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'lib', 'prompts.js'), 'utf8');
  assert.match(src, /renderSites\(unit, anchors\)/, 'the worker prompt includes them, with anchors');
});

// Incident: 20261124-160414Z-proof-luna-multi. Four units failed outright
// (appsmith r1 B1, sentry-5 r1 B8, sentry-5 r2 B1 and B9), each rejected four
// times by the rule above. The prompt showed sites as path:line and the
// rejection said "a hunk anchor is enough"; Luna cited the bare hunk id
// (H39 for delete.py lines 84-94, site at 89), which resolves to the hunk's
// first changed line only (87), or lines next to the site (H46:67 and H46:69
// for a site at 68). Each site now comes with its own anchor, and the
// rejection names it.
function anchored(verdictEvidence) {
  const DIGEST = 'd'.repeat(64);
  const runDir = tmpDir('arw-proof-anchor-');
  const fs = require('node:fs');
  const dir = revisionDir(runDir, 'ctx');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(require('node:path').join(dir, 'review.patch'), git.diffPatch(r.dir, r.base, r.head));
  const sources = makeSources(runDir, { context_id: 'ctx', source: { checkout: r.dir, base_sha: r.base, head_sha: r.head }, inputs: [] });
  sources.context = { context_digest: DIGEST };
  const u = unit();
  const packet = { schema_version: '1.0', context_digest: DIGEST, unit_id: 'T1', role: 'technical', summary: 's', dependency_refs: [],
    coverage: [{ id: `file:${P}`, disposition: 'reviewed', evidence: [{ kind: 'code', anchor: 'H1' }], note: 'n' }],
    item_verdicts: [], findings: [], impact_verdicts: [], recommendation: 'no_findings',
    viewpoint_verdicts: u.checks.map((id) => (id === 'CK-OR-1' ? { viewpoint: id, verdict: 'pass', evidence: verdictEvidence, note: 'n' } : { viewpoint: id, verdict: 'cannot_determine', evidence: [], note: 'n' })) };
  canonicalizeCandidate(packet, sources);
  return validatePacket(packet, { sources, unit: u, role: 'technical', items: [], expectedDependencyRefs: [] });
}

test('a rejection names the anchor of each unquoted site, not "a hunk anchor is enough"', () => {
  const bare = anchored([{ kind: 'code', anchor: 'H1' }, code(2, GET)]);
  const msg = bare.find((e) => /must quote each changed line/.test(e));
  assert.ok(msg, bare.join('\n'));
  assert.match(msg, /not quoted: H1:4 \(src\/replays\/summarize\.py:4\)/);
  assert.doesNotMatch(msg, /a hunk anchor is enough/);
  const near = anchored([{ kind: 'code', anchor: 'H1:3' }, { kind: 'code', anchor: 'H1:5' }, code(2, GET)]);
  assert.ok(near.some((e) => /not quoted: H1:4/.test(e)), 'the lines next to a site do not quote it');
  assert.deepEqual(anchored([{ kind: 'code', anchor: 'H1:4' }, code(2, GET)]), [], 'the anchor given for the site is accepted');
});
