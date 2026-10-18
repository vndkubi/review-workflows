'use strict';
// Model-free verdict over a whole run: per-finding state, completeness and the
// recommendation. A recommendation is never an approval; the human gate is
// separate and recorded only by `arw gate`.

const BLOCKING = new Set(['P1', 'P2']);

// packets: [{ unit_id, role, packet }] (valid packets only)
// jobs:    [{ unit_id, role, required, status }]
// clusters: findingClusters output; rebuttals: Map finding_id -> rebuttal
// repro: Map finding_id -> validated repro record (repro.loadReproRecords).
// reviewable: the frozen reviewable files; each needs a "reviewed" row somewhere.
// units: the review units; their assigned viewpoints form the matrix.
function computeOutcome({ packets, jobs, clusters, rebuttals, items, repro = new Map(), reviewable = null, units = [] }) {
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
      // Execution beats a model's withdrawal: a test that failed twice on the
      // reviewed head keeps the finding open.
      let repro_ = reproFields(f.id, cluster, repro, state);
      let overruled = false;
      if (state === 'withdrawn') {
        const proven = reproFields(f.id, cluster, repro, 'stands');
        if (proven.evidence_level !== 'L1') {
          state = 'stands';
          repro_ = proven;
          overruled = true;
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
        withdrawal_overruled: overruled,
        ...repro_,
      });
    }
  }

  const gaps = [];
  for (const job of jobs) {
    if (job.required && job.status !== 'EXECUTED_PASS') gaps.push(`${job.unit_id}/${job.role} is ${job.status}`);
  }
  // "unverified" is an honest answer from one reviewer, but a changed file
  // that no valid packet reviewed was not reviewed at all.
  if (reviewable) {
    const reviewed = new Set();
    for (const { packet } of packets) for (const row of packet.coverage || []) if (row.disposition === 'reviewed') reviewed.add(row.id);
    for (const file of reviewable) if (!reviewed.has(`file:${file}`)) gaps.push(`file:${file} has no "reviewed" coverage in any valid packet`);
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
    // A technical item (a contract of the code) may be decided by either
    // reviewer; a business item needs the business reviewer.
    const technical = item.nature === 'technical';
    const vs = (verdicts.get(item.id) || []).filter((v) => v.role === 'business' || (technical && v.role === 'technical'));
    if (!vs.some((v) => v.verdict !== 'cannot_determine')) gaps.push(`${item.id} (${item.risk} risk ${item.kind}) has no determinate ${technical ? '' : 'business '}verdict`);
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

  return { findings, gaps, complete: gaps.length === 0, recommendation, items: itemResults, checks: viewpointMatrix(units, packets), impacts: impactMatrix(units, packets) };
}

// One cell per assigned viewpoint of each unit. A cell no valid packet
// answered stays in the matrix as "not_answered": a blind spot is shown, not
// dropped.
function viewpointMatrix(units, packets) {
  const cells = [];
  for (const u of units || []) {
    for (const viewpoint of u.checks || []) {
      const answers = packets.filter((p) => p.unit_id === u.id).flatMap((p) => (p.packet.viewpoint_verdicts || []).filter((v) => v.viewpoint === viewpoint).map((v) => ({ role: p.role, ...v })));
      const v = answers[0];
      cells.push({ unit_id: u.id, viewpoint, verdict: v ? v.verdict : 'not_answered', note: v ? v.note : '', role: v ? v.role : null });
    }
  }
  return cells;
}

// One cell per assigned caller of each unit, like the viewpoint matrix.
function impactMatrix(units, packets) {
  const cells = [];
  for (const u of units || []) {
    for (const c of u.impacts || []) {
      const v = packets.filter((p) => p.unit_id === u.id).flatMap((p) => (p.packet.impact_verdicts || []).filter((x) => x.caller === c.id).map((x) => ({ role: p.role, ...x })))[0];
      cells.push({ unit_id: u.id, caller: c.id, from: c.from, to: c.to, confidence: c.confidence, verdict: v ? v.verdict : 'not_answered', note: v ? v.note : '', role: v ? v.role : null });
    }
  }
  return cells;
}

// Static, quote-validated evidence is L1 (SUSPECTED); agreement between models
// is not proof. CONFIRMED needs a harness-executed test that failed twice on
// the reviewed head (L3). A record is shared by its duplicate cluster.
function reproFields(id, cluster, repro, state) {
  const from = repro.has(id) ? id : cluster ? cluster.members.find((m) => repro.has(m)) : null;
  const rec = from ? repro.get(from) : null;
  const out = { evidence_level: 'L1', label: state === 'withdrawn' ? 'NOT_A_BUG' : 'SUSPECTED', repro: null };
  if (!rec) return out;
  // Recomputed from the runs when the record is loaded; a record without the
  // field (built by hand, or before controls existed) has none.
  const control = rec.control !== undefined ? rec.control : rec.fix && rec.fix.verified === true ? 'fix' : (rec.runs || []).some((r) => r.phase === 'base' && r.status === 'green') ? 'base' : null;
  out.repro = {
    status: rec.status,
    from,
    test: rec.test ? rec.test.selector : null,
    fix_verified: rec.fix ? rec.fix.verified : null,
    control,
    reason: rec.reason || null,
  };
  // A test that fails twice shows a stable failure, not its cause. CONFIRMED
  // needs a control: the finding's fix makes it pass, or the base passes it.
  if (rec.status === 'RED_PROVEN' && state !== 'withdrawn') {
    if (control) {
      out.label = 'CONFIRMED';
      out.evidence_level = 'L3';
    } else {
      out.label = 'REPRODUCED';
      out.evidence_level = 'L2';
    }
  }
  return out;
}

// The synthesis aliases that may hide a finding from the report and the
// published review. The coordinator's word is enough for P3/P4; a P1/P2 is
// hidden only when the runtime put both findings in the same duplicate cluster.
function effectiveAliases(synthesis, metas) {
  const byId = new Map(metas.map((m) => [m.id, m]));
  return (synthesis ? synthesis.aliases : []).filter((a) => {
    const m = byId.get(a.id);
    const to = byId.get(a.duplicate_of);
    if (!m || !BLOCKING.has(m.severity)) return true;
    return Boolean(m.cluster_id && to && to.cluster_id === m.cluster_id);
  });
}

module.exports = { computeOutcome, reproFields, effectiveAliases, BLOCKING };
