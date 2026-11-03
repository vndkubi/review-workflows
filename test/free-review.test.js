'use strict';
// Seen on the pilot2 evals (23 Oct 2026): one raw prompt found 22% of the
// labels with 6 calls, the multi-agent pipeline 52% with 149. Several
// independent reads stand in for one deeper read (SWR-Bench: n runs merged
// raised recall ~2x), so the free-review baseline runs only the whole-PR
// free reviews (ARW_HUNT_LENSES) and the plain review: what the planned
// units add over them is then measured, not assumed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeRepo } = require('./helpers');

// Before anything under src/lib is required: runs.js reads ARW_RUNS_DIR once,
// when it is first loaded (src/lib/AGENTS.md). Requiring eval.js below loads
// runs.js, so setting this later wrote into the real runs/ directory.
const RUNS_DIR = tmpDir('arw-free-runs-');
process.env.ARW_RUNS_DIR = RUNS_DIR;
process.env.ARW_WT_DIR = tmpDir('arw-free-wt-');

const { freeReviewUnits } = require('../src/lib/plan');
const { reviewDefaults } = require('../src/lib/setup');
const { CONFIGS } = require('../src/lib/eval');
const { RUNS } = require('../src/lib/runs');

function restore([lenses, plain]) {
  for (const [k, v] of [['ARW_HUNT_LENSES', lenses], ['ARW_PLAIN_REVIEW', plain]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Incident: this file used to set ARW_RUNS_DIR after requiring eval.js, which
// loads runs.js: `npm test` wrote an acme/free run into the real runs/ dir.
test('the test runs directory is the temporary one', () => {
  assert.equal(path.resolve(RUNS), path.resolve(RUNS_DIR));
});

test('free-review units: one free review per lens and the plain review, nothing planned', () => {
  const files = ['src/A.java', 'src/B.java'];
  const saved = [process.env.ARW_HUNT_LENSES, process.env.ARW_PLAIN_REVIEW];
  process.env.ARW_HUNT_LENSES = '3';
  process.env.ARW_PLAIN_REVIEW = 'on'; // scripts/test.js turns it off
  let built;
  try {
    built = freeReviewUnits(files);
  } finally {
    restore(saved);
  }
  assert.deepEqual(built.units.map((u) => [u.id, u.lens]), [['V0', 'general'], ['V1', 'business'], ['V2', 'adversarial'], ['P0', 'plain']]);
  assert.ok(built.units.every((u) => u.hunt && u.kind === 'viewpoint'));
  assert.deepEqual(built.errors, []);
  assert.ok(files.every((f) => built.required_coverage.includes(`file:${f}`)));
  assert.equal(built.plan.units.length, 0);
});

test('free-review mode: a flag or ARW_REVIEW_MODE; --single-agent wins', () => {
  assert.deepEqual(reviewDefaults({}, {}), { singleAgent: false, freeReview: false, noRepro: false });
  assert.deepEqual(reviewDefaults({}, { ARW_REVIEW_MODE: 'free-review' }), { singleAgent: false, freeReview: true, noRepro: false });
  assert.deepEqual(reviewDefaults({ freeReview: true }, {}), { singleAgent: false, freeReview: true, noRepro: false });
  assert.deepEqual(reviewDefaults({ singleAgent: true }, { ARW_REVIEW_MODE: 'free-review' }), { singleAgent: true, freeReview: false, noRepro: false });
  assert.deepEqual(CONFIGS['free-review'], { freeReview: true, noRepro: true });
});

test('a free-review run calls no planner and reviews with the free reviews only', async () => {
  const repo = makeRepo();
  const { reviewPr } = require('../src/lib/pr-review');
  const fake = require('./fixtures/fake-review-executor');
  const prompts = [];
  const executor = async (opts) => {
    prompts.push(opts.prompt);
    return fake(opts);
  };
  const prepared = { info: { title: 'ACME-7 member discount', body: 'Members get 10% off from 1,000,000.', headRefName: 'feature', baseRefName: 'main', url: null }, checkout: repo.dir, head: repo.head, base: repo.base };
  const saved = [process.env.ARW_HUNT_LENSES, process.env.ARW_PLAIN_REVIEW];
  process.env.ARW_HUNT_LENSES = '2';
  process.env.ARW_PLAIN_REVIEW = 'off';
  let out;
  try {
    out = await reviewPr({ repo: 'acme/free', pr: 1, executor, prepared, workers: 2, freeReview: true, noRepro: true, skipRebuttals: true, skipSynthesis: true });
  } finally {
    restore(saved);
  }
  const run = JSON.parse(fs.readFileSync(path.join(out.runDir, 'run.json'), 'utf8'));
  assert.equal(run.review.mode, 'free-review');
  assert.deepEqual(run.review.units.map((u) => u.id), ['V0', 'V1']);
  assert.ok(!fs.existsSync(path.join(out.runDir, 'plan-work', 'receipts.json')), 'no planner call');
  const units = prompts.map((p) => (p.match(/^UNIT: \{"id":"([^"]+)"/m) || [])[1]).filter(Boolean);
  assert.deepEqual([...new Set(units)].sort(), ['V0', 'V1']);
  assert.ok(prompts.some((p) => /FREE REVIEW V1 \(lens: business\)/.test(p)));
  assert.ok(out.validation.jobs.every((j) => j.status === 'EXECUTED_PASS'), JSON.stringify(out.validation.jobs.filter((j) => j.errors.length), null, 1));
});
