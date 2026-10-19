'use strict';
// A PR without a ticket: its intent is read from what the author wrote (title,
// description, linked issues, commit messages), never from the diff, and goes
// through the usual requirements -> spec tables -> SPEC gate. It is the
// author's claim, so no policy approves it: a person confirms the intent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, scriptedExecutor } = require('./helpers');

process.env.ARW_RUNS_DIR = tmpDir('arw-intent-runs-');

const { prTicketKey, linkedRefs, prIntentEvidence } = require('../src/lib/pr-intent');
const { advanceTicket } = require('../src/lib/ticket-pipeline');
const { ensurePrIntent, ticketInputs } = require('../src/lib/pr-review');
const { gateState, ticketDir } = require('../src/lib/runs');

const BODY = [
  'Refund approvals.',
  '',
  '## Acceptance Criteria',
  '- Refunds over 500 need two approvers.',
  '- Refunds of 500 or less need one approver.',
  '- Negative refunds are rejected.',
  '',
  'Fixes #12',
].join('\n');

// A spec with no gaps, contradictions or inferred rules: clean.
function cleanModel(ticket) {
  return {
    schema_version: '1.0',
    ticket,
    features: [{
      id: 'F1',
      name: 'Refund approval',
      variables: [{ id: 'amount', description: 'refund amount', type: 'integer', classes: [
        { id: 'neg', label: 'negative', validity: 'invalid', max: '0', max_inclusive: false },
        { id: 'small', label: '0..500', validity: 'valid', min: '0', min_inclusive: true, max: '500', max_inclusive: true },
        { id: 'large', label: '> 500', validity: 'valid', min: '500', min_inclusive: false },
      ] }],
      outcomes: [{ id: 'approvers', description: 'approvers needed' }],
      rules: [
        { id: 'R1', conditions: [{ variable: 'amount', classes: ['large'] }], results: [{ outcome: 'approvers', value: '2' }], acs: ['AC1'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'Refunds over 500 need two approvers.' } },
        { id: 'R2', conditions: [{ variable: 'amount', classes: ['small'] }], results: [{ outcome: 'approvers', value: '1' }], acs: ['AC2'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'Refunds of 500 or less need one approver.' } },
        { id: 'R3', conditions: [{ variable: 'amount', classes: ['neg'] }], results: [{ outcome: 'approvers', value: 'rejected' }], acs: ['AC3'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'Negative refunds are rejected.' } },
      ],
    }],
    other_acs: [],
    notes: '',
  };
}

function executorFor(ticket) {
  return scriptedExecutor((prompt) => {
    if (prompt.startsWith('You audit')) return '{"missing":[],"invalid":[]}';
    if (prompt.startsWith('You model the business decisions')) return JSON.stringify(cleanModel(ticket));
    // Only reached after an approval (the control); stops the run there.
    if (prompt.includes('requirement analyst')) return { error_class: 'auth', error_message: 'analysis is not part of this test' };
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  });
}

const issue12 = { title: 'Big refunds need a second look', body: 'Finance asked for two approvers above 500.', state: 'open', url: 'https://github.com/acme/shop/issues/12' };
const fromPr = (pr = 7, extra = {}) => ({
  repo: 'acme/shop',
  pr,
  info: { title: 'Refund approvals by amount', body: BODY, url: `https://github.com/acme/shop/pull/${pr}` },
  commits: ['Require two approvers above 500', 'Reject negative refunds'],
  fetchIssue: async (repo, n) => (repo === 'acme/shop' && n === 12 ? issue12 : null),
  ...extra,
});

test('a PR ticket key is a valid, repository-specific ticket key', () => {
  assert.equal(prTicketKey('appsmithorg/appsmith', 42411), 'PRAPPSMITH-42411');
  assert.equal(prTicketKey('Anuken/Mindustry', 12707), 'PRMINDUSTRY-12707');
  assert.equal(prTicketKey('a/my-repo.js', 1), 'PRMYREPOJS-1');
  for (const k of ['PRAPPSMITH-42411', 'PRMYREPOJS-1']) assert.match(k, /^[A-Z][A-Z0-9]+-\d+$/);
});

test('linked issues and PRs are read from the description, the PR itself left out', () => {
  const body = 'Fixes #12, see acme/lib#3, https://github.com/Anuken/Mindustry-Suggestions/issues/6110 and https://github.com/acme/shop/pull/11768. Again #12; this is #7.';
  assert.deepEqual(linkedRefs(body, 'acme/shop', 7), [
    { repo: 'acme/shop', number: 12, relation: 'fixes' },
    { repo: 'acme/lib', number: 3, relation: 'mentions' },
    { repo: 'Anuken/Mindustry-Suggestions', number: 6110, relation: 'mentions' },
    { repo: 'acme/shop', number: 11768, relation: 'mentions' },
  ]);
});

test('the intent evidence is what the author wrote, labelled as such, without the diff', async () => {
  const ev = await prIntentEvidence(fromPr(7, { info: { ...fromPr().info, diff: '+ if (amount > 500)' } }));
  assert.match(ev.text, /written by the author of the change/);
  assert.match(ev.text, /Refund approvals by amount/);
  assert.match(ev.text, /Refunds over 500 need two approvers\./);
  assert.match(ev.text, /- Require two approvers above 500/);
  assert.ok(!ev.text.includes('amount > 500'), 'the diff is never intent evidence');
  assert.deepEqual(ev.linked.map((l) => [l.key, l.relation]), [['acme-shop-12', 'fixes']]);
  assert.match(ev.linked[0].text, /Finance asked for two approvers above 500\./);
  // An issue that cannot be read is noted, not fatal.
  const broken = await prIntentEvidence(fromPr(7, { fetchIssue: async () => { throw new Error('404'); } }));
  assert.deepEqual(broken.linked, []);
  assert.match(broken.notes.join(' '), /acme\/shop#12 could not be read/);
});

test('a PR-derived spec gets the usual tables and waits for a person even when clean', async () => {
  const saved = process.env.ARW_AUTO_APPROVE_SPEC;
  process.env.ARW_AUTO_APPROVE_SPEC = '1';
  try {
    // Control: the same model from a ticket file is clean and auto-approved.
    const file = path.join(tmpDir(), 'T.md');
    fs.writeFileSync(file, BODY);
    const fromTicket = await advanceTicket({ key: 'CTRL-1', fromFile: file, executor: executorFor('CTRL-1') });
    assert.equal(gateState(fromTicket.dir, 'SPEC').decision, 'approved', 'control: the policy approves a clean ticket spec');

    const key = prTicketKey('acme/shop', 7);
    const res = await advanceTicket({ key, fromPr: fromPr(7), executor: executorFor(key) });
    assert.equal(res.state, 'AWAIT_GATE_SPEC', res.message);
    assert.match(res.message, /author/);
    assert.equal(gateState(res.dir, 'SPEC').decision, 'NOT_RECORDED');
    const run = JSON.parse(fs.readFileSync(path.join(res.dir, 'run.json'), 'utf8'));
    assert.deepEqual([run.stages.intake.source, run.stages.intake.intent], ['github-pr:acme/shop#7', 'pr']);
    assert.ok(fs.existsSync(path.join(res.dir, 'evidence', 'linked-acme-shop-12.md')));
    const spec = JSON.parse(fs.readFileSync(path.join(res.dir, 'spec.json'), 'utf8'));
    assert.equal(spec.clean, true);
    assert.equal(spec.stats.rules, 3);
    assert.match(fs.readFileSync(path.join(res.dir, 'spec.md'), 'utf8'), /DECISION TABLE|Decision table/i);
  } finally {
    if (saved === undefined) delete process.env.ARW_AUTO_APPROVE_SPEC;
    else process.env.ARW_AUTO_APPROVE_SPEC = saved;
  }
});

test('a review without a ticket derives the intent from its PR once, then uses it', async () => {
  const key = prTicketKey('acme/shop', 8);
  const exec = executorFor(key);
  const logs = [];
  const base = { repo: 'acme/shop', pr: 8, info: fromPr(8).info, executor: exec, models: {}, log: (m) => logs.push(m), commits: fromPr(8).commits, fetchIssue: fromPr(8).fetchIssue };
  const run = { identity: {} };
  const tickets = await ensurePrIntent({ ...base, run, tickets: ticketInputs(run, { info: base.info }) });
  assert.equal(tickets.key, key);
  assert.equal(tickets.approved, false);
  const derived = JSON.parse(fs.readFileSync(path.join(ticketDir(key), 'spec.json'), 'utf8'));
  assert.deepEqual(tickets.items.map((i) => i.id), derived.review_items.map((i) => i.id), 'unconfirmed: the items of the derived spec');
  assert.ok(tickets.specMarkdown, 'the reviewers see the derived spec');
  assert.equal(run.identity.ticket, key);
  assert.equal(run.identity.ticket_source, 'pr');
  assert.ok(logs.some((l) => /derived the intent from the PR description/.test(l)));
  const calls = exec.calls.length;

  // A second review finds the PR ticket run and does not rebuild it.
  const again = { identity: {} };
  const found = ticketInputs(again, { info: base.info, repo: 'acme/shop', pr: 8 });
  assert.equal(found.key, key);
  const reused = await ensurePrIntent({ ...base, run: again, tickets: found });
  assert.equal(reused.key, key);
  assert.equal(exec.calls.length, calls, 'no model call when the PR ticket run exists');

  // Off by setting, and never for local reviews.
  const saved = process.env.ARW_PR_INTENT;
  process.env.ARW_PR_INTENT = 'off';
  try {
    const off = await ensurePrIntent({ ...base, pr: 9, info: { ...base.info, body: 'x' }, run: { identity: {} }, tickets: { key: null } });
    assert.equal(off.key, null);
  } finally {
    if (saved === undefined) delete process.env.ARW_PR_INTENT;
    else process.env.ARW_PR_INTENT = saved;
  }
  const local = await ensurePrIntent({ ...base, repo: null, pr: null, run: { identity: {} }, tickets: { key: null } });
  assert.equal(local.key, null);
  assert.ok(!fs.existsSync(ticketDir(prTicketKey('acme/shop', 9))));
});

test('a ticket key named in the PR keeps precedence when its run exists', async () => {
  const file = path.join(tmpDir(), 'T.md');
  fs.writeFileSync(file, BODY);
  await advanceTicket({ key: 'SHOP-5', fromFile: file, executor: executorFor('SHOP-5') });
  const run = { identity: {} };
  const info = { ...fromPr(10).info, title: 'SHOP-5 refunds' };
  const t = await ensurePrIntent({ repo: 'acme/shop', pr: 10, info, executor: executorFor('X'), models: {}, log: () => {}, run, tickets: ticketInputs(run, { info, repo: 'acme/shop', pr: 10 }) });
  assert.equal(t.key, 'SHOP-5');
  assert.notEqual(run.identity.ticket_source, 'pr');
});

// ---------- confirm the intent before reviewing ----------

const PATCH = [
  'diff --git a/src/Lightning.java b/src/Lightning.java',
  '--- a/src/Lightning.java',
  '+++ b/src/Lightning.java',
  '@@ -1,3 +1,8 @@',
  '-    // old comment that was removed',
  '+    /** Maximum number of times the same target can be hit. <= 0 for unlimited. */',
  '+    public int lightningHits = -1;',
  '+    if (hits < 0 || count < hits) create();',
  '+    # not a comment in Java but kept as prose',
  'diff --git a/test/LightningTest.java b/test/LightningTest.java',
  '+++ b/test/LightningTest.java',
  '@@ -0,0 +1,4 @@',
  '+    @Test',
  '+    void zeroHitsMeansUnlimited() {',
  '+    @DisplayName("negative hits keep the vanilla behaviour")',
  '+def test_zero_means_unlimited():',
].join('\n');

test('what the author wrote inside the change (comments, test names) is intent evidence; the code is not', async () => {
  const ev = await prIntentEvidence(fromPr(7, { patch: PATCH }));
  assert.match(ev.text, /## What the author wrote in the change/);
  assert.match(ev.text, /src\/Lightning\.java: \/\*\* Maximum number of times the same target can be hit\. <= 0 for unlimited\. \*\//);
  assert.match(ev.text, /test\/LightningTest\.java: test zeroHitsMeansUnlimited/);
  assert.match(ev.text, /test: negative hits keep the vanilla behaviour/);
  assert.match(ev.text, /test zero_means_unlimited/);
  assert.ok(!ev.text.includes('count < hits'), 'code lines are not intent');
  assert.ok(!ev.text.includes('public int lightningHits'), 'declarations are not intent');
  assert.ok(!ev.text.includes('old comment that was removed'), 'removed lines are not intent');
});

test('each feature is business or technical; technical items can be graded by the technical reviewer', async () => {
  const { computeOutcome } = require('../src/lib/outcome');
  const key = 'TECH-1';
  const model = cleanModel(key);
  model.features[0].nature = 'technical';
  const exec = scriptedExecutor((prompt) => {
    if (prompt.startsWith('You audit')) return '{"missing":[],"invalid":[]}';
    if (prompt.startsWith('You model')) {
      assert.match(prompt, /nature/, 'the prompt asks for business or technical');
      return JSON.stringify(model);
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  });
  const file = path.join(tmpDir(), 'T.md');
  fs.writeFileSync(file, BODY);
  const res = await advanceTicket({ key, fromFile: file, executor: exec });
  const spec = JSON.parse(fs.readFileSync(path.join(res.dir, 'spec.json'), 'utf8'));
  assert.equal(spec.features[0].nature, 'technical');
  assert.ok(spec.review_items.every((i) => i.nature === 'technical'));
  assert.match(fs.readFileSync(path.join(res.dir, 'spec.md'), 'utf8'), /## F1 — Refund approval \(technical\)/);

  const item = { ...spec.review_items.find((i) => i.kind === 'rule'), risk: 'money' };
  const packets = [{ unit_id: 'B1', role: 'technical', packet: { findings: [], item_verdicts: [{ item: item.id, verdict: 'pass', note: 'n' }] } }];
  const jobs = [];
  assert.deepEqual(computeOutcome({ packets, jobs, clusters: [], rebuttals: new Map(), items: [item] }).gaps, [], 'a technical verdict decides a technical item');
  const business = { ...item, nature: 'business' };
  assert.equal(computeOutcome({ packets, jobs, clusters: [], rebuttals: new Map(), items: [business] }).gaps.length, 1, 'a business item still needs the business reviewer');
  // A model that leaves nature out (older answers) is business.
  delete model.features[0].nature;
  model.ticket = 'TECH-2';
  const old = await advanceTicket({ key: 'TECH-2', fromFile: file, executor: exec });
  assert.equal(JSON.parse(fs.readFileSync(path.join(old.dir, 'spec.json'), 'utf8')).features[0].nature, 'business');
});

test('a review of a PR without a ticket reviews right away against the derived spec; confirm mode waits for a person', async () => {
  const { makeRepo } = require('./helpers');
  const { reviewPr } = require('../src/lib/pr-review');
  const { recordGate, prDir } = require('../src/lib/runs');
  const repo = makeRepo();
  const prompts = [];
  const execFor = (key) => scriptedExecutor((prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('You audit')) return '{"missing":[],"invalid":[]}';
    if (prompt.startsWith('You model the')) return JSON.stringify(cleanModel(key));
    return { error_class: 'auth', error_message: 'the review itself is not part of this test' };
  });
  const prepared = (pr) => ({ info: { ...fromPr(pr).info, headRefName: `refunds-${pr}`, baseRefName: 'main' }, checkout: repo.dir, head: repo.head, base: repo.base });
  const planner = () => prompts.find((p) => p.startsWith('You are a read-only planner'));

  // Default: derive, then review at once, graded by the derived spec's items, labelled unconfirmed.
  const key = prTicketKey('acme/shop', 21);
  await assert.rejects(reviewPr({ repo: 'acme/shop', pr: 21, prepared: prepared(21), executor: execFor(key), noRepro: true }), /planning failed/);
  assert.ok(planner(), 'the review does not wait');
  const spec = JSON.parse(fs.readFileSync(path.join(ticketDir(key), 'spec.json'), 'utf8'));
  const boundary = spec.review_items.find((i) => i.kind === 'boundary');
  assert.ok(boundary && planner().includes(boundary.id) && planner().includes('Boundary of amount'), 'the planner gets the spec items (boundaries included), not only raw requirements');
  const run = JSON.parse(fs.readFileSync(path.join(prDir('acme/shop', 21), 'run.json'), 'utf8'));
  assert.deepEqual([run.phases.ticket.status, run.phases.ticket.ticket, run.phases.ticket.spec_approved, run.phases.ticket.intent], ['EXECUTED_PASS', key, false, 'unconfirmed']);

  // ARW_PR_INTENT=confirm waits until the SPEC gate is approved.
  const saved = process.env.ARW_PR_INTENT;
  process.env.ARW_PR_INTENT = 'confirm';
  try {
    prompts.length = 0;
    const key2 = prTicketKey('acme/shop', 22);
    const res = await reviewPr({ repo: 'acme/shop', pr: 22, prepared: prepared(22), executor: execFor(key2), noRepro: true });
    assert.deepEqual([res.awaiting, res.ticket, res.validation], ['intent', key2, null]);
    assert.ok(!planner(), 'nothing is reviewed before the intent is confirmed');
    const waiting = JSON.parse(fs.readFileSync(path.join(prDir('acme/shop', 22), 'run.json'), 'utf8'));
    assert.deepEqual([waiting.phases.ticket.status, waiting.phases.ticket.ticket], ['AWAITING_INTENT', key2]);
    recordGate(ticketDir(key2), 'SPEC', 'approved', { by: 'test', note: 'that is what it should do' });
    await assert.rejects(reviewPr({ repo: 'acme/shop', pr: 22, prepared: prepared(22), executor: execFor(key2), noRepro: true }));
    assert.ok(planner(), 'the review starts once confirmed');
    const after = JSON.parse(fs.readFileSync(path.join(prDir('acme/shop', 22), 'run.json'), 'utf8'));
    assert.deepEqual([after.phases.ticket.status, after.phases.ticket.spec_approved, after.phases.ticket.intent], ['EXECUTED_PASS', true, 'confirmed']);
  } finally {
    if (saved === undefined) delete process.env.ARW_PR_INTENT;
    else process.env.ARW_PR_INTENT = saved;
  }
});

test('an edited PR description rebuilds the derived intent, and a confirmation of the old one no longer counts', async () => {
  const { recordGate, isApproved } = require('../src/lib/runs');
  const key = prTicketKey('acme/shop', 30);
  const exec = executorFor(key);
  const base = { repo: 'acme/shop', pr: 30, executor: exec, models: {}, log: () => {}, commits: [], fetchIssue: async () => null };
  const info = fromPr(30).info;
  await ensurePrIntent({ ...base, info, run: { identity: {} }, tickets: { key: null } });
  recordGate(ticketDir(key), 'SPEC', 'approved', { by: 'test' });
  const calls = exec.calls.length;

  // Same description: nothing rebuilt, the confirmation holds.
  const same = await ensurePrIntent({ ...base, info, run: { identity: {} }, tickets: ticketInputs({ identity: {} }, { info, repo: 'acme/shop', pr: 30 }) });
  assert.equal(exec.calls.length, calls);
  assert.equal(same.approved, true);

  // Edited description: requirements and spec are rebuilt; the old approval is not bound to the new spec.
  const edited = { ...info, body: `${BODY}\n\nAlso: refunds above 10000 are blocked.` };
  const t = await ensurePrIntent({ ...base, info: edited, run: { identity: {} }, tickets: ticketInputs({ identity: {} }, { info: edited, repo: 'acme/shop', pr: 30 }) });
  assert.ok(exec.calls.length > calls, 'the intent was rebuilt from the new description');
  assert.equal(t.approved, false);
  assert.equal(isApproved(ticketDir(key), 'SPEC'), false);
});

test('the PR page data carries the derived intent: its state, gate and spec; a failed derivation is shown, not hidden', async () => {
  const { makeRepo } = require('./helpers');
  const { reviewPr } = require('../src/lib/pr-review');
  const { recordGate } = require('../src/lib/runs');
  const data = require('../src/web/data');
  const repo = makeRepo();
  const key = prTicketKey('acme/shop', 23);
  const exec = scriptedExecutor((prompt) => {
    if (prompt.startsWith('You audit')) return '{"missing":[],"invalid":[]}';
    if (prompt.startsWith('You model the')) return JSON.stringify(cleanModel(key));
    return { error_class: 'auth', error_message: 'the review itself is not part of this test' };
  });
  const prepared = (pr, body) => ({ info: { title: 'Refunds', body, headRefName: `r${pr}`, baseRefName: 'main', url: null }, checkout: repo.dir, head: repo.head, base: repo.base });

  await assert.rejects(reviewPr({ repo: 'acme/shop', pr: 23, prepared: prepared(23, BODY), executor: exec, noRepro: true }), /planning failed/);
  let d = data.prDetail('acme__shop__23');
  assert.equal(d.intent.key, key);
  assert.equal(d.intent.state, 'AWAIT_GATE_SPEC');
  assert.equal(d.intent.gate.decision, 'NOT_RECORDED');
  assert.equal(d.intent.stats.rules, 3);
  assert.equal(d.intent.error, null);

  recordGate(ticketDir(key), 'SPEC', 'approved', { by: 'test' });
  d = data.prDetail('acme__shop__23');
  assert.equal(d.intent.state, 'SPEC_APPROVED', 'an approved spec is not waiting for a decision');
  assert.equal(data.ticketDetail(key).state, 'SPEC_APPROVED');

  // An empty description gives nothing to derive: the review goes on, and says so.
  await assert.rejects(reviewPr({ repo: 'acme/shop', pr: 24, prepared: prepared(24, ''), executor: exec, noRepro: true }));
  d = data.prDetail('acme__shop__24');
  assert.match(d.intent.error, /could not derive the intent|no requirement items/);
  assert.equal(d.phases.ticket.intent_error, d.intent.error);
});

// Incident (user report): a review run for a PR whose ticket was added but
// never taken through requirements and spec reviewed without the spec, and
// the PR page had no Spec tab for a ticket. The review now builds the spec
// (stopping at the SPEC gate), grades against it unconfirmed, and the PR
// page carries the ticket's spec like a derived one.
test('a ticket whose spec is not built yet is built by the review, graded unconfirmed, and shown on the PR page', async () => {
  const { makeRepo } = require('./helpers');
  const { reviewPr } = require('../src/lib/pr-review');
  const { prDir } = require('../src/lib/runs');
  const data = require('../src/web/data');
  const repo = makeRepo();
  const file = path.join(tmpDir(), 'REF-9.md');
  fs.writeFileSync(file, `# REF-9 Refund approvals\n\n${BODY}\n`);
  // The user added the ticket, but its pipeline stopped before the spec.
  const stop = scriptedExecutor(() => ({ error_class: 'auth', error_message: 'stopped' }));
  await advanceTicket({ key: 'REF-9', fromFile: file, executor: stop }).catch(() => null);
  assert.ok(fs.existsSync(path.join(ticketDir('REF-9'), 'run.json')));
  assert.ok(!fs.existsSync(path.join(ticketDir('REF-9'), 'spec.json')));

  const prompts = [];
  const exec = scriptedExecutor((prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('You audit')) return '{"missing":[],"invalid":[]}';
    if (prompt.startsWith('You model the')) return JSON.stringify(cleanModel('REF-9'));
    return { error_class: 'auth', error_message: 'the review itself is not part of this test' };
  });
  const prepared = { info: { title: 'REF-9 refund approvals', body: '', headRefName: 'ref-9', baseRefName: 'main', url: null }, checkout: repo.dir, head: repo.head, base: repo.base };
  await assert.rejects(reviewPr({ repo: 'acme/shop', pr: 31, ticket: 'REF-9', prepared, executor: exec, noRepro: true }), /planning failed/);

  const specFile = path.join(ticketDir('REF-9'), 'spec.json');
  assert.ok(fs.existsSync(specFile), 'the review built the spec');
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const planner = prompts.find((p) => p.startsWith('You are a read-only planner'));
  const boundary = spec.review_items.find((i) => i.kind === 'boundary');
  assert.ok(planner && boundary && planner.includes(boundary.id), 'graded by the spec items, boundaries included');
  const run = JSON.parse(fs.readFileSync(path.join(prDir('acme/shop', 31), 'run.json'), 'utf8'));
  assert.deepEqual([run.phases.ticket.ticket, run.phases.ticket.spec_approved, run.phases.ticket.intent], ['REF-9', false, 'unconfirmed']);

  const d = data.prDetail('acme__shop__31');
  assert.deepEqual([d.intent.key, d.intent.source, d.intent.state], ['REF-9', 'ticket', 'AWAIT_GATE_SPEC']);
  assert.equal(d.intent.stats.rules, 3);
});
