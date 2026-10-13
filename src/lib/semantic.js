'use strict';
// Meaning-level similarity of two findings, deterministic and offline:
//   concepts  words reduced to a stem and folded into review vocabulary
//             ("threshold", "limit", "edge" -> boundary; "float", "rounding",
//             "decimal" -> precision), so a rephrased finding still matches;
//   anchor    where the finding points in code: file, the enclosing method or
//             function (from the structural index), the checklist/requirement
//             it cites, and the identifiers of the code it would change.
// Two findings about the same method that change the same code are the same
// concern however they are worded.
const { jaccard } = require('./cluster');

// Canonical concept -> words that mean it in review findings.
const GROUPS = {
  boundary: ['boundary', 'threshold', 'limit', 'edge', 'inclusive', 'exclusive', 'cutoff', 'border', 'exact', 'exactly', 'off-by-one', 'off by one'],
  precision: ['float', 'floating', 'double', 'rounding', 'round', 'decimal', 'precision', 'cent', 'cents', 'fraction', 'bigdecimal', 'binary'],
  missing: ['null', 'none', 'nil', 'missing', 'empty', 'absent', 'undefined', 'unset', 'npe', 'nullpointerexception'],
  error: ['error', 'exception', 'throw', 'raise', 'crash', 'fail', 'failure', 'swallow', 'catch', 'unhandled'],
  concurrency: ['race', 'concurrent', 'concurrency', 'thread', 'lock', 'atomic', 'synchronized', 'parallel', 'simultaneous'],
  transaction: ['transaction', 'transactional', 'rollback', 'commit', 'atomicity', 'partial'],
  idempotency: ['idempotent', 'idempotency', 'duplicate', 'retry', 'redelivery', 'twice', 'replay'],
  timeout: ['timeout', 'hang', 'block', 'blocking', 'deadline'],
  injection: ['injection', 'concatenation', 'concatenate', 'unsanitized', 'sanitize', 'escape', 'interpolation'],
  auth: ['authorization', 'authorisation', 'permission', 'access', 'auth', 'authenticate', 'role', 'privilege'],
  secret: ['secret', 'password', 'token', 'credential', 'leak', 'expose', 'pii', 'personal'],
  test: ['test', 'tests', 'coverage', 'untested', 'assert', 'assertion'],
  compat: ['compatibility', 'compatible', 'caller', 'callers', 'signature', 'contract', 'breaking', 'backward', 'api', 'argument', 'parameter', 'default'],
  money: ['money', 'amount', 'price', 'fee', 'discount', 'refund', 'charge', 'total', 'currency', 'payment'],
  time: ['date', 'time', 'timezone', 'zone', 'utc', 'datetime', 'timestamp', 'clock'],
  logging: ['log', 'logging', 'logger', 'message'],
  resource: ['leak', 'close', 'closed', 'resource', 'stream', 'connection', 'release'],
  validation: ['validate', 'validation', 'check', 'guard', 'verify', 'input'],
};

const CANON = new Map();
for (const [concept, list] of Object.entries(GROUPS)) for (const w of list) if (!w.includes(' ')) CANON.set(w, concept);

const STOP = new Set('a an the of to in on for and or is are be by with when not no it its this that from at as can may does do should would could will was were has have had into than then only also but if so such which who there their they them these those because while where being been about over under after before more less same any each every all some'.split(' '));

function stem(w) {
  if (w.length <= 4) return w;
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ies', 'ied', 'ers', 'er', 'ed', 'es', 'ly', 's']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return suf === 'ies' || suf === 'ied' ? `${w.slice(0, -3)}y` : w.slice(0, -suf.length);
  }
  return w;
}

// Concept set of a text: canonical concepts plus stems of other content words.
function concepts(text) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  for (const [concept, list] of Object.entries(GROUPS)) for (const phrase of list) if (phrase.includes(' ') && lower.includes(phrase)) out.add(`#${concept}`);
  for (const raw of lower.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw) && raw.length < 4) continue;
    const c = CANON.get(raw) || CANON.get(stem(raw));
    out.add(c ? `#${c}` : stem(raw));
  }
  return out;
}

// Identifiers of a code snippet (for comparing what two fixes would change).
function codeTokens(code) {
  return new Set(String(code || '').split(/[^A-Za-z0-9_$]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t)));
}

// anchor: { path, symbol, authority, fix: [identifiers] }
function similarityOf(a, b) {
  const text = jaccard(concepts(`${a.title} ${a.asis}`), concepts(`${b.title} ${b.asis}`));
  let structural = 0;
  // The same method alone is not enough (two defects often share one): the
  // two must also change the same code or cite the same checklist/requirement.
  if (a.anchor && b.anchor && a.anchor.path && a.anchor.path === b.anchor.path && a.anchor.symbol && a.anchor.symbol === b.anchor.symbol) {
    const sameAuthority = Boolean(a.anchor.authority && a.anchor.authority === b.anchor.authority);
    const fix = jaccard(new Set(a.anchor.fix || []), new Set(b.anchor.fix || []));
    if (fix >= 0.5 || sameAuthority) structural = 0.3 + (sameAuthority ? 0.25 : 0) + 0.25 * fix + 0.4 * text;
  }
  return { score: Math.min(1, Math.max(text, structural)), text, structural };
}

module.exports = { concepts, codeTokens, similarityOf, stem, GROUPS };
