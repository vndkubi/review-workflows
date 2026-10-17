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
  assert.equal(tickets.items.length, 3, 'unapproved: one item per requirement item');
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
