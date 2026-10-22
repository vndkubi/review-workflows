'use strict';
// Statistics for comparing eval runs, deterministic so the same runs always
// give the same numbers:
//   mcnemar       exact two-sided test on the labels one run found and the
//                 other did not (binomial on the discordant pairs)
//   bootstrapDiff a 95% CI for a difference B - A, resampling cases
//   stability     how much repeats of one configuration agree
//   meanSd        mean and sample standard deviation

const round4 = (x) => Math.round(x * 10000) / 10000;

function mcnemar(b, c) {
  const n = b + c;
  if (!n) return { b, c, p: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  let term = 2 ** -n; // C(n, 0) / 2^n
  for (let i = 0; i <= k; i += 1) {
    tail += term;
    term = (term * (n - i)) / (i + 1);
  }
  return { b, c, p: round4(Math.min(1, 2 * tail)) };
}

// A small seeded generator: the same seed gives the same resamples.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// a, b: per-case rows in the same order (case i of a pairs with case i of b).
// metric(rows) -> number or null. Returns { est, lo, hi, n }.
function bootstrapDiff(a, b, metric, { n = 10000, seed = 42 } = {}) {
  const ok = (x) => typeof x === 'number' && Number.isFinite(x);
  const ma = metric(a);
  const mb = metric(b);
  if (!ok(ma) || !ok(mb) || !a.length) return { est: null, lo: null, hi: null, n: 0 };
  const rand = mulberry32(seed);
  const diffs = [];
  for (let r = 0; r < n; r += 1) {
    const idx = Array.from({ length: a.length }, () => Math.floor(rand() * a.length));
    const d = metric(idx.map((i) => b[i])) - metric(idx.map((i) => a[i]));
    if (ok(d)) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);
  const at = (q) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(q * diffs.length)))];
  return { est: round4(mb - ma), lo: diffs.length ? round4(at(0.025)) : null, hi: diffs.length ? round4(at(0.975)) : null, n: diffs.length };
}

function jaccard(x, y) {
  const union = new Set([...x, ...y]);
  if (!union.size) return 1;
  return [...x].filter((v) => y.has(v)).length / union.size;
}

// Two findings point at the same place: same file, overlapping lines.
const SLACK = 3;
function anchorJaccard(fa, fb) {
  const a = fa.filter((f) => f.path);
  const b = fb.filter((f) => f.path);
  if (!a.length && !b.length) return 1;
  const used = new Set();
  let matched = 0;
  for (const f of a) {
    const i = b.findIndex((g, j) => !used.has(j) && g.path === f.path && (!f.lines || !g.lines || (g.lines[0] <= f.lines[1] + SLACK && f.lines[0] <= g.lines[1] + SLACK)));
    if (i >= 0) {
      used.add(i);
      matched += 1;
    }
  }
  return matched / (a.length + b.length - matched);
}

// repeats: [[case score, ...] per repeat]. Mean over repeat pairs and cases.
function stability(repeats) {
  if (repeats.length < 2) return null;
  const labels = [];
  const anchors = [];
  let pairs = 0;
  for (let i = 0; i < repeats.length; i += 1) {
    for (let j = i + 1; j < repeats.length; j += 1) {
      pairs += 1;
      const other = new Map(repeats[j].map((s) => [s.id, s]));
      for (const s of repeats[i]) {
        const t = other.get(s.id);
        if (!t || !s.details || !t.details) continue;
        const found = (x) => new Set((x.details.expected || []).filter((e) => e.found).map((e) => e.id));
        labels.push(jaccard(found(s), found(t)));
        anchors.push(anchorJaccard(s.details.findings || [], t.details.findings || []));
      }
    }
  }
  const mean = (v) => (v.length ? round4(v.reduce((x, y) => x + y, 0) / v.length) : null);
  return { labels: mean(labels), anchors: mean(anchors), pairs };
}

function meanSd(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { mean: null, sd: null };
  const mean = v.reduce((x, y) => x + y, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((n, x) => n + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean: round4(mean), sd: round4(sd) };
}

module.exports = { mcnemar, bootstrapDiff, stability, meanSd, mulberry32, jaccard, anchorJaccard };
