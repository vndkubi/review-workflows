'use strict';
// Direct quotes with exact bytes but a wrong or missing line range are
// re-located, not repaired: coverage, item verdicts and overview evidence
// all use the same canonicalizer. Ambiguous code quotes stay rejected.
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalizeCandidate, validateEvidence } = require('../src/lib/validate');

const UNIQUE = 'uniqueLine();';
const DUP = 'duplicateLine();';
const LINES = ['one();', 'two();', UNIQUE, 'three();', DUP, 'four();', DUP, 'five();'];

const sources = {
  code: () => LINES,
  input: () => null,
  artifact: () => null,
  artifactSha: () => null,
  inputIds: () => [],
  anchors: () => [],
};

const ev = (over = {}) => ({ kind: 'code', path: 'src/a.js', start_line: 1, end_line: 1, quote: UNIQUE, ...over });

function candidate(evidence) {
  const copy = () => ({ ...evidence });
  return {
    evidence: [copy()],
    coverage: [{ id: 'file:src/a.js', evidence: [copy()] }],
    item_verdicts: [{ item: 'I1', evidence: [copy()] }],
    overview: [{ evidence: [copy()] }],
  };
}

test('an exact direct quote with wrong or missing lines is accepted at the found lines', () => {
  for (const range of [{ start_line: 1, end_line: 1 }, { start_line: null, end_line: null }]) {
    const packet = candidate(ev(range));
    const changes = canonicalizeCandidate(packet, sources);
    for (const section of [packet.evidence[0], packet.coverage[0].evidence[0], packet.item_verdicts[0].evidence[0], packet.overview[0].evidence[0]]) {
      assert.equal(section.start_line, 3);
      assert.equal(section.end_line, 3);
      assert.equal(section.quote, UNIQUE, 'the bytes are never rewritten');
    }
    assert.equal(changes.filter((c) => /canonicalized/.test(c)).length, 4, changes.join('\n'));
    for (const section of [packet.evidence[0], packet.coverage[0].evidence[0], packet.item_verdicts[0].evidence[0], packet.overview[0].evidence[0]]) {
      assert.deepEqual(validateEvidence(section, sources, '$.x'), []);
    }
  }
});

test('a duplicate code quote stays rejected, even when it is near the cited line', () => {
  const packet = candidate(ev({ start_line: 1, end_line: 1, quote: DUP }));
  const changes = canonicalizeCandidate(packet, sources);
  assert.deepEqual(changes, [], 'an ambiguous quote is not re-anchored');
  assert.match(validateEvidence(packet.evidence[0], sources, '$.evidence[0]').join('\n'), /ambiguous|more than once/);
});

test('a quote that is not in the file stays rejected', () => {
  const packet = candidate(ev({ quote: 'notInTheFile();' }));
  const changes = canonicalizeCandidate(packet, sources);
  assert.deepEqual(changes, []);
  assert.match(validateEvidence(packet.evidence[0], sources, '$.evidence[0]').join('\n'), /quote not found/);
});

test('whitespace-only differences keep the validator behaviour they have today', () => {
  const packet = candidate(ev({ start_line: 3, end_line: 3, quote: '  uniqueLine();  ' }));
  const changes = canonicalizeCandidate(packet, sources);
  assert.deepEqual(changes, [], 'no repair and no canonicalization note for a whitespace match');
  assert.deepEqual(validateEvidence(packet.evidence[0], sources, '$.evidence[0]'), []);
});
