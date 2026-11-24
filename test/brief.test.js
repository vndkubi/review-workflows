'use strict';
// The review brief: one screen that says what the PR does, how the code
// meets each situation the spec names, who else is affected, what a person
// must decide and the order to read the files in. Assembled by the runtime
// from validated artifacts; every line names where it comes from.
const test = require('node:test');
const assert = require('node:assert/strict');
const brief = require('../src/lib/brief');

const SPEC_MD = [
  '# Spec — PRTRADING-1',
  '',
  '## Open questions',
  '',
  '- **Q1** (gap) No rule covers example_file_present=absent: what should example_excluded be?',
  '',
  '## F1 — Deploy configuration (technical)',
  '',
  '### Scenarios',
  '',
  '| ID | bot_config | mainnet_flag | Expected | Rule |',
  '|---|---|---|---|---|',
  '| S1 | <missing> | false | testnet, default config | R1 |',
  '| S2 | <missing> | true | mainnet \\| default config | R2 |',
  '',
  '## F2 — Example file (technical)',
  '',
  '### Scenarios',
  '',
  '| ID | example_file_present | Expected | Rule |',
  '|---|---|---|---|',
  '| S1 | present | included | R5 |',
].join('\n');

const ITEMS = [
  { id: 'I1', kind: 'rule', feature: 'F1', rule: 'R1', acs: ['AC2'], risk: 'money', label: 'CONFIRMED', text: 'R1 (Deploy): when bot_config ∈ {unset} AND mainnet_flag ∈ {no} → testnet', expected: 'Run on testnet with the default config.', scenarios: ['S1'] },
  { id: 'I2', kind: 'rule', feature: 'F1', rule: 'R2', acs: ['AC8'], risk: 'normal', label: 'INFERRED', text: 'R2 (Deploy): when bot_config ∈ {unset} AND mainnet_flag ∈ {yes} → mainnet', expected: 'Run on mainnet with the default config.', scenarios: ['S2'] },
  { id: 'I3', kind: 'rule', feature: 'F2', rule: 'R5', acs: ['AC5'], risk: 'normal', label: 'CONFIRMED', text: 'R5 (Example): when example_file_present ∈ {present} → included', expected: 'The example file is committed.', scenarios: ['S1'] },
  { id: 'I4', kind: 'constraint', acs: ['AC9'], risk: 'security', label: 'CONFIRMED', text: 'Secrets never reach the image.', expected: '', scenarios: [] },
];

function inputs(over = {}) {
  return {
    identity: { repo: 'o/trading', pr: 1, title: 'Fix docker run for the ETH bot', intent: 'derived', ticket: 'PRTRADING-1', head_sha: 'h'.repeat(40) },
    validation: {
      context_id: 'ctx1',
      recommendation: 'changes_requested',
      complete: false,
      gaps: ['V0/technical is EXECUTED_FAIL', 'X9/technical is EXECUTED_FAIL', 'B2/business is EXECUTED_FAIL', 'B2/technical is EXECUTED_FAIL', 'I4 (security risk constraint) has no determinate verdict', 'something else entirely'],
      human_gate: { recorded: 'NOT_RECORDED', bound_to_current_context: false },
      warnings: [],
      jobs: [
        { unit_id: 'B1', role: 'business', status: 'EXECUTED_PASS' },
        { unit_id: 'B2', role: 'business', status: 'EXECUTED_FAIL' },
        { unit_id: 'B2', role: 'technical', status: 'EXECUTED_FAIL' },
      ],
      items: [
        { id: 'I1', kind: 'rule', risk: 'money', result: 'pass', verdicts: [
          { unit_id: 'B1', role: 'business', verdict: 'pass', note: 'Unset BOT_CONFIG and no flag: default config, testnet.' },
          { unit_id: 'B1', role: 'technical', verdict: 'pass', note: 'Default config is forwarded without --mainnet.' },
        ] },
        { id: 'I2', kind: 'rule', risk: 'normal', result: 'fail', verdicts: [
          { unit_id: 'B1', role: 'business', verdict: 'fail', note: 'With only --mainnet the flag becomes the image tag.' },
          { unit_id: 'B1', role: 'technical', verdict: 'pass', note: 'Mainnet flag is appended.' },
        ] },
        { id: 'I3', kind: 'rule', risk: 'normal', result: 'not_graded', verdicts: [] },
        { id: 'I4', kind: 'constraint', risk: 'security', result: 'cannot_determine', verdicts: [
          { unit_id: 'B1', role: 'technical', verdict: 'cannot_determine', note: 'The Dockerfile is not in the diff.' },
        ] },
      ],
      findings: [
        { id: 'B1-business-F1', severity: 'P2', state: 'stands', label: 'SUSPECTED' },
        { id: 'B1-technical-F2', severity: 'P4', state: 'not_challenged', label: 'SUSPECTED', suggestion: true },
        { id: 'B1-technical-F3', severity: 'P1', state: 'withdrawn', label: 'SUSPECTED' },
      ],
      impacts: [
        { caller: 'C1', verdict: 'compatible', from: { path: 'bot/run.py', line: 3, symbol: 'main' }, to: { symbol: 'deploy' }, unit_id: 'B1', note: 'passes the config through' },
        { caller: 'C2', verdict: 'broken', from: { path: 'ops/cron.sh', line: 9, symbol: '(top level)' }, to: { symbol: 'deploy' }, unit_id: 'B1', note: 'calls with --mainnet only' },
      ],
    },
    plan: {
      hypotheses: [{ id: 'H1', statement: 'The deploy script forwards the chosen config and network to the container.', confidence: 'CONFIRMED' }],
      units: [
        { id: 'B1', kind: 'business', desc: 'Review how the deploy script picks config and network.', files: ['deploy/gcp.sh'] },
        { id: 'B2', kind: 'business', desc: 'Review the credential sections of the example env file.', files: ['.env.example'] },
        { id: 'V0', kind: 'viewpoint', desc: 'Free review of the whole change.', files: ['deploy/gcp.sh', '.env.example', 'README.md', 'tests/test_deploy.py', 'src/bot/api/controller.py', 'src/bot/core/engine.py', '.gitignore'] },
      ],
    },
    items: ITEMS,
    specMd: SPEC_MD,
    findings: new Map([
      ['B1-business-F1', { id: 'B1-business-F1', severity: 'P2', title: 'A mainnet-only invocation is treated as an image tag', authority: { kind: 'requirement', id: 'AC8' }, evidence: [{ kind: 'code', path: 'deploy/gcp.sh', start_line: 12, end_line: 14 }] }],
      ['B1-technical-F2', { id: 'B1-technical-F2', severity: 'P4', title: 'No test for the mainnet flag', authority: { kind: 'curated_viewpoint', id: 'CK-TS-1' }, evidence: [{ kind: 'code', path: 'deploy/gcp.sh', start_line: 1, end_line: 1 }] }],
      ['B1-technical-F3', { id: 'B1-technical-F3', severity: 'P1', title: 'Withdrawn one', authority: { kind: 'inferred', id: 'x' }, evidence: [{ kind: 'code', path: 'deploy/gcp.sh', start_line: 2, end_line: 2 }] }],
    ]),
    synthesis: { overview: [{ flow: 'GCP deploy', change: 'forwards BOT_CONFIG and --mainnet to the container', finding_ids: ['B1-business-F1'] }] },
    related: [],
    ...over,
  };
}

test('scenarios are read per feature from the spec, escaped pipes kept', () => {
  const s = brief.parseScenarios(SPEC_MD);
  assert.deepEqual(s.get('F1:S1'), { bot_config: '<missing>', mainnet_flag: 'false' });
  assert.deepEqual(s.get('F1:S2'), { bot_config: '<missing>', mainnet_flag: 'true' });
  assert.deepEqual(s.get('F2:S1'), { example_file_present: 'present' }, 'S1 of F2 is not S1 of F1');
  assert.deepEqual(brief.parseQuestions(SPEC_MD), [{ id: 'Q1', text: '(gap) No rule covers example_file_present=absent: what should example_excluded be?' }]);
});

test('the brief says what the PR does, with the source of every line', () => {
  const b = brief.buildBrief(inputs());
  assert.equal(b.title, 'Fix docker run for the ETH bot');
  assert.match(b.intent.text, /derived from the PR as PRTRADING-1/);
  assert.equal(b.intent.confirmed, false);
  assert.deepEqual(b.purpose.map((p) => p.source), ['H1', 'GCP deploy']);
  // Parts: substantive units only, with what happened to them.
  assert.deepEqual(b.parts.map((p) => [p.source, p.checked]), [['B1', true], ['B2', false]]);
});

test('each situation is written with its concrete values and the reviewers\' finding', () => {
  const b = brief.buildBrief(inputs());
  const byId = Object.fromEntries(b.behaviour.rows.map((r) => [r.source, r]));
  // Order: what fails first, then undecided, then not checked, then passes.
  assert.deepEqual(b.behaviour.rows.map((r) => r.source), ['I2', 'I4', 'I3', 'I1']);
  assert.equal(byId.I1.situation, 'bot_config=<missing>, mainnet_flag=false');
  assert.equal(byId.I3.situation, 'example_file_present=present', 'F2 scenario, not F1\'s S1');
  assert.equal(byId.I4.situation, 'Secrets never reach the image.', 'no scenario: the item text');
  assert.equal(byId.I1.expected, 'Run on testnet with the default config.');
  // Same verdict from both roles: one note; different verdicts: both, labelled.
  assert.equal(byId.I1.head, 'Unset BOT_CONFIG and no flag: default config, testnet.');
  assert.match(byId.I2.head, /business: fail — With only --mainnet/);
  assert.match(byId.I2.head, /technical: pass — Mainnet flag/);
  assert.equal(byId.I3.head, null, 'no verdict: nothing is claimed about the code');
  assert.equal(byId.I1.result, 'pass');
  assert.equal(byId.I3.result, 'not_graded');
  assert.equal(b.behaviour.base_recorded, false, 'behaviour at base is not recorded yet, and says so');
});

test('the verdict names open P1/P2 findings and turns gaps into what was not checked', () => {
  const b = brief.buildBrief(inputs());
  assert.equal(b.verdict.recommendation, 'changes_requested');
  assert.equal(b.verdict.complete, false);
  assert.deepEqual(b.verdict.blocking.map((f) => f.source), ['B1-business-F1'], 'withdrawn and P4 are not blocking');
  assert.match(b.verdict.blocking[0].text, /mainnet-only invocation/);
  assert.equal(b.verdict.blocking[0].where, 'deploy/gcp.sh:12');
  assert.equal(b.verdict.blocking[0].against, 'AC8');
  assert.deepEqual(b.verdict.others, { P3: 0, P4: 0, suggestions: 1 });
  const unchecked = b.verdict.unchecked.map((u) => [u.source, u.text]);
  assert.deepEqual(unchecked, [
    ['V0', 'Free review of the whole change. (deploy/gcp.sh, .env.example, README.md +4)'],
    ['X9', 'X9 did not return a valid answer (EXECUTED_FAIL)'],
    ['B2', 'Review the credential sections of the example env file. (.env.example)'],
    ['gap', 'something else entirely'],
  ], 'one line per unit, not one per role; items are rows of the table, not repeated');
  assert.deepEqual(b.verdict.undecided, ['I2', 'I4', 'I3']);
});

test('who else is affected: caller verdicts, and unknown consumers said out loud', () => {
  const b = brief.buildBrief(inputs());
  assert.deepEqual(b.affected.counts, { compatible: 1, broken: 1 });
  assert.deepEqual(b.affected.attention.map((c) => c.source), ['C2']);
  assert.match(b.affected.outside, /no related repositories are configured/);
  const withRelated = brief.buildBrief(inputs({ related: ['acme/bff'] }));
  assert.match(withRelated.affected.outside, /acme\/bff/);
});

test('decisions for a person: unconfirmed intent, open spec questions, the REVIEW gate', () => {
  const b = brief.buildBrief(inputs());
  assert.deepEqual(b.decisions.map((d) => d.source), ['intent', 'Q1', 'REVIEW']);
  const confirmed = brief.buildBrief(inputs({ identity: { ...inputs().identity, intent: 'confirmed' } }));
  assert.ok(!confirmed.decisions.some((d) => d.source === 'intent'));
});

test('reading order follows the flow: entry, logic, config and data, docs, tests', () => {
  const b = brief.buildBrief(inputs());
  assert.deepEqual(b.reading.map((r) => [r.group, r.path]), [
    ['entry', 'deploy/gcp.sh'],
    ['entry', 'src/bot/api/controller.py'],
    ['logic', 'src/bot/core/engine.py'],
    ['config', '.env.example'],
    ['config', '.gitignore'],
    ['docs', 'README.md'],
    ['tests', 'tests/test_deploy.py'],
  ]);
  assert.deepEqual(b.reading.find((r) => r.path === 'deploy/gcp.sh').findings, ['B1-business-F1']);
});

test('the markdown brief fits one screen and every bullet carries its source', () => {
  const md = brief.renderBrief(brief.buildBrief(inputs()));
  assert.match(md, /^## Review brief/);
  assert.match(md, /\| Situation \| Spec expects \| Code at head \(reviewers\) \| Result \|/);
  assert.match(md, /Behaviour at base is not recorded/);
  for (const line of md.split('\n').filter((l) => /^- /.test(l))) {
    assert.match(line, /`[^`]+`/, `bullet without a source: ${line}`);
  }
  assert.ok(md.split('\n').length < 60, `${md.split('\n').length} lines`);
});

test('many passing situations collapse into one line', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ id: `I${i + 10}`, kind: 'constraint', acs: [], risk: 'normal', label: 'CONFIRMED', text: `rule ${i}`, expected: 'x', scenarios: [] }));
  const v = inputs();
  v.items = [...ITEMS, ...many];
  v.validation.items = [...v.validation.items, ...many.map((m) => ({ id: m.id, kind: m.kind, risk: 'normal', result: 'pass', verdicts: [{ unit_id: 'B1', role: 'business', verdict: 'pass', note: 'ok' }] }))];
  const b = brief.buildBrief(v);
  assert.equal(b.behaviour.rows.filter((r) => r.result === 'pass').length, 0);
  assert.deepEqual(b.behaviour.passed.length, 15);
  assert.match(brief.renderBrief(b), /15 situations behave as the spec expects/);
});

test('an acceptance item reads as given/when; the then stays in "spec expects"', () => {
  const v = inputs();
  v.items = [...ITEMS, { id: 'I9', kind: 'acceptance', acs: ['AC1'], risk: 'normal', text: 'AC1: given The game uses the default configuration., when Lightning is evaluated., then The default behaviour remains unchanged.', expected: 'The default behaviour remains unchanged.', scenarios: [] }];
  v.validation.items = [...v.validation.items, { id: 'I9', kind: 'acceptance', risk: 'normal', result: 'pass', verdicts: [{ unit_id: 'B1', role: 'business', verdict: 'pass', note: 'unchanged' }] }];
  const row = brief.buildBrief(v).behaviour.rows.find((r) => r.source === 'I9');
  assert.equal(row.situation, 'Given The game uses the default configuration, when Lightning is evaluated');
  assert.equal(row.expected, 'The default behaviour remains unchanged.');
});

test('an older run with a PR<NAME>-<n> key is still read as an intent derived from the PR', () => {
  const old = brief.buildBrief(inputs({ identity: { repo: 'Anuken/Mindustry', pr: 12707, title: 't', ticket: 'PRMINDUSTRY-12707' } }));
  assert.match(old.intent.text, /derived from the PR as PRMINDUSTRY-12707 \(whether it was confirmed is not recorded/);
  assert.ok(!old.decisions.some((d) => d.source === 'intent'), 'no confirmation is asked for when it is not known');
  const ticket = brief.buildBrief(inputs({ identity: { repo: 'o/n', pr: 3, title: 't', ticket: 'SHOP-12' } }));
  assert.equal(ticket.intent.text, 'ticket SHOP-12');
});

test('a PR without items or plan still gets a brief, honest about it', () => {
  const v = inputs({ items: [], plan: null, specMd: '', synthesis: null });
  v.validation.items = [];
  const b = brief.buildBrief(v);
  assert.equal(b.behaviour.rows.length, 0);
  assert.match(brief.renderBrief(b), /No review items: the code was reviewed against the checklist and the reviewers' judgement only/);
});
