'use strict';
// Duplicate clustering. A voter is one independent packet (unit/role); the
// same defect reported by several voters is corroboration (votes), and costs
// only one red-team rebuttal.
const { collapse } = require('./validate');

const STOPWORDS = new Set(
  'a an the of to in on for and or is are be by with when not no it its this that from at as can may does do should missing wrong incorrect'.split(' '),
);
const SEVERITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };
const SPAN_SLACK = 3;

function words(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function spansOverlap(a, b) {
  return a.evidence.some((x) =>
    b.evidence.some(
      (y) =>
        x.kind === 'code' &&
        y.kind === 'code' &&
        x.path === y.path &&
        (x.revision || 'reviewed') === (y.revision || 'reviewed') &&
        x.start_line <= y.end_line + SPAN_SLACK &&
        y.start_line <= x.end_line + SPAN_SLACK,
    ),
  );
}

function sameAsis(a, b) {
  const x = collapse(a.fix.asis);
  return a.fix.kind === 'code_change' && b.fix.kind === 'code_change' && x.length >= 10 && x === collapse(b.fix.asis);
}

const SAME_TITLE = 0.6;

// 0 when not duplicates, otherwise how strongly they look alike.
function duplicateStrength(a, b) {
  const sim = jaccard(words(a.title), words(b.title));
  const overlap = spansOverlap(a, b);
  const asis = sameAsis(a, b);
  if (!(sim >= SAME_TITLE || (overlap && sim >= 0.2) || (asis && sim >= 0.1))) return 0;
  return sim + (overlap ? 0.3 : 0) + (asis ? 0.3 : 0);
}

function isDuplicate(a, b) {
  return duplicateStrength(a, b) > 0;
}

// entries: [{ finding, voter }] -> [{ id, canonical_id, members, voters, votes, severity }]
// Members are sorted most severe first; the canonical member leads.
//
// Pairs merge strongest first. A voter that reported two findings with
// different titles saw two defects, so no merge may put both in one cluster
// (otherwise a chain of look-alike pairs - easy in a small file where every
// span overlaps - folds distinct defects together and hides one of them).
function findingClusters(entries) {
  const pairs = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i].voter === entries[j].voter) continue;
      const s = duplicateStrength(entries[i].finding, entries[j].finding);
      if (s > 0) pairs.push([s, i, j]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
  const distinct = (i, j) => entries[i].voter === entries[j].voter && jaccard(words(entries[i].finding.title), words(entries[j].finding.title)) < SAME_TITLE;
  const clusterOf = entries.map((_, i) => i);
  const members = new Map(entries.map((_, i) => [i, [i]]));
  for (const [, i, j] of pairs) {
    const a = clusterOf[i];
    const b = clusterOf[j];
    if (a === b) continue;
    if (members.get(a).some((x) => members.get(b).some((y) => distinct(x, y)))) continue;
    for (const x of members.get(b)) clusterOf[x] = a;
    members.get(a).push(...members.get(b));
    members.delete(b);
  }
  const groups = new Map([...members.entries()].map(([k, list]) => [k, list.map((i) => entries[i])]));
  const clusters = [...groups.values()].map((members) => {
    members.sort((x, y) => SEVERITY_RANK[x.finding.severity] - SEVERITY_RANK[y.finding.severity] || x.finding.id.localeCompare(y.finding.id));
    const voters = [...new Set(members.map((m) => m.voter))].sort();
    return {
      canonical_id: members[0].finding.id,
      members: members.map((m) => m.finding.id),
      voters,
      votes: voters.length,
      severity: members[0].finding.severity,
    };
  });
  clusters.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.canonical_id.localeCompare(b.canonical_id));
  clusters.forEach((c, i) => {
    c.id = `C${i + 1}`;
  });
  return clusters;
}

module.exports = { findingClusters, jaccard, words, isDuplicate, SEVERITY_RANK };
