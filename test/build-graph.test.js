'use strict';
// Repositories that build on each other: payment-lib (Java 8) ->
// payment-common (11) -> payment-server (11), an unrelated repository in
// parallel; cycles, duplicate coordinates and a too-new library are
// problems, not guesses.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpDir, sh, write } = require('./helpers');

const { discoverRepo } = require('../src/lib/discovery');
const { buildGraph, levelsOf, renderGraph } = require('../src/lib/build-graph');

function pom({ g = 'com.company', a, v = '1.0.0', java, deps = [] }) {
  const d = deps.map(([dg, da, dv]) => `    <dependency>\n      <groupId>${dg}</groupId>\n      <artifactId>${da}</artifactId>\n      <version>${dv}</version>\n    </dependency>\n`).join('');
  return `<project>\n  <groupId>${g}</groupId>\n  <artifactId>${a}</artifactId>\n  <version>${v}</version>\n  <properties>\n    <maven.compiler.release>${java}</maven.compiler.release>\n  </properties>\n  <dependencies>\n${d}  </dependencies>\n</project>\n`;
}

function repo(name, pomText) {
  const dir = path.join(tmpDir('arw-graph-'), name);
  sh(path.dirname(dir), ['init', '-q', '-b', 'main', name]);
  write(dir, 'pom.xml', pomText);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

const discover = (dir) => discoverRepo({ checkout: dir, repo: path.basename(dir) });

function payments({ libJava = 8, libVersion = '1.2.0-SNAPSHOT' } = {}) {
  return {
    lib: repo('payment-lib', pom({ a: 'payment-lib', v: libVersion, java: libJava, deps: [['junit', 'junit', '4.13.2']] })),
    common: repo('payment-common', pom({ a: 'payment-common', v: '2.0.0', java: 11, deps: [['com.company', 'payment-lib', '1.2.0-SNAPSHOT']] })),
    server: repo('payment-server', pom({ a: 'payment-server', v: '3.0.0', java: 11, deps: [['com.company', 'payment-common', '2.0.0'], ['com.company', 'payment-lib', '1.2.0-SNAPSHOT'], ['org.slf4j', 'slf4j-api', '2.0.9']] })),
    other: repo('reporting', pom({ a: 'reporting', java: 17 })),
  };
}

test('payment-lib (8) -> payment-common (11) -> payment-server (11): order, levels, artifacts between them', () => {
  const r = payments();
  const g = buildGraph([r.server, r.other, r.lib, r.common].map(discover));
  assert.deepEqual(g.problems, []);
  assert.deepEqual(g.levels, [['payment-lib', 'reporting'], ['payment-common'], ['payment-server']], 'independent repositories share a level');
  assert.deepEqual(g.nodes.find((n) => n.repo === 'payment-server').depends_on, ['payment-common', 'payment-lib']);
  const e = g.edges.find((x) => x.consumer === 'payment-common');
  assert.deepEqual([e.dependency, e.artifact, e.wanted, e.produced, e.version_match], ['payment-lib', 'com.company:payment-lib', '1.2.0-SNAPSHOT', '1.2.0-SNAPSHOT', true]);
  assert.equal(e.evidence.quote, '<dependency>');
  assert.deepEqual(g.nodes.filter((n) => n.repo.startsWith('payment')).map((n) => [n.repo, n.jdk]).sort(), [['payment-common', 11], ['payment-lib', 8], ['payment-server', 11]]);
  assert.ok(g.external.some((x) => x.artifact === 'org.slf4j:slf4j-api:2.0.9'), 'a dependency no repository builds is external');
  assert.match(renderGraph(g), /1\. payment-lib, reporting\n {2}2\. payment-common\n {2}3\. payment-server/);
});

test('a library compiled for a newer Java than its consumer builds with is a problem', () => {
  const r = payments({ libJava: 17 });
  const g = buildGraph([r.lib, r.common].map(discover));
  assert.match(g.problems.map((p) => p.detail).join('\n'), /payment-lib compiles for Java 17; payment-common builds with JDK 11/);
});

// Seen on real clones: elasticsearch depends on hadoop 2.8.5 releases; the
// hadoop source produces 3.6.0-SNAPSHOT. Building it first would be wrong.
test('the consumer wants another version than the source produces: no build edge, a note with both versions', () => {
  const r = payments({ libVersion: '1.3.0-SNAPSHOT' });
  const g = buildGraph([r.lib, r.common].map(discover));
  assert.deepEqual(g.edges, []);
  assert.equal(g.unmatched[0].version_match, false);
  assert.deepEqual(g.levels, [['payment-common', 'payment-lib']], 'nothing has to build first');
  assert.match(g.notes.join('\n'), /wants com\.company:payment-lib:1\.2\.0-SNAPSHOT; payment-lib at [0-9a-f]{12} produces 1\.3\.0-SNAPSHOT: resolved from a Maven repository/);
});

test('two repositories producing one coordinate, and a cycle: reported, no order', () => {
  const a = repo('a', pom({ a: 'a', java: 11, deps: [['com.company', 'b', '1.0.0']] }));
  const b = repo('b', pom({ a: 'b', java: 11, deps: [['com.company', 'a', '1.0.0']] }));
  const g = buildGraph([a, b].map(discover));
  assert.equal(g.order, null);
  assert.deepEqual(g.problems.map((p) => p.kind), ['cycle']);
  assert.match(g.problems[0].detail, /a -> b -> a/);
  const dup = repo('payment-lib-fork', pom({ a: 'payment-lib', java: 8 }));
  const r = payments();
  const g2 = buildGraph([r.lib, dup, r.common].map(discover));
  assert.deepEqual(g2.problems.map((p) => p.kind), ['duplicate_coordinate']);
  assert.ok(!g2.edges.length, 'the consumer is not wired to either producer');
  assert.deepEqual(levelsOf(new Map([['x', new Set(['y'])], ['y', new Set()]])).levels, [['y'], ['x']]);
});

test('arw sandbox graph: text and exit code 2 on problems', () => {
  const r = payments({ libJava: 17 });
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli', 'arw.js'), 'sandbox', 'graph', r.lib, r.common], { encoding: 'utf8' });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stdout, /build order/);
  assert.match(res.stdout, /problem: payment-lib compiles for Java 17/);
});

test('what a repository needs built first, transitively (bootstrap of one repository brings them)', () => {
  const { dependencyClosure } = require('../src/lib/build-graph');
  const r = payments();
  const g = buildGraph([r.server, r.common, r.lib, r.other].map(discover));
  assert.deepEqual([...dependencyClosure(g, ['payment-server'])].sort(), ['payment-common', 'payment-lib']);
  assert.deepEqual([...dependencyClosure(g, ['payment-lib'])], []);
  assert.deepEqual([...dependencyClosure(g, ['payment-server', 'payment-common'])], ['payment-lib'], 'a target is not its own dependency');
});
