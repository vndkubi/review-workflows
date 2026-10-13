'use strict';
// Impact analysis: changed declarations, their call sites two levels up,
// resolution through imports and packages, comments and strings ignored.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, sh, write } = require('./helpers');

// The structural index is tested on its own; javac is tested below when a JDK 11+ exists.
process.env.ARW_JAVA_AST = 'off';

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
    'src/main/java/org/other/Coupon.java': 'package org.other;\n\npublic class Coupon {\n    int apply(Promo p) {\n        return p.discount(true, null).intValue() + lookup().discount(true, null).intValue();\n    }\n}\n',
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
    'CheckoutController.total@CheckoutController.java:11->OrderService.discount typed',
    'Coupon.apply@Coupon.java:5->OrderService.discount name-only',
  ], 'the comment (line 9) and the string (line 10) are not calls; p.discount() on a Promo is another method, lookup().discount() is unknown');
  assert.deepEqual(e(2), ['Api.checkout@Api.java:8->CheckoutController.total typed'], 'name-only callers are not followed');
  assert.deepEqual(e(3), ['ApiTest.checks@ApiTest.java:5->Api.checkout typed']);
  assert.match(renderImpact(out), /Direct callers:\n- CheckoutController\.total at src\/main\/java\/com\/acme\/CheckoutController\.java:11 -> OrderService\.discount \[typed\]/);
  // The test that reaches the change through a caller is impacted, by call.
  const ti = testImpact({ checkout: r.dir, head: r.head, changed: r.changed, impact: out });
  const tests = ti.sources.find((s) => s.source.endsWith('OrderService.java')).tests;
  assert.deepEqual(tests.map((t) => [t.path, t.how]), [['src/test/java/com/acme/api/ApiTest.java', 'call']]);
});

test('java: injected interfaces, XML beans, reflection, other repositories and HTTP clients', () => {
  const PRICE = (rate) => `package com.acme;\n\nimport java.math.BigDecimal;\n\n@Service\npublic class DefaultPricing implements PricingService {\n    public BigDecimal price(BigDecimal amount) {\n        return amount.multiply(new BigDecimal("${rate}"));\n    }\n}\n`;
  const CART = (body) => `package com.acme;\n\nimport java.math.BigDecimal;\n\n@RestController\n@RequestMapping("/api/cart")\npublic class CartController {\n    @Autowired\n    private PricingService pricing;\n\n    @GetMapping("/total/{id}")\n    public BigDecimal total(String id) {\n        ${body}\n    }\n}\n`;
  const r = repo({
    'src/main/java/com/acme/PricingService.java': 'package com.acme;\n\nimport java.math.BigDecimal;\n\npublic interface PricingService {\n    BigDecimal price(BigDecimal amount);\n}\n',
    'src/main/java/com/acme/DefaultPricing.java': PRICE('1.10'),
    'src/main/java/com/acme/CartController.java': CART('return pricing.price(BigDecimal.TEN);'),
    'src/main/java/com/acme/Plugins.java': 'package com.acme;\n\npublic class Plugins {\n    Object load() throws Exception {\n        return DefaultPricing.class.getMethod("price", java.math.BigDecimal.class);\n    }\n}\n',
    'src/main/resources/applicationContext.xml': '<beans>\n  <bean id="pricing" class="com.acme.DefaultPricing"/>\n</beans>\n',
  }, {
    'src/main/java/com/acme/DefaultPricing.java': PRICE('1.20'),
    'src/main/java/com/acme/CartController.java': CART('return pricing.price(BigDecimal.ONE);'),
  });
  // A related repository: a batch job using the interface, and a web client of the endpoint.
  const other = tmpDir('arw-impact-other-');
  sh(other, ['init', '-q', '-b', 'main']);
  write(other, 'src/main/java/com/acme/batch/Nightly.java', 'package com.acme.batch;\n\nimport com.acme.PricingService;\n\npublic class Nightly {\n    private PricingService prices;\n\n    void run() {\n        prices.price(java.math.BigDecimal.ONE);\n    }\n}\n');
  write(other, 'web/src/cart.js', "export const total = (id) => fetch('/api/cart/total/' + id);\n");
  sh(other, ['add', '-A']);
  sh(other, ['commit', '-q', '-m', 'other']);
  const out = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed, related: [{ name: 'acme/web', dir: other }] });
  assert.deepEqual(out.changed.map((c) => c.symbol).sort(), ['CartController.total', 'DefaultPricing.price']);
  const has = (pred, why) => assert.ok(out.edges.some(pred), `${why}: ${JSON.stringify(out.edges, null, 1)}`);
  has((e) => e.from.symbol === 'CartController.total' && e.to.symbol === 'DefaultPricing.price' && e.confidence === 'interface' && e.via === 'PricingService', 'an injected interface dispatches to the changed implementation');
  has((e) => e.confidence === 'config' && e.from.path.endsWith('applicationContext.xml') && e.to.symbol === 'DefaultPricing.price', 'the Spring XML bean');
  has((e) => e.confidence === 'reflection' && e.from.path.endsWith('Plugins.java'), 'getMethod("price")');
  has((e) => e.repo === 'acme/web' && e.from.symbol === 'Nightly.run' && e.confidence === 'interface', 'a caller in another repository');
  has((e) => e.repo === 'acme/web' && e.confidence === 'http' && e.from.path === 'web/src/cart.js' && e.to.symbol === 'CartController.total', 'a client of the changed endpoint');
  const text = renderImpact(out);
  assert.match(text, /Referenced by name \(configuration, reflection, HTTP clients\):/);
  assert.match(text, /Other repositories \(acme\/web\):\n- \[acme\/web\] Nightly\.run at src\/main\/java\/com\/acme\/batch\/Nightly\.java:9 -> DefaultPricing\.price \[interface via PricingService\]/);
});

test('python: variable types from constructors and annotations', () => {
  const r = repo({
    'billing/fees.py': 'class FeeService:\n    def late_fee(self, days):\n        return days * 2\n\n\nclass Other:\n    def late_fee(self, days):\n        return 0\n',
    'billing/use.py': 'from billing.fees import FeeService, Other\n\n\ndef a():\n    svc = FeeService()\n    return svc.late_fee(3)\n\n\ndef b(o: Other):\n    return o.late_fee(3)\n',
  }, { 'billing/fees.py': 'class FeeService:\n    def late_fee(self, days):\n        return days * 3\n\n\nclass Other:\n    def late_fee(self, days):\n        return 0\n' });
  const out = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed });
  assert.deepEqual(out.edges.map((e) => `${e.from.symbol}->${e.to.symbol} ${e.confidence}`), ['a->FeeService.late_fee typed'], 'b() calls Other.late_fee');
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

// ---------- javac call graph ----------
const javaAst = require('../src/lib/java-ast');
const hasJdk = javaAst.javaVersion() != null;

test('javac: overloads, var, chained calls and interface dispatch, where text cannot tell', { skip: !hasJdk && 'no JDK 11+ on PATH' }, () => {
  const IMPL = (v) => `package com.acme;\n\npublic class Impl implements Pricing {\n    public int price(int a) {\n        return a * ${v};\n    }\n\n    public int price(int a, int b) {\n        return a + b;\n    }\n}\n`;
  const r = repo({
    'src/main/java/com/acme/Pricing.java': 'package com.acme;\n\npublic interface Pricing {\n    int price(int a);\n}\n',
    'src/main/java/com/acme/Impl.java': IMPL(1),
    'src/main/java/com/acme/Use.java': [
      'package com.acme;',
      '',
      'import org.missing.Lib;',
      '',
      'public class Use {',
      '    private Pricing pricing;',
      '',
      '    Impl make() {',
      '        return new Impl();',
      '    }',
      '',
      '    int viaInterface() {',
      '        return pricing.price(1);',
      '    }',
      '',
      '    int viaVar() {',
      '        var x = make();',
      '        return x',
      '            .price(2);',
      '    }',
      '',
      '    int otherOverload() {',
      '        return make().price(1, 2);',
      '    }',
      '',
      '    int unresolved() {',
      '        return Lib.thing().price(3);',
      '    }',
      '}',
      '',
    ].join('\n'),
  }, { 'src/main/java/com/acme/Impl.java': IMPL(2) });
  process.env.ARW_JAVA_AST = 'on';
  try {
    const out = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed });
    assert.match(out.engine, /^javac \(JDK \d+, \d+ ms\) \+ structural$/);
    assert.deepEqual(out.changed.map((c) => c.symbol), ['Impl.price']);
    const edges = out.edges.map((e) => `${e.from.symbol}:${e.from.line} ${e.confidence}${e.via ? ` via ${e.via}` : ''}`).sort();
    assert.deepEqual(edges, [
      'Use.unresolved:27 resolved', // a missing library: javac cannot say, so the structural match (same package, names Impl) stands
      'Use.viaInterface:13 ast-dispatch via Pricing', // Pricing.price, which Impl.price(int) overrides
      'Use.viaVar:19 ast', // var x = make() is an Impl; the call spans two lines
    ], 'otherOverload calls price(int, int), a different method: not listed');
    assert.match(renderImpact(out), /\[ast-dispatch via Pricing\]/);
  } finally {
    process.env.ARW_JAVA_AST = 'off';
  }
});

test('javac: a failing indexer falls back to the structural index and says so', { skip: !hasJdk && 'no JDK 11+ on PATH' }, () => {
  const A = (v) => `class A {\n    int f() {\n        return ${v};\n    }\n\n    int g() {\n        return f();\n    }\n}\n`;
  const r = repo({ 'src/main/java/A.java': A(1) }, { 'src/main/java/A.java': A(2) });
  process.env.ARW_JAVA_AST = 'on';
  process.env.ARW_JAVA_AST_MAX_FILES = '0';
  try {
    const out = analyzeImpact({ cwd: r.dir, base: r.base, parsed: r.parsed });
    assert.equal(out.engine, 'structural');
    assert.match(out.ast_error, /above ARW_JAVA_AST_MAX_FILES/);
    assert.match(renderImpact(out), /javac call graph unavailable/);
    assert.ok(out.edges.some((e) => e.from.symbol === 'A.g'), 'the structural index still finds the caller');
  } finally {
    process.env.ARW_JAVA_AST = 'off';
    delete process.env.ARW_JAVA_AST_MAX_FILES;
  }
});
