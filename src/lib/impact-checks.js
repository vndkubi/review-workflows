'use strict';
// Impact as required coverage. The impact index (impact.js) lists who calls
// the declarations a PR changes; here every direct call site that resolves
// to the changed declaration (or references it by name: config, reflection,
// HTTP clients) becomes a caller check C<n>, owned by the substantive unit
// that covers the changed file. Its reviewer answers each one at the caller.
// Name-only matches are noise and are not asked; they stay visible in the
// impact view. Callers in related repositories are asked when they resolve.
// Tests that call the changed code are not asked either: the test
// viewpoints (CK-TS-*) and the impacted-test runs cover them.
const { TEST } = require('./viewpoint-checks');

const ASKED = new Set(['ast', 'ast-dispatch', 'typed', 'resolved', 'interface', 'config', 'reflection', 'http']);
const ANSWERING_KINDS = new Set(['business', 'technical', 'orphan']);

function isAsked(e) {
  // A caller in a related repository is asked too when it resolves (typed,
  // import, endpoint path): it is read at the frozen revision of that
  // repository and answered with a quote from it ("repo": "<name>").
  return e.level === 1 && ASKED.has(e.confidence) && !TEST.test(e.from.path);
}

function impactLine(c) {
  return `${c.id} ${c.from.symbol} at ${c.repo ? `[${c.repo}] ` : ''}${c.from.path}:${c.from.line} -> ${c.to.symbol} [${c.confidence}${c.via ? ` via ${c.via}` : ''}]${c.note ? ` ${c.note}` : ''}${c.mismatch ? ` SIGNATURE MISMATCH: ${c.mismatch}` : ''}`;
}

function mismatchText(x) {
  return `calls ${x.name} with ${x.args} argument(s); declarations take ${x.declared.join(' or ')}`;
}

function assignImpacts(units, impact) {
  for (const u of units) u.impacts = [];
  if (!impact || impact.error || !Array.isArray(impact.edges)) return units;
  let n = 0;
  for (const e of impact.edges) {
    if (!isAsked(e)) continue;
    const owners = units.filter((u) => ANSWERING_KINDS.has(u.kind) && u.covers.includes(`file:${e.to.path}`));
    if (!owners.length) continue;
    n += 1;
    const check = { id: `C${n}`, ...(e.repo ? { repo: e.repo } : {}), from: e.from, to: e.to, confidence: e.confidence, ...(e.via ? { via: e.via } : {}), ...(e.note ? { note: e.note } : {}) };
    for (const u of owners) u.impacts.push(check);
  }
  // A call whose argument count no declaration accepts most likely does not
  // compile: it is marked on its check, and added when the index missed it.
  for (const x of impact.mismatches || []) {
    const text = mismatchText(x);
    const existing = units.flatMap((u) => u.impacts).filter((c) => c.from.path === x.path && c.from.line === x.line);
    if (existing.length) {
      for (const c of existing) c.mismatch = text;
      continue;
    }
    const decl = (impact.changed || []).find((d) => d.symbol === x.name || d.symbol.endsWith(`.${x.name}`));
    const owners = decl ? units.filter((u) => ANSWERING_KINDS.has(u.kind) && u.covers.includes(`file:${decl.path}`)) : [];
    if (!owners.length) continue;
    n += 1;
    const check = { id: `C${n}`, from: { path: x.path, line: x.line, symbol: `call of ${x.name}` }, to: { path: decl.path, symbol: decl.symbol }, confidence: 'arity', mismatch: text };
    for (const u of owners) u.impacts.push(check);
  }
  return units;
}

module.exports = { assignImpacts, impactLine, isAsked, ASKED };
