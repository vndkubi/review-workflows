'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSpec, pairwiseRows, compressPatterns } = require('../src/lib/spec');

const TICKET = '## Acceptance Criteria\n- Members get 10% off orders of 1,000,000 or more.';
const blocks = [{ name: 'ticket', text: TICKET }];
const requirements = {
  items: [{ id: 'AC1', kind: 'acceptance', given: 'g', when: 'w', then: 'Members get 10% off orders of 1,000,000 or more.', evidence: { source: 'ticket', quote: 'x' }, risk: 'money' }],
};

function discountModel(overrides = {}) {
  return {
    schema_version: '1.0',
    ticket: 'ACME-7',
    features: [
      {
        id: 'F1',
        name: 'Member discount',
        variables: [
          { id: 'member', description: 'customer is a member', type: 'boolean', classes: [{ id: 'yes', label: 'member', validity: 'valid', value: 'true' }, { id: 'no', label: 'non-member', validity: 'valid', value: 'false' }] },
          {
            id: 'total',
            description: 'order total',
            type: 'integer',
            unit: 'VND',
            classes: [
              { id: 'negative', label: 'negative', validity: 'invalid', max: '0', max_inclusive: false },
              { id: 'below', label: '< 1,000,000', validity: 'valid', min: '0', min_inclusive: true, max: '1000000', max_inclusive: false },
              { id: 'from', label: '≥ 1,000,000', validity: 'valid', min: '1000000', min_inclusive: true },
              { id: 'missing', label: 'missing', validity: 'invalid', special: 'missing' },
            ],
          },
        ],
        outcomes: [{ id: 'discount', description: 'discount rate' }],
        rules: [
          { id: 'R1', conditions: [{ variable: 'member', classes: ['yes'] }, { variable: 'total', classes: ['from'] }], results: [{ outcome: 'discount', value: '10%' }], acs: ['AC1'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'Members get 10% off orders of 1,000,000 or more.' } },
          { id: 'R2', conditions: [{ variable: 'member', classes: ['yes'] }, { variable: 'total', classes: ['below'] }], results: [{ outcome: 'discount', value: '0' }], acs: ['AC1'], label: 'INFERRED', source: { source: 'ticket', quote: '' } },
          { id: 'R3', conditions: [{ variable: 'member', classes: ['no'] }, { variable: 'total', classes: ['below', 'from'] }], results: [{ outcome: 'discount', value: '0' }], acs: ['AC1'], label: 'INFERRED', source: { source: 'ticket', quote: '' } },
        ],
      },
    ],
    other_acs: [],
    notes: '',
    ...overrides,
  };
}

test('spec: tables, exhaustive gaps, business boundary, review items', () => {
  const { errors, spec } = buildSpec({ model: discountModel(), requirements, ticket: 'ACME-7', blocks });
  assert.equal(errors, undefined);
  const f = spec.features[0];
  assert.equal(f.combinations, 8);
  assert.equal(f.mode, 'exhaustive');
  // The 1,000,000 boundary changes the member result: 999,999 -> 0, 1,000,000 -> 10%.
  const b = f.boundaries.find((x) => x.variable === 'total' && x.below === 'below');
  assert.deepEqual(b.at, ['999999', '1000000']);
  const [sa, sb] = b.scenarios.map((id) => f.scenarios.find((s) => s.id === id));
  assert.equal(sa.expected, 'discount=0');
  assert.equal(sb.expected, 'discount=10%');
  assert.equal(sa.values.member, 'true');
  // negative and missing totals are not covered by any rule: compressed to two gap patterns.
  const gaps = spec.questions.filter((q) => q.kind === 'gap').map((q) => q.text);
  assert.equal(gaps.length, 2);
  assert.ok(gaps.some((t) => t.includes('member=*, total=negative')));
  assert.ok(gaps.some((t) => t.includes('member=*, total=missing')));
  // Items: 3 rules, boundaries that change results, 2 gaps.
  const kinds = spec.review_items.map((i) => i.kind);
  assert.equal(kinds.filter((k) => k === 'rule').length, 3);
  // 999,999|1,000,000 is gradable; -1|0 has an unspecified side, so it is reported as a gap.
  assert.equal(kinds.filter((k) => k === 'boundary').length, 1);
  assert.equal(kinds.filter((k) => k === 'gap').length, 3);
  assert.equal(spec.review_items.find((i) => i.rule === 'R1').risk, 'money');
  assert.equal(spec.clean, false);
  assert.equal(spec.stats.inferred_rules, 2);
});

test('spec: modelling mistakes go back to the model as precise errors', () => {
  const m1 = discountModel();
  m1.features[0].variables[1].classes[1].max = '999999'; // leaves a hole before 1,000,000
  m1.features[0].variables[1].classes[1].max_inclusive = false;
  const e1 = buildSpec({ model: m1, requirements, ticket: 'ACME-7', blocks }).errors;
  assert.ok(e1.some((e) => /values 999999\.\.999999 lie between "below" and "from"/.test(e)), e1.join('\n'));

  const m2 = discountModel();
  m2.features[0].variables[1].classes.shift(); // nothing below 0
  const e2 = buildSpec({ model: m2, requirements, ticket: 'ACME-7', blocks }).errors;
  assert.ok(e2.some((e) => /values below 0 belong to no class/.test(e)));

  const m3 = discountModel();
  m3.features[0].rules[0].conditions[1].classes = ['huge'];
  m3.features[0].rules[1].results = [{ outcome: 'rate', value: '1' }];
  const e3 = buildSpec({ model: m3, requirements, ticket: 'ACME-7', blocks }).errors;
  assert.ok(e3.some((e) => /"huge" is not a class of total/.test(e)));
  assert.ok(e3.some((e) => /unknown outcome "rate"/.test(e)));
  assert.ok(e3.some((e) => /missing a value for outcome "discount"/.test(e)));

  const m4 = discountModel();
  m4.features[0].rules.forEach((r) => {
    r.acs = [];
  });
  const e4 = buildSpec({ model: m4, requirements, ticket: 'ACME-7', blocks }).errors;
  assert.ok(e4.some((e) => /AC1 is not modelled/.test(e)));
});

// Incident: Date.parse rolls 2026-02-30 over to 2026-03-02, so an impossible
// day silently moved a class boundary instead of going back to the model.
test('spec: impossible calendar dates are unparsable, not rolled over', () => {
  const dated = (min) => {
    const m = discountModel();
    m.features[0].variables[1] = {
      id: 'total',
      description: 'order date',
      type: 'date',
      classes: [
        { id: 'below', label: 'before', validity: 'valid', max: min, max_inclusive: false },
        { id: 'from', label: 'from', validity: 'valid', min, min_inclusive: true },
        { id: 'missing', label: 'missing', validity: 'invalid', special: 'missing' },
      ],
    };
    return buildSpec({ model: m, requirements, ticket: 'ACME-7', blocks }).errors || [];
  };
  for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-00-10', '2026-13-01']) {
    assert.ok(dated(bad).some((e) => /"from" has an unparsable min\/max for type date/.test(e)), `${bad}: ${dated(bad).join('\n')}`);
  }
  for (const good of ['2024-02-29', '2026-12-31', '2026-01-01']) {
    assert.ok(!dated(good).some((e) => /unparsable/.test(e)), `${good}: ${dated(good).join('\n')}`);
  }
});

test('spec: contradictions and unquotable CONFIRMED rules', () => {
  const m = discountModel();
  m.features[0].rules.push({ id: 'R4', conditions: [{ variable: 'member', classes: ['yes'] }, { variable: 'total', classes: ['from'] }], results: [{ outcome: 'discount', value: '15%' }], acs: ['AC1'], label: 'CONFIRMED', source: { source: 'ticket', quote: 'VIPs get 15%' } });
  const { spec } = buildSpec({ model: m, requirements, ticket: 'ACME-7', blocks });
  assert.equal(spec.stats.contradictions, 1);
  assert.ok(spec.questions.some((q) => q.kind === 'contradiction' && q.text.includes('R1 and R4')));
  assert.ok(spec.warnings.some((w) => w.startsWith('R4: quote not found')));
  assert.equal(spec.model.features[0].rules.find((r) => r.id === 'R4').label, 'INFERRED');
});

test('pairwise covers every pair; large features keep one row per rule', () => {
  const lists = [['a', 'b', 'c'], ['x', 'y', 'z'], ['1', '2', '3'], ['p', 'q', 'r'], ['u', 'v']];
  const rows = pairwiseRows(lists);
  for (let i = 0; i < lists.length; i += 1) {
    for (let j = i + 1; j < lists.length; j += 1) {
      for (const a of lists[i]) for (const b of lists[j]) assert.ok(rows.some((r) => r[i] === a && r[j] === b), `missing ${a}/${b}`);
    }
  }
  assert.ok(rows.length < 162 / 5, `pairwise should be far smaller than ${3 * 3 * 3 * 3 * 2} rows, got ${rows.length}`);

  const m = discountModel();
  const f = m.features[0];
  for (const name of ['channel', 'region', 'tier']) {
    f.variables.push({ id: name, description: name, type: 'enum', classes: ['a', 'b', 'c', 'd'].map((x) => ({ id: x, label: x, validity: 'valid', value: x })) });
  }
  const { spec } = buildSpec({ model: m, requirements, ticket: 'ACME-7', blocks });
  const feat = spec.features[0];
  assert.equal(feat.combinations, 512);
  assert.equal(feat.mode, 'pairwise+rules');
  for (const r of ['R1', 'R2', 'R3']) assert.ok(feat.scenarios.some((s) => s.rules.includes(r)), `${r} lost its scenario`);
  assert.ok(feat.boundaries.some((b) => b.variable === 'total' && b.at[1] === '1000000'), 'business boundary kept under pairwise');
  assert.ok(feat.scenarios.length < 512);
});

test('gap patterns collapse full sub-blocks to *', () => {
  const lists = [['a', 'b'], ['x', 'y']];
  assert.deepEqual(compressPatterns([['a', 'x'], ['b', 'x']], lists), [['*', 'x']]);
  assert.deepEqual(compressPatterns([['a', 'x'], ['b', 'x'], ['a', 'y'], ['b', 'y']], lists), [['*', '*']]);
});

test('gap patterns widen to overlapping wildcards (seen live: missing status split in two)', () => {
  const { generalizePatterns } = require('../src/lib/spec');
  const lists = [['member', 'non', 'missing'], ['neg', 'below', 'from']];
  // uncovered: anything negative, and a missing status with any amount
  const gaps = [['member', 'neg'], ['non', 'neg'], ['missing', 'neg'], ['missing', 'below'], ['missing', 'from']];
  const keys = new Set(gaps.map((c) => c.join('\u0000')));
  const out = generalizePatterns(compressPatterns(gaps, lists), lists, keys);
  assert.deepEqual(out.map((p) => p.join(',')).sort(), ['*,neg', 'missing,*']);
});

test('complement rules without their own AC inherit the feature risk', () => {
  const { spec } = buildSpec({ model: discountModel(), requirements, ticket: 'ACME-7', blocks });
  const m = discountModel();
  m.features[0].rules[1].acs = [];
  const out = buildSpec({ model: m, requirements, ticket: 'ACME-7', blocks }).spec;
  assert.equal(out.review_items.find((i) => i.rule === 'R2').risk, 'money');
  assert.ok(spec);
});
