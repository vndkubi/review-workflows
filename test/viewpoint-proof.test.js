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
const { makeSources, validatePacket } = require('../src/lib/validate');

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

test('the prompt names the lines each viewpoint was asked about', () => {
  const text = renderSites(unit());
  assert.match(text, /CK-OR-1 was asked because of: src\/replays\/summarize\.py:4 `for error_id, event in zip\(error_ids, events\.values\(\)\):`/);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'lib', 'prompts.js'), 'utf8');
  assert.match(src, /renderSites\(unit\)/, 'the worker prompt includes them');
});
