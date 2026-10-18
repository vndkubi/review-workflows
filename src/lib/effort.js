'use strict';
// Reasoning effort per job, so tokens go where they find defects. Measured
// on luna: the free review of the whole PR finds the most at max; synthesis
// only writes an overview; the red team at max cost 4x and never withdrew
// more than at high. Each stage can be set (ARW_*_EFFORT); "inherit" keeps
// the run's own effort (CODEX_EFFORT).

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const rank = (e) => LEVELS.indexOf(e || 'medium');

function setting(env, key, fallback, base) {
  const v = env[key];
  if (v === 'inherit') return base;
  return v && LEVELS.includes(v) ? v : fallback;
}

// stage: 'packet' | 'rebuttal' | 'synthesis' | 'plan'; unit: the review unit
// for a packet; base: the run's effort (null = codex default).
function effortFor(stage, unit, base, env = process.env) {
  // Managed by the provider (CODEX_EFFORT=managed): never chosen here.
  if (env.CODEX_EFFORT === 'managed') return null;
  if (stage === 'synthesis') return setting(env, 'ARW_SYNTHESIS_EFFORT', 'low', base);
  if (stage === 'rebuttal') {
    const cap = setting(env, 'ARW_REDTEAM_EFFORT', 'high', base);
    return base && rank(base) < rank(cap) ? base : cap;
  }
  if (stage === 'packet' && unit) {
    if (unit.hunt) return setting(env, 'ARW_HUNT_EFFORT', 'max', base);
    if (unit.effort_boost) return setting(env, 'ARW_BOOST_EFFORT', 'max', base);
  }
  return base;
}

// The riskiest substantive unit gets the boost: one unit, so the extra cost
// stays bounded on a large PR.
function markBoost(units, env = process.env) {
  if (env.ARW_BOOST_EFFORT === 'off') return units;
  const candidates = units.filter((u) => ['business', 'technical', 'orphan'].includes(u.kind) && (u.risk || 0) > 0);
  candidates.sort((a, b) => (b.risk || 0) - (a.risk || 0));
  if (candidates.length > 1) candidates[0].effort_boost = true;
  return units;
}

module.exports = { effortFor, markBoost, LEVELS };
