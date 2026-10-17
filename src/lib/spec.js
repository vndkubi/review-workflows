'use strict';
// Spec tables. A model only *declares* the spec model (variables, value
// classes, rules, results, with quotes). Everything countable is done here:
// partition checks, exhaustive gap/contradiction analysis over all value
// combinations, pairwise reduction of scenario rows, business-relevant
// boundaries, and the review items the PR review is graded against.
const { validateAgainst } = require('./schema');
const { collapse } = require('./validate');
const { nowIso, sha256Value } = require('./util');

const EXHAUSTIVE_LIMIT = 64;
const MAX_COMBOS = 100000;
const ORDERED = new Set(['integer', 'decimal', 'date']);
const RISK_RANK = { security: 4, money: 3, data: 2, normal: 1 };
const DAY = 86400000;

// ---------- values ----------
function stepOf(v) {
  if (v.type === 'decimal') return Number(v.step) > 0 ? Number(v.step) : 0.01;
  return 1;
}

function decimalsOf(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function parseValue(v, s) {
  if (s == null || s === '') return null;
  if (v.type === 'date') {
    // Date.parse rolls impossible days over (2026-02-30 -> 2026-03-02), so a
    // date counts only if it formats back to exactly what was written.
    const str = String(s);
    const t = /^\d{4}-\d{2}-\d{2}$/.test(str) ? Date.parse(`${str}T00:00:00Z`) : NaN;
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== str ? NaN : Math.round(t / DAY);
  }
  return Number(String(s).replace(/[,_\s]/g, ''));
}

function formatValue(v, n) {
  if (v.type === 'date') return new Date(n * DAY).toISOString().slice(0, 10);
  if (v.type === 'integer') return String(Math.round(n));
  return n.toFixed(decimalsOf(stepOf(v)));
}

// Range of an ordered, non-special class. Unset inclusivity means [min, max).
function rangeOf(v, c) {
  const lo = c.min == null ? -Infinity : parseValue(v, c.min);
  const hi = c.max == null ? Infinity : parseValue(v, c.max);
  const loInc = c.min == null ? true : c.min_inclusive !== false;
  const hiInc = c.max == null ? true : c.max_inclusive === true;
  const step = stepOf(v);
  const discrete = v.type !== 'decimal';
  return {
    lo,
    hi,
    loInc,
    hiInc,
    // closest values that belong to the class at each end
    lowEdge: Number.isFinite(lo) ? (loInc ? lo : lo + step) : null,
    highEdge: Number.isFinite(hi) ? (hiInc ? hi : hi - step) : null,
    discrete,
  };
}

function rangeText(v, c) {
  if (c.special) return c.special;
  if (!ORDERED.has(v.type)) return c.value != null ? JSON.stringify(c.value) : c.label;
  const r = rangeOf(v, c);
  const lo = Number.isFinite(r.lo) ? `${r.loInc ? '[' : '('}${formatValue(v, r.lo)}` : '(-∞';
  const hi = Number.isFinite(r.hi) ? `${formatValue(v, r.hi)}${r.hiInc ? ']' : ')'}` : '+∞)';
  return `${lo}, ${hi}`;
}

function representative(v, c) {
  if (c.special === 'missing') return '(missing)';
  if (c.special === 'malformed') return c.value || '(malformed)';
  if (!ORDERED.has(v.type)) return c.value != null ? c.value : c.label;
  const r = rangeOf(v, c);
  if (r.lowEdge != null) return formatValue(v, r.lowEdge);
  if (r.highEdge != null) return formatValue(v, r.highEdge);
  return c.value || formatValue(v, v.type === 'date' ? Math.round(Date.parse('2026-01-01T00:00:00Z') / DAY) : 1);
}

// ---------- model checks (errors go back to the model) ----------
function checkPartition(v, at, errors) {
  const ranges = v.classes.filter((c) => !c.special).map((c) => ({ c, r: rangeOf(v, c) }));
  for (const { c, r } of ranges) {
    if (Number.isNaN(r.lo) || Number.isNaN(r.hi)) errors.push(`${at}: class "${c.id}" has an unparsable min/max for type ${v.type}`);
    else if (r.lowEdge != null && r.highEdge != null && r.lowEdge > r.highEdge) errors.push(`${at}: class "${c.id}" is empty`);
  }
  if (errors.length) return;
  if (!ranges.length) {
    errors.push(`${at}: an ${v.type} variable needs range classes (min/max); special classes only cover missing/malformed input`);
    return;
  }
  ranges.sort((a, b) => a.r.lo - b.r.lo || (a.r.loInc === b.r.loInc ? 0 : a.r.loInc ? -1 : 1));
  const fmt = (n) => formatValue(v, n);
  if (Number.isFinite(ranges[0].r.lo)) errors.push(`${at}: values below ${fmt(ranges[0].r.lo)} belong to no class; add a class (usually invalid) for them`);
  const last = ranges[ranges.length - 1];
  if (Number.isFinite(last.r.hi)) errors.push(`${at}: values above ${fmt(last.r.hi)} belong to no class; add a class (usually invalid) for them`);
  for (let i = 0; i + 1 < ranges.length; i += 1) {
    const a = ranges[i];
    const b = ranges[i + 1];
    if (a.r.discrete) {
      const next = a.r.highEdge + stepOf(v);
      if (a.r.highEdge == null || b.r.lowEdge == null || a.r.highEdge >= b.r.lowEdge) errors.push(`${at}: classes "${a.c.id}" and "${b.c.id}" overlap`);
      else if (next < b.r.lowEdge) errors.push(`${at}: values ${fmt(next)}..${fmt(b.r.lowEdge - stepOf(v))} lie between "${a.c.id}" and "${b.c.id}" and belong to no class`);
    } else if (a.r.hi > b.r.lo || (a.r.hi === b.r.lo && a.r.hiInc && b.r.loInc)) {
      errors.push(`${at}: classes "${a.c.id}" and "${b.c.id}" overlap at ${fmt(b.r.lo)}`);
    } else if (a.r.hi < b.r.lo || (!a.r.hiInc && !b.r.loInc)) {
      errors.push(`${at}: values between "${a.c.id}" and "${b.c.id}" (around ${fmt(b.r.lo)}) belong to no class`);
    }
  }
}

function checkModel(model, requirements, ticket) {
  const errors = validateAgainst('spec', model, 'specModel');
  if (errors.length) return errors;
  if (model.ticket !== ticket) errors.push(`$.ticket: must be "${ticket}"`);
  const acIds = new Set(((requirements && requirements.items) || []).map((i) => i.id));
  const ruleIds = new Set();
  const featureIds = new Set();
  const modelled = new Set(model.other_acs.map((o) => o.ac));
  model.other_acs.forEach((o, i) => {
    if (!acIds.has(o.ac)) errors.push(`$.other_acs[${i}].ac: ${o.ac} is not a requirement item`);
  });
  model.features.forEach((f, fi) => {
    const fat = `$.features[${fi}]`;
    if (featureIds.has(f.id)) errors.push(`${fat}.id: duplicate feature ${f.id}`);
    featureIds.add(f.id);
    const vars = new Map();
    f.variables.forEach((v, vi) => {
      const at = `${fat}.variables[${vi}]`;
      if (vars.has(v.id)) errors.push(`${at}.id: duplicate variable ${v.id}`);
      vars.set(v.id, v);
      const cids = v.classes.map((c) => c.id);
      if (new Set(cids).size !== cids.length) errors.push(`${at}: class ids must be unique`);
      if (ORDERED.has(v.type)) checkPartition(v, at, errors);
      else {
        const valued = v.classes.filter((c) => !c.special);
        if (valued.some((c) => c.value == null || c.value === '')) errors.push(`${at}: every non-special ${v.type} class needs a "value"`);
        const values = valued.map((c) => String(c.value).toLowerCase());
        if (new Set(values).size !== values.length) errors.push(`${at}: class values must be distinct`);
        if (v.type === 'boolean' && !(values.includes('true') && values.includes('false'))) errors.push(`${at}: a boolean needs classes with value "true" and "false"`);
      }
    });
    const outcomes = new Set(f.outcomes.map((o) => o.id));
    f.rules.forEach((r, ri) => {
      const at = `${fat}.rules[${ri}]`;
      if (ruleIds.has(r.id)) errors.push(`${at}.id: duplicate rule id ${r.id} (rule ids are unique across features)`);
      ruleIds.add(r.id);
      const seenVars = new Set();
      r.conditions.forEach((c, ci) => {
        const v = vars.get(c.variable);
        if (!v) return errors.push(`${at}.conditions[${ci}].variable: unknown variable "${c.variable}"`);
        if (seenVars.has(c.variable)) errors.push(`${at}.conditions: "${c.variable}" appears twice`);
        seenVars.add(c.variable);
        for (const cls of c.classes) if (!v.classes.some((x) => x.id === cls)) errors.push(`${at}.conditions[${ci}]: "${cls}" is not a class of ${c.variable}`);
      });
      const given = new Set(r.results.map((x) => x.outcome));
      for (const x of r.results) if (!outcomes.has(x.outcome)) errors.push(`${at}.results: unknown outcome "${x.outcome}"`);
      for (const o of outcomes) if (!given.has(o)) errors.push(`${at}.results: missing a value for outcome "${o}" (every rule states every outcome)`);
      for (const ac of r.acs) {
        if (!acIds.has(ac)) errors.push(`${at}.acs: ${ac} is not a requirement item`);
        modelled.add(ac);
      }
      if (r.label === 'CONFIRMED' && !r.source.quote.trim()) errors.push(`${at}.source.quote: a CONFIRMED rule quotes the ticket; otherwise label it INFERRED`);
    });
  });
  for (const item of (requirements && requirements.items) || []) {
    if (item.kind !== 'inferred' && !modelled.has(item.id)) errors.push(`${item.id} is not modelled: cite it in a rule's acs, or list it in other_acs with the reason it is not a decision`);
  }
  return errors;
}

// ---------- analysis ----------
function* combinations(lists) {
  const idx = lists.map(() => 0);
  if (lists.some((l) => !l.length)) return;
  while (true) {
    yield idx.map((i, k) => lists[k][i]);
    let k = lists.length - 1;
    while (k >= 0 && ++idx[k] === lists[k].length) idx[k--] = 0;
    if (k < 0) return;
  }
}

function matcher(feature) {
  const varIndex = new Map(feature.variables.map((v, i) => [v.id, i]));
  const rules = feature.rules.map((r) => ({
    rule: r,
    conds: r.conditions.map((c) => [varIndex.get(c.variable), new Set(c.classes)]),
    key: JSON.stringify([...r.results].sort((a, b) => a.outcome.localeCompare(b.outcome)).map((x) => [x.outcome, x.value])),
  }));
  return (combo) => rules.filter((r) => r.conds.every(([i, set]) => set.has(combo[i])));
}

// Collapse gap combinations into patterns: a position that takes every class
// of its variable while the rest stays fixed becomes "*".
function compressPatterns(combos, lists) {
  let patterns = combos.map((c) => [...c]);
  for (let v = 0; v < lists.length; v += 1) {
    const groups = new Map();
    for (const p of patterns) {
      const key = JSON.stringify(p.map((x, i) => (i === v ? null : x)));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const next = [];
    for (const group of groups.values()) {
      const values = new Set(group.map((p) => p[v]));
      if (lists[v].every((c) => values.has(c)) && !values.has('*')) {
        const merged = [...group[0]];
        merged[v] = '*';
        next.push(merged);
      } else next.push(...group);
    }
    patterns = next;
  }
  return patterns;
}

// Widen each gap pattern while every combination it then covers is still a
// gap, and drop patterns another one subsumes: (missing, below) and
// (missing, from) become (missing, *) when all of (missing, *) is uncovered.
function generalizePatterns(patterns, lists, gapKeys) {
  const expand = (p) => {
    let out = [[]];
    p.forEach((cid, i) => {
      const options = cid === '*' ? lists[i] : [cid];
      out = out.flatMap((prefix) => options.map((o) => [...prefix, o]));
    });
    return out;
  };
  const widened = patterns.map((p) => {
    const q = [...p];
    for (let i = 0; i < q.length; i += 1) {
      if (q[i] === '*') continue;
      const trial = [...q];
      trial[i] = '*';
      if (expand(trial).every((c) => gapKeys.has(c.join('\u0000')))) q[i] = '*';
    }
    return q;
  });
  const subsumes = (a, b) => a.every((x, i) => x === '*' || x === b[i]);
  const unique = [...new Map(widened.map((p) => [p.join('\u0000'), p])).values()];
  return unique.filter((p, i) => !unique.some((q, j) => j !== i && subsumes(q, p) && !subsumes(p, q)));
}

// Deterministic greedy pairwise covering array over class ids.
function pairwiseRows(lists) {
  if (lists.length < 2) return lists.length ? lists[0].map((c) => [c]) : [];
  const uncovered = new Set();
  const key = (i, a, j, b) => `${i}:${a}|${j}:${b}`;
  for (let i = 0; i < lists.length; i += 1) {
    for (let j = i + 1; j < lists.length; j += 1) for (const a of lists[i]) for (const b of lists[j]) uncovered.add(key(i, a, j, b));
  }
  const rows = [];
  while (uncovered.size) {
    const [seed] = uncovered;
    const [, si, sa, sj, sb] = seed.match(/^(\d+):(.*)\|(\d+):(.*)$/);
    const row = new Array(lists.length).fill(null);
    row[Number(si)] = sa;
    row[Number(sj)] = sb;
    for (let i = 0; i < lists.length; i += 1) {
      if (row[i] !== null) continue;
      let best = lists[i][0];
      let bestGain = -1;
      for (const cand of lists[i]) {
        let gain = 0;
        row.forEach((val, j) => {
          if (val === null || j === i) return;
          if (uncovered.has(j < i ? key(j, val, i, cand) : key(i, cand, j, val))) gain += 1;
        });
        if (gain > bestGain) {
          best = cand;
          bestGain = gain;
        }
      }
      row[i] = best;
    }
    for (let i = 0; i < row.length; i += 1) for (let j = i + 1; j < row.length; j += 1) uncovered.delete(key(i, row[i], j, row[j]));
    rows.push(row);
  }
  return rows;
}

function riskOf(acs, requirements) {
  const byId = new Map(((requirements && requirements.items) || []).map((i) => [i.id, i]));
  let best = 'normal';
  for (const ac of acs) {
    const r = (byId.get(ac) || {}).risk || 'normal';
    if (RISK_RANK[r] > RISK_RANK[best]) best = r;
  }
  return best;
}

function quoteFound(quote, blocks) {
  const q = collapse(quote);
  return q.length > 0 && blocks.some((b) => collapse(b.text).includes(q));
}

// Returns { errors } (model must repair) or { spec } (derived tables).
function buildSpec({ model, requirements, ticket, blocks }) {
  const errors = checkModel(model, requirements, ticket);
  if (errors.length) return { errors };
  const m = JSON.parse(JSON.stringify(model));
  const warnings = [];
  let downgraded = 0;
  for (const f of m.features) {
    for (const r of f.rules) {
      if (r.label === 'CONFIRMED' && !quoteFound(r.source.quote, blocks)) {
        r.label = 'INFERRED';
        downgraded += 1;
        warnings.push(`${r.id}: quote not found verbatim in the ticket evidence; downgraded to INFERRED`);
      }
    }
  }

  let sCounter = 0;
  let qCounter = 0;
  const questions = [];
  const items = [];
  const features = [];
  // business: what users or the business care about; technical: a contract
  // of the code (a field's meaning, defaults, limits, compatibility). A
  // model that leaves it out means business.
  const natureOf = new Map(m.features.map((f) => [f.id, f.nature === 'technical' ? 'technical' : 'business']));
  const addItem = (item) => {
    const id = `I${items.length + 1}`;
    items.push({ id, nature: natureOf.get(item.feature) || 'business', ...item });
    return id;
  };

  for (const f of m.features) {
    const lists = f.variables.map((v) => v.classes.map((c) => c.id));
    const total = lists.reduce((n, l) => n * l.length, 1);
    if (total > MAX_COMBOS) return { errors: [`feature ${f.id} has ${total} value combinations (limit ${MAX_COMBOS}); split it into smaller features`] };
    const match = matcher(f);
    const classOf = (vi, cid) => f.variables[vi].classes.find((c) => c.id === cid);
    const describe = (combo) => combo.map((cid, i) => `${f.variables[i].id}=${cid === '*' ? '*' : classOf(i, cid).label}`).join(', ');
    const valuesFor = (combo) => Object.fromEntries(combo.map((cid, i) => [f.variables[i].id, representative(f.variables[i], classOf(i, cid))]));
    const outcomeOf = (matched) => {
      const keys = new Set(matched.map((x) => x.key));
      if (!matched.length) return { kind: 'gap', text: 'UNSPECIFIED' };
      if (keys.size > 1) return { kind: 'conflict', text: `CONFLICT (${matched.map((x) => x.rule.id).join(' vs ')})` };
      return { kind: 'rule', rules: matched.map((x) => x.rule.id), text: matched[0].rule.results.map((x) => `${x.outcome}=${x.value}`).join(', '), key: matched[0].key };
    };

    // Exhaustive analysis: cheap for code, so it is never sampled.
    const gaps = [];
    const conflicts = new Map();
    const firstComboOfRule = new Map();
    const resultByCombo = new Map();
    for (const combo of combinations(lists)) {
      const matched = match(combo);
      const out = outcomeOf(matched);
      resultByCombo.set(combo.join('\u0000'), out);
      if (out.kind === 'gap') gaps.push(combo);
      else if (out.kind === 'conflict') {
        const pair = matched.map((x) => x.rule.id).join('+');
        if (!conflicts.has(pair)) conflicts.set(pair, combo);
      } else if (matched.length > 1) {
        const pair = matched.map((x) => x.rule.id).join('+');
        if (!warnings.some((w) => w.startsWith(`${pair}:`))) warnings.push(`${pair}: rules overlap with the same result (redundant)`);
      }
      for (const x of matched) if (!firstComboOfRule.has(x.rule.id)) firstComboOfRule.set(x.rule.id, combo);
    }
    for (const r of f.rules) if (!firstComboOfRule.has(r.id)) warnings.push(`${r.id}: matches no value combination (dead rule)`);

    // Scenario rows: every combination when small; otherwise pairwise plus
    // one row per rule, so every business rule keeps a scenario.
    const mode = total <= EXHAUSTIVE_LIMIT ? 'exhaustive' : 'pairwise+rules';
    let rowCombos = mode === 'exhaustive' ? [...combinations(lists)] : pairwiseRows(lists);
    if (mode !== 'exhaustive') {
      const seen = new Set(rowCombos.map((c) => c.join('\u0000')));
      for (const combo of firstComboOfRule.values()) if (!seen.has(combo.join('\u0000'))) rowCombos.push(combo);
    }
    const scenarios = rowCombos.map((combo) => {
      const out = resultByCombo.get(combo.join('\u0000'));
      sCounter += 1;
      return { id: `S${sCounter}`, feature: f.id, classes: Object.fromEntries(combo.map((c, i) => [f.variables[i].id, c])), values: valuesFor(combo), rules: out.rules || [], expected: out.text, kind: out.kind };
    });

    // Business-relevant boundaries: adjacent classes of an ordered variable
    // where crossing the boundary changes the expected result.
    const boundaries = [];
    f.variables.forEach((v, vi) => {
      if (!ORDERED.has(v.type)) return;
      const sorted = v.classes.filter((c) => !c.special).map((c) => ({ c, r: rangeOf(v, c) })).sort((a, b) => a.r.lo - b.r.lo);
      for (let k = 0; k + 1 < sorted.length; k += 1) {
        const A = sorted[k];
        const B = sorted[k + 1];
        if (A.r.highEdge == null || B.r.lowEdge == null) continue;
        let base = null;
        for (const combo of combinations(lists)) {
          if (combo[vi] !== A.c.id) continue;
          const other = [...combo];
          other[vi] = B.c.id;
          const ra = resultByCombo.get(combo.join('\u0000'));
          const rb = resultByCombo.get(other.join('\u0000'));
          if ((ra.key || ra.text) !== (rb.key || rb.text)) {
            base = { a: combo, b: other, ra, rb };
            break;
          }
        }
        if (!base) continue;
        // Reuse an identical existing row instead of duplicating it.
        const rowFor = (combo, values, out) => {
          const same = scenarios.find((s) => JSON.stringify(s.values) === JSON.stringify(values));
          if (same) {
            same.boundary = true;
            return same;
          }
          sCounter += 1;
          const row = { id: `S${sCounter}`, feature: f.id, classes: Object.fromEntries(combo.map((c, i) => [f.variables[i].id, c])), values, rules: out.rules || [], expected: out.text, kind: out.kind, boundary: true };
          scenarios.push(row);
          return row;
        };
        const sa = rowFor(base.a, { ...valuesFor(base.a), [v.id]: formatValue(v, A.r.highEdge) }, base.ra);
        const sb = rowFor(base.b, { ...valuesFor(base.b), [v.id]: formatValue(v, B.r.lowEdge) }, base.rb);
        boundaries.push({ variable: v.id, below: A.c.id, above: B.c.id, at: [sa.values[v.id], sb.values[v.id]], scenarios: [sa.id, sb.id] });
      }
    });

    // Review items, in a stable order: rules, boundaries, gaps, conflicts.
    const featureAcs = [...new Set(f.rules.flatMap((r) => r.acs))];
    for (const r of f.rules) {
      const cond = r.conditions.map((c) => `${c.variable} ∈ {${c.classes.map((cid) => f.variables.find((v) => v.id === c.variable).classes.find((x) => x.id === cid).label).join(', ')}}`).join(' AND ') || 'always';
      addItem({
        kind: 'rule',
        feature: f.id,
        rule: r.id,
        acs: r.acs,
        // A complement rule (often INFERRED, without its own AC) decides the
        // same money/data as the feature: it inherits the feature's risk.
        risk: riskOf(r.acs.length ? r.acs : featureAcs, requirements),
        label: r.label,
        text: `${r.id} (${f.name}): when ${cond} → ${r.results.map((x) => `${x.outcome}=${x.value}`).join(', ')}`,
        expected: r.results.map((x) => `${x.outcome}=${x.value}`).join(', '),
        scenarios: scenarios.filter((s) => s.rules.includes(r.id)).map((s) => s.id),
      });
    }
    for (const b of boundaries) {
      const [sa, sb] = b.scenarios.map((id) => scenarios.find((s) => s.id === id));
      const acs = [...new Set([...sa.rules, ...sb.rules].flatMap((rid) => f.rules.find((r) => r.id === rid).acs))];
      addItem({
        // A boundary next to an unspecified or conflicting side has no
        // expected result on that side: it is reported, not graded.
        kind: sa.kind === 'rule' && sb.kind === 'rule' ? 'boundary' : 'gap',
        feature: f.id,
        acs,
        risk: riskOf(acs.length ? acs : featureAcs, requirements),
        label: [...sa.rules, ...sb.rules].every((rid) => f.rules.find((r) => r.id === rid).label === 'CONFIRMED') && sa.rules.length && sb.rules.length ? 'CONFIRMED' : 'INFERRED',
        text: `Boundary of ${b.variable} (${f.name}): ${b.at[0]} → ${sa.expected}; ${b.at[1]} → ${sb.expected}`,
        expected: `${b.at[0]} → ${sa.expected}; ${b.at[1]} → ${sb.expected}`,
        scenarios: b.scenarios,
      });
    }
    const gapKeys = new Set(gaps.map((c) => c.join('\u0000')));
    for (const p of generalizePatterns(compressPatterns(gaps, lists), lists, gapKeys)) {
      qCounter += 1;
      const text = `No rule covers ${describe(p)} in "${f.name}": what should ${f.outcomes.map((o) => o.id).join(', ')} be?`;
      const itemId = addItem({ kind: 'gap', feature: f.id, acs: featureAcs, risk: riskOf(featureAcs, requirements), label: 'UNKNOWN', text: `Unspecified (${f.name}): ${describe(p)} — report what the code does`, expected: 'UNSPECIFIED', scenarios: scenarios.filter((s) => s.kind === 'gap' && p.every((cid, i) => cid === '*' || s.classes[f.variables[i].id] === cid)).map((s) => s.id) });
      questions.push({ id: `Q${qCounter}`, kind: 'gap', feature: f.id, text, item: itemId });
    }
    for (const [pair, combo] of conflicts) {
      qCounter += 1;
      const itemId = addItem({ kind: 'contradiction', feature: f.id, acs: featureAcs, risk: riskOf(featureAcs, requirements), label: 'UNKNOWN', text: `Contradiction (${f.name}): ${pair.replace('+', ' and ')} both apply to ${describe(combo)} with different results — report which one the code follows`, expected: 'CONFLICT', scenarios: [] });
      questions.push({ id: `Q${qCounter}`, kind: 'contradiction', feature: f.id, text: `${pair.replace('+', ' and ')} give different results for ${describe(combo)}: which is right?`, item: itemId });
    }

    features.push({
      id: f.id,
      name: f.name,
      nature: natureOf.get(f.id),
      combinations: total,
      mode,
      gaps: gaps.length,
      variables: f.variables.map((v) => ({ id: v.id, description: v.description, type: v.type, unit: v.unit || null, classes: v.classes.map((c) => ({ id: c.id, label: c.label, validity: c.validity, range: rangeText(v, c), example: representative(v, c) })) })),
      outcomes: f.outcomes,
      decision_table: f.rules.map((r) => ({
        rule: r.id,
        conditions: Object.fromEntries(f.variables.map((v) => {
          const c = r.conditions.find((x) => x.variable === v.id);
          return [v.id, c ? c.classes.map((cid) => v.classes.find((x) => x.id === cid).label) : ['*']];
        })),
        results: Object.fromEntries(r.results.map((x) => [x.outcome, x.value])),
        acs: r.acs,
        label: r.label,
        quote: r.source.quote,
      })),
      scenarios,
      boundaries,
    });
  }

  for (const o of m.other_acs) {
    const req = requirements.items.find((i) => i.id === o.ac);
    addItem({ kind: 'ac', feature: null, acs: [o.ac], risk: req.risk, label: req.kind === 'inferred' ? 'INFERRED' : 'CONFIRMED', text: `${o.ac}: given ${req.given}, when ${req.when}, then ${req.then}`, expected: req.then, scenarios: [] });
  }

  const inferred = m.features.reduce((n, f) => n + f.rules.filter((r) => r.label === 'INFERRED').length, 0);
  const stats = {
    features: features.length,
    rules: m.features.reduce((n, f) => n + f.rules.length, 0),
    combinations: features.reduce((n, f) => n + f.combinations, 0),
    scenarios: features.reduce((n, f) => n + f.scenarios.length, 0),
    gaps: questions.filter((q) => q.kind === 'gap').length,
    contradictions: questions.filter((q) => q.kind === 'contradiction').length,
    inferred_rules: inferred,
    downgraded,
    items: items.length,
  };
  return {
    spec: {
      schema_version: '1.0',
      ticket,
      generated_at: nowIso(),
      requirements_sha256: sha256Value(requirements),
      requirement_items: requirements.items,
      model: m,
      features,
      questions,
      warnings,
      review_items: items,
      stats,
      clean: stats.gaps === 0 && stats.contradictions === 0 && inferred === 0,
    },
  };
}

// Fallback when no approved spec exists: one item per requirement item.
function itemsFromRequirements(requirements) {
  return ((requirements && requirements.items) || []).map((req, i) => ({
    id: `I${i + 1}`,
    kind: 'ac',
    feature: null,
    acs: [req.id],
    risk: req.risk,
    label: req.kind === 'inferred' ? 'INFERRED' : 'CONFIRMED',
    text: `${req.id}: given ${req.given}, when ${req.when}, then ${req.then}`,
    expected: req.then,
    scenarios: [],
  }));
}

function renderSpecMarkdown(spec) {
  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = [`# Spec — ${spec.ticket}`, ''];
  const s = spec.stats;
  out.push(`${s.features} feature(s) · ${s.rules} rules · ${s.combinations} combinations analysed exhaustively · ${s.scenarios} scenarios · ${s.items} review items`);
  out.push(`gaps ${s.gaps} · contradictions ${s.contradictions} · inferred rules ${s.inferred_rules} · ${spec.clean ? 'CLEAN' : 'needs a decision'}`, '');
  if (spec.questions.length) out.push('## Open questions', '', ...spec.questions.map((q) => `- **${q.id}** (${q.kind}) ${q.text}`), '');
  if (spec.warnings.length) out.push('## Warnings', '', ...spec.warnings.map((w) => `- ${w}`), '');
  for (const f of spec.features) {
    out.push(`## ${f.id} — ${f.name} (${f.nature || 'business'})`, '');
    out.push(`### Input matrix (${f.combinations} combinations; scenarios: ${f.mode})`, '', '| Variable | Type | Class | Validity | Range / value | Example |', '|---|---|---|---|---|---|');
    for (const v of f.variables) for (const c of v.classes) out.push(`| ${v.id} | ${v.type}${v.unit ? ` (${v.unit})` : ''} | ${cell(c.label)} | ${c.validity} | ${cell(c.range)} | ${cell(c.example)} |`);
    const vars = f.variables.map((v) => v.id);
    const outs = f.outcomes.map((o) => o.id);
    out.push('', '### Decision table', '', `| Rule | ${vars.join(' | ')} | → ${outs.join(' | ')} | AC | Label |`, `|${'---|'.repeat(vars.length + outs.length + 3)}`);
    for (const r of f.decision_table) out.push(`| ${r.rule} | ${vars.map((v) => cell(r.conditions[v].join(', '))).join(' | ')} | ${outs.map((o) => cell(r.results[o])).join(' | ')} | ${r.acs.join(', ')} | ${r.label} |`);
    out.push('', '### Scenarios', '', `| ID | ${vars.join(' | ')} | Expected | Rule |`, `|${'---|'.repeat(vars.length + 3)}`);
    for (const sc of f.scenarios) out.push(`| ${sc.id}${sc.boundary ? ' (boundary)' : ''} | ${vars.map((v) => cell(sc.values[v])).join(' | ')} | ${cell(sc.expected)} | ${sc.rules.join(', ') || '—'} |`);
    out.push('');
  }
  out.push('## Review items', '', '| ID | Kind | Risk | Label | Item |', '|---|---|---|---|---|');
  for (const i of spec.review_items) out.push(`| ${i.id} | ${i.kind} | ${i.risk} | ${i.label} | ${cell(i.text)} |`);
  return `${out.join('\n')}\n`;
}

module.exports = { buildSpec, checkModel, itemsFromRequirements, renderSpecMarkdown, pairwiseRows, compressPatterns, generalizePatterns, rangeOf, representative, EXHAUSTIVE_LIMIT };
