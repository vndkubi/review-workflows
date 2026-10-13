'use strict';
// Checklist mining: proposals for config/policies/checklist.md from what
// people did with published findings.
//   - add:     the same kind of defect kept by reviewers in several PRs, not
//              yet covered by a checklist item -> a new viewpoint;
//   - avoid:   look-alike findings rejected again and again -> a "do not
//              report" line, so reviewers stop raising them;
//   - revise:  a checklist item whose findings are mostly dropped.
// Proposals are only proposals: a person edits the wording and accepts one,
// and the change shows in every later review as a new frozen policy hash.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJsonIfExists, sha256 } = require('./util');
const { RUNS } = require('./runs');
const { revisionDir } = require('./freeze');
const { packetRel } = require('./driver');
const { words, jaccard } = require('./cluster');
const { concepts } = require('./semantic');
const memory = require('./memory');

const GROUP_SIMILARITY = 0.35;

function checklistFile() {
  return process.env.ARW_CHECKLIST_FILE ? path.resolve(process.env.ARW_CHECKLIST_FILE) : path.join(ROOT, 'config', 'policies', 'checklist.md');
}

function checklistIds(text) {
  return [...String(text).matchAll(/^- (CK-[A-Z]+-\d+):/gm)].map((m) => m[1]);
}

// Findings people decided on, with the full finding text.
function decidedFindings() {
  const base = path.join(RUNS, 'prs');
  const out = [];
  if (!fs.existsSync(base)) return out;
  const rejected = new Map(memory.loadMemory().entries.map((e) => [`${e.run}\0${e.finding_id}`, e]));
  for (const id of fs.readdirSync(base)) {
    const dir = path.join(base, id);
    const run = readJsonIfExists(path.join(dir, 'run.json'));
    const pointer = readJsonIfExists(path.join(dir, 'review', 'context.json'));
    if (!run || !pointer) continue;
    const fb = readJsonIfExists(path.join(dir, 'feedback.json'));
    const verdicts = new Map(((fb && fb.findings) || []).map((f) => [f.id, f.verdict]));
    const ctxId = (fb && fb.context_id) || pointer.context_id;
    const v = readJsonIfExists(path.join(revisionDir(dir, ctxId), 'validation.json'));
    if (!v) continue;
    for (const job of v.jobs) {
      if (job.status !== 'EXECUTED_PASS') continue;
      const packet = readJsonIfExists(path.join(revisionDir(dir, ctxId), packetRel(job.unit_id, job.role)));
      for (const f of (packet && packet.findings) || []) {
        const verdict = verdicts.get(f.id);
        const rej = rejected.get(`${id}\0${f.id}`);
        const outcome = verdict === 'kept' || verdict === 'edited' ? 'kept' : verdict === 'dropped' || rej ? 'rejected' : null;
        if (!outcome) continue;
        out.push({ run: id, repo: run.identity.repo, finding: f, outcome, reason: rej ? rej.reason : null });
      }
    }
  }
  return out;
}

// Same kind of finding: by words or by concepts (rephrasings), whichever is closer.
function group(list) {
  const groups = [];
  for (const d of list) {
    const text = `${d.finding.title} ${d.finding.asis}`;
    const w = words(text);
    const c = concepts(text);
    const g = groups.find((x) => Math.max(jaccard(x.words, w), jaccard(x.concepts, c)) >= GROUP_SIMILARITY);
    if (g) {
      g.members.push(d);
      for (const x of w) g.words.add(x);
      for (const x of c) g.concepts.add(x);
    } else groups.push({ words: new Set(w), concepts: new Set(c), members: [d] });
  }
  return groups;
}

function proposalId(kind, members) {
  return `${kind}-${sha256(members.map((m) => `${m.run}/${m.finding.id}`).sort().join('|')).slice(0, 8)}`;
}

function shortest(titles) {
  return [...titles].sort((a, b) => a.length - b.length)[0];
}

function mineChecklist({ minRuns = 2 } = {}) {
  const decided = decidedFindings();
  const text = fs.existsSync(checklistFile()) ? fs.readFileSync(checklistFile(), 'utf8') : '';
  const known = new Set(checklistIds(text));
  const proposals = [];

  // add: kept defects with no checklist authority, seen in several runs.
  const keptUncovered = decided.filter((d) => d.outcome === 'kept' && d.finding.authority && d.finding.authority.kind !== 'curated_viewpoint');
  for (const g of group(keptUncovered)) {
    const runs = new Set(g.members.map((m) => m.run));
    if (runs.size < minRuns) continue;
    proposals.push({
      id: proposalId('add', g.members),
      kind: 'add',
      text: shortest(g.members.map((m) => m.finding.title)),
      evidence: `kept in ${runs.size} reviews (${[...new Set(g.members.map((m) => m.repo))].join(', ')}) with no checklist item behind it`,
      examples: g.members.slice(0, 5).map((m) => ({ run: m.run, finding: m.finding.id, title: m.finding.title, severity: m.finding.severity })),
    });
  }

  // avoid: look-alike rejections across runs. Findings that cite a
  // checklist item are judged under "revise" for that item instead.
  const citesKnown = (d) => d.finding.authority && d.finding.authority.kind === 'curated_viewpoint' && known.has(d.finding.authority.id);
  for (const g of group(decided.filter((d) => d.outcome === 'rejected' && !citesKnown(d)))) {
    const runs = new Set(g.members.map((m) => m.run));
    if (runs.size < minRuns) continue;
    const reasons = [...new Set(g.members.map((m) => m.reason).filter(Boolean))];
    proposals.push({
      id: proposalId('avoid', g.members),
      kind: 'avoid',
      text: `Do not report: ${shortest(g.members.map((m) => m.finding.title))}${reasons.length ? ` (${reasons[0]})` : ''}`,
      evidence: `rejected in ${runs.size} reviews${reasons.length ? `; reasons: ${reasons.slice(0, 3).join(' | ')}` : ''}`,
      examples: g.members.slice(0, 5).map((m) => ({ run: m.run, finding: m.finding.id, title: m.finding.title, severity: m.finding.severity })),
    });
  }

  // revise: checklist items whose findings people mostly drop.
  const byCk = new Map();
  for (const d of decided) {
    const a = d.finding.authority;
    if (!a || a.kind !== 'curated_viewpoint' || !known.has(a.id)) continue;
    const c = byCk.get(a.id) || { kept: 0, rejected: 0, examples: [] };
    c[d.outcome] += 1;
    if (d.outcome === 'rejected' && c.examples.length < 5) c.examples.push({ run: d.run, finding: d.finding.id, title: d.finding.title, severity: d.finding.severity });
    byCk.set(a.id, c);
  }
  for (const [ck, c] of byCk) {
    const total = c.kept + c.rejected;
    if (total >= 4 && c.rejected / total >= 0.6) {
      const line = (text.match(new RegExp(`^- ${ck}: (.*)$`, 'm')) || [])[1] || '';
      proposals.push({ id: `revise-${ck}`, kind: 'revise', ck, text: line, evidence: `${c.rejected} of ${total} findings citing ${ck} were rejected: the item is too broad or too easy to misapply`, examples: c.examples });
    }
  }
  return { at: new Date().toISOString(), decided: decided.length, proposals };
}

// Appends an accepted proposal under "## Learned from reviews" with the next
// free id of its category. Returns the new id.
function acceptProposal(proposalIdArg, { text, category, file = checklistFile() } = {}) {
  const { proposals } = mineChecklist();
  const p = proposals.find((x) => x.id === proposalIdArg);
  if (!p) throw new Error(`no proposal ${proposalIdArg} (run arw checklist propose)`);
  if (p.kind === 'revise') throw new Error(`${p.ck}: edit its line in ${path.relative(ROOT, file)} yourself; a rewrite needs your wording`);
  const wording = String(text || p.text).replace(/\s+/g, ' ').trim();
  if (!wording || wording.length > 300) throw new Error('the checklist line must be 1-300 characters');
  const cat = String(category || (p.kind === 'avoid' ? 'NO' : 'LR')).toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(cat)) throw new Error('category: 2-4 capital letters, e.g. BZ, LR');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Review checklist\n';
  const used = checklistIds(current).filter((id) => id.startsWith(`CK-${cat}-`)).map((id) => Number(id.split('-')[2]));
  const id = `CK-${cat}-${(used.length ? Math.max(...used) : 0) + 1}`;
  const header = '## Learned from reviews';
  let next = current.endsWith('\n') ? current : `${current}\n`;
  if (!next.includes(`\n${header}\n`)) next += `\n${header}\n`;
  // Insert at the end of that section, before the next "## " heading.
  const start = next.indexOf(`\n${header}\n`) + header.length + 2;
  const after = next.indexOf('\n## ', start - 1);
  const at = after === -1 ? next.length : after + 1;
  const before = next.slice(0, at).replace(/\n*$/, '\n');
  next = `${before}- ${id}: ${wording}\n${after === -1 ? '' : `\n${next.slice(at)}`}`;
  fs.writeFileSync(file, next);
  return { id, line: `- ${id}: ${wording}`, file };
}

module.exports = { mineChecklist, acceptProposal, checklistFile, checklistIds, decidedFindings };
