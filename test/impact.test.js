'use strict';
// Impact analysis: changed declarations, their call sites two levels up,
// resolution through imports and packages, comments and strings ignored.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, sh, write } = require('./helpers');

const git = require('../src/lib/git');
const { parsePatch } = require('../src/lib/patch');
const { analyzeImpact, renderImpact, stripPython } = require('../src/lib/impact');
const { testImpact } = require('../src/lib/static-evidence');

function repo(files, changes) {
  const dir = tmpDir('arw-impact-');
  sh(dir, ['init', '-q', '-b', 'main']);
  for (const [f, t] of Object.entries(files)) write(dir, f, t);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const base = sh(dir, ['rev-parse', 'HEAD']);
  for (const [f, t] of Object.entries(changes)) write(dir, f, t);
  sh(dir, ['commit', '-q', '-am', 'change']);
  const head = sh(dir, ['rev-parse', 'HEAD']);
  return { dir, base, head, parsed: parsePatch(git.diffPatch(dir, base, head)), changed: git.changedFiles(dir, base, head).map((f) => f.path) };
}

const ORDER = (body) => `package com.acme;\n\nimport java.math.BigDecimal;\n\npublic class OrderService {\n    public BigDecimal discount(boolean member, BigDecimal total) {\n        ${body}\n    }\n\n    public BigDecimal unchanged() {\n        return BigDecimal.ONE;\n    }\n}\n`;

test('java: direct and second-level callers, resolution, comments and strings ignored', () => {
  const r = repo({
    'src/main/java/com/acme/OrderService.java': ORDER('return BigDecimal.ZERO;'),
    'src/main/java/com/acme/CheckoutController.java': 'package com.acme;\n\nimport java.math.BigDecimal;\n\npublic class CheckoutController {\n    private final OrderService orders = new OrderService();\n\n    public BigDecimal total(boolean member, BigDecimal total) {\n        // orders.discount(member, total) was here before\n        String note = "discount(";\n        return total.subtract(orders.discount(member, total));\n    }\n}\n',
    'src/main/java/com/acme/api/Api.java': 'package com.acme.api;\n\nimport com.acme.CheckoutController;\nimport java.math.BigDecimal;\n\npublic class Api {\n    public BigDecimal checkout() {\n        return new CheckoutController().total(true, BigDecimal.TEN);\n    }\n}\n',
    'src/main/java/org/other/Coupon.java': 'package org.other;\n\npublic class Coupon {\n    int apply(Promo p) {\n        return p.discount(true, null).intValue();\n    }\n}\n',
    'src/test/java/com/acme/api/ApiTest.java': 'package com.acme.api;\n\nclass ApiTest {\n    void checks() {\n        new Api().checkout();\n    }\n}\n',
    // Regressions from a 3000-file benchmark: another class's declaration of
    // the same name is not a call, and Rates.discount(...) is not OrderService's.
    'src/main/java/com/acme/Pricing.java': 'package com.acme;\n\nimport java.math.BigDecimal;\n\npublic class Pricing {\n    public BigDecimal discount(boolean member, BigDecimal total) {\n        return Rates.discount(member, total);\n    }\n}\n',
  }, {
    'src/main/java/com/acme/OrderService.java': ORDER('return member ? total.multiply(new BigDecimal("0.1")) : BigDecimal.ZERO;'),
  });
  const out = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed });
  assert.deepEqual(out.changed.map((c) => c.symbol), ['OrderService.discount'], 'only the method whose lines changed');
  const e = (level) => out.edges.filter((x) => x.level === level).map((x) => `${x.from.symbol}@${x.from.path.split('/').pop()}:${x.from.line}->${x.to.symbol} ${x.confidence}`).sort();
  assert.deepEqual(e(1), [
    'CheckoutController.total@CheckoutController.java:11->OrderService.discount resolved',
    'Coupon.apply@Coupon.java:5->OrderService.discount name-only',
  ], 'the comment (line 9) and the string (line 10) are not calls');
  assert.deepEqual(e(2), ['Api.checkout@Api.java:8->CheckoutController.total resolved'], 'name-only callers are not followed');
  assert.deepEqual(e(3), ['ApiTest.checks@ApiTest.java:5->Api.checkout resolved']);
  assert.match(renderImpact(out), /Direct callers:\n- CheckoutController\.total at src\/main\/java\/com\/acme\/CheckoutController\.java:11 -> OrderService\.discount \[resolved\]/);
  // The test that reaches the change through a caller is impacted, by call.
  const ti = testImpact({ checkout: r.dir, head: r.head, changed: r.changed, impact: out });
  const tests = ti.sources.find((s) => s.source.endsWith('OrderService.java')).tests;
  assert.deepEqual(tests.map((t) => [t.path, t.how]), [['src/test/java/com/acme/api/ApiTest.java', 'call']]);
});

test('python: imports resolve module functions and methods; docstrings are not calls', () => {
  const r = repo({
    'billing/fees.py': '"""late_fee(days) is documented here."""\n\n\ndef late_fee(days):\n    return days * 2\n',
    'billing/invoice.py': 'from billing.fees import late_fee\n\n\ndef invoice_total(days):\n    return 100 + late_fee(days)\n',
    'reports/summary.py': 'def late_fee(x):\n    return 0\n\n\ndef summary():\n    return late_fee(1)\n',
    'tests/test_invoice.py': 'from billing.invoice import invoice_total\n\n\ndef test_total():\n    assert invoice_total(3) == 106\n',
  }, { 'billing/fees.py': '"""late_fee(days) is documented here."""\n\n\ndef late_fee(days):\n    return days * 3\n' });
  const out = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed });
  assert.deepEqual(out.changed.map((c) => c.symbol), ['late_fee']);
  const lines = out.edges.map((x) => `${x.level} ${x.from.symbol}@${x.from.path}->${x.to.symbol} ${x.confidence}`).sort();
  assert.deepEqual(lines, [
    '1 invoice_total@billing/invoice.py->late_fee resolved',
    '1 summary@reports/summary.py->late_fee name-only', // its own late_fee, not the changed one
    '2 test_total@tests/test_invoice.py->invoice_total resolved',
  ]);
  assert.equal(stripPython('x = "a#b"  # c\ny = \'\'\'q\nw\'\'\'\n').split('\n').length, 4, 'newlines kept');
  const ti = testImpact({ checkout: r.dir, head: r.head, changed: r.changed, impact: out });
  assert.deepEqual(ti.sources[0].tests.map((t) => [t.path, t.how]), [['tests/test_invoice.py', 'call']]);
});
