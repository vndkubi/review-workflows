'use strict';
// PR size and per-unit risk, from the parsed diff and the evidence pack's
// boundary signals. Deterministic: the same diff gives the same numbers.
//   - A large PR is reviewed anyway, but the report says so and suggests
//     how to split it along the planned units.
//   - Units run riskiest first inside each wave, so when a budget stops the
//     run, what is left undone is the least risky part.
const { envInt } = require('./util');

// Paths whose changes usually carry money, access or data-integrity risk.
const RISKY_PATH = /(pay|money|price|amount|charge|refund|discount|invoice|billing|ledger|balance|tax|fee|auth|login|session|token|secret|password|crypt|permission|role|acl|security|transaction|migration|schema)/i;
const LOW_RISK_PATH = /(^|\/)(docs?|examples?|samples?)\/|\.(md|txt|rst|adoc)$|(^|\/)(src\/test|tests?)\//i;

function prSize(parsed, reviewable) {
  const set = new Set(reviewable);
  let added = 0;
  let removed = 0;
  for (const f of parsed) {
    if (!set.has(f.path)) continue;
    added += f.added;
    removed += f.removed;
  }
  const limits = { files: envInt('ARW_LARGE_PR_FILES', 60), lines: envInt('ARW_LARGE_PR_LINES', 2000) };
  const size = { files: reviewable.length, added, removed, lines: added + removed, limits };
  size.large = size.files > limits.files || size.lines > limits.lines;
  return size;
}

function fileRisks(parsed, reviewable, signals) {
  const stats = new Map(parsed.map((f) => [f.path, f]));
  const signalCount = new Map();
  for (const s of signals || []) signalCount.set(s.path, (signalCount.get(s.path) || 0) + 1);
  const out = new Map();
  for (const file of reviewable) {
    const st = stats.get(file);
    const churn = st ? st.added + st.removed : 0;
    let score = Math.min(churn, 400) + 50 * (signalCount.get(file) || 0);
    if (RISKY_PATH.test(file)) score += 300;
    if (LOW_RISK_PATH.test(file)) score = Math.round(score / 4);
    out.set(file, score);
  }
  return out;
}

function unitFiles(unit) {
  return unit.covers.filter((c) => c.startsWith('file:')).map((c) => c.slice(5));
}

// Adds `risk` to each unit (sum over its files; viewpoints get the PR total,
// so they keep running first).
function scoreUnits(units, risks) {
  const total = [...risks.values()].reduce((a, b) => a + b, 0);
  for (const u of units) u.risk = u.kind === 'viewpoint' ? total : unitFiles(u).reduce((n, f) => n + (risks.get(f) || 0), 0);
  return units;
}

// Candidate PRs along the planned units: each B/T/O unit with its files and
// lines. Units that share files are tied by a seam and belong together.
function suggestSplit(units, parsed) {
  const stats = new Map(parsed.map((f) => [f.path, f]));
  const parts = units.filter((u) => ['business', 'technical', 'orphan'].includes(u.kind)).map((u) => {
    const files = unitFiles(u);
    return { units: [u.id], desc: u.desc, files, lines: files.reduce((n, f) => n + (stats.get(f) ? stats.get(f).added + stats.get(f).removed : 0), 0), risk: u.risk || 0 };
  });
  // Merge parts that share a file (union-find over shared files).
  const merged = [];
  for (const p of parts) {
    const hits = merged.filter((m) => m.files.some((f) => p.files.includes(f)));
    const into = { units: [...p.units], desc: p.desc, files: [...p.files], lines: 0, risk: p.risk };
    for (const m of hits) {
      into.units.push(...m.units);
      into.files.push(...m.files);
      into.risk += m.risk;
      into.desc = `${m.desc}; ${into.desc}`;
      merged.splice(merged.indexOf(m), 1);
    }
    into.files = [...new Set(into.files)];
    into.lines = into.files.reduce((n, f) => n + (stats.get(f) ? stats.get(f).added + stats.get(f).removed : 0), 0);
    merged.push(into);
  }
  return merged.sort((a, b) => b.risk - a.risk);
}

module.exports = { prSize, fileRisks, scoreUnits, suggestSplit, RISKY_PATH };
