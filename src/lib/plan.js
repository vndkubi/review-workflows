'use strict';
// Turns the planner's B/T proposal into the enforced unit ledger. Orphans (O),
// seams (S) and the whole-diff viewpoints (V0, V1) are added by code, so the
// coverage rules never depend on the model remembering them.

const ORPHAN_CHUNK = 8;

function viewpointChunkSize() {
  const n = Number(process.env.ARW_VIEWPOINT_FILES);
  return Number.isInteger(n) && n > 0 ? n : 25;
}

// Files sorted by path, cut into near-equal parts of at most the chunk size,
// so each part holds neighbouring directories.
function viewpointChunks(files) {
  const size = viewpointChunkSize();
  if (files.length <= size) return [files];
  const sorted = [...files].sort();
  const parts = Math.ceil(sorted.length / size);
  const per = Math.ceil(sorted.length / parts);
  const out = [];
  for (let i = 0; i < sorted.length; i += per) out.push(sorted.slice(i, i + per));
  return out;
}

function dirSummary(files) {
  const dirs = [...new Set(files.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.')))];
  return dirs.length <= 3 ? dirs.join(', ') : `${dirs.slice(0, 3).join(', ')} and ${dirs.length - 3} more director${dirs.length - 3 === 1 ? 'y' : 'ies'}`;
}

const VIEWPOINTS = [
  { id: 'V0', roles: ['technical'], desc: 'Whole-diff technical sweep: checklist viewpoints, error handling, transactions, concurrency, compatibility, tests.' },
  { id: 'V1', roles: ['business'], desc: 'Whole-diff business sweep: business invariants, data consistency, behaviour changes the requirements do not mention.' },
];

// Returns { units, required_coverage, errors }. Errors are phrased for the
// planner's repair prompt.
// items: review items (spec-derived, or one per requirement item) or null.
function buildUnits(plan, reviewableFiles, items, { singleRole = false } = {}) {
  const errors = [];
  const fileSet = new Set(reviewableFiles);
  const reviewItems = Array.isArray(items) ? items : [];
  const itemIds = new Set(reviewItems.map((i) => i.id));
  const units = [];
  const seen = new Set();

  for (const u of plan.units) {
    if (seen.has(u.id)) errors.push(`unit ${u.id} is defined twice`);
    seen.add(u.id);
    const expectedKind = u.id.startsWith('B') ? 'business' : 'technical';
    if (u.kind !== expectedKind) errors.push(`unit ${u.id}: id prefix ${u.id[0]} requires kind "${expectedKind}"`);
    if (u.kind === 'technical' && u.items.length) errors.push(`unit ${u.id}: only business (B*) units may cover review items`);
    for (const f of u.files) if (!fileSet.has(f)) errors.push(`unit ${u.id}: "${f}" is not a reviewable changed file`);
    for (const id of u.items) if (!itemIds.has(id)) errors.push(`unit ${u.id}: ${id} is not a review item id`);
    const roles = u.kind === 'business' ? (singleRole ? ['business'] : ['business', 'technical']) : ['technical'];
    units.push({
      id: u.id,
      kind: u.kind,
      desc: u.desc,
      covers: [...new Set([...u.files.map((f) => `file:${f}`), ...u.items])],
      depends_on: [],
      required: true,
      roles,
      status: 'NOT_RUN',
    });
  }

  // Every review item is graded, gaps and contradictions included (the
  // reviewer reports what the code does where the spec is silent).
  for (const item of reviewItems) {
    if (!units.some((u) => u.kind === 'business' && u.covers.includes(item.id))) {
      errors.push(`${item.id} (${item.kind}) is not covered by any business (B*) unit`);
    }
  }

  // Orphans: changed files no proposed unit claims.
  const claimed = new Set(units.flatMap((u) => u.covers.filter((c) => c.startsWith('file:')).map((c) => c.slice(5))));
  const orphans = reviewableFiles.filter((f) => !claimed.has(f));
  for (let i = 0; i < orphans.length; i += ORPHAN_CHUNK) {
    const chunk = orphans.slice(i, i + ORPHAN_CHUNK);
    units.push({
      id: `O${i / ORPHAN_CHUNK + 1}`,
      kind: 'orphan',
      desc: `Files no planned unit claimed: ${chunk.join(', ')}`,
      covers: chunk.map((f) => `file:${f}`),
      depends_on: [],
      required: true,
      roles: ['technical'],
      status: 'NOT_RUN',
    });
  }

  // Seams: files claimed by 2+ substantive units, grouped by the set of units.
  const owners = new Map();
  for (const u of units) {
    for (const c of u.covers) {
      if (!c.startsWith('file:')) continue;
      if (!owners.has(c)) owners.set(c, []);
      owners.get(c).push(u.id);
    }
  }
  const seamGroups = new Map();
  for (const [cover, ids] of owners) {
    if (ids.length < 2) continue;
    const key = [...ids].sort().join('+');
    if (!seamGroups.has(key)) seamGroups.set(key, { depends_on: [...ids].sort(), covers: [] });
    seamGroups.get(key).covers.push(cover);
  }
  let s = 0;
  for (const group of seamGroups.values()) {
    s += 1;
    units.push({
      id: `S${s}`,
      kind: 'seam',
      desc: `Seam between ${group.depends_on.join(', ')}: interactions in shared files`,
      covers: group.covers,
      depends_on: group.depends_on,
      required: true,
      roles: ['technical'],
      status: 'NOT_RUN',
    });
  }

  // A viewpoint answers one coverage row per file. On a large PR one sweep
  // over everything produces an answer too long to stay accurate, so the
  // sweep is split into parts of related files (sorted by path).
  const chunks = viewpointChunks(reviewableFiles);
  for (const v of VIEWPOINTS) {
    chunks.forEach((files, i) => {
      const id = chunks.length === 1 ? v.id : `${v.id}_${i + 1}`;
      units.push({
        id,
        kind: 'viewpoint',
        desc: chunks.length === 1 ? v.desc : `${v.desc} Part ${i + 1}/${chunks.length}: ${dirSummary(files)}.`,
        covers: [`viewpoint:${id}`, ...files.map((f) => `file:${f}`)],
        depends_on: [],
        required: true,
        roles: v.roles,
        status: 'NOT_RUN',
      });
    });
  }

  const required_coverage = [...new Set(units.flatMap((u) => u.covers))].sort();
  return { units, required_coverage, errors };
}

// The single-agent baseline: one unit over every reviewable file (and every
// review item, graded by a business reviewer when there are items), no
// orphans, seams or viewpoints. Used to measure what the multi-agent waves add.
function singleAgentUnits(reviewableFiles, items) {
  const hasItems = Boolean(items && items.length);
  const unit = {
    id: hasItems ? 'B1' : 'T1',
    kind: hasItems ? 'business' : 'technical',
    desc: 'Single-agent baseline: the whole change, one reviewer.',
    covers: [...reviewableFiles.map((f) => `file:${f}`), ...(hasItems ? items.map((i) => i.id) : [])],
    depends_on: [],
    required: true,
    roles: [hasItems ? 'business' : 'technical'],
    status: 'NOT_RUN',
  };
  const plan = { schema_version: '1.0', hypotheses: [], units: [{ id: unit.id, kind: unit.kind, desc: unit.desc, files: reviewableFiles, items: hasItems ? items.map((i) => i.id) : [] }], gaps: [], notes: 'single-agent baseline (no planner)' };
  return { units: [unit], required_coverage: [...unit.covers].sort(), errors: [], plan };
}

function renderPlanMarkdown({ identity, plan, units, items, reviewable, skipped }) {
  const out = [];
  out.push(`# Review plan — ${identity.repo}#${identity.pr}`, '');
  out.push(`${identity.title}`, '', `- head: \`${identity.head_sha}\``, `- base (merge-base): \`${identity.base_sha}\``);
  out.push(`- ticket: ${identity.ticket || '(none found)'}`, `- review items: ${items && items.length ? items.length : 'none (no ticket spec or requirements)'}`, '');
  out.push('## Hypotheses', '');
  if (!plan.hypotheses.length) out.push('(none)');
  plan.hypotheses.forEach((h) => out.push(`- **${h.id}** [${h.confidence}] ${h.statement}${h.items.length ? ` — ${h.items.join(', ')}` : ''}`));
  out.push('', '## Units', '', '| Unit | Kind | Roles | Covers | Depends on | Description |', '|---|---|---|---|---|---|');
  for (const u of units) {
    out.push(`| ${u.id} | ${u.kind} | ${u.roles.join(', ')} | ${u.covers.length} | ${u.depends_on.join(', ') || '—'} | ${u.desc.replace(/\|/g, '\\|')} |`);
  }
  out.push('', `## Coverage ledger (${reviewable.length} reviewable files)`, '');
  for (const f of reviewable) {
    const owners = units.filter((u) => u.covers.includes(`file:${f}`)).map((u) => u.id);
    out.push(`- \`${f}\` → ${owners.join(', ')}`);
  }
  if (skipped.length) out.push('', '## Not reviewable', '', ...skipped.map((f) => `- \`${f}\``));
  out.push('', '## Gaps called out by the planner', '');
  out.push(...(plan.gaps.length ? plan.gaps.map((g) => `- ${g}`) : ['(none)']));
  if (plan.notes) out.push('', '## Notes', '', plan.notes);
  return `${out.join('\n')}\n`;
}

module.exports = { buildUnits, singleAgentUnits, renderPlanMarkdown, VIEWPOINTS };
