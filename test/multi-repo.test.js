'use strict';
// A backend reviewed alone while its consumers live in other repositories:
// a BFF in its own repository calls the changed backend code. The related
// repository is read at the revision the team pins (a tag), not at whatever
// its checkout holds, that revision is frozen with the context, its callers
// become caller checks like local ones, and a quote from it is checked
// against that revision.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, sh, write, makeRepo } = require('./helpers');
const git = require('../src/lib/git');
const { parsePatch } = require('../src/lib/patch');
const { analyzeImpact } = require('../src/lib/impact');
const { assignImpacts } = require('../src/lib/impact-checks');
const { makeSources, validateEvidence, validatePacket, splitLines } = require('../src/lib/validate');
const { resolveRelated } = require('../src/lib/related');

const ORDER = 'src/main/java/com/acme/OrderService.java';
const QUOTE_CTRL = 'src/main/java/com/acme/bff/QuoteController.java';
const CALL = 'return total.subtract(orders.discount(member, total));';
const BFF_V1 = `package com.acme.bff;

import com.acme.OrderService;
import java.math.BigDecimal;

public class QuoteController {
    private final OrderService orders = new OrderService();

    public BigDecimal quote(boolean member, BigDecimal total) {
        ${CALL}
    }
}
`;
const BFF_V2 = `package com.acme.bff;

import java.math.BigDecimal;

public class QuoteController {
    public BigDecimal quote(boolean member, BigDecimal total) {
        return total;
    }
}
`;

function bffRepo() {
  const dir = tmpDir('arw-bff-');
  sh(dir, ['init', '-q', '-b', 'main']);
  write(dir, QUOTE_CTRL, BFF_V1);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'bff calls the order service']);
  sh(dir, ['tag', 'v1']);
  const v1 = git.revParse(dir, 'v1');
  // Work on the BFF went on: its HEAD no longer calls the backend.
  write(dir, QUOTE_CTRL, BFF_V2);
  sh(dir, ['commit', '-q', '-am', 'bff stops calling it']);
  return { dir, v1, head: git.revParse(dir, 'HEAD') };
}

const backend = makeRepo();
const bff = bffRepo();
const parsed = parsePatch(git.diffPatch(backend.dir, backend.base, backend.head));
const callLine = BFF_V1.split('\n').findIndex((l) => l.includes(CALL)) + 1;

test('a related repository is resolved to the revision the team pins', () => {
  const repos = { 'acme/bff': { checkout: bff.dir } };
  const [pinned] = resolveRelated([{ repo: 'acme/bff', ref: 'v1' }], repos);
  assert.deepEqual(pinned, { name: 'acme/bff', dir: bff.dir, ref: 'v1', sha: bff.v1 });
  const [head] = resolveRelated(['acme/bff'], repos);
  assert.equal(head.sha, bff.head, 'no ref: the checkout\'s HEAD, still frozen as a sha');
  const [byPath] = resolveRelated([{ path: bff.dir, ref: 'v1' }], repos);
  assert.equal(byPath.sha, bff.v1);
  assert.deepEqual(resolveRelated(['acme/missing', { repo: 'acme/bff', ref: 'no-such-tag' }], repos).map((r) => r.error), [
    'acme/missing: not a configured repository with a checkout, nor an existing directory',
    'acme/bff: ref "no-such-tag" does not resolve in its checkout',
  ]);
});

test('impact reads the related repository at the pinned revision, not its working tree', () => {
  const atV1 = analyzeImpact({ cwd: backend.dir, base: backend.base, parsed, related: [{ name: 'acme/bff', dir: bff.dir, sha: bff.v1 }] });
  const edge = atV1.edges.find((e) => e.repo === 'acme/bff');
  assert.ok(edge, JSON.stringify(atV1.edges));
  assert.deepEqual([edge.from.path, edge.from.line, edge.to.symbol], [QUOTE_CTRL, callLine, 'OrderService.discount']);
  assert.deepEqual(atV1.related, [{ name: 'acme/bff', sha: bff.v1, files: 1 }]);
  const atHead = analyzeImpact({ cwd: backend.dir, base: backend.base, parsed, related: [{ name: 'acme/bff', dir: bff.dir, sha: bff.head }] });
  assert.ok(!atHead.edges.some((e) => e.repo), 'HEAD of the BFF no longer calls it');
});

test('a resolvable caller in another repository becomes a caller check', () => {
  const impact = analyzeImpact({ cwd: backend.dir, base: backend.base, parsed, related: [{ name: 'acme/bff', dir: bff.dir, sha: bff.v1 }] });
  const units = assignImpacts([{ id: 'B1', kind: 'business', covers: [`file:${ORDER}`] }], impact);
  const c = units[0].impacts.find((x) => x.repo === 'acme/bff');
  assert.ok(c, JSON.stringify(units[0].impacts));
  assert.equal(c.from.path, QUOTE_CTRL);
});

function context() {
  return {
    context_id: 'ctx-mr',
    source: { checkout: backend.dir, base_sha: backend.base, head_sha: backend.head, related: [{ name: 'acme/bff', dir: bff.dir, sha: bff.v1 }] },
    inputs: [],
  };
}

test('a quote from the related repository is checked at its frozen revision', () => {
  const sources = makeSources(tmpDir('arw-mr-run-'), context());
  const ev = { kind: 'code', repo: 'acme/bff', path: QUOTE_CTRL, start_line: callLine, end_line: callLine, quote: CALL };
  assert.deepEqual(validateEvidence(ev, sources, '$.e'), []);
  // The same line is not in the BFF's HEAD: the frozen v1 is what counts.
  assert.equal(git.showFile(bff.dir, bff.head, QUOTE_CTRL).includes(CALL), false);
  assert.match(validateEvidence({ ...ev, quote: 'return total;' }, sources, '$.e').join('\n'), /quote/);
  assert.match(validateEvidence({ ...ev, repo: 'acme/other' }, sources, '$.e').join('\n'), /acme\/other is not a related repository of this context/);
  assert.match(validateEvidence({ ...ev, revision: 'base' }, sources, '$.e').join('\n'), /read at one frozen revision/);
});

test('a caller check in another repository is answered with a quote from it', () => {
  const sources = makeSources(tmpDir('arw-mr-run2-'), context());
  const DIGEST = 'c'.repeat(64);
  sources.context = { context_digest: DIGEST };
  const check = { id: 'C1', repo: 'acme/bff', from: { path: QUOTE_CTRL, line: callLine, symbol: 'QuoteController.quote' }, to: { path: ORDER, symbol: 'OrderService.discount' }, confidence: 'typed' };
  const unit = { id: 'T1', kind: 'technical', covers: [`file:${ORDER}`], depends_on: [], roles: ['technical'], checks: [], impacts: [check] };
  const headLine = splitLines(git.showFile(backend.dir, backend.head, ORDER)).findIndex((l) => l.includes('if (member')) + 1;
  const orderEv = { kind: 'code', path: ORDER, start_line: headLine, end_line: headLine, quote: 'if (member && total.compareTo(THRESHOLD) > 0) {' };
  const packet = (evidence) => ({
    schema_version: '1.0', context_digest: DIGEST, unit_id: 'T1', role: 'technical', summary: 's', dependency_refs: [],
    coverage: [{ id: `file:${ORDER}`, disposition: 'reviewed', evidence: [orderEv], note: 'n' }],
    item_verdicts: [], viewpoint_verdicts: [], impact_verdicts: [{ caller: 'C1', verdict: 'compatible', evidence, note: 'still takes the same two arguments' }],
    findings: [], recommendation: 'no_findings',
  });
  const check1 = (p) => validatePacket(p, { sources, unit, role: 'technical', items: [], expectedDependencyRefs: [] });
  const bffEv = { kind: 'code', repo: 'acme/bff', path: QUOTE_CTRL, start_line: callLine, end_line: callLine, quote: CALL };
  assert.deepEqual(check1(packet([bffEv])), []);
  // The same path in this repository is not the caller.
  const { repo, ...here } = bffEv;
  assert.equal(repo, 'acme/bff');
  const errors = check1(packet([here]));
  assert.ok(errors.some((e) => /needs code evidence in the caller acme\/bff:/.test(e)), errors.join('\n'));
});

test('the frozen context names the related repositories and their revisions', () => {
  const { freezeContext } = require('../src/lib/freeze');
  assert.equal(typeof freezeContext, 'function');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'freeze.js'), 'utf8');
  assert.match(src, /related:/, 'freezeContext records source.related');
});
