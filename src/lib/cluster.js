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

function isDuplicate(a, b) {
  const sim = jaccard(words(a.title), words(b.title));
  return sim >= 0.6 || (spansOverlap(a, b) && sim >= 0.2) || (sameAsis(a, b) && sim >= 0.1);
}

// entries: [{ finding, voter }] -> [{ id, canonical_id, members, voters, votes, severity }]
// Members are sorted most severe first; the canonical member leads.
function findingClusters(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i].voter === entries[j].voter) continue;
      if (isDuplicate(entries[i].finding, entries[j].finding)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  entries.forEach((e, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  });
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
