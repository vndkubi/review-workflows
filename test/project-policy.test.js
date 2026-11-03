'use strict';
// Project policy: what one repository adds to the shared charters and
// checklist, kept in config/projects/<owner>/<name>/ (never read from the
// reviewed checkout, whose files the PR author controls).
//   checklist.md  PRJ-<AREA>-<n> viewpoints: each names its source and when it
//                 applies; the runtime assigns them like CK-* viewpoints and
//                 a finding may cite one as curated_viewpoint authority;
//   profile.md    context for reviewers (glossary, architecture, hot spots);
//                 frozen and shown, but never authority.
// Both are frozen with the context: editing them is drift, as for
// config/policies. A malformed file stops the review (fail closed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, makeRepo, write, viewpointVerdicts } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-project-runs-');
process.env.ARW_PROJECTS_DIR = tmpDir('arw-projects-');

const project = require('../src/lib/project-policy');
const { selectChecks, assignChecks } = require('../src/lib/viewpoint-checks');

const CHECKLIST = `# Project checklist: acme/proj

## Discounts
- PRJ-DSC-1: The member discount threshold is inclusive: a total of exactly 1,000,000 gets the discount.
  - source: docs/adr/0003-discounts.md:12
  - paths: src/main/java/**/OrderService.java
  - lines: /compareTo|THRESHOLD/
- PRJ-DSC-2: Every source change keeps the audit log call.
  - source: incident INC-42
`;

const PROFILE = `# acme/proj
- "member": a customer with an active loyalty card.
`;

function addProject(repo, files) {
  const dir = path.join(process.env.ARW_PROJECTS_DIR, ...repo.split('/'));
  for (const [name, text] of Object.entries(files)) write(dir, name, text);
  return dir;
}

test('parseChecklist: PRJ items with source, paths and lines', () => {
  const { items, errors } = project.parseChecklist(CHECKLIST);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => i.id), ['PRJ-DSC-1', 'PRJ-DSC-2']);
  assert.equal(items[0].source, 'docs/adr/0003-discounts.md:12');
  assert.deepEqual(items[0].paths, ['src/main/java/**/OrderService.java']);
  assert.ok(items[0].lines.test('total.compareTo(x)'));
  assert.equal(items[1].paths.length, 0);
  assert.equal(items[1].lines, null);
});

test('parseChecklist: a viewpoint without a source, a bad regex, a duplicate or a foreign id is an error', () => {
  const errs = (text) => project.parseChecklist(text).errors.join('\n');
  assert.match(errs('- PRJ-A-1: text\n'), /PRJ-A-1: needs a "source:"/);
  assert.match(errs('- PRJ-A-1: text\n  - source: x\n  - lines: /(/\n'), /PRJ-A-1: bad lines regex/);
  assert.match(errs('- PRJ-A-1: text\n  - source: x\n  - lines: compareTo\n'), /PRJ-A-1: lines must be written \/regex\/flags/);
  assert.match(errs('- PRJ-A-1: a\n  - source: x\n- PRJ-A-1: b\n  - source: y\n'), /duplicate id PRJ-A-1/);
  assert.match(errs('- CK-BZ-1: shadowing the shared checklist\n  - source: x\n'), /line 1: only PRJ-<AREA>-<n> viewpoints/);
  assert.match(errs('- PRJ-A-1: text\n  - source: x\n  - when: always\n'), /PRJ-A-1: unknown key "when"/);
  assert.match(errs('  - source: x\n'), /line 1: "source:" outside a viewpoint/);
});

test('projectDir: only owner/name, no traversal', () => {
  assert.ok(project.projectDir('acme/proj').endsWith(path.join('acme', 'proj')));
  for (const bad of ['../x', 'acme/../../etc', 'acme', 'a/b/c', 'acme/.', '', null]) assert.throws(() => project.projectDir(bad), /bad repository name/, String(bad));
});

test('loadProject: none configured is null; files become frozen inputs; malformed stops the review', () => {
  assert.equal(project.loadProject('acme/none'), null);
  addProject('acme/load', { 'checklist.md': CHECKLIST, 'profile.md': PROFILE });
  const p = project.loadProject('acme/load');
  assert.deepEqual(p.inputs.map((i) => [i.id, i.kind]), [['policy-project-checklist', 'policy'], ['project-profile', 'project']]);
  assert.deepEqual(p.rules.map((r) => r.id), ['PRJ-DSC-1', 'PRJ-DSC-2']);
  // GitHub names are case-insensitive: the folder is found either way.
  assert.ok(project.loadProject('Acme/Load'));
  addProject('acme/broken', { 'checklist.md': '- PRJ-A-1: no source\n' });
  assert.throws(() => project.loadProject('acme/broken'), /acme\/broken.*PRJ-A-1: needs a "source:".*arw project check acme\/broken/s);
});

const file = (p, added, removed = []) => ({ path: p, hunks: [{ lines: [...added.map((text) => ({ type: '+', text })), ...removed.map((text) => ({ type: '-', text }))] }] });

test('selectChecks: project viewpoints follow their paths and lines, after the shared ones', () => {
  const rules = project.parseChecklist(CHECKLIST).items;
  const order = file('src/main/java/com/acme/OrderService.java', ['if (total.compareTo(THRESHOLD) >= 0) {']);
  const other = file('src/main/java/com/acme/Other.java', ['if (total.compareTo(LIMIT) >= 0) {']);
  const readme = file('README.md', ['compareTo']);
  const testFile = file('src/test/java/com/acme/OrderServiceTest.java', ['assertEquals(1, 1);']);
  const ck = '- CK-BZ-1: Boundary conditions.\n';
  assert.deepEqual(selectChecks([order], ck, { projectRules: rules }), ['CK-BZ-1', 'PRJ-DSC-1', 'PRJ-DSC-2']);
  // paths and lines both must hold
  assert.deepEqual(selectChecks([other], '', { projectRules: rules }), ['PRJ-DSC-2']);
  // no paths and no lines: every changed non-test source file
  assert.deepEqual(selectChecks([readme], '', { projectRules: rules }), []);
  assert.deepEqual(selectChecks([testFile], '', { projectRules: rules }), []);
  const units = [{ id: 'U1', kind: 'technical', covers: [`file:${order.path}`], roles: ['technical'] }];
  assignChecks(units, [order], ck, rules);
  assert.deepEqual(units[0].checks, ['CK-BZ-1', 'PRJ-DSC-1', 'PRJ-DSC-2']);
});

test('freeze: project files are frozen inputs of their repository only; editing one is drift', () => {
  const repo = makeRepo();
  const freeze = require('../src/lib/freeze');
  const dir = addProject('acme/drift', { 'checklist.md': CHECKLIST, 'profile.md': PROFILE });
  const runDir = tmpDir('arw-project-freeze-');
  const review = { units: [] };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ review }));
  const args = { runDir, checkout: repo.dir, base: repo.base, head: repo.head, changed: [], reviewable: [], patch: '', review, inputs: [] };
  const ctx = freeze.freezeContext({ ...args, project: 'acme/drift' });
  assert.equal(ctx.project, 'acme/drift');
  const ids = ctx.inputs.map((i) => i.id);
  assert.ok(ids.includes('policy-project-checklist') && ids.includes('project-profile'), ids.join(','));
  assert.deepEqual(freeze.verifyContext(runDir, ctx), []);
  // Another repository's review does not see this project's files.
  const otherRun = tmpDir('arw-project-freeze-');
  fs.writeFileSync(path.join(otherRun, 'run.json'), JSON.stringify({ review }));
  const other = freeze.freezeContext({ ...args, runDir: otherRun, project: 'acme/other' });
  assert.ok(!other.inputs.some((i) => /project/.test(i.id)));
  fs.appendFileSync(path.join(dir, 'profile.md'), '- "VIP": edited after the freeze.\n');
  assert.match(freeze.verifyContext(runDir, ctx).join('\n'), /policy files changed since freeze: project-profile/);
  assert.deepEqual(freeze.verifyContext(otherRun, other), []);
  fs.rmSync(dir, { recursive: true });
  assert.match(freeze.verifyContext(runDir, ctx).join('\n'), /policy-project-checklist, project-profile/);
});

const ORDER = 'src/main/java/com/acme/OrderService.java';
const IF_LINE = 'if (member && total.compareTo(THRESHOLD) > 0) {';

function inputEv(prompt, id, needle) {
  const start = prompt.indexOf(`INPUT ${id}:\n`);
  assert.ok(start >= 0, `prompt lacks input ${id}`);
  const lines = prompt.slice(start + `INPUT ${id}:\n`.length).split('\n');
  const i = lines.findIndex((l) => l.replace(/^\s*\d+\| /, '').includes(needle));
  assert.ok(i >= 0, `${needle} not in ${id}`);
  return { kind: 'input', path: id, start_line: i + 1, end_line: i + 1, quote: needle };
}

test('a PR review asks the project viewpoints, shows the profile, and accepts a finding citing one', async () => {
  const repo = makeRepo();
  addProject('acme/proj', { 'checklist.md': CHECKLIST, 'profile.md': PROFILE });
  const { reviewPr } = require('../src/lib/pr-review');
  const fake = require('./fixtures/fake-review-executor');
  const jobPrompts = [];
  const executor = async (opts) => {
    const res = await fake(opts);
    if (!opts.prompt.includes('JOB: ') || !res.ok) return res;
    jobPrompts.push(opts.prompt);
    const packet = JSON.parse(res.output);
    if (/VIEWPOINT CHECKS \(required\).*PRJ-DSC-1/.test(opts.prompt)) {
      const ev = { kind: 'code', path: ORDER, start_line: 9, end_line: 9, quote: IF_LINE };
      packet.findings.push({
        id: `${packet.unit_id}-${packet.role}-F${packet.findings.length + 1}`, severity: 'P2', confidence: 'LIKELY', title: 'Threshold is exclusive',
        asis: 'A member with exactly 1,000,000 gets no discount.', tobe: 'The discount applies from 1,000,000.',
        trigger: { given: 'a member', when: 'the total is exactly 1,000,000', then: 'no discount' }, impact: 'Members are overcharged.',
        evidence: [ev], fix: { kind: 'code_change', asis: IF_LINE, tobe: 'if (member && total.compareTo(THRESHOLD) >= 0) {', reason: 'inclusive threshold' },
        verification: { method: 'inspected', detail: 'read the comparison', evidence: [] },
        authority: { kind: 'curated_viewpoint', id: 'PRJ-DSC-1', source: inputEv(opts.prompt, 'policy-project-checklist', 'PRJ-DSC-1: The member discount threshold is inclusive') }, items: [],
      });
      packet.viewpoint_verdicts = viewpointVerdicts(opts.prompt, packet.findings);
      packet.recommendation = 'findings';
      res.output = JSON.stringify(packet);
    }
    return res;
  };
  const prepared = { info: { title: 'ACME-7 member discount', body: 'Members get 10% off from 1,000,000.', headRefName: 'feature', baseRefName: 'main', url: null }, checkout: repo.dir, head: repo.head, base: repo.base };
  process.env.ARW_PLAIN_REVIEW = 'off';
  let out;
  try {
    out = await reviewPr({ repo: 'acme/proj', pr: 3, executor, prepared, workers: 2, noRepro: true, skipRebuttals: true, skipSynthesis: true, prIntent: false });
  } finally {
    delete process.env.ARW_PLAIN_REVIEW;
  }
  const { validation } = out;
  assert.equal(validation.status, 'EXECUTED_PASS', JSON.stringify(validation.jobs.filter((j) => j.errors.length), null, 1));
  const asked = jobPrompts.find((p) => /VIEWPOINT CHECKS \(required\).*PRJ-DSC-1/.test(p));
  assert.ok(asked, 'a job was asked PRJ-DSC-1');
  assert.match(asked, /PRJ-\* in input "policy-project-checklist"/);
  assert.match(asked, /INPUT project-profile:\n1\| # acme\/proj\n2\| - "member": a customer with an active loyalty card/);
  assert.match(asked, /- project-profile \(project\)/);
  assert.ok(validation.findings.some((f) => f.title === 'Threshold is exclusive'), validation.findings.map((f) => f.title).join(', '));
});

test('authority: the project checklist counts, the profile never does', () => {
  const freeze = require('../src/lib/freeze');
  const repo = makeRepo();
  addProject('acme/auth', { 'checklist.md': '- PRJ-OK-1: real\n  - source: x\n', 'profile.md': '- PRJ-FAKE-1 written in the profile\n' });
  const runDir = tmpDir('arw-project-auth-');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ review: { units: [] } }));
  const ctx = freeze.freezeContext({ runDir, checkout: repo.dir, base: repo.base, head: repo.head, changed: [], reviewable: [], patch: '', review: { units: [] }, inputs: [], project: 'acme/auth' });
  const { makeSources } = require('../src/lib/validate');
  const sources = makeSources(runDir, ctx);
  assert.ok(sources.policyText().includes('PRJ-OK-1'));
  assert.ok(!sources.policyText().includes('PRJ-FAKE-1'));
});

test('init writes a skeleton that parses; check reports sources missing from the checkout', () => {
  const repo = makeRepo();
  const dir = project.initProject('acme/new');
  assert.ok(fs.existsSync(path.join(dir, 'checklist.md')) && fs.existsSync(path.join(dir, 'profile.md')));
  assert.throws(() => project.initProject('acme/new'), /already exists/);
  assert.deepEqual(project.parseChecklist(fs.readFileSync(path.join(dir, 'checklist.md'), 'utf8')).errors, []);
  addProject('acme/check', { 'checklist.md': `- PRJ-A-1: a\n  - source: ${ORDER}:9\n- PRJ-A-2: b\n  - source: docs/missing.md:3\n- PRJ-A-3: c\n  - source: ${ORDER}:999\n- PRJ-A-4: d\n  - source: incident INC-1\n` });
  const r = project.checkProject('acme/check', { checkout: repo.dir });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.items.map((i) => i.id), ['PRJ-A-1', 'PRJ-A-2', 'PRJ-A-3', 'PRJ-A-4']);
  const w = r.warnings.join('\n');
  assert.match(w, /PRJ-A-2: source docs\/missing\.md is not in .* at HEAD/);
  assert.match(w, /PRJ-A-3: source .*OrderService\.java has \d+ lines, not 999/);
  assert.doesNotMatch(w, /PRJ-A-1|PRJ-A-4/);
});
