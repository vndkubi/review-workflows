'use strict';
// Model-free verdict over a whole run: per-finding state, completeness and the
// recommendation. A recommendation is never an approval; the human gate is
// separate and recorded only by `arw gate`.

const BLOCKING = new Set(['P1', 'P2']);

// packets: [{ unit_id, role, packet }] (valid packets only)
// jobs:    [{ unit_id, role, required, status }]
// clusters: findingClusters output; rebuttals: Map finding_id -> rebuttal
function computeOutcome({ packets, jobs, clusters, rebuttals, items }) {
  const findings = [];
  const clusterOf = new Map();
  for (const c of clusters) for (const id of c.members) clusterOf.set(id, c);

  for (const { unit_id, role, packet } of packets) {
    for (const f of packet.findings) {
      const cluster = clusterOf.get(f.id);
      const own = rebuttals.get(f.id);
      let state;
      let rebuttalFrom = null;
      if (!BLOCKING.has(f.severity)) {
        state = 'not_challenged';
      } else if (own) {
        state = { FINDING_STANDS: 'stands', FINDING_WITHDRAWN: 'withdrawn', UNRESOLVED: 'unresolved' }[own.verdict];
        rebuttalFrom = f.id;
      } else {
        // A STANDS verdict covers the other blocking members of the cluster;
        // a withdrawal never propagates.
        const donor = cluster && cluster.members.find((id) => id !== f.id && rebuttals.get(id) && rebuttals.get(id).verdict === 'FINDING_STANDS');
        if (donor) {
          state = 'stands';
          rebuttalFrom = donor;
        } else {
          state = 'unverified';
        }
      }
      findings.push({
        id: f.id,
        unit_id,
        role,
        severity: f.severity,
        confidence: f.confidence,
        title: f.title,
        state,
        rebuttal_from: rebuttalFrom,
        cluster_id: cluster ? cluster.id : null,
        canonical: cluster ? cluster.canonical_id === f.id : true,
        votes: cluster ? cluster.votes : 1,
        // Static, quote-validated evidence only. CONFIRMED needs an executed
        // reproduction (L3); agreement between models is not proof.
        evidence_level: 'L1',
        label: state === 'withdrawn' ? 'NOT_A_BUG' : 'SUSPECTED',
      });
    }
  }

  const gaps = [];
  for (const job of jobs) {
    if (job.required && job.status !== 'EXECUTED_PASS') gaps.push(`${job.unit_id}/${job.role} is ${job.status}`);
  }
  const verdicts = new Map();
  for (const { unit_id, role, packet } of packets) {
    for (const v of packet.item_verdicts) {
      if (!verdicts.has(v.item)) verdicts.set(v.item, []);
      verdicts.get(v.item).push({ unit_id, role, verdict: v.verdict, note: v.note });
    }
  }
  // Risky items with an expected result must be decided; gaps and
  // contradictions are reported, not decided.
  for (const item of items || []) {
    if (item.risk === 'normal' || !['rule', 'boundary', 'ac'].includes(item.kind)) continue;
    const vs = (verdicts.get(item.id) || []).filter((v) => v.role === 'business');
    if (!vs.some((v) => v.verdict !== 'cannot_determine')) gaps.push(`${item.id} (${item.risk} risk ${item.kind}) has no determinate business verdict`);
  }
  // Per-item grading for the report: fail beats pass; any pass beats "unknown".
  const itemResults = (items || []).map((item) => {
    const vs = verdicts.get(item.id) || [];
    const has = (x) => vs.some((v) => v.verdict === x);
    const result = has('fail') ? 'fail' : has('pass') ? 'pass' : has('not_applicable') ? 'not_applicable' : vs.length ? 'cannot_determine' : 'not_graded';
    return { id: item.id, kind: item.kind, risk: item.risk, result, verdicts: vs };
  });

  const blockingOpen = findings.filter((f) => BLOCKING.has(f.severity) && f.state !== 'withdrawn');
  let recommendation = 'no_blocking_findings';
  if (blockingOpen.length) recommendation = 'changes_requested';
  else if (gaps.length) recommendation = 'needs_investigation';

  return { findings, gaps, complete: gaps.length === 0, recommendation, items: itemResults };
}

module.exports = { computeOutcome, BLOCKING };
